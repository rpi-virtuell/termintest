// Minimaler, robuster Nostr-Relay-Pool (NIP-01) ohne Backend.
// Jedes Relay hält eine WebSocket-Verbindung mit automatischem Reconnect;
// Subscriptions werden nach einem Reconnect erneut gesendet.

import { verifyEvent } from '../vendor/nostr-tools.js';

let subCounter = 0;
const nextSubId = () => `tt${(++subCounter).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

class Relay {
  constructor(url, pool) {
    this.url = url;
    this.pool = pool;
    this.ws = null;
    this.status = 'idle'; // idle | connecting | open | closed | error
    this.subs = new Map(); // subId -> { filters, onevent, oneose, closed }
    this.pendingOk = new Map(); // eventId -> resolve
    this.retry = 0;
    this.queue = [];
    this.closedByUser = false;
    this.info = null;
  }

  setStatus(s, detail = '') {
    this.status = s;
    this.detail = detail;
    this.pool.emitStatus();
  }

  connect() {
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return;
    this.closedByUser = false;
    this.setStatus('connecting');
    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch (e) {
      this.setStatus('error', String(e.message || e));
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.setStatus('open');
      for (const [id, sub] of this.subs) {
        if (!sub.closed) this.send(['REQ', id, ...sub.filters]);
      }
      const q = this.queue;
      this.queue = [];
      q.forEach((m) => this.send(m));
    };
    ws.onmessage = (msg) => this.handle(msg.data);
    ws.onerror = () => this.setStatus('error', 'Verbindungsfehler');
    ws.onclose = () => {
      if (this.status !== 'error') this.setStatus('closed');
      // Offene Subscriptions gelten nach Abbruch als "fertig geladen", damit die UI nicht hängt
      for (const sub of this.subs.values()) {
        if (!sub.eosed) { sub.eosed = true; sub.oneose?.(this.url); }
      }
      for (const [, resolve] of this.pendingOk) resolve({ ok: false, message: 'Verbindung getrennt' });
      this.pendingOk.clear();
      if (!this.closedByUser) this.scheduleReconnect();
    };
  }

  scheduleReconnect() {
    const delay = Math.min(30000, 1000 * 2 ** this.retry++) + Math.random() * 500;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  close() {
    this.closedByUser = true;
    clearTimeout(this.reconnectTimer);
    try { this.ws?.close(); } catch { /* ignore */ }
    this.setStatus('idle');
  }

  send(msg) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(msg));
    else {
      this.queue.push(msg);
      this.connect();
    }
  }

  handle(raw) {
    let data;
    try { data = JSON.parse(raw); } catch { return; }
    const [type, a, b, c] = data;
    if (type === 'EVENT') {
      const sub = this.subs.get(a);
      if (!sub || sub.closed || !b || typeof b !== 'object') return;
      if (!this.pool.seenValid.has(b.id)) {
        // nostr-only Vertrauensmodell: nur Events mit gültiger Signatur werden angenommen
        if (!verifyEvent(b)) return;
        this.pool.seenValid.add(b.id);
      }
      sub.onevent?.(b, this.url);
    } else if (type === 'EOSE') {
      const sub = this.subs.get(a);
      if (sub && !sub.eosed) { sub.eosed = true; sub.oneose?.(this.url); }
    } else if (type === 'CLOSED') {
      const sub = this.subs.get(a);
      if (sub && !sub.eosed) { sub.eosed = true; sub.oneose?.(this.url, b); }
    } else if (type === 'OK') {
      const resolve = this.pendingOk.get(a);
      if (resolve) { this.pendingOk.delete(a); resolve({ ok: !!b, message: c || '' }); }
    } else if (type === 'NOTICE') {
      console.info(`[${this.url}] NOTICE:`, a);
    }
  }

  req(subId, filters, handlers) {
    this.subs.set(subId, { filters, ...handlers, eosed: false, closed: false });
    this.send(['REQ', subId, ...filters]);
  }

  unsub(subId) {
    const sub = this.subs.get(subId);
    if (!sub) return;
    sub.closed = true;
    this.subs.delete(subId);
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(['CLOSE', subId]));
  }

  publish(event, timeout = 8000) {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.pendingOk.delete(event.id);
        resolve({ ok: false, message: 'Zeitüberschreitung' });
      }, timeout);
      this.pendingOk.set(event.id, (r) => { clearTimeout(t); resolve(r); });
      this.send(['EVENT', event]);
    });
  }
}

export class RelayPool {
  constructor(urls = []) {
    this.relays = new Map();
    this.seenValid = new Set();
    this.statusListeners = new Set();
    this.setRelays(urls);
  }

  setRelays(urls) {
    const wanted = new Set(urls.map(normalizeRelayUrl).filter(Boolean));
    for (const [url, relay] of this.relays) {
      if (!wanted.has(url)) { relay.close(); this.relays.delete(url); }
    }
    for (const url of wanted) {
      if (!this.relays.has(url)) this.relays.set(url, new Relay(url, this));
    }
    this.emitStatus();
  }

  get urls() { return [...this.relays.keys()]; }

  onStatus(fn) { this.statusListeners.add(fn); return () => this.statusListeners.delete(fn); }

  emitStatus() {
    const snapshot = [...this.relays.values()].map((r) => ({ url: r.url, status: r.status, detail: r.detail }));
    this.statusListeners.forEach((fn) => fn(snapshot));
  }

  /**
   * Startet eine Subscription auf allen (oder ausgewählten) Relays.
   * oneose wird aufgerufen, sobald alle Relays EOSE (oder Abbruch) gemeldet haben.
   * Gibt eine Funktion zum Schließen zurück.
   */
  subscribe(filters, { onevent, oneose, relays, eoseTimeout = 10000 } = {}) {
    const targets = (relays ? relays.map(normalizeRelayUrl) : this.urls)
      .map((u) => this.relays.get(u))
      .filter(Boolean);
    const id = nextSubId();
    const pendingEose = new Set(targets.map((r) => r.url));
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      oneose?.();
    };
    const timer = setTimeout(finish, eoseTimeout);
    if (!targets.length) setTimeout(finish, 0);
    for (const relay of targets) {
      relay.req(id, filters, {
        onevent,
        oneose: (url) => {
          pendingEose.delete(url);
          if (!pendingEose.size) finish();
        },
      });
    }
    return () => targets.forEach((r) => r.unsub(id));
  }

  /** Einmalige Abfrage: sammelt Events bis EOSE aller Relays und schließt dann. */
  query(filters, opts = {}) {
    return new Promise((resolve) => {
      const events = new Map();
      const close = this.subscribe(filters, {
        ...opts,
        onevent: (ev, url) => { events.set(ev.id, ev); opts.onevent?.(ev, url); },
        oneose: () => { close?.(); resolve([...events.values()]); },
      });
    });
  }

  async publish(event, relays) {
    const targets = (relays || this.urls).map((u) => this.relays.get(normalizeRelayUrl(u))).filter(Boolean);
    const results = await Promise.all(targets.map(async (r) => ({ url: r.url, ...(await r.publish(event)) })));
    return results;
  }

  connectAll() { this.relays.forEach((r) => r.connect()); }
}

export function normalizeRelayUrl(url) {
  if (!url) return null;
  let u = String(url).trim();
  if (!/^wss?:\/\//i.test(u)) u = `wss://${u}`;
  try {
    const parsed = new URL(u);
    if (!/^wss?:$/.test(parsed.protocol)) return null;
    let s = `${parsed.protocol}//${parsed.host.toLowerCase()}${parsed.pathname}`;
    if (s.endsWith('/') && parsed.pathname === '/') s = s.slice(0, -1);
    return s + parsed.search;
  } catch {
    return null;
  }
}
