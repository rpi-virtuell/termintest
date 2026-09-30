// Edufeed Termine – nostr-only Kalender-App.
// Lädt NIP-52-Termine direkt von den Edufeed-Relays, verifiziert Signaturen im Browser
// und veröffentlicht Termine, Zusagen (RSVP) und Löschungen per NIP-07-Signatur.

import { nip19, verifyEvent } from '../vendor/nostr-tools.js';
import { RelayPool, normalizeRelayUrl } from './pool.js';
import {
  Store, CALENDAR_KINDS, KIND_DATE, KIND_TIME, KIND_CALENDAR, KIND_RSVP, toISODate, parseLocalDate,
} from './model.js';
import {
  h, icon, F, startOfDay, addDays, addMonths, startOfMonth, startOfWeek, sameDay, unix,
  formatRange, timeLabelFor, originalTzLabel, normalize, colorFor, initials, renderRichText,
  decodeGeohash, debounce, storage, toast, USER_TZ,
} from './util.js';
import { downloadICS } from './ics.js';
import {
  DEFAULT_RELAYS, DEFAULT_PROFILE_RELAYS, VIEWER_BASE, NJUMP_BASE, PAST_DAYS,
} from './config.js';

const $ = (id) => document.getElementById(id);
const CACHE_KEY = 'tt-cache-v1';
const RELAYS_KEY = 'tt-relays';
const USER_KEY = 'tt-user';
const PAGE_SIZE = 60;

// ---------------------------------------------------------------------------
// Zustand
// ---------------------------------------------------------------------------
const urlRelays = new URLSearchParams(location.search).get('relays');
const relays = urlRelays
  ? urlRelays.split(',').map(normalizeRelayUrl).filter(Boolean)
  : (storage.get(RELAYS_KEY) || DEFAULT_RELAYS);

const pool = new RelayPool(relays);
const profilePool = new RelayPool(DEFAULT_PROFILE_RELAYS.filter((u) => !relays.includes(u)));
const store = new Store();

const state = {
  view: window.matchMedia('(max-width: 900px)').matches ? 'list' : 'month',
  cursor: startOfDay(new Date()),
  miniCursor: startOfMonth(new Date()),
  q: '',
  tags: new Set(),
  authors: new Set(),
  calendar: '',
  past: false,
  event: '', // naddr des geöffneten Termins
  listLimit: PAGE_SIZE,
  showAllTags: false,
  loading: 0,
  user: storage.get(USER_KEY) || null, // { pubkey }
};

// ---------------------------------------------------------------------------
// URL-Hash <-> Zustand (teilbare Links, Zurück-Button)
// ---------------------------------------------------------------------------
function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  if (['month', 'week', 'list'].includes(p.get('v'))) state.view = p.get('v');
  const d = parseLocalDate(p.get('d'));
  if (d) { state.cursor = d; state.miniCursor = startOfMonth(d); }
  state.q = p.get('q') || '';
  state.tags = new Set((p.get('t') || '').split(',').filter(Boolean));
  state.authors = new Set((p.get('a') || '').split(',').filter((x) => /^[0-9a-f]{64}$/.test(x)));
  state.calendar = p.get('c') || '';
  state.past = p.get('past') === '1';
  state.event = p.get('e') || '';
}

function writeHash() {
  const p = new URLSearchParams();
  p.set('v', state.view);
  if (!sameDay(state.cursor, new Date())) p.set('d', toISODate(state.cursor));
  if (state.q) p.set('q', state.q);
  if (state.tags.size) p.set('t', [...state.tags].join(','));
  if (state.authors.size) p.set('a', [...state.authors].join(','));
  if (state.calendar) p.set('c', state.calendar);
  if (state.past) p.set('past', '1');
  if (state.event) p.set('e', state.event);
  const next = `#${p.toString()}`;
  if (next !== location.hash) history.replaceState(null, '', next);
}

// ---------------------------------------------------------------------------
// Laden von den Relays
// ---------------------------------------------------------------------------
function busy(delta) {
  state.loading = Math.max(0, state.loading + delta);
  $('loading-bar').hidden = state.loading === 0;
}

let closeMainSub = null;
const loadedWindows = new Set();

function startMainSubscription() {
  closeMainSub?.();
  loadedWindows.clear();
  busy(+1);
  const since = String(unix(new Date()) - PAST_DAYS * 86400);
  let done = false;
  closeMainSub = pool.subscribe(
    [
      // Standard-NIP-01-Abfrage: die neuesten Termine (funktioniert auf jedem Relay)
      { kinds: CALENDAR_KINDS, limit: 1000 },
      // Zeitbereichs-Abfrage der Edufeed/AMB-Relays (start_after-Index): kommende Termine
      { kinds: CALENDAR_KINDS, '#start_after': [since], limit: 1000 },
      { kinds: [KIND_CALENDAR], limit: 200 },
    ],
    {
      onevent: (ev, url) => store.addRaw(ev, url),
      oneose: () => { if (!done) { done = true; busy(-1); initialLoaded = true; render(); } },
      eoseTimeout: 12000,
    },
  );
  ensureWindowForView();
}

let initialLoaded = false;

/** Lädt gezielt den sichtbaren Zeitraum nach (Monat/Woche), z. B. beim Blättern in die Zukunft. */
function ensureWindow(from, to) {
  const key = `${unix(from)}-${unix(to)}`;
  if (loadedWindows.has(key)) return;
  loadedWindows.add(key);
  busy(+1);
  pool.query(
    [{ kinds: CALENDAR_KINDS, '#start_after': [String(unix(from) - 86400 * 7)], '#start_before': [String(unix(to))], limit: 500 }],
    { onevent: (ev, url) => store.addRaw(ev, url), eoseTimeout: 8000 },
  ).finally(() => busy(-1));
}

function ensureWindowForView() {
  const { from, to } = viewRange();
  if (from && to) ensureWindow(from, to);
}

// Profile (kind 0) und Löschungen (kind 5) für neu entdeckte Veranstalter nachladen
const knownAuthors = new Set();
const fetchAuthorsMeta = debounce(() => {
  const fresh = [...new Set([...store.events.values()].map((e) => e.pubkey))].filter((pk) => !knownAuthors.has(pk));
  if (state.user?.pubkey && !knownAuthors.has(state.user.pubkey)) fresh.push(state.user.pubkey);
  if (!fresh.length) return;
  fresh.forEach((pk) => knownAuthors.add(pk));
  for (let i = 0; i < fresh.length; i += 100) {
    const authors = fresh.slice(i, i + 100);
    const onevent = (ev, url) => store.addRaw(ev, url);
    pool.query([{ kinds: [0], authors }, { kinds: [5], authors, limit: 500 }], { onevent, eoseTimeout: 8000 });
    profilePool.query([{ kinds: [0], authors }], { onevent, eoseTimeout: 8000 });
  }
}, 500);

// NIP-50-Volltextsuche auf Relays, die sie unterstützen (Ergebnisse ergänzen die lokale Suche)
const remoteSearch = debounce((q) => {
  if (q.trim().length < 3) return;
  busy(+1);
  pool.query([{ kinds: CALENDAR_KINDS, search: q.trim(), limit: 200 }], {
    onevent: (ev, url) => store.addRaw(ev, url),
    eoseTimeout: 6000,
  }).finally(() => busy(-1));
}, 450);

// ---------------------------------------------------------------------------
// Lokaler Cache für sofortiges Rendern beim nächsten Besuch
// ---------------------------------------------------------------------------
function loadCache() {
  const cache = storage.get(CACHE_KEY);
  if (!cache?.events) return;
  const skip = pool.seenValid;
  for (const ev of [...(cache.profiles || []), ...cache.events]) {
    if (!ev?.id || !ev.sig) continue;
    skip.add(ev.id);
    store.addRaw(ev);
  }
}

const saveCache = debounce(() => {
  const cutoff = Date.now() - PAST_DAYS * 86400000;
  const events = [...store.events.values()]
    .filter((e) => e.end.getTime() >= cutoff)
    .sort((a, b) => a.start - b.start)
    .slice(0, 1500)
    .map((e) => { const { _relays, ...raw } = e.raw; return raw; });
  const profiles = [...store.profiles.values()].map((p) => p.raw).filter(Boolean);
  if (!storage.set(CACHE_KEY, { events, profiles, savedAt: Date.now() })) {
    storage.set(CACHE_KEY, { events: events.slice(0, 400), profiles: profiles.slice(0, 200), savedAt: Date.now() });
  }
}, 2000);

// ---------------------------------------------------------------------------
// Filtern
// ---------------------------------------------------------------------------
function haystack(e) {
  if (!e._hay) {
    e._hay = normalize([e.title, e.summary, e.content, e.locations.join(' '), e.hashtags.join(' ')].join(' '));
  }
  return e._hay;
}

function makePredicate({ ignoreTags = false, ignoreAuthors = false, ignoreTime = true } = {}) {
  const tokens = normalize(state.q).split(/\s+/).filter(Boolean);
  const cal = state.calendar ? store.calendars.get(state.calendar) : null;
  const now = startOfDay(new Date());
  return (e) => {
    if (!ignoreTags) for (const t of state.tags) if (!e.hashtags.includes(t)) return false;
    if (!ignoreAuthors && state.authors.size && !state.authors.has(e.pubkey)) return false;
    if (cal && !cal.refs.has(e.coord)) return false;
    if (!ignoreTime && !state.past && e.end < now) return false;
    if (tokens.length) {
      const hay = haystack(e);
      const author = normalize(store.profiles.get(e.pubkey)?.name);
      for (const tok of tokens) if (!hay.includes(tok) && !author.includes(tok)) return false;
    }
    return true;
  };
}

function viewRange() {
  if (state.view === 'month') {
    const first = startOfMonth(state.cursor);
    const from = startOfWeek(first);
    const weeks = Math.ceil(((first.getDay() + 6) % 7 + new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate()) / 7);
    return { from, to: addDays(from, weeks * 7), weeks };
  }
  if (state.view === 'week') {
    const from = startOfWeek(state.cursor);
    return { from, to: addDays(from, 7) };
  }
  return { from: state.past ? null : state.cursor, to: null };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function avatar(pubkey, cls = '') {
  const p = store.profiles.get(pubkey);
  const name = store.displayName(pubkey);
  if (p?.picture && /^https:\/\//.test(p.picture)) {
    const img = h('img', { class: `avatar ${cls}`, src: p.picture, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
    img.addEventListener('error', () => img.replaceWith(h('span', { class: `avatar ${cls}`, '--c': colorFor(pubkey), 'aria-hidden': 'true' }, initials(name))), { once: true });
    return img;
  }
  return h('span', { class: `avatar ${cls}`, '--c': colorFor(pubkey), 'aria-hidden': 'true' }, initials(name));
}

function render() {
  writeHash();
  renderToolbar();
  renderActiveFilters();
  renderMiniCal();
  renderFacets();
  const view = $('view');
  view.replaceChildren();
  if (!initialLoaded && store.events.size === 0) {
    view.append(h('div', { class: 'agenda' }, [1, 2, 3, 4].map(() => h('div', { class: 'skeleton' }))));
    return;
  }
  if (state.view === 'month') view.append(renderMonth());
  else if (state.view === 'week') view.append(renderWeek());
  else view.append(renderList());
}

function renderToolbar() {
  for (const v of ['month', 'week', 'list']) $(`tab-${v}`).setAttribute('aria-selected', String(state.view === v));
  let label;
  if (state.view === 'month') label = F.monthYear.format(state.cursor);
  else if (state.view === 'week') {
    const s = startOfWeek(state.cursor);
    const e = addDays(s, 6);
    label = s.getMonth() === e.getMonth()
      ? `${s.getDate()}.–${e.getDate()}. ${F.monthYear.format(e)}`
      : `${F.dayMonth.format(s)} – ${F.dayMonth.format(e)} ${e.getFullYear()}`;
  } else label = state.past ? 'Alle Termine' : (sameDay(state.cursor, new Date()) ? 'Kommende Termine' : `Ab ${F.dayMonth.format(state.cursor)} ${state.cursor.getFullYear()}`);
  $('range-label').textContent = label;
  document.title = `${label} · Edufeed Termine`;
  $('btn-prev').hidden = state.view === 'list' && state.past;
  $('btn-next').hidden = state.view === 'list' && state.past;
}

function renderActiveFilters() {
  const box = $('active-filters');
  box.replaceChildren();
  const chip = (label, onclick) => h('button', { class: 'chip removable', 'aria-pressed': 'true', onclick, title: 'Filter entfernen' }, label);
  if (state.q) box.append(chip(`„${state.q}“`, () => { state.q = ''; $('search').value = ''; render(); }));
  for (const t of state.tags) box.append(chip(`#${t}`, () => { state.tags.delete(t); render(); }));
  for (const a of state.authors) box.append(chip(store.displayName(a), () => { state.authors.delete(a); render(); }));
  if (state.calendar) {
    const c = store.calendars.get(state.calendar);
    box.append(chip(`Kalender: ${c?.title || '…'}`, () => { state.calendar = ''; render(); }));
  }
  const any = state.q || state.tags.size || state.authors.size || state.calendar;
  $('btn-reset-filters').classList.toggle('hidden', !any);
}

function renderMiniCal() {
  const box = $('mini-cal');
  const m = state.miniCursor;
  const from = startOfWeek(m);
  const to = addDays(from, 42);
  const pred = makePredicate();
  const days = new Set();
  for (const e of store.between(from, to, pred)) {
    let d = startOfDay(e.start < from ? from : e.start);
    const end = e.end > e.start ? e.end : addDays(e.start, 0);
    while (d < to && (d < end || sameDay(d, e.start))) { days.add(toISODate(d)); d = addDays(d, 1); }
  }
  const today = new Date();
  const grid = h('div', { class: 'mini-grid', role: 'grid' });
  for (let i = 0; i < 7; i++) grid.append(h('div', { class: 'dow' }, F.dowNarrow.format(addDays(from, i))));
  for (let i = 0; i < 42; i++) {
    const d = addDays(from, i);
    const cls = [
      d.getMonth() !== m.getMonth() && 'out',
      sameDay(d, today) && 'today',
      sameDay(d, state.cursor) && 'selected',
      days.has(toISODate(d)) && 'has',
    ].filter(Boolean).join(' ');
    grid.append(h('button', {
      class: cls,
      'aria-label': F.dayLong.format(d),
      onclick: () => { state.cursor = d; state.miniCursor = startOfMonth(d); state.listLimit = PAGE_SIZE; closeSidebar(); onNavigate(); },
    }, d.getDate()));
  }
  box.replaceChildren(
    h('div', { class: 'mini-head' },
      h('button', { class: 'icon-btn', 'aria-label': 'Vorheriger Monat', onclick: () => { state.miniCursor = addMonths(state.miniCursor, -1); renderMiniCal(); } }, iconChevron('l')),
      h('b', {}, F.monthYear.format(m)),
      h('button', { class: 'icon-btn', 'aria-label': 'Nächster Monat', onclick: () => { state.miniCursor = addMonths(state.miniCursor, 1); renderMiniCal(); } }, iconChevron('r'))),
    grid,
  );
}

function iconChevron(dir) {
  const svg = icon('x');
  svg.innerHTML = dir === 'l' ? '<path d="m15 6-6 6 6 6"/>' : '<path d="m9 6 6 6-6 6"/>';
  return svg;
}

function renderFacets() {
  // Schlagworte: gezählt über die (sonst gefilterten) kommenden Termine
  const tagCounts = new Map();
  const tagPred = makePredicate({ ignoreTags: true, ignoreTime: false });
  const upcoming = store.all(tagPred);
  for (const e of upcoming) {
    if (![...state.tags].every((t) => e.hashtags.includes(t))) continue;
    for (const t of e.hashtags) tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
  }
  const topTags = [...tagCounts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 40);
  for (const t of state.tags) if (!topTags.find(([x]) => x === t)) topTags.unshift([t, 0]);
  const tagBox = $('tag-list');
  const hiddenTags = state.showAllTags ? 0 : Math.max(0, topTags.length - 14);
  const visibleTags = hiddenTags ? topTags.slice(0, 14) : topTags;
  tagBox.replaceChildren(...(visibleTags.length ? visibleTags.map(([t, n]) => h('button', {
    class: 'chip',
    'aria-pressed': String(state.tags.has(t)),
    onclick: () => { toggleSet(state.tags, t); state.listLimit = PAGE_SIZE; render(); },
  }, `#${t}`, n ? h('span', { class: 'count' }, n) : null)) : [h('span', { class: 'muted small' }, initialLoaded ? 'Keine Schlagworte' : 'wird geladen …')]));
  if (hiddenTags || state.showAllTags) {
    tagBox.append(h('button', { class: 'link-btn', onclick: () => { state.showAllTags = !state.showAllTags; renderFacets(); } },
      state.showAllTags ? 'weniger' : `+${hiddenTags} weitere`));
  }

  // Veranstalter
  const authorCounts = new Map();
  for (const e of store.all(makePredicate({ ignoreAuthors: true, ignoreTime: false }))) {
    authorCounts.set(e.pubkey, (authorCounts.get(e.pubkey) || 0) + 1);
  }
  for (const a of state.authors) if (!authorCounts.has(a)) authorCounts.set(a, 0);
  const authors = [...authorCounts].sort((a, b) => b[1] - a[1]).slice(0, 30);
  $('author-list').replaceChildren(...(authors.length ? authors.map(([pk, n]) => h('button', {
    class: 'author-item',
    'aria-pressed': String(state.authors.has(pk)),
    onclick: () => { toggleSet(state.authors, pk); state.listLimit = PAGE_SIZE; render(); },
  }, avatar(pk), h('span', { class: 'name' }, store.displayName(pk)), h('span', { class: 'count' }, n))) : [h('span', { class: 'muted small' }, initialLoaded ? 'Keine Veranstalter' : 'wird geladen …')]));

  // Kalender (kind 31924)
  const cals = [...store.calendars.values()].filter((c) => c.refs.size);
  $('panel-calendars').hidden = !cals.length;
  $('calendar-list').replaceChildren(...cals.map((c) => h('button', {
    class: 'author-item',
    'aria-pressed': String(state.calendar === c.coord),
    onclick: () => { state.calendar = state.calendar === c.coord ? '' : c.coord; render(); },
  }, h('span', { class: 'avatar', '--c': colorFor(c.pubkey) }, initials(c.title)), h('span', { class: 'name' }, c.title), h('span', { class: 'count' }, c.refs.size))));

  $('toggle-past').checked = state.past;
}

function toggleSet(set, v) { if (set.has(v)) set.delete(v); else set.add(v); }

function bucketByDay(events, from, to) {
  const map = new Map();
  for (const e of events) {
    let d = startOfDay(e.start < from ? from : e.start);
    const end = e.end > e.start ? e.end : new Date(e.start.getTime() + 1);
    while (d < to && d < end) {
      const k = toISODate(d);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(e);
      d = addDays(d, 1);
    }
  }
  for (const list of map.values()) {
    list.sort((a, b) => (b.allDay - a.allDay) || ((b.end - b.start > 864e5) - (a.end - a.start > 864e5)) || a.start - b.start);
  }
  return map;
}

function renderMonth() {
  const { from, to } = viewRange();
  const events = store.between(from, to, makePredicate());
  const byDay = bucketByDay(events, from, to);
  const month = state.cursor.getMonth();
  const today = new Date();
  const maxPills = window.matchMedia('(max-width: 900px)').matches ? 2 : 3;

  const dow = h('div', { class: 'month-dow' });
  for (let i = 0; i < 7; i++) dow.append(h('div', {}, F.dow.format(addDays(from, i)).replace('.', '')));
  const grid = h('div', { class: 'month-grid' });
  for (let d = from; d < to; d = addDays(d, 1)) {
    const list = byDay.get(toISODate(d)) || [];
    const wd = (d.getDay() + 6) % 7;
    const day = d;
    const cell = h('div', {
      class: ['day', d.getMonth() !== month && 'out', sameDay(d, today) && 'today', wd >= 5 && 'weekend'].filter(Boolean).join(' '),
    }, h('button', {
      class: 'day-num',
      'aria-label': `${F.dayLong.format(d)}: ${list.length} Termine`,
      onclick: () => { state.cursor = day; state.view = 'week'; onNavigate(); },
    }, d.getDate()));
    list.slice(0, maxPills).forEach((e) => {
      const multi = e.allDay || (e.end - e.start > 864e5);
      cell.append(h('button', {
        class: `pill${multi ? ' allday' : ''}`,
        '--c': colorFor(e.pubkey),
        title: `${e.title}\n${formatRange(e)}`,
        onclick: () => openEvent(e),
      }, multi ? null : h('span', { class: 't' }, F.time.format(e.start)), h('span', { class: 'n' }, e.title)));
    });
    if (list.length > maxPills) {
      cell.append(h('button', { class: 'more', onclick: () => { state.cursor = day; state.view = 'week'; onNavigate(); } }, `+${list.length - maxPills}`, h('span', { class: 'hide-mobile' }, ' weitere')));
    }
    grid.append(cell);
  }
  const wrap = h('div', { class: 'month' }, dow, grid);
  if (!events.length && initialLoaded) {
    return h('div', {}, wrap, h('p', { class: 'muted small', style: { marginTop: '10px' } }, 'In diesem Monat wurden keine passenden Termine gefunden.'));
  }
  return wrap;
}

function renderWeek() {
  const { from, to } = viewRange();
  const events = store.between(from, to, makePredicate());
  const byDay = bucketByDay(events, from, to);
  const today = new Date();
  const wrap = h('div', { class: 'week' });
  for (let d = from; d < to; d = addDays(d, 1)) {
    const list = byDay.get(toISODate(d)) || [];
    const day = d;
    wrap.append(h('section', { class: `week-col${sameDay(d, today) ? ' today' : ''}`, 'aria-label': F.dayLong.format(d) },
      h('div', { class: 'week-head' }, h('span', { class: 'dow' }, F.dow.format(d).replace('.', '')), h('span', { class: 'num' }, d.getDate()), h('span', { class: 'muted small' }, F.monthShort.format(d))),
      h('div', { class: 'week-body' }, list.length ? list.map((e) => h('button', {
        class: 'week-card', '--c': colorFor(e.pubkey), onclick: () => openEvent(e),
      }, h('div', { class: 'time' }, timeLabelFor(e, day)), h('div', { class: 'title' }, e.title))) : h('div', { class: 'week-empty' }, '–'))));
  }
  return wrap;
}

function renderList() {
  const now = startOfDay(new Date());
  const from = state.past ? null : state.cursor;
  const pred = makePredicate();
  let events = store.all((e) => pred(e) && (!from || e.end > from || (e.end <= e.start && e.start >= from)));
  if (state.past) events = events.reverse(); // Neueste zuerst, wenn alles gezeigt wird
  const total = events.length;
  events = events.slice(0, state.listLimit);

  if (!total) {
    return h('div', { class: 'empty' }, icon('calendar'),
      h('b', {}, initialLoaded ? 'Keine Termine gefunden' : 'Termine werden geladen …'),
      h('span', {}, state.q || state.tags.size || state.authors.size ? 'Passe Suche oder Filter an.' : 'Die Relays haben für diesen Zeitraum keine Termine geliefert.'));
  }

  const agenda = h('div', { class: 'agenda' });
  let lastMonth = '';
  let lastDay = '';
  let dayEvents = null;
  for (const e of events) {
    // Mehrtägige, bereits laufende Termine unter dem Startdatum der Liste einsortieren
    const anchor = from && e.start < from ? from : startOfDay(e.start);
    const mKey = `${anchor.getFullYear()}-${anchor.getMonth()}`;
    if (mKey !== lastMonth) {
      agenda.append(h('h2', { class: 'agenda-month' }, F.monthYear.format(anchor)));
      lastMonth = mKey;
    }
    const dKey = toISODate(anchor);
    if (dKey !== lastDay) {
      dayEvents = h('div', { class: 'agenda-events' });
      agenda.append(h('section', { class: 'agenda-day', 'aria-label': F.dayLong.format(anchor) },
        h('div', { class: `date-badge${sameDay(anchor, now) ? ' today' : ''}` },
          h('span', { class: 'dow' }, F.dow.format(anchor).replace('.', '')),
          h('span', { class: 'num' }, anchor.getDate()),
          h('span', { class: 'mon' }, F.monthShort.format(anchor))),
        dayEvents));
      lastDay = dKey;
    }
    dayEvents.append(renderCard(e, anchor));
  }
  if (total > events.length) {
    agenda.append(h('button', { class: 'btn load-more', onclick: () => { state.listLimit += PAGE_SIZE; render(); } }, `Weitere Termine laden (${total - events.length})`));
  }
  return agenda;
}

function renderCard(e, day) {
  const hasImg = e.image && /^https:\/\//.test(e.image);
  return h('article', {
    class: 'card', '--c': colorFor(e.pubkey), tabindex: '0', role: 'button', 'aria-label': e.title,
    onclick: () => openEvent(e),
    onkeydown: (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openEvent(e); } },
  },
  h('div', {},
    h('div', { class: 'card-meta' },
      h('span', {}, icon('clock'), e.allDay || e.end - e.start > 864e5 ? formatRange(e) : timeLabelFor(e, day) + (e.allDay ? '' : ' Uhr')),
      e.locations[0] ? h('span', {}, icon('pin'), e.locations[0]) : null),
    h('h3', {}, e.title),
    e.summary || e.content ? h('p', {}, (e.summary || e.content).replace(/<[^>]+>/g, ' ').replace(/\*\*|__|^#+\s*/gm, '').slice(0, 280)) : null,
    h('div', { class: 'card-foot' },
      h('span', { class: 'by' }, avatar(e.pubkey), store.displayName(e.pubkey)),
      e.hashtags.slice(0, 4).map((t) => h('span', { class: 'tag' }, `#${t}`)))),
  hasImg ? h('img', { class: 'card-img', src: e.image, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer', onerror: (ev) => ev.target.remove() }) : null);
}

// ---------------------------------------------------------------------------
// Detailansicht
// ---------------------------------------------------------------------------
let closeRsvpSub = null;

function openEvent(e) {
  state.event = e.naddr;
  writeHash();
  renderDetail(e);
  const dlg = $('dlg-event');
  if (!dlg.open) dlg.showModal();
  dlg.scrollTop = 0;
  // Zusagen live abonnieren
  closeRsvpSub?.();
  closeRsvpSub = pool.subscribe([{ kinds: [KIND_RSVP], '#a': [e.coord], limit: 500 }], {
    onevent: (ev, url) => store.addRaw(ev, url),
  });
}

async function openByNaddr(naddr) {
  let ptr;
  try {
    const dec = nip19.decode(naddr);
    if (dec.type !== 'naddr') throw new Error('kein naddr');
    ptr = dec.data;
  } catch {
    toast('Ungültiger Termin-Link', 'error');
    state.event = '';
    writeHash();
    return;
  }
  const coord = `${ptr.kind}:${ptr.pubkey}:${ptr.identifier}`;
  const found = store.events.get(coord);
  if (found) { openEvent(found); return; }
  const dlg = $('dlg-event');
  $('event-detail').replaceChildren(h('div', { class: 'ev-body' }, h('div', { class: 'skeleton' }), h('p', { class: 'muted' }, 'Termin wird von den Relays geladen …')));
  if (!dlg.open) dlg.showModal();
  await pool.query([{ kinds: [ptr.kind], authors: [ptr.pubkey], '#d': [ptr.identifier] }], {
    onevent: (ev, url) => store.addRaw(ev, url),
    eoseTimeout: 8000,
  });
  const e = store.events.get(coord);
  if (e) openEvent(e);
  else $('event-detail').replaceChildren(h('div', { class: 'ev-body' },
    h('button', { class: 'icon-btn ev-close', 'aria-label': 'Schließen', onclick: () => dlg.close() }, icon('close')),
    h('h2', { class: 'ev-title' }, 'Termin nicht gefunden'),
    h('p', { class: 'muted' }, 'Auf den verbundenen Relays wurde dieser Termin nicht gefunden. Er wurde möglicherweise gelöscht.')));
}

function renderDetail(e) {
  const box = $('event-detail');
  const dlg = $('dlg-event');
  const isOwn = state.user?.pubkey === e.pubkey;
  const hasImg = e.image && /^https:\/\//.test(e.image);
  const profile = store.profiles.get(e.pubkey);
  const npub = nip19.npubEncode(e.pubkey);
  const tzLabel = originalTzLabel(e);
  const geo = decodeGeohash(e.geohash);
  const mapHref = geo
    ? `https://www.openstreetmap.org/?mlat=${geo.lat.toFixed(5)}&mlon=${geo.lon.toFixed(5)}#map=15/${geo.lat.toFixed(5)}/${geo.lon.toFixed(5)}`
    : e.locations[0] && !/^online$/i.test(e.locations[0]) ? `https://www.openstreetmap.org/search?query=${encodeURIComponent(e.locations[0])}` : '';
  const shareUrl = `${location.origin}${location.pathname}#e=${e.naddr}`;

  const fact = (ic, main, sub) => h('div', { class: 'ev-fact' }, icon(ic), h('div', {}, main, sub ? h('div', { class: 'sub' }, sub) : null));

  const actions = h('div', { class: 'ev-actions' },
    h('button', { class: 'btn', onclick: () => downloadICS([e], `${slug(e.title)}.ics`, { viewerBase: VIEWER_BASE }) }, icon('download'), 'In Kalender (.ics)'),
    h('button', { class: 'btn', onclick: () => share(e.title, shareUrl) }, icon('share'), 'Teilen'),
    e.naddr ? h('a', { class: 'btn', href: VIEWER_BASE + e.naddr, target: '_blank', rel: 'noopener' }, icon('external'), 'Edufeed') : null,
    isOwn ? h('button', { class: 'btn', onclick: () => openEditor(e) }, icon('edit'), 'Bearbeiten') : null,
  );

  box.replaceChildren(
    h('div', { class: `ev-hero${hasImg ? '' : ' noimg'}`, '--c': colorFor(e.pubkey), style: hasImg ? { backgroundImage: `url("${encodeURI(e.image)}")` } : null }),
    h('button', { class: 'icon-btn ev-close', 'aria-label': 'Schließen', onclick: () => dlg.close() }, icon('close')),
    h('div', { class: 'ev-body' },
      h('h2', { class: 'ev-title', id: 'ev-title' }, e.title),
      h('div', { class: 'ev-facts' },
        fact('clock', formatRange(e), tzLabel),
        ...e.locations.map((loc, i) => fact('pin', i === 0 && mapHref ? h('a', { href: mapHref, target: '_blank', rel: 'noopener' }, loc) : loc)),
        !e.locations.length && mapHref ? fact('pin', h('a', { href: mapHref, target: '_blank', rel: 'noopener' }, 'Auf der Karte anzeigen')) : null,
        ...e.links.slice(0, 3).map((l) => fact('link', h('a', { href: safeUrl(l), target: '_blank', rel: 'noopener nofollow' }, l.replace(/^https?:\/\//, '').slice(0, 70))))),
      e.summary && e.summary !== e.content ? h('p', { class: 'ev-summary' }, e.summary) : null,
      e.content ? h('div', { class: 'ev-desc' }, renderRichText(e.content)) : null,
      e.hashtags.length ? h('div', { class: 'chips' }, e.hashtags.map((t) => h('button', {
        class: 'chip', onclick: () => { state.tags = new Set([t]); state.view = 'list'; state.listLimit = PAGE_SIZE; dlg.close(); render(); },
      }, `#${t}`))) : null,
      actions,
      renderRsvp(e),
      h('div', { class: 'ev-author' },
        avatar(e.pubkey, 'lg'),
        h('div', { class: 'who' },
          h('b', {}, store.displayName(e.pubkey)),
          h('span', {}, profile?.nip05 || `${npub.slice(0, 20)}…`)),
        h('button', { class: 'btn', onclick: () => { state.authors = new Set([e.pubkey]); state.view = 'list'; state.listLimit = PAGE_SIZE; dlg.close(); render(); } }, 'Alle Termine'),
        h('a', { class: 'icon-btn', href: NJUMP_BASE + npub, target: '_blank', rel: 'noopener', 'aria-label': 'Nostr-Profil öffnen', title: 'Nostr-Profil öffnen' }, icon('external'))),
      h('details', { class: 'ev-tech' },
        h('summary', {}, 'Nostr-Details'),
        h('code', {}, `nostr:${e.naddr}`),
        h('code', {}, `kind ${e.kind} · event ${e.id}`),
        h('code', {}, `signiert ${new Date(e.createdAt * 1000).toLocaleString('de-DE')} · Relays: ${[...(store.relaysByEvent.get(e.coord) || [])].join(', ') || 'Cache'}`),
        h('button', { class: 'link-btn', onclick: () => copy(`nostr:${e.naddr}`) }, 'naddr kopieren'))),
  );
}

function renderRsvp(e) {
  const m = store.rsvps.get(e.coord) || new Map();
  const by = { accepted: [], tentative: [], declined: [] };
  for (const [pk, r] of m) by[r.status]?.push(pk);
  const mine = state.user ? m.get(state.user.pubkey)?.status : null;
  const btn = (status, label) => h('button', {
    class: 'btn', 'aria-pressed': String(mine === status), onclick: () => sendRsvp(e, status),
  }, mine === status ? icon('check') : null, label);
  return h('section', { class: 'rsvp', id: 'rsvp-box', dataset: { coord: e.coord } },
    h('div', { class: 'rsvp-head' },
      h('h3', {}, 'Teilnahme'),
      h('span', { class: 'muted small' }, `${by.accepted.length} Zusagen · ${by.tentative.length} vielleicht`)),
    by.accepted.length ? h('div', { class: 'rsvp-faces' }, by.accepted.slice(0, 40).map((pk) => {
      const a = avatar(pk);
      a.title = store.displayName(pk);
      return a;
    })) : null,
    state.user
      ? h('div', { class: 'ev-actions' }, btn('accepted', 'Ich nehme teil'), btn('tentative', 'Vielleicht'), btn('declined', 'Absagen'))
      : h('p', { class: 'muted small', style: { margin: 0 } }, 'Melde dich mit Nostr an, um zu- oder abzusagen.'));
}

function slug(s) { return normalize(s).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'termin'; }
function safeUrl(u) { return /^https?:\/\//i.test(u) ? u : '#'; }

async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('In die Zwischenablage kopiert'); } catch { toast('Kopieren nicht möglich', 'error'); }
}
async function share(title, url) {
  if (navigator.share) {
    try { await navigator.share({ title, url }); return; } catch (err) { if (err?.name === 'AbortError') return; }
  }
  copy(url);
}

// ---------------------------------------------------------------------------
// Anmeldung & Veröffentlichen (NIP-07)
// ---------------------------------------------------------------------------
async function waitForNostr(ms = 1500) {
  const t0 = Date.now();
  while (!window.nostr && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 100));
  return window.nostr;
}

async function login() {
  if (state.user) {
    if (confirm('Abmelden?')) { state.user = null; storage.remove(USER_KEY); renderUser(); render(); }
    return;
  }
  const nostr = await waitForNostr();
  if (!nostr) {
    toast('Keine Nostr-Browsererweiterung gefunden (NIP-07, z. B. Alby, nos2x oder Keys.band).', 'error', 6000);
    return;
  }
  try {
    const pubkey = await nostr.getPublicKey();
    if (!/^[0-9a-f]{64}$/.test(pubkey)) throw new Error('Ungültiger Schlüssel');
    state.user = { pubkey };
    storage.set(USER_KEY, state.user);
    fetchAuthorsMeta();
    renderUser();
    render();
    toast('Angemeldet');
  } catch (err) {
    toast(`Anmeldung fehlgeschlagen: ${err.message || err}`, 'error');
  }
}

function renderUser() {
  const btn = $('btn-login');
  btn.replaceChildren();
  if (state.user) {
    btn.classList.add('avatar-btn');
    btn.append(avatar(state.user.pubkey), h('span', { class: 'hide-mobile' }, store.displayName(state.user.pubkey)));
    btn.title = 'Abmelden';
  } else {
    btn.classList.remove('avatar-btn');
    const svg = icon('users');
    svg.innerHTML = '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>';
    btn.append(svg, h('span', { class: 'hide-mobile' }, 'Anmelden'));
    btn.title = 'Mit Nostr anmelden (NIP-07)';
  }
  $('btn-create').classList.toggle('hidden', !state.user);
}

async function signAndPublish(template) {
  const nostr = await waitForNostr();
  if (!nostr) throw new Error('Keine Nostr-Erweiterung verfügbar');
  const signed = await nostr.signEvent({ created_at: unix(new Date()), content: '', ...template });
  if (!verifyEvent(signed)) throw new Error('Signatur ungültig');
  if (state.user && signed.pubkey !== state.user.pubkey) throw new Error('Signiert mit anderem Schlüssel als angemeldet');
  pool.seenValid.add(signed.id);
  store.addRaw(signed, null);
  const results = await pool.publish(signed);
  const ok = results.filter((r) => r.ok).length;
  if (!ok) {
    const why = results.map((r) => `${r.url.replace('wss://', '')}: ${r.message || 'abgelehnt'}`).join(' · ');
    throw new Error(`Kein Relay hat angenommen (${why})`);
  }
  return { signed, ok, total: results.length };
}

async function sendRsvp(e, status) {
  try {
    const { ok, total } = await signAndPublish({
      kind: KIND_RSVP,
      tags: [
        ['a', e.coord],
        ['e', e.id],
        ['d', `rsvp-${e.coord}`],
        ['status', status],
        ['p', e.pubkey],
      ],
    });
    toast(`Rückmeldung gesendet (${ok}/${total} Relays)`);
  } catch (err) {
    toast(err.message || String(err), 'error', 6000);
  }
}

// Editor ---------------------------------------------------------------------
let editing = null;

function toLocalInput(d, dateOnly) {
  if (!d) return '';
  const p = (n) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return dateOnly ? date : `${date}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function setAllDayInputs(form, allDay) {
  for (const name of ['start', 'end']) {
    const input = form.elements[name];
    const val = input.value;
    input.type = allDay ? 'date' : 'datetime-local';
    if (val) input.value = allDay ? val.slice(0, 10) : (val.length === 10 ? `${val}T${name === 'start' ? '09:00' : '10:00'}` : val);
  }
}

function openEditor(e = null) {
  editing = e;
  const form = $('edit-form');
  form.reset();
  $('edit-title').textContent = e ? 'Termin bearbeiten' : 'Neuer Termin';
  $('btn-delete-event').classList.toggle('hidden', !e);
  const allDay = e ? e.allDay : false;
  form.elements.allDay.checked = allDay;
  form.elements.start.type = allDay ? 'date' : 'datetime-local';
  form.elements.end.type = allDay ? 'date' : 'datetime-local';
  if (e) {
    form.elements.title.value = e.title;
    form.elements.start.value = toLocalInput(e.start, allDay);
    form.elements.end.value = e.allDay ? toLocalInput(addDays(e.end, -1), true) : (e.end > e.start ? toLocalInput(e.end) : '');
    form.elements.location.value = e.locations.join(', ');
    form.elements.summary.value = e.summary;
    form.elements.content.value = e.content;
    form.elements.link.value = e.links[0] || '';
    form.elements.image.value = e.image;
    form.elements.tags.value = e.hashtags.join(', ');
  } else {
    const base = new Date(state.cursor);
    base.setHours(10, 0, 0, 0);
    if (base < new Date()) { base.setDate(new Date().getDate() + 1); }
    form.elements.start.value = toLocalInput(base);
    form.elements.end.value = toLocalInput(new Date(base.getTime() + 3600000));
  }
  $('dlg-event').close();
  $('dlg-edit').showModal();
}

async function submitEditor(ev) {
  ev.preventDefault();
  const form = ev.target;
  const f = Object.fromEntries(new FormData(form));
  const allDay = form.elements.allDay.checked;
  const kind = allDay ? KIND_DATE : KIND_TIME;
  const d = editing && editing.kind === kind ? editing.d : (crypto.randomUUID?.() || String(Date.now()));
  const tags = [['d', d], ['title', f.title.trim()]];
  if (allDay) {
    const s = parseLocalDate(f.start);
    const eIncl = parseLocalDate(f.end) || s;
    if (!s) return toast('Bitte ein Startdatum angeben', 'error');
    if (eIncl < s) return toast('Das Ende liegt vor dem Beginn', 'error');
    tags.push(['start', toISODate(s)], ['end', toISODate(addDays(eIncl, 1))]);
  } else {
    const s = new Date(f.start);
    const e = f.end ? new Date(f.end) : null;
    if (Number.isNaN(s.getTime())) return toast('Bitte einen Beginn angeben', 'error');
    if (e && e < s) return toast('Das Ende liegt vor dem Beginn', 'error');
    tags.push(['start', String(unix(s))]);
    if (e) tags.push(['end', String(unix(e))]);
    tags.push(['start_tzid', USER_TZ]);
    if (e) tags.push(['end_tzid', USER_TZ]);
  }
  if (f.summary.trim()) tags.push(['summary', f.summary.trim()]);
  if (f.location.trim()) tags.push(['location', f.location.trim()]);
  if (f.image.trim()) tags.push(['image', f.image.trim()]);
  if (f.link.trim()) tags.push(['r', f.link.trim()]);
  const hashtags = [...new Set(f.tags.split(',').map((t) => t.trim().replace(/^#/, '').toLowerCase()).filter(Boolean))];
  hashtags.forEach((t) => tags.push(['t', t]));
  tags.push(['alt', `Kalendertermin: ${f.title.trim()}`]);

  const submit = form.querySelector('[type=submit]');
  submit.disabled = true;
  try {
    const { signed, ok, total } = await signAndPublish({ kind, content: f.content.trim(), tags });
    // Wechsel ganztägig <-> mit Uhrzeit ergibt eine neue Koordinate: alte Version löschen
    if (editing && editing.kind !== kind) await deleteEvent(editing, true);
    $('dlg-edit').close();
    toast(`Termin veröffentlicht (${ok}/${total} Relays)`);
    const parsed = store.events.get(`${signed.kind}:${signed.pubkey}:${d}`);
    if (parsed) { state.cursor = startOfDay(parsed.start); state.miniCursor = startOfMonth(parsed.start); render(); openEvent(parsed); }
  } catch (err) {
    toast(err.message || String(err), 'error', 7000);
  } finally {
    submit.disabled = false;
  }
}

async function deleteEvent(e, silent = false) {
  if (!silent && !confirm(`„${e.title}“ wirklich löschen? Die Löschanfrage (NIP-09) wird an alle Relays gesendet.`)) return;
  try {
    await signAndPublish({
      kind: 5,
      content: 'Termin gelöscht',
      tags: [['a', e.coord], ['e', e.id], ['k', String(e.kind)]],
    });
    if (!silent) {
      $('dlg-edit').close();
      $('dlg-event').close();
      toast('Termin gelöscht');
    }
    render();
  } catch (err) {
    toast(err.message || String(err), 'error', 6000);
  }
}

// ---------------------------------------------------------------------------
// Einstellungen: Relays
// ---------------------------------------------------------------------------
let relayStatus = [];

function renderRelayStatus(snapshot) {
  relayStatus = snapshot;
  const open = snapshot.filter((r) => r.status === 'open').length;
  const dot = $('relay-dot');
  dot.className = `relay-dot ${open === snapshot.length && open ? 'ok' : open ? 'partial' : snapshot.some((r) => r.status === 'connecting') ? '' : 'down'}`;
  $('btn-settings').title = `Relays: ${open}/${snapshot.length} verbunden`;
  if ($('dlg-settings').open) renderRelayList();
}

const STATUS_LABEL = { open: 'verbunden', connecting: 'verbinde …', error: 'Fehler', closed: 'getrennt', idle: 'inaktiv' };

function renderRelayList() {
  $('relay-list').replaceChildren(...pool.urls.map((url) => {
    const st = relayStatus.find((r) => r.url === url)?.status || 'idle';
    return h('li', {},
      h('span', { class: `status-dot ${st}` }),
      h('span', { class: 'url' }, url),
      h('span', { class: 'st' }, STATUS_LABEL[st] || st),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': `${url} entfernen`, onclick: () => setRelays(pool.urls.filter((u) => u !== url)) }, icon('trash')));
  }));
}

function setRelays(urls) {
  const clean = [...new Set(urls.map(normalizeRelayUrl).filter(Boolean))];
  if (!clean.length) { toast('Mindestens ein Relay wird benötigt', 'error'); return; }
  storage.set(RELAYS_KEY, clean);
  pool.setRelays(clean);
  pool.connectAll();
  renderRelayList();
  startMainSubscription();
}

// ---------------------------------------------------------------------------
// Navigation & Events
// ---------------------------------------------------------------------------
function onNavigate() {
  state.listLimit = PAGE_SIZE;
  if (state.view !== 'list') state.miniCursor = startOfMonth(state.cursor);
  ensureWindowForView();
  render();
}

function step(dir) {
  if (state.view === 'month') state.cursor = new Date(state.cursor.getFullYear(), state.cursor.getMonth() + dir, 1);
  else if (state.view === 'week') state.cursor = addDays(state.cursor, dir * 7);
  else state.cursor = addMonths(state.cursor, dir);
  onNavigate();
}

function setView(v) {
  state.view = v;
  onNavigate();
}

function openSidebar() { $('sidebar').classList.add('open'); $('scrim').hidden = false; $('btn-sidebar').setAttribute('aria-expanded', 'true'); }
function closeSidebar() { $('sidebar').classList.remove('open'); $('scrim').hidden = true; $('btn-sidebar').setAttribute('aria-expanded', 'false'); }

function exportCurrent() {
  let events;
  if (state.view === 'list') {
    const pred = makePredicate({ ignoreTime: false });
    events = store.all((e) => pred(e) && (state.past || e.end >= state.cursor));
  } else {
    const { from, to } = viewRange();
    events = store.between(from, to, makePredicate());
  }
  if (!events.length) { toast('Keine Termine zum Exportieren'); return; }
  downloadICS(events, 'edufeed-termine.ics', { viewerBase: VIEWER_BASE });
  toast(`${events.length} Termine exportiert`);
}

function bindUI() {
  $('btn-today').onclick = () => { state.cursor = startOfDay(new Date()); state.past = false; onNavigate(); };
  $('btn-prev').onclick = () => step(-1);
  $('btn-next').onclick = () => step(1);
  document.querySelectorAll('.segmented [data-view]').forEach((b) => { b.onclick = () => setView(b.dataset.view); });
  $('btn-export').onclick = exportCurrent;
  $('btn-login').onclick = login;
  $('btn-create').onclick = () => openEditor();
  $('btn-sidebar').onclick = openSidebar;
  $('scrim').onclick = closeSidebar;
  $('toggle-past').onchange = (ev) => { state.past = ev.target.checked; state.listLimit = PAGE_SIZE; if (state.past && state.view !== 'list') state.view = 'list'; render(); };
  $('btn-reset-filters').onclick = () => { state.q = ''; $('search').value = ''; state.tags.clear(); state.authors.clear(); state.calendar = ''; render(); };

  const search = $('search');
  search.value = state.q;
  const applySearch = debounce(() => {
    state.q = search.value.trim();
    state.listLimit = PAGE_SIZE;
    if (state.q && state.view !== 'list') state.view = 'list';
    render();
    remoteSearch(state.q);
  }, 180);
  search.addEventListener('input', applySearch);

  // Einstellungen
  $('btn-settings').onclick = () => { renderRelayList(); $('dlg-settings').showModal(); };
  $('btn-add-relay').onclick = () => {
    const url = normalizeRelayUrl($('relay-input').value);
    if (!url) { toast('Ungültige Relay-Adresse', 'error'); return; }
    $('relay-input').value = '';
    setRelays([...pool.urls, url]);
  };
  $('relay-input').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); $('btn-add-relay').click(); } });
  $('btn-reset-relays').onclick = () => { storage.remove(RELAYS_KEY); setRelays(DEFAULT_RELAYS); };

  // Editor
  const form = $('edit-form');
  form.addEventListener('submit', submitEditor);
  form.elements.allDay.addEventListener('change', (ev) => setAllDayInputs(form, ev.target.checked));
  form.querySelectorAll('[data-close]').forEach((b) => { b.onclick = () => $('dlg-edit').close(); });
  $('btn-delete-event').onclick = () => editing && deleteEvent(editing);

  // Detaildialog
  const dlg = $('dlg-event');
  dlg.addEventListener('close', () => { state.event = ''; closeRsvpSub?.(); closeRsvpSub = null; writeHash(); });
  dlg.addEventListener('click', (ev) => { if (ev.target === dlg) dlg.close(); }); // Klick auf Backdrop

  // Tastenkürzel
  document.addEventListener('keydown', (ev) => {
    if (ev.target.closest('input, textarea, select, [contenteditable]') || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    if (document.querySelector('dialog[open]')) return;
    const k = ev.key;
    if (k === '/') { ev.preventDefault(); search.focus(); } else if (k === 'ArrowLeft' || k === 'j') step(-1);
    else if (k === 'ArrowRight' || k === 'k') step(1);
    else if (k === 't') $('btn-today').click();
    else if (k === 'm') setView('month');
    else if (k === 'w') setView('week');
    else if (k === 'l') setView('list');
  });

  window.addEventListener('hashchange', () => {
    const before = state.event;
    readHash();
    search.value = state.q;
    render();
    if (state.event && state.event !== before) openByNaddr(state.event);
  });

  let lastMobile = window.matchMedia('(max-width: 900px)').matches;
  window.addEventListener('resize', debounce(() => {
    const mobile = window.matchMedia('(max-width: 900px)').matches;
    if (mobile !== lastMobile) { lastMobile = mobile; render(); }
  }, 200));
}

// Store-Änderungen gebündelt rendern
store.addEventListener('change', (ev) => {
  const kinds = ev.detail;
  if (kinds.has('events')) { fetchAuthorsMeta(); saveCache(); }
  if (kinds.has('profiles')) { renderUser(); saveCache(); }
  render();
  const dlg = $('dlg-event');
  if (dlg.open && state.event) {
    const open = [...store.events.values()].find((e) => e.naddr === state.event);
    const rsvpBox = $('rsvp-box');
    if (open && rsvpBox && (kinds.has('rsvps') || kinds.has('profiles'))) rsvpBox.replaceWith(renderRsvp(open));
  }
});

pool.onStatus(renderRelayStatus);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
readHash();
bindUI();
renderUser();
loadCache();
render();
pool.connectAll();
startMainSubscription();
if (state.q) remoteSearch(state.q);
if (state.event) openByNaddr(state.event);
