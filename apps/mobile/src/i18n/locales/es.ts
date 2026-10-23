import type { Messages } from '../zh-CN';

export const es: Messages = {
  'computers.title': 'Ordenadores',
  'computers.empty': 'No hay ordenadores vinculados',
  'computers.add': 'Añadir ordenador',

  'status.paused': 'Sin conexión',
  'status.connecting': 'Conectando',
  'status.online': 'En línea',
  'status.offline': 'Desconectado',
  'status.offlineSince': 'Desconectado · {time}',
  'status.removed': 'Eliminado',
  'status.remoteDisabled': 'Acceso remoto desactivado',
  'status.hostMismatch': 'Identidad distinta',
  'route.direct': 'Directa',
  'route.relay': 'Por relé',

  'add.title': 'Añadir ordenador',
  'add.method.scan': 'Escanear',
  'add.method.link': 'Enlace',
  'add.method.code': 'Código',
  'add.link': 'Enlace de vinculación',
  'add.paste': 'Pegar',
  'add.code': 'Código de vinculación',
  'add.deviceName': 'Nombre del dispositivo',
  'add.pair': 'Vincular',
  'add.cancel': 'Cancelar',
  'add.camera.permission': 'Escanear requiere acceso a la cámara',
  'add.camera.allow': 'Permitir cámara',
  'add.camera.settings': 'Abrir Ajustes',

  'pair.searching': 'Buscando ordenadores',
  'pair.connecting': 'Conectando',
  'pair.awaiting': 'Permitir «{device}» en {host}',
  'pair.thatComputer': 'el ordenador',
  'pair.error.invalidLink': 'Enlace de vinculación no válido o versión no compatible',
  'pair.error.invalidInput': 'No es un enlace de vinculación ni un código de 8 caracteres',
  'pair.error.noneFound':
    'No se encontró ningún Wevir con acceso remoto en esta red. Los códigos solo vinculan en la misma red; si no, escanear el código QR.',
  'pair.error.denied': 'El ordenador no permitió la vinculación',
  'pair.error.wrongSecret': 'Código o enlace incorrecto o ya usado',
  'pair.error.hostMismatch': 'No es el ordenador del código QR',
  'pair.error.windowClosed':
    'La vinculación caducó o ya se usó. Añadir el dispositivo de nuevo en el ordenador.',
  'pair.error.unreachable':
    'No se puede conectar con el ordenador. Comprobar que el acceso remoto está activado y que está en la misma red o en Tailscale.',
  'pair.error.relay': 'No se puede conectar con el ordenador ni directamente ni por relé',
  'pair.error.timeout': 'Se agotó el tiempo de espera de la aprobación',
  'pair.error.failed': 'Error al vincular',

  'computer.sessions': 'Sesiones',
  'computer.noSessions': 'No hay sesiones',
  'computer.loading': 'Cargando',
  'computer.sessionsFailed': 'No se pudieron cargar las sesiones',
  'computer.forbidden':
    'Este dispositivo no puede leer sesiones. Cambiar sus permisos en el ordenador.',
  'computer.pending': '{count} pendientes',
  'computer.retry': 'Reintentar',
  'computer.removed':
    'Este dispositivo se eliminó en este ordenador. Vincular de nuevo para conectar.',
  'computer.remoteDisabled':
    'El acceso remoto está desactivado en este ordenador. Activarlo en Configuración → Dispositivos del ordenador.',
  'computer.hostMismatch': 'No es el ordenador vinculado. Vincular de nuevo si se reinstaló Wevir.',
  'computer.unreachable':
    'No se puede conectar. Comprobar que el ordenador está encendido, sin suspender y en la misma red o en Tailscale.',
  'computer.relay': 'No se puede conectar ni directamente ni por relé',
  'computer.pairAgain': 'Vincular de nuevo',
  'computer.forget': 'Olvidar este ordenador',
  'computer.forget.title': '¿Olvidar este ordenador?',
  'computer.forget.consequence':
    'Borra el registro y la clave de este teléfono. El dispositivo sigue en la lista del ordenador; eliminarlo allí en Configuración → Dispositivos.',
  'computer.forget.confirm': 'Olvidar',

  'session.untitled': 'Sesión sin título',
  'session.state.idle': 'Inactiva',
  'session.state.running': 'En curso',
  'session.state.awaiting_approval': 'Requiere aprobación',
  'session.state.cancelling': 'Cancelando',
  'session.state.error': 'Error',
  'session.state.closed': 'Cerrada',
  'session.awaitingInput': 'Requiere respuesta',

  'time.justNow': 'ahora',
  'time.minutes': 'hace {n} min',
  'time.hours': 'hace {n} h',
  'time.days': 'hace {n} d',
};
