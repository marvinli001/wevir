import type { Messages } from '../zh-CN';

export const fr: Messages = {
  'computers.title': 'Ordinateurs',
  'computers.empty': 'Aucun ordinateur associé',
  'computers.add': 'Ajouter un ordinateur',

  'status.paused': 'Non connecté',
  'status.connecting': 'Connexion',
  'status.online': 'En ligne',
  'status.offline': 'Hors ligne',
  'status.offlineSince': 'Hors ligne · {time}',
  'status.removed': 'Retiré',
  'status.remoteDisabled': 'Accès à distance désactivé',
  'status.hostMismatch': 'Identité différente',
  'route.direct': 'Direct',
  'route.relay': 'Via relais',

  'add.title': 'Ajouter un ordinateur',
  'add.method.scan': 'Scanner',
  'add.method.link': 'Lien',
  'add.method.code': 'Code',
  'add.link': 'Lien d’association',
  'add.paste': 'Coller',
  'add.code': 'Code d’association',
  'add.deviceName': 'Nom de l’appareil',
  'add.pair': 'Associer',
  'add.cancel': 'Annuler',
  'add.camera.permission': 'Le scan nécessite l’accès à l’appareil photo',
  'add.camera.allow': 'Autoriser l’appareil photo',
  'add.camera.settings': 'Ouvrir Réglages',

  'pair.searching': 'Recherche d’ordinateurs',
  'pair.connecting': 'Connexion',
  'pair.awaiting': 'Autoriser « {device} » sur {host}',
  'pair.thatComputer': 'l’ordinateur',
  'pair.error.invalidLink': 'Lien d’association non valide ou version non prise en charge',
  'pair.error.invalidInput': 'Ni un lien d’association ni un code de 8 caractères',
  'pair.error.noneFound':
    'Aucun Wevir avec l’accès à distance trouvé sur ce réseau. Les codes n’associent que sur le même réseau ; sinon, scanner le code QR.',
  'pair.error.denied': 'L’ordinateur n’a pas autorisé l’association',
  'pair.error.wrongSecret': 'Code ou lien incorrect ou déjà utilisé',
  'pair.error.hostMismatch': 'Ce n’est pas l’ordinateur du code QR',
  'pair.error.windowClosed':
    'Association expirée ou déjà utilisée. Ajouter à nouveau l’appareil sur l’ordinateur.',
  'pair.error.unreachable':
    'Ordinateur injoignable. Vérifier que l’accès à distance est activé et qu’il est sur le même réseau ou dans Tailscale.',
  'pair.error.relay': 'Ordinateur injoignable en direct comme via relais',
  'pair.error.timeout': 'Délai d’attente de l’autorisation dépassé',
  'pair.error.failed': 'Échec de l’association',

  'computer.sessions': 'Sessions',
  'computer.noSessions': 'Aucune session',
  'computer.loading': 'Chargement',
  'computer.sessionsFailed': 'Impossible de charger les sessions',
  'computer.forbidden':
    'Cet appareil ne peut pas lire les sessions. Modifier ses autorisations sur l’ordinateur.',
  'computer.pending': '{count} en attente',
  'computer.retry': 'Réessayer',
  'computer.removed':
    'Cet appareil a été retiré sur cet ordinateur. Associer à nouveau pour se connecter.',
  'computer.remoteDisabled':
    'L’accès à distance est désactivé sur cet ordinateur. L’activer dans Paramètres → Appareils sur l’ordinateur.',
  'computer.hostMismatch':
    'Ce n’est pas l’ordinateur associé. Associer à nouveau si Wevir a été réinstallé.',
  'computer.unreachable':
    'Connexion impossible. Vérifier que l’ordinateur est allumé, pas en veille, et sur le même réseau ou dans Tailscale.',
  'computer.relay': 'Injoignable en direct comme via relais',
  'computer.pairAgain': 'Associer à nouveau',
  'computer.forget': 'Oublier cet ordinateur',
  'computer.forget.title': 'Oublier cet ordinateur ?',
  'computer.forget.consequence':
    'Supprime l’enregistrement et la clé sur ce téléphone. L’appareil reste listé sur l’ordinateur ; le retirer dans Paramètres → Appareils.',
  'computer.forget.confirm': 'Oublier',

  'session.untitled': 'Session sans titre',
  'session.state.idle': 'Inactive',
  'session.state.running': 'En cours',
  'session.state.awaiting_approval': 'Approbation requise',
  'session.state.cancelling': 'Annulation',
  'session.state.error': 'Erreur',
  'session.state.closed': 'Fermée',
  'session.awaitingInput': 'Réponse requise',

  'time.justNow': 'à l’instant',
  'time.minutes': 'il y a {n} min',
  'time.hours': 'il y a {n} h',
  'time.days': 'il y a {n} j',
};
