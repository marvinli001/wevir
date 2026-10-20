// 线缆上的时间与大小约定。依据与语义见 host-api.md「连接健康」「工具输出截断上限」。

/** 连接建立后必须在此时间内完成 `host.hello`，否则以 `CloseCode.HELLO_TIMEOUT` 关闭。 */
export const HELLO_TIMEOUT_MS = 15_000;
/** client-sdk 发送 `host.ping` 的间隔。 */
export const PING_INTERVAL_MS = 10_000;
/** Host 对超过这么久没有收到任何消息的连接以 `CloseCode.LEASE_EXPIRED` 断开。 */
export const CONNECTION_LEASE_MS = 45_000;
/** 每条连接的发送缓冲上限，超限以 `CloseCode.SEND_BUFFER_OVERFLOW` 断开这一条连接。 */
export const SEND_BUFFER_LIMIT_BYTES = 8 * 1024 * 1024;

// 长度一律按 UTF-16 code unit（JS `string.length`）计，截断时不切开代理对。

/** `ToolOutput.text` 的上限；超过时保留开头与结尾各一半，中间换成省略标记。 */
export const TOOL_OUTPUT_MAX_LENGTH = 64 * 1024;
/** `input`、`engine.raw.params` 等 JSON 值里单个字符串的上限；超过时只保留开头并加省略标记。 */
export const JSON_STRING_MAX_LENGTH = 16 * 1024;
/** 字符串截断后整个 JSON 值序列化的上限；仍超过时整体换成 `TruncatedJson`。 */
export const JSON_VALUE_MAX_LENGTH = 128 * 1024;
/** `TruncatedJson.preview` 的长度。 */
export const JSON_PREVIEW_LENGTH = 4 * 1024;

/** `usage.summary` 一次最多的分桶数（`edges` 最多多一个）。 */
export const USAGE_MAX_BUCKETS = 400;
/** `usage.records` 一页最多的条数，也是省略 `limit` 时的条数。 */
export const USAGE_RECORDS_PAGE_MAX = 200;

/** 自动化 `interval` 计划的最短间隔（分钟）。 */
export const AUTOMATION_MIN_INTERVAL_MINUTES = 5;
/** 自动化标题的长度上限。 */
export const AUTOMATION_TITLE_MAX_LENGTH = 120;
/** 自动化指令的长度上限。 */
export const AUTOMATION_PROMPT_MAX_LENGTH = 20_000;
/** 每个自动化保留的运行记录条数，更早的删除。 */
export const AUTOMATION_RUNS_KEPT = 50;
/** `AutomationRun.summary` 的长度上限。 */
export const AUTOMATION_RUN_SUMMARY_MAX_LENGTH = 2_000;
/** 自动化检查脚本（0.71.0）命令的长度上限。 */
export const AUTOMATION_CHECK_COMMAND_MAX_LENGTH = 4_000;
/** 检查脚本省略 `timeoutSeconds` 时的超时（秒）。 */
export const AUTOMATION_CHECK_DEFAULT_TIMEOUT_SECONDS = 60;
/** 检查脚本超时的上限（秒）。 */
export const AUTOMATION_CHECK_MAX_TIMEOUT_SECONDS = 600;
/** `AutomationCheckResult.output` 留下的输出末尾（字符），也是唤醒时附给 Agent 的部分。 */
export const AUTOMATION_CHECK_OUTPUT_MAX_LENGTH = 8_000;
/** 连着失败几次后 Host 自动停用自动化（`Automation.autoPausedAt`）。 */
export const AUTOMATION_MAX_CONSECUTIVE_FAILURES = 3;
