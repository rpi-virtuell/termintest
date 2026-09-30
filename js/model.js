// Datenmodell für NIP-52-Kalenderereignisse (kind 31922 datumsbasiert, 31923 zeitbasiert)
// plus Kalender (31924), RSVPs (31925), Profile (0) und Löschungen (NIP-09, kind 5).

import { nip19 } from '../vendor/nostr-tools.js';

export const KIND_DATE = 31922;
export const KIND_TIME = 31923;
export const KIND_CALENDAR = 31924;
export const KIND_RSVP = 31925;
export const CALENDAR_KINDS = [KIND_DATE, KIND_TIME];

const tag = (ev, name) => ev.tags.find((t) => t[0] === name)?.[1];
const tagsAll = (ev, name) => ev.tags.filter((t) => t[0] === name).map((t) => t[1]).filter(Boolean);

export const coordOf = (ev) => `${ev.kind}:${ev.pubkey}:${tag(ev, 'd') ?? ''}`;

/** "YYYY-MM-DD" als lokales Datum (Mitternacht) interpretieren. */
export function parseLocalDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || '');
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3]);
}

export function toISODate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Wandelt ein rohes Nostr-Event in ein Kalender-Objekt um. Ungültige Events → null. */
export function parseCalendarEvent(ev) {
  if (!CALENDAR_KINDS.includes(ev.kind)) return null;
  const d = tag(ev, 'd');
  const startRaw = tag(ev, 'start');
  if (d == null || !startRaw) return null;
  const allDay = ev.kind === KIND_DATE;
  let start;
  let end;
  const endRaw = tag(ev, 'end');
  if (allDay) {
    start = parseLocalDate(startRaw);
    // NIP-52: Enddatum ist exklusiv. Fehlt es, dauert der Termin einen Tag.
    end = endRaw ? parseLocalDate(endRaw) : null;
    if (!start) return null;
    if (!end || end <= start) end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
  } else {
    const s = Number(startRaw);
    if (!Number.isFinite(s)) return null;
    start = new Date(s * 1000);
    const e = Number(endRaw);
    end = Number.isFinite(e) && e > s ? new Date(e * 1000) : new Date(start.getTime());
  }
  const title = (tag(ev, 'title') || tag(ev, 'name') || '').trim() || 'Ohne Titel';
  const coord = coordOf(ev);
  let naddr = '';
  try {
    naddr = nip19.naddrEncode({ kind: ev.kind, pubkey: ev.pubkey, identifier: d, relays: ev._relays?.slice(0, 2) || [] });
  } catch { /* ignore */ }
  const geohash = ev.tags.filter((t) => t[0] === 'g').map((t) => t[1]).sort((a, b) => b.length - a.length)[0] || '';
  return {
    id: ev.id,
    kind: ev.kind,
    pubkey: ev.pubkey,
    d,
    coord,
    naddr,
    allDay,
    start,
    end,
    startTzid: tag(ev, 'start_tzid') || '',
    endTzid: tag(ev, 'end_tzid') || '',
    title,
    summary: tag(ev, 'summary') || '',
    content: ev.content || '',
    image: tag(ev, 'image') || '',
    locations: tagsAll(ev, 'location'),
    geohash,
    hashtags: [...new Set(tagsAll(ev, 't').map((t) => t.toLowerCase()))],
    links: [...new Set(tagsAll(ev, 'r'))],
    participants: ev.tags.filter((t) => t[0] === 'p').map((t) => ({ pubkey: t[1], role: t[3] || '' })),
    createdAt: ev.created_at,
    raw: ev,
  };
}

export function parseProfile(ev) {
  try {
    const p = JSON.parse(ev.content || '{}');
    return {
      pubkey: ev.pubkey,
      name: p.display_name || p.displayName || p.name || '',
      picture: typeof p.picture === 'string' ? p.picture : '',
      about: p.about || '',
      nip05: p.nip05 || '',
      website: p.website || '',
      createdAt: ev.created_at,
      raw: ev,
    };
  } catch {
    return null;
  }
}

/** Zentraler, reaktiver Speicher. Replaceable Events werden über ihre Koordinate dedupliziert. */
export class Store extends EventTarget {
  constructor() {
    super();
    this.events = new Map(); // coord -> parsed calendar event
    this.profiles = new Map(); // pubkey -> profile
    this.calendars = new Map(); // coord -> { title, pubkey, refs:Set }
    this.rsvps = new Map(); // event coord -> Map(pubkey -> {status, createdAt})
    this.deletedIds = new Set();
    this.deletedCoords = new Map(); // coord -> created_at der Löschung
    this.relaysByEvent = new Map(); // coord -> Set(relay)
    this._scheduled = false;
  }

  changed(kind = 'events') {
    this._pending = this._pending || new Set();
    this._pending.add(kind);
    if (this._scheduled) return;
    this._scheduled = true;
    requestAnimationFrame(() => {
      this._scheduled = false;
      const kinds = this._pending;
      this._pending = null;
      this.dispatchEvent(new CustomEvent('change', { detail: kinds }));
    });
  }

  addRaw(ev, relayUrl) {
    switch (ev.kind) {
      case KIND_DATE:
      case KIND_TIME: return this.addCalendarEvent(ev, relayUrl);
      case 0: return this.addProfile(ev);
      case 5: return this.addDeletion(ev);
      case KIND_CALENDAR: return this.addCalendar(ev);
      case KIND_RSVP: return this.addRsvp(ev);
      default: return false;
    }
  }

  isDeleted(ev) {
    if (this.deletedIds.has(ev.id)) return true;
    const delAt = this.deletedCoords.get(coordOf(ev));
    return delAt != null && delAt >= ev.created_at;
  }

  addCalendarEvent(ev, relayUrl) {
    const coord = coordOf(ev);
    if (relayUrl) {
      if (!this.relaysByEvent.has(coord)) this.relaysByEvent.set(coord, new Set());
      this.relaysByEvent.get(coord).add(relayUrl);
    }
    if (this.isDeleted(ev)) return false;
    const prev = this.events.get(coord);
    if (prev && prev.createdAt >= ev.created_at) return false;
    ev._relays = [...(this.relaysByEvent.get(coord) || [])];
    const parsed = parseCalendarEvent(ev);
    if (!parsed) return false;
    this.events.set(coord, parsed);
    this.changed('events');
    return true;
  }

  addProfile(ev) {
    const prev = this.profiles.get(ev.pubkey);
    if (prev && prev.createdAt >= ev.created_at) return false;
    const p = parseProfile(ev);
    if (!p) return false;
    this.profiles.set(ev.pubkey, p);
    this.changed('profiles');
    return true;
  }

  addDeletion(ev) {
    let touched = false;
    for (const t of ev.tags) {
      if (t[0] === 'e' && t[1]) {
        this.deletedIds.add(t[1]);
        for (const [coord, e] of this.events) {
          if (e.id === t[1] && e.pubkey === ev.pubkey) { this.events.delete(coord); touched = true; }
        }
      } else if (t[0] === 'a' && t[1]) {
        // Nur der Autor darf eigene Events löschen
        if (t[1].split(':')[1] !== ev.pubkey) continue;
        const prev = this.deletedCoords.get(t[1]) || 0;
        this.deletedCoords.set(t[1], Math.max(prev, ev.created_at));
        const e = this.events.get(t[1]);
        if (e && e.createdAt <= ev.created_at) { this.events.delete(t[1]); touched = true; }
      }
    }
    if (touched) this.changed('events');
    return touched;
  }

  addCalendar(ev) {
    const coord = coordOf(ev);
    const prev = this.calendars.get(coord);
    if (prev && prev.createdAt >= ev.created_at) return false;
    this.calendars.set(coord, {
      coord,
      pubkey: ev.pubkey,
      title: tag(ev, 'title') || tag(ev, 'name') || 'Kalender',
      refs: new Set(tagsAll(ev, 'a')),
      createdAt: ev.created_at,
    });
    this.changed('calendars');
    return true;
  }

  addRsvp(ev) {
    const a = tag(ev, 'a');
    const status = tag(ev, 'status') || tag(ev, 'l');
    if (!a || !['accepted', 'declined', 'tentative'].includes(status)) return false;
    if (!this.rsvps.has(a)) this.rsvps.set(a, new Map());
    const m = this.rsvps.get(a);
    const prev = m.get(ev.pubkey);
    if (prev && prev.createdAt >= ev.created_at) return false;
    m.set(ev.pubkey, { status, createdAt: ev.created_at });
    this.changed('rsvps');
    return true;
  }

  /** Alle Events, die den Zeitraum [from, to) berühren, sortiert nach Beginn. */
  between(from, to, predicate = () => true) {
    const out = [];
    for (const e of this.events.values()) {
      const endEff = e.end > e.start ? e.end : new Date(e.start.getTime() + 1);
      if (e.start < to && endEff > from && predicate(e)) out.push(e);
    }
    return out.sort((a, b) => a.start - b.start || a.title.localeCompare(b.title));
  }

  all(predicate = () => true) {
    return [...this.events.values()].filter(predicate).sort((a, b) => a.start - b.start);
  }

  displayName(pubkey) {
    const p = this.profiles.get(pubkey);
    if (p?.name) return p.name;
    try { return `${nip19.npubEncode(pubkey).slice(0, 12)}…`; } catch { return pubkey.slice(0, 8); }
  }
}
