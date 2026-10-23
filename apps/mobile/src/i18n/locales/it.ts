import type { Messages } from '../zh-CN';

export const it: Messages = {
  'computers.title': 'Computer',
  'computers.empty': 'Nessun computer abbinato',
  'computers.add': 'Aggiungi computer',

  'status.paused': 'Non connesso',
  'status.connecting': 'Connessione',
  'status.online': 'Online',
  'status.offline': 'Offline',
  'status.offlineSince': 'Offline · {time}',
  'status.removed': 'Rimosso',
  'status.remoteDisabled': 'Accesso remoto disattivato',
  'status.hostMismatch': 'Identità diversa',
  'route.direct': 'Diretta',
  'route.relay': 'Tramite relay',

  'add.title': 'Aggiungi computer',
  'add.method.scan': 'Scansiona',
  'add.method.link': 'Link',
  'add.method.code': 'Codice',
  'add.link': 'Link di abbinamento',
  'add.paste': 'Incolla',
  'add.code': 'Codice di abbinamento',
  'add.deviceName': 'Nome del dispositivo',
  'add.pair': 'Abbina',
  'add.cancel': 'Annulla',
  'add.camera.permission': 'La scansione richiede l’accesso alla fotocamera',
  'add.camera.allow': 'Consenti fotocamera',
  'add.camera.settings': 'Apri Impostazioni',

  'pair.searching': 'Ricerca dei computer',
  'pair.connecting': 'Connessione',
  'pair.awaiting': 'Consenti «{device}» su {host}',
  'pair.thatComputer': 'il computer',
  'pair.error.invalidLink': 'Link di abbinamento non valido o versione non supportata',
  'pair.error.invalidInput': 'Né un link di abbinamento né un codice di 8 caratteri',
  'pair.error.noneFound':
    'Nessun Wevir con accesso remoto trovato in questa rete. I codici abbinano solo nella stessa rete; altrimenti scansionare il codice QR.',
  'pair.error.denied': 'Il computer non ha consentito l’abbinamento',
  'pair.error.wrongSecret': 'Codice o link errato o già usato',
  'pair.error.hostMismatch': 'Non è il computer del codice QR',
  'pair.error.windowClosed':
    'Abbinamento scaduto o già usato. Aggiungere di nuovo il dispositivo sul computer.',
  'pair.error.unreachable':
    'Computer non raggiungibile. Verificare che l’accesso remoto sia attivo e che sia nella stessa rete o in Tailscale.',
  'pair.error.relay': 'Computer non raggiungibile né direttamente né tramite relay',
  'pair.error.timeout': 'Tempo scaduto in attesa dell’autorizzazione',
  'pair.error.failed': 'Abbinamento non riuscito',

  'computer.sessions': 'Sessioni',
  'computer.noSessions': 'Nessuna sessione',
  'computer.loading': 'Caricamento',
  'computer.sessionsFailed': 'Impossibile caricare le sessioni',
  'computer.forbidden':
    'Questo dispositivo non può leggere le sessioni. Modificarne i permessi sul computer.',
  'computer.pending': '{count} in attesa',
  'computer.retry': 'Riprova',
  'computer.removed':
    'Questo dispositivo è stato rimosso su questo computer. Abbinare di nuovo per connettersi.',
  'computer.remoteDisabled':
    'L’accesso remoto è disattivato su questo computer. Attivarlo in Impostazioni → Dispositivi sul computer.',
  'computer.hostMismatch':
    'Non è il computer abbinato. Abbinare di nuovo se Wevir è stato reinstallato.',
  'computer.unreachable':
    'Connessione impossibile. Verificare che il computer sia acceso, non in stop e nella stessa rete o in Tailscale.',
  'computer.relay': 'Non raggiungibile né direttamente né tramite relay',
  'computer.pairAgain': 'Abbina di nuovo',
  'computer.forget': 'Dimentica questo computer',
  'computer.forget.title': 'Dimenticare questo computer?',
  'computer.forget.consequence':
    'Elimina il record e la chiave su questo telefono. Il dispositivo resta nell’elenco del computer; rimuoverlo lì in Impostazioni → Dispositivi.',
  'computer.forget.confirm': 'Dimentica',

  'session.untitled': 'Sessione senza titolo',
  'session.state.idle': 'Inattiva',
  'session.state.running': 'In corso',
  'session.state.awaiting_approval': 'Da approvare',
  'session.state.cancelling': 'Annullamento',
  'session.state.error': 'Errore',
  'session.state.closed': 'Chiusa',
  'session.awaitingInput': 'Da rispondere',

  'time.justNow': 'adesso',
  'time.minutes': '{n} min fa',
  'time.hours': '{n} h fa',
  'time.days': '{n} g fa',
};
