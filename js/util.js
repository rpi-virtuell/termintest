// Kleine DOM-, Datums- und Formatierungshelfer.

/** Sicherer DOM-Builder: Strings werden immer als Text eingefügt, nie als HTML. */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('--')) el.style.setProperty(k, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const ICONS = {
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  pin: '<path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  download: '<path d="M12 4v11m0 0-4-4m4 4 4-4M5 20h14"/>',
  share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a1 1 0 0 1 1-1h10"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16v4z"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18"/>',
  check: '<path d="m5 12 5 5 9-10"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M21.5 20a6.5 6.5 0 0 0-4-6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
};
export function icon(name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = ICONS[name] || '';
  return svg;
}

// ---------- Datum ----------
export const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
export const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes());
export const addMonths = (d, n) => new Date(d.getFullYear(), d.getMonth() + n, 1);
export const startOfMonth = (d) => new Date(d.getFullYear(), d.getMonth(), 1);
export const startOfWeek = (d) => { const s = startOfDay(d); const wd = (s.getDay() + 6) % 7; return addDays(s, -wd); };
export const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
export const unix = (d) => Math.floor(d.getTime() / 1000);

const LOCALE = 'de-DE';
export const USER_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const fmt = (opts) => new Intl.DateTimeFormat(LOCALE, opts);
export const F = {
  time: fmt({ hour: '2-digit', minute: '2-digit' }),
  dayLong: fmt({ weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }),
  dayShort: fmt({ weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }),
  dayMonth: fmt({ day: 'numeric', month: 'short' }),
  monthYear: fmt({ month: 'long', year: 'numeric' }),
  month: fmt({ month: 'long' }),
  monthShort: fmt({ month: 'short' }),
  dow: fmt({ weekday: 'short' }),
  dowNarrow: fmt({ weekday: 'narrow' }),
};

/** Menschenlesbarer Zeitraum eines Termins in lokaler Zeit. */
export function formatRange(e) {
  if (e.allDay) {
    const last = addDays(e.end, -1);
    if (sameDay(e.start, last) || last < e.start) return `${F.dayLong.format(e.start)} · ganztägig`;
    return `${F.dayShort.format(e.start)} – ${F.dayShort.format(last)}`;
  }
  const t0 = F.time.format(e.start);
  if (e.end <= e.start) return `${F.dayLong.format(e.start)}, ${t0} Uhr`;
  const t1 = F.time.format(e.end);
  if (sameDay(e.start, e.end)) return `${F.dayLong.format(e.start)}, ${t0}–${t1} Uhr`;
  return `${F.dayShort.format(e.start)}, ${t0} – ${F.dayShort.format(e.end)}, ${t1} Uhr`;
}

/** Zeitangabe für einen Termin an einem bestimmten Tag (für Kalenderzellen). */
export function timeLabelFor(e, day) {
  if (e.allDay) return 'ganztägig';
  const dayEnd = addDays(startOfDay(day), 1);
  const startsToday = e.start >= startOfDay(day);
  const endsToday = e.end <= dayEnd;
  if (startsToday && (endsToday || e.end <= e.start)) {
    return e.end > e.start ? `${F.time.format(e.start)}–${F.time.format(e.end)}` : F.time.format(e.start);
  }
  if (startsToday) return `ab ${F.time.format(e.start)}`;
  if (endsToday) return `bis ${F.time.format(e.end)}`;
  return 'ganztägig';
}

/** Zeigt den Zeitraum in der Original-Zeitzone, falls sie von der des Nutzers abweicht. */
export function originalTzLabel(e) {
  if (e.allDay || !e.startTzid || e.startTzid === USER_TZ) return '';
  try {
    const f = new Intl.DateTimeFormat(LOCALE, { timeZone: e.startTzid, hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' });
    return `Ortszeit (${e.startTzid}): ${f.format(e.start)}`;
  } catch { return ''; }
}

// ---------- Text ----------
export const normalize = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Farbe aus einem Pubkey – stabil pro Veranstalter:in. */
export function colorFor(pubkey = '') {
  const hue = parseInt(pubkey.slice(0, 6) || '0', 16) % 360;
  return `hsl(${hue} 62% 42%)`;
}

export function initials(name = '') {
  const parts = name.replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] || '?') + (parts[1]?.[0] || '')).toUpperCase();
}

const URL_RE = /(https?:\/\/[^\s<>"')\]]+[^\s<>"')\].,;:!?])/g;

/** Text mit klickbaren Links (als DOM-Knoten, XSS-sicher). */
export function linkify(text) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    if (m.index > last) out.push(...boldify(text.slice(last, m.index)));
    out.push(h('a', { href: m[0], target: '_blank', rel: 'noopener noreferrer nofollow' }, m[0].replace(/^https?:\/\//, '').slice(0, 60)));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(...boldify(text.slice(last)));
  return out;
}

function boldify(text) {
  const parts = text.split(/\*\*(.+?)\*\*/g);
  return parts.map((p, i) => (i % 2 ? h('strong', {}, p) : p));
}

/** HTML oder Markdown-ähnlichen Text in lesbare Absätze umwandeln – ohne je fremdes HTML einzufügen. */
export function renderRichText(raw) {
  let text = String(raw || '');
  if (/<\/?[a-z][^>]*>/i.test(text)) {
    const withBreaks = text.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h\d)>/gi, '\n\n').replace(/<li[^>]*>/gi, '• ');
    const doc = new DOMParser().parseFromString(withBreaks, 'text/html');
    text = doc.body.textContent || '';
  }
  text = text.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
  const frag = document.createDocumentFragment();
  for (const para of text.split(/\n\s*\n/)) {
    const lines = para.split('\n').map((l) => l.replace(/^#{1,6}\s+/, ''));
    const p = h('p');
    lines.forEach((line, i) => {
      if (i) p.append(h('br'));
      linkify(line).forEach((n) => p.append(n));
    });
    frag.append(p);
  }
  return frag;
}

/** Geohash → { lat, lon } (Zellmittelpunkt). */
export function decodeGeohash(gh) {
  const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';
  let even = true;
  const lat = [-90, 90];
  const lon = [-180, 180];
  for (const ch of (gh || '').toLowerCase()) {
    const cd = BASE32.indexOf(ch);
    if (cd < 0) return null;
    for (let mask = 16; mask; mask >>= 1) {
      const r = even ? lon : lat;
      const mid = (r[0] + r[1]) / 2;
      if (cd & mask) r[0] = mid; else r[1] = mid;
      even = !even;
    }
  }
  return { lat: (lat[0] + lat[1]) / 2, lon: (lon[0] + lon[1]) / 2 };
}

export function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export const storage = {
  get(key, fallback = null) {
    try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
  },
  remove(key) { try { localStorage.removeItem(key); } catch { /* ignore */ } },
};

export function toast(message, type = 'info', ms = 3500) {
  const box = document.getElementById('toasts');
  if (!box) return;
  const el = h('div', { class: `toast ${type}` }, message);
  box.append(el);
  setTimeout(() => el.remove(), ms);
}
