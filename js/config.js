// Zentrale Konfiguration. Alles läuft im Browser – es gibt kein Backend.
// Relays lassen sich in der Oberfläche (Einstellungen) oder per URL-Parameter
// ?relays=wss://a,wss://b überschreiben.

export const DEFAULT_RELAYS = [
  'wss://relay-rpi.edufeed.org',
  'wss://amb-relay.edufeed.org',
  'wss://relay.edufeed.org',
];

// Zusätzliche Relays nur für Profil-Metadaten (kind 0) der Veranstalter:innen.
export const DEFAULT_PROFILE_RELAYS = [
  'wss://relay.edufeed.org',
  'wss://purplepag.es',
];

// Externe Detailansicht für Termine (naddr wird angehängt)
export const VIEWER_BASE = 'https://dev.edufeed.org/';
export const NJUMP_BASE = 'https://njump.me/';

export const APP_NAME = 'Edufeed Termine';

// Wie viele Tage zurück der Start-Request vergangene Termine mitlädt
export const PAST_DAYS = 31;
