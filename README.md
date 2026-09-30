# Edufeed Termine

Eine Termin- und Kalenderseite für den Bildungsbereich, die **ausschließlich auf Nostr** basiert.
Termine kommen live und signiert von den Edufeed-Relays. Es gibt kein Backend, keine Datenbank
und keinen API-Server: Die statische Seite spricht direkt per WebSocket mit den Relays.

## Funktionen

- **Ansichten:** Monat, Woche und Liste (Agenda) mit Mini-Kalender, „Heute“ und Blättern
- **Suche:** lokale Volltextsuche über Titel, Beschreibung, Ort, Schlagworte und Veranstalter; zusätzlich NIP-50-Suche auf Relays, die sie unterstützen
- **Filter:** Schlagworte (`t`), Veranstalter (Pubkeys mit Profilen aus kind 0), Kalender (kind 31924), vergangene Termine
- **Detailansicht:** Zeit (auch in der Original-Zeitzone), Ort mit Kartenlink (Geohash/OSM), Links, Bild, Beschreibung, Veranstalterprofil, Nostr-Details (naddr, Event-ID, Relays)
- **Export:** einzelne Termine oder die aktuelle Auswahl als iCal (`.ics`)
- **Teilbare Links:** der ganze Zustand (Ansicht, Datum, Filter, geöffneter Termin als `naddr`) steht im URL-Hash
- **Mitmachen mit Nostr-Login (NIP-07):** Termine anlegen, bearbeiten und löschen (NIP-09), Zu- und Absagen (RSVP, kind 31925)
- **Relays einstellbar:** in der Oberfläche oder per `?relays=wss://a,wss://b`; Verbindungsstatus live
- **Sofortstart:** zuletzt geladene Termine werden lokal zwischengespeichert
- Responsiv, Dark Mode, Tastaturkürzel (`/` Suche, `←`/`→` blättern, `t` heute, `m`/`w`/`l` Ansicht), installierbar (Web-Manifest)

## Nostr-Logik

| Zweck | Kind | Hinweise |
|---|---|---|
| Ganztägige Termine | 31922 | `start`/`end` als `YYYY-MM-DD`, `end` exklusiv (NIP-52) |
| Termine mit Uhrzeit | 31923 | Unix-Sekunden, `start_tzid`/`end_tzid` |
| Kalender | 31924 | `a`-Tags auf Termine, als Filter nutzbar |
| Zu-/Absagen | 31925 | `a`, `status` = `accepted`/`tentative`/`declined` |
| Profile | 0 | Name, Bild, NIP-05 der Veranstalter |
| Löschungen | 5 | NIP-09, per `e`- und `a`-Tag, nur vom Autor |

- **Vertrauen durch Signaturen:** jedes Event wird im Browser mit `verifyEvent` geprüft; ungültige werden verworfen.
- **Replaceable Events** werden über ihre Koordinate `kind:pubkey:d` dedupliziert, die neueste Version gewinnt.
- **Abfragen:** eine Standard-NIP-01-Abfrage (neueste Termine) läuft auf jedem Relay. Dazu kommt der Zeitbereichs-Index des AMB-Relays (`#start_after`/`#start_before`), mit dem beim Blättern gezielt der sichtbare Zeitraum nachgeladen wird. Die Subscription bleibt offen, neue Termine erscheinen live.
- **Veröffentlichen:** Events werden mit der Browsererweiterung (NIP-07, z. B. Alby, nos2x, Keys.band) signiert und an alle aktiven Relays gesendet; die `OK`-Antworten werden ausgewertet.

Standard-Relays (`js/config.js`):

- `wss://relay-rpi.edufeed.org`
- `wss://amb-relay.edufeed.org`
- `wss://relay.edufeed.org`

Ergebnis der Relay-Prüfung (Erreichbarkeit, NIPs, Datenqualität): [docs/relays.md](docs/relays.md)

## Aufbau

```
index.html            Grundgerüst und Dialoge
css/app.css           Styles (Light/Dark, responsiv)
js/config.js          Relays und Links
js/pool.js            Relay-Pool: Reconnect, Subscriptions, EOSE, Publish/OK, Signaturprüfung
js/model.js           NIP-52-Parser und reaktiver Store (Dedupe, Löschungen, RSVPs, Profile)
js/app.js             Oberfläche, Routing, Filter, Editor, Login
js/ics.js             iCal-Export
js/util.js            DOM-, Datums- und Texthelfer (XSS-sicher, kein innerHTML für Fremdinhalte)
vendor/nostr-tools.js Gebündeltes nostr-tools 2.x (nip19, Signaturen)
```

Kein Build-Schritt nötig: ES-Module direkt im Browser.

## Lokal starten

```bash
python3 -m http.server 8080
# http://localhost:8080
```

Mit eigenen Relays: `http://localhost:8080/?relays=wss://relay.example.org`

## Veröffentlichen

Der Workflow `.github/workflows/pages.yml` veröffentlicht die Seite bei jedem Push auf `main` über GitHub Pages.
Falls Pages im Repository noch nicht aktiv ist: *Settings → Pages → Source: GitHub Actions*.
