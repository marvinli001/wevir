// 命令行文案的源语言目录（中文，2026-10-15）。给用户看的文字都从这里经 t() 取，命令与模块里不写字面量。
//
// 约定与桌面端的 zh-CN.ts 相同：key 是扁平的点分格式 `<区域>.<名称>`，值是纯字符串；插值写 `{name}`，t() 的类型从这里
// 推出每条文案需要哪些参数；en.ts 满足 `Messages` 类型，key 与参数以本文件为准，新增或改一条文案时同时改两种目录。
// 文案简洁、专业，错误带“下一步”；命令、选项、路径与产品名（Wevir、Host、Provider）照原样写。

export const zh = {
  'list.separator': '、',
  'list.semicolon': '；',
  'common.paren': '（{text}）',
  'common.parenAfter': '（{text}）',
  'common.colonDetail': '：{detail}',

  'error.prefix': '错误：{message}',
  'error.hint': '下一步：{hint}',

  // cli.ts：帮助与用法错误
  'cli.title': 'wevir —— Wevir 命令行客户端 {version}',
  'cli.usage': '用法：{usage}',
  'cli.mainUsage': 'wevir <命令> [选项]',
  'cli.firstSteps': '先运行 wevir host start 启动 Host，再 wevir provider add 配置模型服务。',
  'cli.globalHelp': `全局选项：
  --home <目录>    数据目录，与 Host 相同；环境变量 WEVIR_HOME 优先。默认 macOS ~/Library/Application Support/Wevir，
                   Windows %APPDATA%\\Wevir
  -h, --help       显示帮助（wevir <命令> --help 查看命令的选项）
  -v, --version    显示版本

语言：中文环境（LC_ALL、LC_MESSAGES、LANG 为 zh*）显示中文，其他显示英文；WEVIR_LANG=zh|en 优先。`,
  'cli.groupFooter': '运行 wevir {group} <子命令> --help 查看选项。',
  'group.host': 'Host',
  'group.workspace': '工作区',
  'group.provider': 'Provider（模型服务）',
  'group.session': '会话',

  'usage.seeHelp': '运行 wevir --help 查看用法',
  'usage.seeCommandHelp': '运行 wevir {command} --help 查看用法',
  'usage.seeGroupHelp': '运行 wevir {group} --help 查看',
  'usage.unknownCommand': '未知命令：{command}',
  'usage.unknownOption': '未知选项：{option}',
  'usage.badOptionValue': '选项 {option} 缺少值或不需要值',
  'usage.extraArgs': '多余的参数：{args}',
  'usage.missingArgs': '缺少参数',
  'usage.homeMissing': '--home 缺少目录',
  'usage.homeEmpty': '--home 不能为空',
  'usage.missingWorkspace': '缺少 -w <路径>',
  'usage.missingWorkspace.hint': '例如 wevir session new -w . "汇总这个目录下的 CSV"',

  'cmd.host.start.summary': '在后台启动本机 Host（关闭终端也不停止）',
  'cmd.host.start.usage': 'wevir host start [选项]',
  'cmd.host.start.help': `以分离方式启动 Host：不持有终端，CLI 退出、终端关闭都不影响它；桌面端之后附着到它，退出时也不会停止它。
已有 Host 在运行时只报告它的状态。

选项：
  --adapter <codex|dsh|echo>
                         引擎适配器，默认 codex：codex-app-server（先在仓库根目录运行
                         bash scripts/fetch-codex.sh，或用 WEVIR_CODEX_BIN 指定）；dsh 是可选引擎；
                         echo 是开发用的假引擎
  --log-level <级别>     debug | info | warn | error，默认 info（日志在 <数据目录>/logs/host.log）`,
  'cmd.host.status.summary': '查看 Host 是否在运行',
  'cmd.host.status.usage': 'wevir host status',
  'cmd.host.status.help':
    '读取 <数据目录>/run/host.json 并连上 Host 探活。Host 没有在运行时退出码为 1。',
  'cmd.host.stop.summary': '让 Host 优雅退出',
  'cmd.host.stop.usage': 'wevir host stop',
  'cmd.host.stop.help':
    '经 host.shutdown 请求 Host 优雅退出（运行中的回合会被取消），等它的进程结束。Host 没有在运行时什么也不做。',
  'cmd.workspace.add.summary': '登记一个本地文件夹为工作区',
  'cmd.workspace.add.usage': 'wevir workspace add <路径> [--name <名称>]',
  'cmd.workspace.add.help': `Host 按真实路径去重：同一个目录再次添加时返回已有的工作区。

选项：
  --name <名称>   显示名称，默认取目录名`,
  'cmd.workspace.list.summary': '列出工作区',
  'cmd.workspace.list.usage': 'wevir workspace list',
  'cmd.provider.add.summary': '添加或更新 Provider（Key 不回显、不进 shell 历史）',
  'cmd.provider.add.usage': 'wevir provider add [选项]',
  'cmd.provider.add.help': `没给的选项在终端里逐项询问。API Key 只在终端里不回显地输入，不接受命令行参数，不会写进 shell 历史；
stdin 不是终端时从 stdin 读一行作为 Key。同一个 ID 再次添加即更新（直接回车保留已存的 Key）。

选项：
  --kind <类型>            deepseek-official（DeepSeek 官方）或 openai-compatible（OpenAI 兼容地址）
  --id <ID>                openai-compatible 的 ID（小写字母开头，可含数字与 -；创建后不能改）
  --name <名称>            显示名称
  --api <协议>             openai-completions（默认）或 openai-responses
  --base-url <地址>        服务地址，例如 https://api.moonshot.cn/v1
  --model <模型 ID>        默认模型
  --context-window <数>    模型的上下文长度（token）
  --no-key                 不设置 Key（保留已存的）

示例：
  wevir provider add --kind deepseek-official
  wevir provider add --kind openai-compatible --id kimi --base-url https://api.moonshot.cn/v1 --model kimi-k2.6`,
  'cmd.provider.list.summary': '列出 Provider',
  'cmd.provider.list.usage': 'wevir provider list',
  'cmd.provider.test.summary': '用一次最小请求测试 Provider 的连接',
  'cmd.provider.test.usage': 'wevir provider test [<ID>] [--model <模型 ID>]',
  'cmd.provider.test.help': `只有一个 Provider 时可以省略 ID。会真实地向服务发一次很小的请求。

选项：
  --model <模型 ID>   测试这个模型，默认是 Provider 的默认模型`,
  'cmd.provider.login.summary': '用设备码登录 ChatGPT 账号（只限个人在本机使用）',
  'cmd.provider.login.usage': 'wevir provider login [chatgpt]',
  'cmd.provider.login.help': `用 ChatGPT 订阅登录 Host 的 Codex 引擎：打印一个网址与一次性码，在任意设备的浏览器里打开网址、登录
ChatGPT 并输入这个码。登录走 OpenAI 自己的 Codex 登录流程，凭据只存在本机的 Codex 目录里，Wevir 不读取、
不转交；按 OpenAI 的条款只供个人在本机使用 Wevir 时登录。登录成功后多出一个 ID 为 chatgpt 的 Provider。
Ctrl-C 取消登录。`,
  'cmd.provider.status.summary': '查看 ChatGPT 账号：是否登录、账号、套餐与用量',
  'cmd.provider.status.usage': 'wevir provider status [chatgpt]',
  'cmd.provider.logout.summary': '登出 ChatGPT 账号（删除本机凭据）',
  'cmd.provider.logout.usage': 'wevir provider logout [chatgpt]',
  'cmd.provider.logout.help':
    '删除本机的 ChatGPT 凭据并尽力吊销令牌。chatgpt Provider 与用它的会话保留，重新登录后可以继续。',
  'cmd.session.new.summary': '新建会话、发送提示并进入 attach',
  'cmd.session.new.usage': 'wevir session new -w <路径> [选项] "<提示>"',
  'cmd.session.new.help': `目录还不是工作区时自动登记。默认发送后进入 attach（实时输出、交互式审批、继续对话）。

选项：
  -w, --workspace <路径>   会话的工作区目录（必填）
  --provider <ID>          使用的 Provider；只有一个时可省略
  --model <模型 ID>        默认用 Provider 的默认模型
  --detach                 只创建并发送，不进入 attach`,
  'cmd.session.list.summary': '列出会话',
  'cmd.session.list.usage': 'wevir session list [-w <路径>]',
  'cmd.session.list.help': `选项：
  -w, --workspace <路径>   只列这个工作区的会话`,
  'cmd.session.attach.summary': '连到会话：实时输出、审批、继续对话',
  'cmd.session.attach.usage': 'wevir session attach <会话 ID>',
  'cmd.session.attach.help': `从头回放会话历史，然后实时显示助手输出与工具调用；遇到审批时在输入框里选择（另一端先处理时显示处理者）。
会话空闲时在输入框里输入并回车即继续对话。会话 ID 可以只写开头几位（唯一即可）。

按键：
  Enter    发送消息 / 回答审批
  Ctrl-C   回合运行中：第一次取消当前运行，第二次退出 attach；空闲时连按两次退出
  Ctrl-D   退出 attach（会话保留在 Host 中）`,

  // errors.ts：describeError
  'err.hostNotRunning': 'Wevir Host 没有在运行。',
  'err.hostNotRunning.hint': '先运行 wevir host start',
  'err.hostStarting': 'Wevir Host 正在启动，还不能连接。',
  'err.hostStarting.hint': '稍等几秒再试，或运行 wevir host status 查看',
  'err.runtimeFile': '读不了 Host 的运行时文件 {path}。',
  'err.runtimeFile.hint':
    '运行 wevir host status 检查；确认没有 Host 在运行后删除该文件，再 wevir host start',
  'err.connectTimeout': '{seconds} s 内没能连上 Host。',
  'err.connectTimeout.hint':
    '运行 wevir host status 检查 Host 是否卡住；必要时 wevir host stop 后再 wevir host start',
  'err.connectionLost': '与 Host 的连接断开了。',
  'err.connectionLost.hint': '运行 wevir host status 检查 Host 是否还在运行',
  'err.clientClosed': '与 Host 的连接已关闭。',
  'err.requestTimeout': '请求 {method} 在 {seconds} s 内没有得到响应。',
  'err.requestTimeout.sent': 'Host 可能仍在处理；运行 wevir host status 检查',
  'err.requestTimeout.unsent': '一直没连上 Host；运行 wevir host status 检查',
  'err.protocol': 'Host 的响应不合协议：{message}',
  'err.protocol.hint':
    '确认 CLI 与 Host 来自同一次构建（pnpm build 后 wevir host stop && wevir host start）',
  'err.featureUnavailable': 'Host {version} 不支持 {feature}。',
  'err.featureUnavailable.hint': '升级 Wevir Host',
  'err.unauthorized': 'Host 拒绝了令牌。',
  'err.unauthorized.hint': 'run/host.json 可能来自另一次启动；运行 wevir host status 检查',
  'err.incompatible':
    'CLI（协议 {cliProtocol}）与 Host {hostVersion}（协议 {hostProtocol}，最低 {minProtocol}）不兼容。',
  'err.incompatibleUnknown': 'CLI（协议 {cliProtocol}）与 Host 的协议不兼容。',
  'err.incompatible.hint':
    '用同一版本的 CLI 与 Host：pnpm build 后 wevir host stop && wevir host start',
  'err.shuttingDown': 'Host 正在退出。',
  'err.shuttingDown.hint': '等它退出后运行 wevir host start',
  'err.workspaceNotFound': '工作区不存在。',
  'err.workspaceNotFound.hint': '运行 wevir workspace list 查看',
  'err.providerNotFound': 'Provider 不存在。',
  'err.providerNotFound.hint': '运行 wevir provider list 查看，或 wevir provider add 添加',
  'err.sessionNotFound': '会话不存在。',
  'err.sessionNotFound.hint': '运行 wevir session list 查看',
  'err.approvalNotFound': '这条审批不存在。',
  'err.readOnly': '会话只读：{reason}（{message}）。',
  'err.readOnly.hint': '历史仍可用 wevir session attach 查看；要继续对话请新建会话',
  'err.invalidState': '会话处于“{state}”状态，不能执行这个操作。',
  'err.invalidStateUnknown': '会话当前的状态不允许这个操作。',
  'err.busy': '会话正忙（{state}），这条消息没有发出。',
  'err.busy.hint': '等本轮结束再发送，或在 attach 中按 Ctrl-C 取消当前运行',
  'err.alreadyDecided': '这条审批已经处理过了。',
  'err.messageConflict': '同一个消息 ID 已用于另一条内容。',
  'err.resourceInUse': '还有未关闭的会话在使用它。',
  'err.resourceInUseIds': '还有未关闭的会话在使用它：{ids}。',
  'err.workspacePath': '工作区目录{reason}：{path}。',
  'err.workspacePathUnknown': '工作区目录不可用。',
  'err.workspacePath.not_absolute': '不是绝对路径',
  'err.workspacePath.not_found': '不存在',
  'err.workspacePath.not_directory': '不是目录',
  'err.workspacePath.not_accessible': '无法访问',
  'err.workspacePath.hint': '检查路径；目录被移动过时用新路径重新 wevir workspace add',
  'err.engine': '引擎错误：{message}',
  'err.engineCategory': '引擎错误（{category}）：{message}',
  'err.invalidParams': '参数不合法：{issues}',
  'err.invalidParams.root': '(根)',
  'err.methodNotFound': 'Host 不认识这个请求：{message}',
  'err.host': 'Host 返回错误：{message}',

  // format.ts：协议里的值
  'state.idle': '空闲',
  'state.running': '运行中',
  'state.awaiting_approval': '待审批',
  'state.cancelling': '正在取消',
  'state.error': '出错',
  'state.closed': '已关闭',
  'state.readOnly': '只读',
  'turnOutcome.completed': '完成',
  'turnOutcome.cancelled': '已取消',
  'turnOutcome.failed': '失败',
  'turnOutcome.interrupted': '中断',
  'subagentEnd.completed': '完成',
  'subagentEnd.failed': '失败',
  'subagentEnd.closed': '已关闭',
  'subagentEnd.cancelled': '已取消',
  'toolStatus.completed': '完成',
  'toolStatus.failed': '失败',
  'toolStatus.cancelled': '已取消',
  'toolStatus.unknown': '状态未知',
  'stateReason.engine_exited': '引擎进程退出',
  'stateReason.cancel_unconfirmed': '取消没有得到引擎确认',
  'stateReason.resume_failed': '恢复引擎会话失败',
  'stateReason.host_restarted': 'Host 重启时回合被中断',
  'stateReason.turn_finished': '回合失败',
  'engineError.missing_credentials': '缺少凭据',
  'engineError.provider': 'Provider 错误',
  'engineError.engine_exited': '引擎退出',
  'engineError.cancel_unconfirmed': '取消未确认',
  'engineError.session_unavailable': '引擎会话不可用',
  'engineError.unknown': '未知错误',
  'engineHint.missing_credentials':
    '这个 Provider 没有可用的 Key：运行 wevir provider add 重新设置',
  'engineHint.provider': 'Provider 返回了错误：运行 wevir provider test 检查地址、模型与 Key',
  'engineHint.engine_exited':
    '引擎进程退出了：再发一条消息会自动恢复会话；反复出现时查看 Host 日志（<数据目录>/logs/host.log）',
  'engineHint.cancel_unconfirmed': '取消没有得到引擎确认，引擎已重启：再发一条消息会自动恢复会话',
  'engineHint.session_unavailable': '引擎会话暂时不可用：稍后再发一次；仍不行时查看 Host 日志',
  'engineHint.unknown': '查看 Host 日志（<数据目录>/logs/host.log）了解详情',
  'readOnly.engine_session_not_found': '引擎找不到这个会话（引擎数据目录可能被清理过）',
  'readOnly.engine_session_incompatible': '当前引擎版本读不了这个会话的格式',
  'readOnly.engine_session_corrupted': '引擎的会话日志已损坏',
  'approvalEnd.turn_cancelled': '审批已取消（回合被取消）',
  'approvalEnd.session_closed': '审批已取消（会话已关闭）',
  'approvalEnd.engine_exited': '审批已取消（引擎退出）',
  'approvalEnd.host_shutdown': '审批已取消（Host 退出）',
  'approvalEnd.host_restarted': '审批已过期（Host 重启过）',
  'providerTest.missing_key': '没有 Key',
  'providerTest.network': '连不上',
  'providerTest.timeout': '超时',
  'providerTest.auth': '认证失败',
  'providerTest.model_not_found': '模型不存在',
  'providerTest.protocol': '协议不匹配',
  'providerTest.rate_limited': '被限流',
  'providerTest.server': '服务端错误',
  'providerTest.unknown': '未知错误',
  'providerHint.missing_key': '没有存 Key：运行 wevir provider add，填同一个 ID 并输入 Key',
  'providerHint.network': '连不上服务地址：检查地址（baseURL）与网络、代理',
  'providerHint.timeout': '服务在时限内没有响应：稍后重试，或检查网络',
  'providerHint.auth': 'Key 无效或没有权限：运行 wevir provider add 更新 Key',
  'providerHint.model_not_found':
    '服务端没有这个模型：用 --model 换一个，或运行 wevir provider add 修改默认模型',
  'providerHint.protocol': '地址能连上，但不按所选协议应答：检查地址（通常以 /v1 结尾）与协议',
  'providerHint.rate_limited': '被限流或额度用完：稍后重试，或检查账户余额',
  'providerHint.server': '服务端出错（5xx）：稍后重试',
  'providerHint.unknown': '看上面的错误原文',
  'option.allowOnce': '允许一次',
  'option.allowAlways': '总是允许',
  'option.rejectOnce': '拒绝',
  'option.rejectAlways': '总是拒绝',
  'time.minutes': '{minutes} 分 {seconds} 秒',

  // render.ts：会话事件
  'render.liveDivider': '── 以上为历史，以下为实时 ──',
  'render.reset': 'Host 上的会话历史与本地看到的不一致，重新回放。',
  'render.resumed': '（引擎会话已恢复）',
  'render.resumedVersion': '（引擎会话已恢复，{version}）',
  'render.readOnly': '会话只读：{reason}（{message}）',
  'render.readOnlyHint': '历史仍可查看；要继续对话请新建会话。',
  'render.sessionError': '会话出错。再发一条消息会尝试恢复。',
  'render.sessionErrorWhy': '会话出错：{why}。再发一条消息会尝试恢复。',
  'render.sessionClosed': '会话已关闭。',
  'render.question': '? Agent 提问（请在桌面端回答）',
  'render.questionWithHeader': '{header}：{question}',
  'render.questionCancelled': '提问已取消',
  'render.answerSkipped': '（跳过）',
  'render.answered': '✓ 已回答：{answers}',
  'render.turnFinished': '── 本轮{outcome} · {duration} ──',
  'render.from': '（来自 {client}）',
  'render.steerEchoed': '（插话已插进本回合）',
  'render.steerTag': '（插话）',
  'render.steerTagFrom': '（插话，来自 {client}）',
  'render.pendingSteer': '插话：等这一步结束后插进本回合',
  'render.pendingQueued': '已排队：本回合结束后发出',
  'render.pendingHeld': '已暂停 · {text}（输入 /resume 继续发送）',
  'render.pendingCancelled': '已删除待发消息 · {text}',
  'pendingFallback.unsupported': '这个引擎不能插话，已转为排队',
  'pendingFallback.rejected': '模型这一轮不能插话，已转为排队',
  'pendingFallback.turn_ended': '这一轮结束时还没插进去，已转为排队',
  'render.thinking': '思考：',
  'render.thoughtCollapsed': '（思考过程 {count} 字，已折叠）',
  'render.abandoned': '（上面这段输出被模型放弃，以后续内容为准）',
  'render.tool': '工具',
  'render.subagent': '子 agent',
  'render.subagentStarted': '子 agent 开始工作：{title}{model}',
  'render.subagentResumed': '子 agent 继续工作：{title}',
  'render.subagentEnded': '↳ 子 agent {status}：',
  'render.subagentApprovalEnded': '（子 agent {title} 的审批已结束）',
  'render.oneToolCall': '一次工具调用',
  'render.approvalFromSubagent': '（来自子 agent {title}）',
  'render.approvalNeeded': '⚠ 需要审批{from}：{what}',
  'render.justification': '理由：{text}',
  'render.sandboxPermissions': '申请权限：{text}',
  'render.options': '选项：{options}',
  'render.decidedHere': '✓ 本终端已处理：{decision}',
  'render.decidedBy': '✓ 已由 {client} 处理：{decision}',
  'render.decided': '✓ 已处理：{decision}',

  // attach.ts
  'attach.busyPrompt.steer': '插话 › ',
  'attach.busyPrompt.queue': '排队 › ',
  'attach.delivery.steer': '插话',
  'attach.delivery.queue': '排队',
  'attach.approvalPrompt': '审批 [{options}] › ',
  'attach.reconnecting':
    '与 Host 的连接断开，正在重连…（Host 已停止时，在另一个终端运行 wevir host start）',
  'attach.reconnected': '已重新连接到 Host。',
  'attach.exited': '已退出 attach。会话保留在 Host 中，重新连接：wevir session attach {id}',
  'attach.exitedBusy':
    '已退出 attach，当前运行仍在继续。会话保留在 Host 中，重新连接：wevir session attach {id}',
  'attach.header': '会话 {id} · {state}{title}',
  'attach.headerDetail': '工作区 {cwd} · 模型 {model}',
  'attach.keys': 'Enter 发送 · Ctrl-C 取消当前运行（连按两次退出 attach） · Ctrl-D 退出 attach',
  'attach.keysBusy':
    '回合进行中：Enter 按设置插话或排队、Tab 用另一种 · /resume 继续发送暂停的消息',
  'attach.readOnly': '这个会话是只读的：可以查看历史，不能再发送消息。',
  'attach.errorState': '会话处于出错状态；发送消息时会先尝试恢复。',
  'attach.held': '有 {count} 条暂停的待发消息（上一轮没有正常结束）；输入 /resume 继续发送。',
  'attach.inputEnded': '输入已结束，这条审批请在另一个终端处理：wevir session attach {id}',
  'attach.noHeld': '没有暂停的待发消息。',
  'attach.resumingHeld': '继续发送暂停的消息。',
  'attach.recovering': '会话需要先恢复，正在恢复…',
  'attach.answerHint': '输入选项序号（1–{count}），或 y 允许、n 拒绝。',
  'attach.cancellingAgain': '正在取消…（再按一次 Ctrl-C 退出 attach）',
  'attach.cancelling': '正在取消当前运行…（再按一次 Ctrl-C 退出 attach）',
  'attach.pressAgain': '再按一次 Ctrl-C 退出 attach（会话保留在 Host 中），或按 Ctrl-D。',

  // commands/session.ts
  'session.detachNeedsPrompt': '--detach 需要同时给出提示',
  'session.detachNeedsPrompt.hint': '例如 wevir session new -w . --detach "整理一下 README"',
  'session.workspaceAdded': '已添加工作区 {name}（{path}）',
  'session.created': '已创建会话 {id}',
  'session.sent': '已发送。查看输出：wevir session attach {id}',
  'session.noSuchProvider': '没有 ID 为 {id} 的 Provider。',
  'session.noSuchProvider.hint': '运行 wevir provider list 查看',
  'session.noProviders': '还没有配置 Provider。',
  'session.noProviders.hint': '先运行 wevir provider add',
  'session.manyProviders': '有 {count} 个 Provider，用 --provider 指定：{ids}',
  'session.notWorkspace': '{path} 还不是工作区。',
  'session.notWorkspace.hint': '运行 wevir workspace list 查看已登记的工作区',
  'session.none': '还没有会话。',
  'session.none.hint': 'wevir session new -w <路径> "<提示>"',
  'session.col.id': '会话 ID',
  'session.col.state': '状态',
  'session.col.title': '标题',
  'session.col.workspace': '工作区',
  'session.col.model': '模型',
  'session.col.events': '事件',
  'session.col.updated': '更新于',
  'session.untitled': '（无标题）',
  'session.notFound': '找不到会话 {id}。',
  'session.ambiguous': '{id} 对应多个会话：{ids}。',
  'session.ambiguousMore': '{id} 对应多个会话：{ids} 等。',
  'session.ambiguous.hint': '写全会话 ID',

  // commands/workspace.ts
  'workspace.added': '已添加工作区：{name}（{id}）',
  'workspace.exists': '工作区已存在：{name}（{id}）',
  'workspace.none': '还没有工作区。',
  'workspace.none.hint': 'wevir workspace add <路径>',
  'workspace.col.name': '名称',
  'workspace.col.path': '路径',
  'workspace.col.added': '添加于',

  // commands/host.ts
  'host.noBin': '{path} 里没有 bin.wevir-host',
  'host.noEntry': '找不到 Host 的可执行入口 {path}。',
  'host.noEntry.hint': '先在仓库根目录运行 pnpm build',
  'host.invalidRuntime': '运行时文件 {path} 的内容不对。',
  'host.invalidRuntime.hint': '确认没有 Host 在运行后删除它，再运行 wevir host start',
  'host.invalidRuntime.stopHint': '运行 wevir host status 查看',
  'host.alreadyRunning': 'Host 已在运行：pid {pid} · Host {version}',
  'host.dataDir': '数据目录 {path}',
  'host.logFile': '日志 {path}',
  'host.unreachable': 'Host 进程（pid {pid}）在运行，但连不上：{error}',
  'host.unreachable.startHint': '查看日志 {log}；必要时结束该进程后再运行 wevir host start',
  'host.unreachable.statusHint': '查看日志 {log}',
  'host.waitingStart': 'Host 正在启动（pid {pid}），等待它就绪…',
  'host.started': 'Host 已启动：pid {pid} · Host {version} · 协议 {protocol}',
  'host.spawnFailed': '无法启动 Host：{error}',
  'host.startFailed': 'Host 启动失败（{why}）。{tail}',
  'host.startFailed.signal': '信号 {signal}',
  'host.startFailed.exitCode': '退出码 {code}',
  'host.startFailed.hint': '完整输出见 {stdio} 与 logs/host.log',
  'host.notReady': 'Host 在 {seconds} s 内没有就绪。',
  'host.notReadyWhy': 'Host 在 {seconds} s 内没有就绪（{error}）。',
  'host.seeLog': '查看 {log}',
  'host.notRunning': 'Host 没有在运行。',
  'host.notRunning.hint': '运行 wevir host start',
  'host.stale': 'Host 没有在运行（pid {pid} 已退出，运行时文件是它留下的）。',
  'host.stale.hint': '运行 wevir host start（会自动清理旧文件）',
  'host.starting': 'Host 正在启动（pid {pid}）。',
  'host.starting.stopHint': '等它就绪后再运行 wevir host stop',
  'host.running': 'Host 运行中',
  'host.row.pidValue': '{pid}（启动于 {time}）',
  'host.row.address': '地址',
  'host.row.version': '版本',
  'host.row.versionValue': 'Host {version} · 协议 {protocol}',
  'host.row.latency': '响应',
  'host.row.dataDir': '数据目录',
  'host.stopping': 'Host（pid {pid}）正在退出…',
  'host.stopped': 'Host 已停止。',
  'host.stopTimeout': 'Host（pid {pid}）在 {seconds} s 内没有退出。',
  'host.stopTimeout.hint': '查看 {log}；仍不退出时手动结束该进程',

  // commands/provider.ts
  'provider.flagProblem': '--{flag}：{problem}',
  'provider.missingFlag': '缺少 --{flag}',
  'provider.missingFlag.hint': '在终端里交互运行 wevir provider add，或用选项给出各项',
  'provider.empty': '不能为空',
  'provider.chatgpt': 'ChatGPT 账号不用 provider add',
  'provider.chatgpt.hint': '运行 wevir provider login',
  'provider.badKind': '--kind 只能是 deepseek-official 或 openai-compatible：{kind}',
  'provider.missingKind': '缺少 --kind（deepseek-official 或 openai-compatible）',
  'provider.kindQuestion': 'Provider 类型：',
  'provider.kind.deepseek': 'DeepSeek 官方（deepseek-official）',
  'provider.kind.compatible': 'OpenAI 兼容地址（通义千问、Kimi、智谱、本机模型服务等）',
  'provider.fixedId': 'DeepSeek 官方 Provider 的 ID 固定为 {id}',
  'provider.ask.name': '显示名称 ',
  'provider.ask.deepseekModel': '默认模型（deepseek-flash 或 deepseek-v4-pro）',
  'provider.ask.id': 'Provider ID（小写字母开头，可含数字与 -；创建后不能改）：',
  'provider.ask.api': '协议（openai-completions 或 openai-responses）',
  'provider.ask.baseUrl': '服务地址（例如 https://api.moonshot.cn/v1）',
  'provider.ask.model': '默认模型 ID ',
  'provider.ask.contextWindow': '上下文长度（token，可留空）',
  'provider.ask.key': 'API Key（输入不显示）：',
  'provider.ask.keyKeep': 'API Key（输入不显示；直接回车保留已存的 Key）：',
  'provider.badId': '只能用小写字母、数字和 -，以字母开头，最长 32 个字符',
  'provider.reservedId': '{id} 已被 dsh 占用，换一个 ID',
  'provider.idTaken': 'ID {id} 已被一个 {kind} 类型的 Provider 使用。',
  'provider.badApi': '只能是 openai-completions 或 openai-responses',
  'provider.engineFailed': 'Provider 已保存，但引擎没能用上新配置：{error}',
  'provider.engineFailed.hint': '查看 Host 日志 logs/host.log；改正后再运行一次 wevir provider add',
  'provider.added': '已添加 Provider {id}（{name}，默认模型 {model}，Key {key}）',
  'provider.updated': '已更新 Provider {id}（{name}，默认模型 {model}，Key {key}）',
  'provider.key.set': '已设置',
  'provider.key.unset': '未设置',
  'provider.noKeyWarning': '还没有设置 Key：需要 Key 的服务会话会因缺少凭据而失败。',
  'provider.url.scheme': '只支持 http / https 地址',
  'provider.url.extras': '地址不能带用户名、密码、查询参数或 #',
  'provider.url.invalid': '不是合法的地址',
  'provider.badContextWindow': '上下文长度必须是正整数：{text}',
  'provider.none': '还没有 Provider。',
  'provider.none.hint': 'wevir provider add',
  'provider.col.name': '名称',
  'provider.col.kind': '类型',
  'provider.col.model': '默认模型',
  'provider.col.address': '地址',
  'provider.chatgptLogin': 'ChatGPT 登录',
  'provider.subscriptionLogin': '订阅登录',
  'provider.officialAddress': '（官方默认）',
  'provider.manyToTest': '有 {count} 个 Provider，指定要测试哪一个：{ids}',
  'provider.manyToTest.hint': '例如 wevir provider test <ID>',
  'provider.testing': '正在测试 {id}…',
  'provider.testingModel': '正在测试 {id}（模型 {model}）…',
  'provider.testOk': '✓ 连接正常',
  'provider.testOkLatency': '✓ 连接正常，用时 {ms} ms',
  'provider.testFailed': '✗ 测试失败（{reason}）',
  'provider.testFailedHttp': '✗ 测试失败（{reason}，HTTP {status}）',

  // commands/account.ts
  'account.unknownKind': '不认识的账号：{kind}',
  'account.unknownKind.hint': '现在只有 chatgpt',
  'account.terms':
    '仅供个人在本机使用 Wevir 时登录：登录走 OpenAI 自己的 Codex 登录流程，凭据只存在本机，Wevir 不读取、不转交。',
  'account.alreadySignedIn': '已经登录 ChatGPT：{account}',
  'account.alreadySignedIn.hint': '要换账号，先运行 wevir provider logout',
  'account.noDeviceCode': 'Host 没有给出设备码',
  'account.noDeviceCode.hint': '稍后重试，或在桌面端的设置里登录',
  'account.step1': '1. 在浏览器里打开 {url} 并登录 ChatGPT',
  'account.step2': '2. 输入一次性码 {code}（15 分钟内有效）',
  'account.codeWarning': '这个码是你刚在 Wevir 里发起的登录；不是自己发起的，不要输入。',
  'account.waiting': '等待完成…（Ctrl-C 取消）',
  'account.loginCancelled': '已取消登录。',
  'account.replaced': '登录被另一处发起的登录替换了',
  'account.retry.hint': '重新运行 wevir provider login',
  'account.signedIn': '✓ 已登录 ChatGPT：{account}',
  'account.signedIn.hint': 'wevir session new -w <路径> --provider chatgpt "<提示>"',
  'account.loginFailed': '登录没有成功：{error}',
  'account.cancelled': '已取消',
  'account.status.signedIn': 'ChatGPT：已登录 {account}',
  'account.status.signingIn': 'ChatGPT：登录中（在桌面端或另一个终端发起）',
  'account.status.signedOut': 'ChatGPT：没有登录',
  'account.status.lastError': '上次登录失败：{error}',
  'account.status.signedOut.hint': 'wevir provider login',
  'account.loggedOut':
    '已登出 ChatGPT（本机的凭据已删除）。用 ChatGPT 的会话要重新登录后才能继续。',
  'account.unsupported': '这个 Host 没有 ChatGPT 账号（只有 Codex 引擎有）',
  'account.unsupported.hint':
    '用默认的 Codex 引擎重新启动 Host：wevir host stop && wevir host start',
  'account.unknownEmail': '（邮箱未知）',
  'account.window.usage': '用量',
  'account.window.weekly': '每周',
  'account.window.days': '{count} 天窗口',
  'account.window.hours': '{count} 小时窗口',
  'account.window.minutes': '{count} 分钟窗口',
  'account.window.used': '{span}已用 {percent}%',
  'account.window.resets': '{usage}，{time} 重置',
  'account.window.date': '{month} 月 {day} 日 {time}',

  // prompt.ts
  'prompt.cancelled': '已取消。',
  'prompt.choose': '请选择 ',
  'prompt.invalidChoice': '无效的选择：{answer}',
  'prompt.chooseRange': '请输入 1–{count} 之间的数字。',
  'prompt.inputEnded': '输入已结束，没有读到需要的内容。',
  'prompt.inputEnded.hint': '在终端里交互运行，或用选项给出各项',

  // identity.ts
  'identity.unwritable': '无法读写 {path}',
  'identity.invalid': '{path} 的内容不是合法的 ID',
} as const;

export type MessageKey = keyof typeof zh;
export type Messages = { readonly [K in MessageKey]: string };
