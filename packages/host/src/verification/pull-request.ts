import { hostname, userInfo } from 'node:os';
import type { VerificationEvidence, VerificationEvidenceStatus } from '@wevir/protocol';
import { redactEvidenceText } from './evidence.js';

const statuses = [
  'passed',
  'failed',
  'timed_out',
  'not_run',
  'running',
  'cancelled',
  'environment_unavailable',
  'stale',
  'unbound',
  'config_changed',
] as const satisfies readonly VerificationEvidenceStatus[];

const translations: Record<
  string,
  {
    heading: string;
    results: readonly [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    tests: readonly [string, string, string];
  }
> = {
  en: {
    heading: 'Checks',
    results: [
      'Passed',
      'Failed',
      'Timed out',
      'Not run',
      'Running',
      'Cancelled',
      'Environment unavailable',
      'Does not match this commit',
      'Unbound',
      'Configuration changed',
    ],
    tests: ['passed', 'failed', 'skipped'],
  },
  'zh-CN': {
    heading: '检查',
    results: [
      '通过',
      '失败',
      '超时',
      '未运行',
      '运行中',
      '已取消',
      '环境不可用',
      '不对应此提交',
      '未绑定',
      '配置已改',
    ],
    tests: ['通过', '失败', '跳过'],
  },
  'zh-TW': {
    heading: '檢查',
    results: [
      '通過',
      '失敗',
      '逾時',
      '未執行',
      '執行中',
      '已取消',
      '環境無法使用',
      '不對應此提交',
      '未繫結',
      '設定已變更',
    ],
    tests: ['通過', '失敗', '略過'],
  },
  de: {
    heading: 'Prüfungen',
    results: [
      'Bestanden',
      'Fehlgeschlagen',
      'Zeitüberschreitung',
      'Nicht ausgeführt',
      'Läuft',
      'Abgebrochen',
      'Umgebung nicht verfügbar',
      'Gilt für einen anderen Commit',
      'Ohne Zuordnung',
      'Konfiguration geändert',
    ],
    tests: ['bestanden', 'fehlgeschlagen', 'übersprungen'],
  },
  es: {
    heading: 'Comprobaciones',
    results: [
      'Superada',
      'Fallida',
      'Tiempo agotado',
      'Sin ejecutar',
      'En ejecución',
      'Cancelada',
      'Entorno no disponible',
      'No corresponde a este commit',
      'Sin vincular',
      'Configuración modificada',
    ],
    tests: ['superadas', 'fallidas', 'omitidas'],
  },
  fr: {
    heading: 'Vérifications',
    results: [
      'Réussie',
      'Échec',
      'Délai dépassé',
      'Non exécutée',
      'En cours',
      'Annulée',
      'Environnement indisponible',
      'Concerne un autre commit',
      'Sans correspondance',
      'Configuration modifiée',
    ],
    tests: ['réussis', 'échoués', 'ignorés'],
  },
  it: {
    heading: 'Controlli',
    results: [
      'Superato',
      'Fallito',
      'Tempo scaduto',
      'Non eseguito',
      'In corso',
      'Annullato',
      'Ambiente non disponibile',
      'Relativo a un altro commit',
      'Senza associazione',
      'Configurazione modificata',
    ],
    tests: ['superati', 'falliti', 'saltati'],
  },
  ja: {
    heading: 'チェック',
    results: [
      '合格',
      '失敗',
      'タイムアウト',
      '未実行',
      '実行中',
      'キャンセル',
      '環境を利用できません',
      'このコミットとは不一致',
      '未関連付け',
      '設定変更済み',
    ],
    tests: ['合格', '失敗', 'スキップ'],
  },
  ko: {
    heading: '검사',
    results: [
      '통과',
      '실패',
      '시간 초과',
      '실행 안 됨',
      '실행 중',
      '취소됨',
      '환경 사용 불가',
      '이 커밋에 해당하지 않음',
      '연결 안 됨',
      '설정 변경됨',
    ],
    tests: ['통과', '실패', '건너뜀'],
  },
  ru: {
    heading: 'Проверки',
    results: [
      'Пройдена',
      'Не пройдена',
      'Время истекло',
      'Не запускалась',
      'Выполняется',
      'Отменена',
      'Среда недоступна',
      'Для другого коммита',
      'Без привязки',
      'Конфигурация изменена',
    ],
    tests: ['пройдено', 'не пройдено', 'пропущено'],
  },
};

export function verificationMarkdown(evidence: VerificationEvidence, locale?: string): string {
  if (!evidence.commit || evidence.checks.length === 0) return '';
  const labels = translations[locale ?? ''] ?? translations.en;
  if (labels === undefined) return '';
  const localNames = [hostname(), userInfo().username].filter(Boolean);
  const entries = evidence.checks.map(({ name, status, tests }) => {
    let safeName = redactEvidenceText(name.replace(/https?:\/\/\S+/gi, '[redacted]'));
    for (const localName of localNames) safeName = safeName.replaceAll(localName, '[redacted]');
    safeName = safeName.replace(
      /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:local|internal|lan)\b/gi,
      '[redacted]',
    );
    safeName = safeName
      .replace(/\s+/gu, ' ')
      .trim()
      .replace(/[\\`*_[\]<>~|]/g, '\\$&');
    const counts =
      tests === undefined
        ? ''
        : ` (${tests.passed} ${labels.tests[0]}, ${tests.failed} ${labels.tests[1]}, ${tests.skipped} ${labels.tests[2]})`;
    return `- ${safeName} · ${labels.results[statuses.indexOf(status)]}${counts}`;
  });
  return [`### ${labels.heading} · \`${evidence.commit}\``, '', ...entries].join('\n');
}
