// iCalendar-Export (RFC 5545) für einzelne Termine oder die aktuelle Auswahl.

import { toISODate } from './model.js';

const esc = (s) => String(s || '')
  .replace(/\\/g, '\\\\')
  .replace(/\n/g, '\\n')
  .replace(/,/g, '\\,')
  .replace(/;/g, '\\;');

const utcStamp = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const dateStamp = (d) => toISODate(d).replace(/-/g, '');

// Zeilen auf 75 Oktette falten (vereinfachte Zeichenzählung)
const fold = (line) => {
  const out = [];
  let rest = line;
  while (rest.length > 73) { out.push(rest.slice(0, 73)); rest = ` ${rest.slice(73)}`; }
  out.push(rest);
  return out.join('\r\n');
};

export function toICS(events, { viewerBase = '' } = {}) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//rpi-virtuell//Nostr Termine//DE',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
  ];
  const now = utcStamp(new Date());
  for (const e of events) {
    const url = e.links[0] || (viewerBase && e.naddr ? viewerBase + e.naddr : '');
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${esc(e.coord)}@nostr`);
    lines.push(`DTSTAMP:${now}`);
    if (e.allDay) {
      lines.push(`DTSTART;VALUE=DATE:${dateStamp(e.start)}`);
      lines.push(`DTEND;VALUE=DATE:${dateStamp(e.end)}`);
    } else {
      lines.push(`DTSTART:${utcStamp(e.start)}`);
      if (e.end > e.start) lines.push(`DTEND:${utcStamp(e.end)}`);
    }
    lines.push(`SUMMARY:${esc(e.title)}`);
    const desc = [e.summary, e.content && e.content !== e.summary ? e.content : '', e.naddr ? `nostr:${e.naddr}` : '']
      .filter(Boolean).join('\n\n');
    if (desc) lines.push(`DESCRIPTION:${esc(desc)}`);
    if (e.locations.length) lines.push(`LOCATION:${esc(e.locations.join(', '))}`);
    if (url) lines.push(`URL:${esc(url)}`);
    if (e.hashtags.length) lines.push(`CATEGORIES:${e.hashtags.map(esc).join(',')}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

export function downloadICS(events, filename = 'termine.ics', opts) {
  const blob = new Blob([toICS(events, opts)], { type: 'text/calendar;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
