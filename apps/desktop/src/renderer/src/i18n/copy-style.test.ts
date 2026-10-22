import { describe, expect, it } from 'vitest';
import { zhCN } from './zh-CN';

// 界面文案的写法检查，规则见 zh-CN.ts 文件头与 AGENTS.md 的“界面文案”。名单只收确有必要的条目；新增前先确认这段文字
// 删掉后会不会影响使用，不影响就删掉，不要往名单里加。

/** 发给模型的文案（不显示在界面上），不受界面文案规则约束。 */
const MODEL_FACING = new Set<string>([
  'history.intro',
  'plan.implementPrefix',
  'retro.handoffPrefix',
]);
/** 自动化模板的指令（0.66.0）：填进指令框、每次运行发给 Agent，按发给模型的文案对待。 */
const isModelFacing = (key: string) =>
  MODEL_FACING.has(key) || /^automations\.template\.[a-z]+\.prompt$/.test(key);

/** 说明、提示、副标题一类的 key。只允许下面这些：错误的处理建议、确认框里的后果、配置事实与必要的安全提醒。 */
const EXPLANATORY_KEY =
  /(hint|note|description|subtitle|intro|helper|explain|tip|caption|body|warning)(\.|$)/i;
const EXPLANATORY_ALLOWED = new Set<string>([
  'connection.waitingHint',
  'pending.heldHint',
  'engineError.hint.missing_credentials',
  'engineError.hint.provider',
  'engineError.hint.engine_exited',
  'engineError.hint.cancel_unconfirmed',
  'engineError.hint.session_unavailable',
  'engineError.hint.unknown',
  'history.intro',
  'settings.memory.deleteBody',
  'settings.memory.editor.description',
  // 配置事实：防休眠只挡空闲睡眠，合盖照样睡眠，不写会让人以为合盖也能继续跑。
  'settings.preventSleepNote',
  'settings.appearance.importHint',
  'source.soon.body',
  // 确认框里的后果：删掉账号的凭据与用量，会话不能继续。
  'source.account.remove.body',
  'account.chatgpt.device.warning',
  'account.chatgpt.logout.body',
  'provider.preset.azureOpenai.note',
  'provider.preset.azureClaude.note',
  'provider.preset.mimo.note',
  'provider.phala.phala_no_route.hint',
  'provider.phala.phala_attestation_unavailable.hint',
  'provider.preset.kimi.note',
  'provider.preset.minimax.note',
  // TokenHub 的地域地址与 Key 不通用，配置前必须区分广州、新加坡与美国。
  'provider.preset.tencent.note',
  // 国内按量与国际站的地址 / Key 须区分，按服务接入要求显示地域和大陆直连事实。
  'provider.preset.stepfun.note',
  // 402 的开通后付费操作是连接失败时的必要修复建议。
  'provider.tokenhub.activation.hint',
  'provider.preset.zai.note',
  'provider.preset.zhipu.note',
  'provider.preset.xai.note',
  'provider.preset.ollama.note',
  'provider.test.hint.network',
  'provider.test.hint.timeout',
  'provider.test.hint.auth',
  'provider.test.hint.model_not_found',
  'provider.test.hint.protocol',
  'provider.test.hint.rate_limited',
  'provider.remove.body',
  'workspace.remove.body',
  'project.archiveSessions.body',
  'plugins.plugin.uninstall.body',
  'plugins.connector.delete.body',
  'plugins.skill.delete.body',
  'settings.storage.browserWarning',
  // 确认框里的后果：运行记录一起删掉，会话留着。
  'automations.delete.body',
  // 安全提醒：自动化无人值守，完全访问时命令与改动都不经批准。
  'automations.dialog.fullAccessWarning',
  // 安全提醒：安装脚本会在本机执行代码，确认安装前必须看到。
  'readiness.install.scriptsWarning',
  // 配置事实：中继只在直连不通时兜底，不写会以为同一网络里的流量也经过服务器。
  'settings.devices.relayNote',
  // 确认框里的后果：移除后设备断开、推送令牌删除，只能重新配对。
  'settings.devices.removeBody',
  // 安全提醒：给手机终端与审批策略的权限等于让它在这台电脑上执行命令、放开审批，授予前必须看到。
  'settings.devices.grantBody.terminal',
  'settings.devices.grantBody.policy',
  // 配置事实：第一次在局域网地址上监听时系统防火墙可能弹窗，不写会以为手机连不上是出了错。
  'settings.devices.firewallNote',
]);

/** 口语、解释腔与举例的写法。 */
const COLLOQUIAL =
  /请(?!求)|你|您|这是|这个|这条|这些|还没|一下|例如|比如|不代表|不等于|并不|只说明|只是|就是|即可|[吧呢哦啦]$/;

/** 去掉参数后的长度上限；超出的多半是在解释。 */
const MAX_LENGTH = 32;
const LONG_ALLOWED = new Set<string>([
  'history.intro',
  'hostFailure.entryMissing',
  'provider.ollama.lowContext',
]);

const entries = Object.entries(zhCN) as [string, string][];
const plain = (value: string) => value.replace(/\{[^{}]*\}/g, '');

describe('界面文案的写法', () => {
  it('不新增说明、提示、副标题一类的文案', () => {
    const added = entries
      .map(([key]) => key)
      .filter((key) => EXPLANATORY_KEY.test(key) && !EXPLANATORY_ALLOWED.has(key));
    expect(added, '界面不加说明行与提示；必须保留的写进名单并说明理由').toEqual([]);
  });

  it('名单里的 key 都还存在', () => {
    const keys = new Set(entries.map(([key]) => key));
    const stale = [...EXPLANATORY_ALLOWED, ...LONG_ALLOWED, ...MODEL_FACING].filter(
      (key) => !keys.has(key),
    );
    expect(stale).toEqual([]);
  });

  it('不用口语、举例与解释腔', () => {
    const colloquial = entries.filter(
      ([key, value]) => !isModelFacing(key) && COLLOQUIAL.test(plain(value)),
    );
    expect(colloquial, '用名词短语或短句，不写“请”“你”“这个”“例如”“不代表”').toEqual([]);
  });

  it(`去掉参数后不超过 ${MAX_LENGTH} 个字符`, () => {
    const long = entries.filter(
      ([key, value]) =>
        !LONG_ALLOWED.has(key) && !isModelFacing(key) && plain(value).length > MAX_LENGTH,
    );
    expect(long, '过长的文案多半在解释，删到只剩必要信息').toEqual([]);
  });
});
