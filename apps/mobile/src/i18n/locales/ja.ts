import type { Messages } from '../zh-CN';

export const ja: Messages = {
  'computers.title': 'コンピュータ',
  'computers.empty': 'ペアリング済みのコンピュータなし',
  'computers.add': 'コンピュータを追加',

  'status.paused': '未接続',
  'status.connecting': '接続中',
  'status.online': 'オンライン',
  'status.offline': 'オフライン',
  'status.offlineSince': 'オフライン · {time}',
  'status.removed': '削除済み',
  'status.remoteDisabled': 'リモートアクセスがオフ',
  'status.hostMismatch': 'ID 不一致',
  'route.direct': '直接接続',
  'route.relay': 'リレー経由',

  'add.title': 'コンピュータを追加',
  'add.method.scan': 'スキャン',
  'add.method.link': 'リンク',
  'add.method.code': 'コード',
  'add.link': 'ペアリングリンク',
  'add.paste': 'ペースト',
  'add.code': 'ペアリングコード',
  'add.deviceName': 'デバイス名',
  'add.pair': 'ペアリング',
  'add.cancel': 'キャンセル',
  'add.camera.permission': 'スキャンにはカメラへのアクセスが必要',
  'add.camera.allow': 'カメラを許可',
  'add.camera.settings': '設定を開く',

  'pair.searching': 'コンピュータを検索中',
  'pair.connecting': '接続中',
  'pair.awaiting': '{host} で「{device}」を許可',
  'pair.thatComputer': 'コンピュータ',
  'pair.error.invalidLink': 'ペアリングリンクが無効、または未対応のバージョン',
  'pair.error.invalidInput': 'ペアリングリンクでも 8 文字のコードでもない',
  'pair.error.noneFound':
    'このネットワークにリモートアクセスが有効な Wevir が見つからない。コードは同じネットワーク内でのみ使用でき、別のネットワークでは QR コードをスキャンする。',
  'pair.error.denied': 'コンピュータがペアリングを許可しなかった',
  'pair.error.wrongSecret': 'コードまたはペアリングリンクが違うか、使用済み',
  'pair.error.hostMismatch': 'QR コードのコンピュータではない',
  'pair.error.windowClosed':
    'ペアリングの期限切れまたは使用済み。コンピュータでデバイスを追加し直す。',
  'pair.error.unreachable':
    'コンピュータに接続できない。リモートアクセスがオンで、同じネットワークまたは Tailscale 上にあることを確認する。',
  'pair.error.relay': '直接接続でもリレー経由でもコンピュータに接続できない',
  'pair.error.timeout': '許可の待機がタイムアウト',
  'pair.error.failed': 'ペアリングに失敗',

  'computer.sessions': 'セッション',
  'computer.noSessions': 'セッションなし',
  'computer.loading': '読み込み中',
  'computer.sessionsFailed': 'セッション一覧を読み込めない',
  'computer.forbidden': 'このデバイスにはセッションの読み取り権限がない。コンピュータで変更する。',
  'computer.pending': '{count} 件の対応待ち',
  'computer.retry': '再試行',
  'computer.removed':
    'このデバイスはこのコンピュータで削除された。接続するには再度ペアリングする。',
  'computer.remoteDisabled':
    'このコンピュータのリモートアクセスがオフ。コンピュータの 設定 → デバイス でオンにする。',
  'computer.hostMismatch':
    'ペアリングしたコンピュータではない。Wevir を再インストールした場合は再度ペアリングする。',
  'computer.unreachable':
    '接続できない。コンピュータが起動中でスリープしておらず、同じネットワークまたは Tailscale 上にあることを確認する。',
  'computer.relay': '直接接続でもリレー経由でも接続できない',
  'computer.pairAgain': '再度ペアリング',
  'computer.forget': 'このコンピュータを削除',
  'computer.forget.title': 'このコンピュータを削除しますか？',
  'computer.forget.consequence':
    'この端末の記録と鍵を削除する。コンピュータ側のデバイス記録は残り、そちらの 設定 → デバイス で削除できる。',
  'computer.forget.confirm': '削除',

  'session.untitled': '無題のセッション',
  'session.state.idle': '待機中',
  'session.state.running': '実行中',
  'session.state.awaiting_approval': '承認待ち',
  'session.state.cancelling': 'キャンセル中',
  'session.state.error': 'エラー',
  'session.state.closed': '終了',
  'session.awaitingInput': '回答待ち',

  'time.justNow': 'たった今',
  'time.minutes': '{n} 分前',
  'time.hours': '{n} 時間前',
  'time.days': '{n} 日前',
};
