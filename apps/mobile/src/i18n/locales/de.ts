import type { Messages } from '../zh-CN';

export const de: Messages = {
  'computers.title': 'Computer',
  'computers.empty': 'Keine gekoppelten Computer',
  'computers.add': 'Computer hinzufügen',

  'status.paused': 'Nicht verbunden',
  'status.connecting': 'Verbinden',
  'status.online': 'Online',
  'status.offline': 'Offline',
  'status.offlineSince': 'Offline · {time}',
  'status.removed': 'Entfernt',
  'status.remoteDisabled': 'Fernzugriff aus',
  'status.hostMismatch': 'Identität stimmt nicht',
  'route.direct': 'Direkt',
  'route.relay': 'Über Relay',

  'add.title': 'Computer hinzufügen',
  'add.method.scan': 'Scannen',
  'add.method.link': 'Link',
  'add.method.code': 'Code',
  'add.link': 'Kopplungslink',
  'add.paste': 'Einsetzen',
  'add.code': 'Kopplungscode',
  'add.deviceName': 'Gerätename',
  'add.pair': 'Koppeln',
  'add.cancel': 'Abbrechen',
  'add.camera.permission': 'Zum Scannen ist Kamerazugriff nötig',
  'add.camera.allow': 'Kamera erlauben',
  'add.camera.settings': 'Einstellungen öffnen',

  'pair.searching': 'Computer werden gesucht',
  'pair.connecting': 'Verbinden',
  'pair.awaiting': '„{device}“ auf {host} erlauben',
  'pair.thatComputer': 'dem Computer',
  'pair.error.invalidLink': 'Ungültiger Kopplungslink oder nicht unterstützte Version',
  'pair.error.invalidInput': 'Weder Kopplungslink noch 8-stelliger Code',
  'pair.error.noneFound':
    'Kein Wevir mit Fernzugriff in diesem Netzwerk gefunden. Codes koppeln nur im selben Netzwerk, sonst den QR-Code scannen.',
  'pair.error.denied': 'Der Computer hat die Kopplung nicht erlaubt',
  'pair.error.wrongSecret': 'Code oder Kopplungslink falsch oder bereits verwendet',
  'pair.error.hostMismatch': 'Nicht der Computer aus dem QR-Code',
  'pair.error.windowClosed':
    'Kopplung abgelaufen oder bereits verwendet. Gerät auf dem Computer erneut hinzufügen.',
  'pair.error.unreachable':
    'Computer nicht erreichbar. Fernzugriff muss an sein und der Computer im selben Netzwerk oder in Tailscale.',
  'pair.error.relay': 'Computer weder direkt noch über Relay erreichbar',
  'pair.error.timeout': 'Zeitüberschreitung beim Warten auf die Freigabe',
  'pair.error.failed': 'Kopplung fehlgeschlagen',

  'computer.sessions': 'Sitzungen',
  'computer.noSessions': 'Keine Sitzungen',
  'computer.loading': 'Wird geladen',
  'computer.sessionsFailed': 'Sitzungen konnten nicht geladen werden',
  'computer.forbidden':
    'Dieses Gerät darf keine Sitzungen lesen. Berechtigungen auf dem Computer ändern.',
  'computer.pending': '{count} offen',
  'computer.retry': 'Erneut versuchen',
  'computer.removed':
    'Dieses Gerät wurde auf diesem Computer entfernt. Zum Verbinden erneut koppeln.',
  'computer.remoteDisabled':
    'Fernzugriff ist auf diesem Computer aus. Dort unter Einstellungen → Geräte einschalten.',
  'computer.hostMismatch':
    'Nicht der gekoppelte Computer. Nach einer Neuinstallation von Wevir erneut koppeln.',
  'computer.unreachable':
    'Keine Verbindung. Der Computer muss eingeschaltet, wach und im selben Netzwerk oder in Tailscale sein.',
  'computer.relay': 'Weder direkt noch über Relay erreichbar',
  'computer.pairAgain': 'Erneut koppeln',
  'computer.forget': 'Computer entfernen',
  'computer.forget.title': 'Diesen Computer entfernen?',
  'computer.forget.consequence':
    'Löscht Eintrag und Schlüssel auf diesem Telefon. Auf dem Computer bleibt das Gerät gelistet; dort unter Einstellungen → Geräte entfernen.',
  'computer.forget.confirm': 'Entfernen',

  'session.untitled': 'Unbenannte Sitzung',
  'session.state.idle': 'Bereit',
  'session.state.running': 'Läuft',
  'session.state.awaiting_approval': 'Freigabe nötig',
  'session.state.cancelling': 'Wird abgebrochen',
  'session.state.error': 'Fehler',
  'session.state.closed': 'Geschlossen',
  'session.awaitingInput': 'Antwort nötig',

  'time.justNow': 'gerade eben',
  'time.minutes': 'vor {n} Min.',
  'time.hours': 'vor {n} Std.',
  'time.days': 'vor {n} T.',
};
