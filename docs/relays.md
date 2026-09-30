# Relay-Prüfung für die Kalenderseite

Stand: 30.09.2026. Geprüft wurde, welche Edufeed-Relays erreichbar sind und saubere
NIP-52-Kalender-Events (kind 31922/31923) liefern.

## Ergebnis

| Relay | Software | NIPs (NIP-11) | Limits | Termine | Empfehlung |
|---|---|---|---|---|---|
| `wss://amb-relay.edufeed.org` | amb-relay | 1, 9, 11, 42, 45, 50, 70, 77, 86 | – | ja (Stichprobe s. u.) | **nutzen** |
| `wss://relay.edufeed.org` | strfry 1.1.0 | 1, 2, 4, 9, 11, 28, 40, 45, 70, 77 | `max_limit` 500, 20 Subs | nicht direkt geprüft¹ | **nutzen** |
| `wss://relay-rpi.edufeed.org` | strfry 1.0.4 | 1, 2, 4, 9, 11, 22, 28, 40, 70, 77 | `max_limit` 10000, 20 Subs | nicht direkt geprüft¹ | beibehalten |
| `wss://oersi.edufeed.org` | amb-relay | wie amb-relay | – | keine | weglassen |
| `wss://sodix.edufeed.org` | amb-relay | wie amb-relay | – | keine | weglassen |

¹ Die Prüfumgebung konnte keine WebSocket-Verbindungen aufbauen (der Egress-Proxy
reicht den `Upgrade: websocket`-Header nicht durch). Erreichbarkeit und NIP-11 wurden
per HTTPS geprüft, die Termine auf amb-relay über das AMB-Gateway. Direkt prüfen:

```bash
nak req -k 31922 -k 31923 -l 20 wss://relay.edufeed.org
nak req -k 31922 -k 31923 -l 20 wss://relay-rpi.edufeed.org
```

`oersi` und `sodix` sind reine AMB-Ressourcen-Relays (Lernmaterial-Metadaten) ohne Termine.

Hinweise zu den Relays:

- **Kein NIP-50 auf den strfry-Relays:** Volltextsuche geht nur auf amb-relay; Filter nach
  kind, Autor, Tag und Zeit funktionieren überall.
- **`max_limit` 500 auf relay.edufeed.org:** größere Zeiträume per `since`/`until`
  (z. B. monatsweise) nachladen.

## Datenqualität (Stichprobe amb-relay)

250 Events mit Start ab 01.09.2026 (Limit erreicht, es gibt mehr):

- 192 × kind 31923 (alle mit `start_tzid`), 58 × kind 31922 (sauberes `YYYY-MM-DD`)
- Titel, Start und `d`-Tag überall vorhanden; bei 6 fehlt `end`, bei 23 der Ort, bei 4 die Quell-URL
- rund 80 % stammen von einem Aggregator-Key (`8287095e…`)

Auffälligkeiten, die der Client abfangen sollte:

1. **Ende vor Start** (3 Events, 31923). `js/model.js` setzt `end` in diesem Fall bereits
   auf `start` bzw. den Folgetag.
2. **Test-Key `79be667ef9dc…`** (öffentlicher Schlüssel zum Private Key `1`, von jedem
   nutzbar): 10 Events, darunter Duplikate der relilab-Impulse, die regulär unter
   `fb72f8d4…` stehen. Empfehlung: Key ausschließen oder eine Autoren-Allowlist nutzen.
3. **Doppelte Termine** (~24 gleiche Titel) unter verschiedenen Keys bzw. `d`-Tags. Die
   Deduplizierung über `kind:pubkey:d` fängt sie nicht ab; optional über Titel + Start
   zusammenführen.
4. Ein Event hat eine URL als Titel.
