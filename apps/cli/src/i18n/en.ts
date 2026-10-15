// 命令行文案的英文目录。key 与参数以 zh.ts 为准；复数用 ICU 的 `{count, plural, …}`。

import type { Messages } from './zh.js';

export const en: Messages = {
  'list.separator': ', ',
  'list.semicolon': '; ',
  'common.paren': '({text})',
  'common.parenAfter': ' ({text})',
  'common.colonDetail': ': {detail}',

  'error.prefix': 'Error: {message}',
  'error.hint': 'Next: {hint}',

  'cli.title': 'wevir — Wevir command-line client {version}',
  'cli.usage': 'Usage: {usage}',
  'cli.mainUsage': 'wevir <command> [options]',
  'cli.firstSteps':
    'Start the Host with wevir host start, then set up a model service with wevir provider add.',
  'cli.globalHelp': `Global options:
  --home <dir>     Data directory, shared with the Host; WEVIR_HOME takes precedence. Default: macOS
                   ~/Library/Application Support/Wevir, Windows %APPDATA%\\Wevir
  -h, --help       Show help (wevir <command> --help shows a command's options)
  -v, --version    Show the version

Language: Chinese when LC_ALL, LC_MESSAGES or LANG is zh*, English otherwise; WEVIR_LANG=zh|en overrides.`,
  'cli.groupFooter': 'Run wevir {group} <command> --help for options.',
  'group.host': 'Host',
  'group.workspace': 'Workspaces',
  'group.provider': 'Providers (model services)',
  'group.session': 'Sessions',

  'usage.seeHelp': 'Run wevir --help for usage',
  'usage.seeCommandHelp': 'Run wevir {command} --help for usage',
  'usage.seeGroupHelp': 'Run wevir {group} --help for its commands',
  'usage.unknownCommand': 'Unknown command: {command}',
  'usage.unknownOption': 'Unknown option: {option}',
  'usage.badOptionValue': 'Option {option} is missing a value or does not take one',
  'usage.extraArgs': 'Unexpected argument: {args}',
  'usage.missingArgs': 'Missing argument',
  'usage.homeMissing': '--home needs a directory',
  'usage.homeEmpty': '--home cannot be empty',
  'usage.missingWorkspace': 'Missing -w <path>',
  'usage.missingWorkspace.hint':
    'For example: wevir session new -w . "Summarize the CSV files in this folder"',

  'cmd.host.start.summary':
    'Start the local Host in the background (survives closing the terminal)',
  'cmd.host.start.usage': 'wevir host start [options]',
  'cmd.host.start.help': `Starts the Host detached: it holds no terminal, so exiting the CLI or closing the terminal does not affect it;
the desktop app attaches to it later and does not stop it on quit.
If a Host is already running, only reports its status.

Options:
  --adapter <codex|dsh|echo>
                         Engine adapter, default codex: codex-app-server (run bash scripts/fetch-codex.sh
                         at the repository root first, or set WEVIR_CODEX_BIN); dsh is an optional engine;
                         echo is a fake engine for development
  --log-level <level>    debug | info | warn | error, default info (log at <data dir>/logs/host.log)`,
  'cmd.host.status.summary': 'Show whether the Host is running',
  'cmd.host.status.usage': 'wevir host status',
  'cmd.host.status.help':
    'Reads <data dir>/run/host.json and connects to the Host to check it. Exits with 1 when no Host is running.',
  'cmd.host.stop.summary': 'Shut the Host down gracefully',
  'cmd.host.stop.usage': 'wevir host stop',
  'cmd.host.stop.help':
    'Asks the Host to shut down gracefully via host.shutdown (running turns are cancelled) and waits for its process to exit. Does nothing when no Host is running.',
  'cmd.workspace.add.summary': 'Register a local folder as a workspace',
  'cmd.workspace.add.usage': 'wevir workspace add <path> [--name <name>]',
  'cmd.workspace.add.help': `The Host deduplicates by real path: adding the same folder again returns the existing workspace.

Options:
  --name <name>   Display name, defaults to the folder name`,
  'cmd.workspace.list.summary': 'List workspaces',
  'cmd.workspace.list.usage': 'wevir workspace list',
  'cmd.provider.add.summary':
    'Add or update a provider (the key is never echoed or kept in shell history)',
  'cmd.provider.add.usage': 'wevir provider add [options]',
  'cmd.provider.add.help': `Prompts in the terminal for every option not given. The API key is only entered in the terminal without echo,
never as a command-line argument, so it stays out of shell history; when stdin is not a terminal, one line of
stdin is read as the key. Adding the same ID again updates it (press Enter to keep the stored key).

Options:
  --kind <kind>              deepseek-official (DeepSeek official) or openai-compatible (OpenAI-compatible endpoint)
  --id <ID>                  ID for openai-compatible (starts with a lowercase letter; letters, digits and -;
                             cannot be changed later)
  --name <name>              Display name
  --api <protocol>           openai-completions (default) or openai-responses
  --base-url <address>       Service address, for example https://api.moonshot.cn/v1
  --model <model ID>         Default model
  --context-window <tokens>  The model's context window
  --no-key                   Do not set a key (keep the stored one)

Examples:
  wevir provider add --kind deepseek-official
  wevir provider add --kind openai-compatible --id kimi --base-url https://api.moonshot.cn/v1 --model kimi-k2.6`,
  'cmd.provider.list.summary': 'List providers',
  'cmd.provider.list.usage': 'wevir provider list',
  'cmd.provider.test.summary': "Test a provider's connection with a minimal request",
  'cmd.provider.test.usage': 'wevir provider test [<ID>] [--model <model ID>]',
  'cmd.provider.test.help': `The ID can be omitted when there is only one provider. Sends one small real request to the service.

Options:
  --model <model ID>   Test this model instead of the provider's default model`,
  'cmd.provider.login.summary':
    'Sign in to ChatGPT with a device code (personal use on this machine only)',
  'cmd.provider.login.usage': 'wevir provider login [chatgpt]',
  'cmd.provider.login.help': `Signs the Host's Codex engine in with a ChatGPT subscription: prints a URL and a one-time code; open the URL
in a browser on any device, sign in to ChatGPT and enter the code. Sign-in uses OpenAI's own Codex flow, the
credentials stay in the Codex directory on this machine, and Wevir neither reads nor forwards them; under
OpenAI's terms, sign in only for your personal use of Wevir on this machine. After sign-in, a provider with
the ID chatgpt appears. Ctrl-C cancels the sign-in.`,
  'cmd.provider.status.summary': 'Show the ChatGPT account: sign-in, account, plan and usage',
  'cmd.provider.status.usage': 'wevir provider status [chatgpt]',
  'cmd.provider.logout.summary': 'Sign out of ChatGPT (deletes local credentials)',
  'cmd.provider.logout.usage': 'wevir provider logout [chatgpt]',
  'cmd.provider.logout.help':
    'Deletes the local ChatGPT credentials and tries to revoke the tokens. The chatgpt provider and its sessions are kept and continue after you sign in again.',
  'cmd.session.new.summary': 'Create a session, send a prompt and attach',
  'cmd.session.new.usage': 'wevir session new -w <path> [options] "<prompt>"',
  'cmd.session.new.help': `Registers the folder as a workspace if needed. By default attaches after sending (live output, interactive
approvals, follow-up messages).

Options:
  -w, --workspace <path>   The session's workspace folder (required)
  --provider <ID>          Provider to use; optional when there is only one
  --model <model ID>       Defaults to the provider's default model
  --detach                 Only create the session and send, without attaching`,
  'cmd.session.list.summary': 'List sessions',
  'cmd.session.list.usage': 'wevir session list [-w <path>]',
  'cmd.session.list.help': `Options:
  -w, --workspace <path>   Only list sessions in this workspace`,
  'cmd.session.attach.summary': 'Attach to a session: live output, approvals, follow-ups',
  'cmd.session.attach.usage': 'wevir session attach <session ID>',
  'cmd.session.attach.help': `Replays the session history from the start, then shows assistant output and tool calls live; approvals are
answered in the input line (if another client answers first, shows who). When the session is idle, type in the
input line and press Enter to continue. A unique prefix of the session ID is enough.

Keys:
  Enter    Send a message / answer an approval
  Ctrl-C   During a run: first press cancels the run, second leaves attach; when idle, press twice to leave
  Ctrl-D   Leave attach (the session stays on the Host)`,

  'err.hostNotRunning': 'Wevir Host is not running.',
  'err.hostNotRunning.hint': 'Run wevir host start first',
  'err.hostStarting': 'Wevir Host is starting and cannot accept connections yet.',
  'err.hostStarting.hint': 'Try again in a few seconds, or run wevir host status',
  'err.runtimeFile': 'Cannot read the Host runtime file {path}.',
  'err.runtimeFile.hint':
    'Run wevir host status; once no Host is running, delete the file and run wevir host start',
  'err.connectTimeout': 'Could not connect to the Host within {seconds} s.',
  'err.connectTimeout.hint':
    'Run wevir host status to check whether the Host is stuck; if needed, run wevir host stop, then wevir host start',
  'err.connectionLost': 'Lost the connection to the Host.',
  'err.connectionLost.hint': 'Run wevir host status to check whether the Host is still running',
  'err.clientClosed': 'The connection to the Host is closed.',
  'err.requestTimeout': 'Request {method} got no response within {seconds} s.',
  'err.requestTimeout.sent': 'The Host may still be processing it; run wevir host status',
  'err.requestTimeout.unsent': 'Never connected to the Host; run wevir host status',
  'err.protocol': 'The Host response violates the protocol: {message}',
  'err.protocol.hint':
    'Make sure the CLI and Host come from the same build (pnpm build, then wevir host stop && wevir host start)',
  'err.featureUnavailable': 'Host {version} does not support {feature}.',
  'err.featureUnavailable.hint': 'Upgrade the Wevir Host',
  'err.unauthorized': 'The Host rejected the token.',
  'err.unauthorized.hint': 'run/host.json may be from another launch; run wevir host status',
  'err.incompatible':
    'The CLI (protocol {cliProtocol}) is incompatible with Host {hostVersion} (protocol {hostProtocol}, minimum {minProtocol}).',
  'err.incompatibleUnknown':
    'The CLI (protocol {cliProtocol}) is incompatible with the Host protocol.',
  'err.incompatible.hint':
    'Use the same version of the CLI and Host: pnpm build, then wevir host stop && wevir host start',
  'err.shuttingDown': 'The Host is shutting down.',
  'err.shuttingDown.hint': 'Run wevir host start once it has exited',
  'err.workspaceNotFound': 'Workspace not found.',
  'err.workspaceNotFound.hint': 'Run wevir workspace list',
  'err.providerNotFound': 'Provider not found.',
  'err.providerNotFound.hint': 'Run wevir provider list, or add one with wevir provider add',
  'err.sessionNotFound': 'Session not found.',
  'err.sessionNotFound.hint': 'Run wevir session list',
  'err.approvalNotFound': 'Approval not found.',
  'err.readOnly': 'The session is read-only: {reason} ({message}).',
  'err.readOnly.hint':
    'The history is still available with wevir session attach; start a new session to continue',
  'err.invalidState': 'Not allowed while the session is “{state}”.',
  'err.invalidStateUnknown': "The session's current state does not allow this operation.",
  'err.busy': 'The session is busy ({state}); the message was not sent.',
  'err.busy.hint':
    'Send it after this turn ends, or press Ctrl-C in attach to cancel the current run',
  'err.alreadyDecided': 'This approval has already been handled.',
  'err.messageConflict': 'This message ID is already used for different content.',
  'err.resourceInUse': 'Open sessions are still using it.',
  'err.resourceInUseIds': 'Open sessions are still using it: {ids}.',
  'err.workspacePath': 'The workspace folder {reason}: {path}.',
  'err.workspacePathUnknown': 'The workspace folder is unavailable.',
  'err.workspacePath.not_absolute': 'is not an absolute path',
  'err.workspacePath.not_found': 'does not exist',
  'err.workspacePath.not_directory': 'is not a folder',
  'err.workspacePath.not_accessible': 'is not accessible',
  'err.workspacePath.hint':
    'Check the path; if the folder moved, run wevir workspace add with the new path',
  'err.engine': 'Engine error: {message}',
  'err.engineCategory': 'Engine error ({category}): {message}',
  'err.invalidParams': 'Invalid parameters: {issues}',
  'err.invalidParams.root': '(root)',
  'err.methodNotFound': 'The Host does not recognize this request: {message}',
  'err.host': 'The Host returned an error: {message}',

  'state.idle': 'Idle',
  'state.running': 'Running',
  'state.awaiting_approval': 'Awaiting approval',
  'state.cancelling': 'Cancelling',
  'state.error': 'Error',
  'state.closed': 'Closed',
  'state.readOnly': 'Read-only',
  'turnOutcome.completed': 'completed',
  'turnOutcome.cancelled': 'cancelled',
  'turnOutcome.failed': 'failed',
  'turnOutcome.interrupted': 'interrupted',
  'subagentEnd.completed': 'completed',
  'subagentEnd.failed': 'failed',
  'subagentEnd.closed': 'closed',
  'subagentEnd.cancelled': 'cancelled',
  'toolStatus.completed': 'done',
  'toolStatus.failed': 'failed',
  'toolStatus.cancelled': 'cancelled',
  'toolStatus.unknown': 'status unknown',
  'stateReason.engine_exited': 'the engine process exited',
  'stateReason.cancel_unconfirmed': 'the engine did not confirm the cancellation',
  'stateReason.resume_failed': 'resuming the engine session failed',
  'stateReason.host_restarted': 'a Host restart interrupted the turn',
  'stateReason.turn_finished': 'the turn failed',
  'engineError.missing_credentials': 'missing credentials',
  'engineError.provider': 'provider error',
  'engineError.engine_exited': 'engine exited',
  'engineError.cancel_unconfirmed': 'cancellation unconfirmed',
  'engineError.session_unavailable': 'engine session unavailable',
  'engineError.unknown': 'unknown error',
  'engineHint.missing_credentials':
    'This provider has no usable key: run wevir provider add to set it again',
  'engineHint.provider':
    'The provider returned an error: run wevir provider test to check the address, model and key',
  'engineHint.engine_exited':
    'The engine process exited: sending another message resumes the session; if it keeps happening, check the Host log (<data dir>/logs/host.log)',
  'engineHint.cancel_unconfirmed':
    'The engine did not confirm the cancellation and was restarted: sending another message resumes the session',
  'engineHint.session_unavailable':
    'The engine session is temporarily unavailable: try again shortly; if it persists, check the Host log',
  'engineHint.unknown': 'See the Host log (<data dir>/logs/host.log) for details',
  'readOnly.engine_session_not_found':
    'the engine cannot find this session (its data directory may have been cleaned up)',
  'readOnly.engine_session_incompatible':
    "the current engine version cannot read this session's format",
  'readOnly.engine_session_corrupted': "the engine's session log is corrupted",
  'approvalEnd.turn_cancelled': 'Approval cancelled (turn cancelled)',
  'approvalEnd.session_closed': 'Approval cancelled (session closed)',
  'approvalEnd.engine_exited': 'Approval cancelled (engine exited)',
  'approvalEnd.host_shutdown': 'Approval cancelled (Host shut down)',
  'approvalEnd.host_restarted': 'Approval expired (Host restarted)',
  'providerTest.missing_key': 'no key',
  'providerTest.network': 'unreachable',
  'providerTest.timeout': 'timed out',
  'providerTest.auth': 'authentication failed',
  'providerTest.model_not_found': 'model not found',
  'providerTest.protocol': 'protocol mismatch',
  'providerTest.rate_limited': 'rate limited',
  'providerTest.server': 'server error',
  'providerTest.unknown': 'unknown error',
  'providerHint.missing_key':
    'No key stored: run wevir provider add with the same ID and enter the key',
  'providerHint.network':
    'Cannot reach the service: check the address (baseURL), network and proxy',
  'providerHint.timeout': 'The service did not respond in time: retry later or check the network',
  'providerHint.auth':
    'The key is invalid or lacks permission: run wevir provider add to update it',
  'providerHint.model_not_found':
    'The service has no such model: pick another with --model, or change the default model with wevir provider add',
  'providerHint.protocol':
    'The address is reachable but does not answer in the selected protocol: check the address (usually ending in /v1) and the protocol',
  'providerHint.rate_limited':
    'Rate limited or out of quota: retry later or check the account balance',
  'providerHint.server': 'Server error (5xx): retry later',
  'providerHint.unknown': 'See the original error above',
  'option.allowOnce': 'Allow once',
  'option.allowAlways': 'Always allow',
  'option.rejectOnce': 'Reject',
  'option.rejectAlways': 'Always reject',
  'time.minutes': '{minutes} min {seconds} s',

  'render.liveDivider': '── history above, live below ──',
  'render.reset': 'The session history on the Host differs from what was shown here; replaying.',
  'render.resumed': '(engine session resumed)',
  'render.resumedVersion': '(engine session resumed, {version})',
  'render.readOnly': 'Read-only session: {reason} ({message})',
  'render.readOnlyHint': 'The history is still viewable; start a new session to continue.',
  'render.sessionError': 'Session error. Sending another message tries to recover it.',
  'render.sessionErrorWhy': 'Session error: {why}. Sending another message tries to recover it.',
  'render.sessionClosed': 'Session closed.',
  'render.question': '? Agent question (answer it in the desktop app)',
  'render.questionWithHeader': '{header}: {question}',
  'render.questionCancelled': 'Question cancelled',
  'render.answerSkipped': '(skipped)',
  'render.answered': '✓ Answered: {answers}',
  'render.turnFinished': '── Turn {outcome} · {duration} ──',
  'render.from': ' (from {client})',
  'render.steerEchoed': '(steer added to this turn)',
  'render.steerTag': ' (steer)',
  'render.steerTagFrom': ' (steer, from {client})',
  'render.pendingSteer': 'Steer: added to this turn after the current step',
  'render.pendingQueued': 'Queued: sent after this turn',
  'render.pendingHeld': 'Held · {text} (type /resume to send)',
  'render.pendingCancelled': 'Pending message deleted · {text}',
  'pendingFallback.unsupported': 'This engine cannot take steers; queued instead',
  'pendingFallback.rejected': 'The model cannot take a steer this turn; queued instead',
  'pendingFallback.turn_ended': 'The turn ended before the steer was added; queued instead',
  'render.thinking': 'Thinking: ',
  'render.thoughtCollapsed':
    '(reasoning, {count, plural, one {# character} other {# characters}}, collapsed)',
  'render.abandoned': '(the model abandoned the output above; what follows supersedes it)',
  'render.tool': 'Tool',
  'render.subagent': 'Subagent',
  'render.subagentStarted': 'Subagent started: {title}{model}',
  'render.subagentResumed': 'Subagent resumed: {title}',
  'render.subagentEnded': '↳ Subagent {status}: ',
  'render.subagentApprovalEnded': '(approval for subagent {title} ended)',
  'render.oneToolCall': 'a tool call',
  'render.approvalFromSubagent': ' (from subagent {title})',
  'render.approvalNeeded': '⚠ Approval needed{from}: {what}',
  'render.justification': 'Reason: {text}',
  'render.sandboxPermissions': 'Requested permissions: {text}',
  'render.options': 'Options: {options}',
  'render.decidedHere': '✓ Handled here: {decision}',
  'render.decidedBy': '✓ Handled by {client}: {decision}',
  'render.decided': '✓ Handled: {decision}',

  'attach.busyPrompt.steer': 'steer › ',
  'attach.busyPrompt.queue': 'queue › ',
  'attach.delivery.steer': 'steer',
  'attach.delivery.queue': 'queue',
  'attach.approvalPrompt': 'Approve [{options}] › ',
  'attach.reconnecting':
    'Lost the connection to the Host; reconnecting… (if the Host stopped, run wevir host start in another terminal)',
  'attach.reconnected': 'Reconnected to the Host.',
  'attach.exited':
    'Left attach. The session stays on the Host; to reconnect: wevir session attach {id}',
  'attach.exitedBusy':
    'Left attach; the current run continues. The session stays on the Host; to reconnect: wevir session attach {id}',
  'attach.header': 'Session {id} · {state}{title}',
  'attach.headerDetail': 'Workspace {cwd} · Model {model}',
  'attach.keys':
    'Enter sends · Ctrl-C cancels the current run (twice leaves attach) · Ctrl-D leaves attach',
  'attach.keysBusy':
    'During a turn: Enter steers or queues per settings, Tab uses the other · /resume sends held messages',
  'attach.readOnly':
    'This session is read-only: the history is viewable, but no messages can be sent.',
  'attach.errorState':
    'The session is in an error state; sending a message tries to recover it first.',
  'attach.held':
    '{count, plural, one {# held message} other {# held messages}} (the last turn did not end normally); type /resume to send.',
  'attach.inputEnded':
    'Input ended; handle this approval in another terminal: wevir session attach {id}',
  'attach.noHeld': 'No held messages.',
  'attach.resumingHeld': 'Sending held messages.',
  'attach.recovering': 'The session needs to be recovered first; recovering…',
  'attach.answerHint': 'Enter an option number (1–{count}), or y to allow, n to reject.',
  'attach.cancellingAgain': 'Cancelling… (press Ctrl-C again to leave attach)',
  'attach.cancelling': 'Cancelling the current run… (press Ctrl-C again to leave attach)',
  'attach.pressAgain':
    'Press Ctrl-C again to leave attach (the session stays on the Host), or press Ctrl-D.',

  'session.detachNeedsPrompt': '--detach needs a prompt',
  'session.detachNeedsPrompt.hint':
    'For example: wevir session new -w . --detach "Tidy up the README"',
  'session.workspaceAdded': 'Added workspace {name} ({path})',
  'session.created': 'Created session {id}',
  'session.sent': 'Sent. To see the output: wevir session attach {id}',
  'session.noSuchProvider': 'No provider with ID {id}.',
  'session.noSuchProvider.hint': 'Run wevir provider list',
  'session.noProviders': 'No providers configured.',
  'session.noProviders.hint': 'Run wevir provider add first',
  'session.manyProviders': '{count} providers configured; choose one with --provider: {ids}',
  'session.notWorkspace': '{path} is not a workspace.',
  'session.notWorkspace.hint': 'Run wevir workspace list to see registered workspaces',
  'session.none': 'No sessions.',
  'session.none.hint': 'wevir session new -w <path> "<prompt>"',
  'session.col.id': 'Session ID',
  'session.col.state': 'State',
  'session.col.title': 'Title',
  'session.col.workspace': 'Workspace',
  'session.col.model': 'Model',
  'session.col.events': 'Events',
  'session.col.updated': 'Updated',
  'session.untitled': '(untitled)',
  'session.notFound': 'Session {id} not found.',
  'session.ambiguous': '{id} matches several sessions: {ids}.',
  'session.ambiguousMore': '{id} matches several sessions: {ids} and more.',
  'session.ambiguous.hint': 'Use the full session ID',

  'workspace.added': 'Added workspace: {name} ({id})',
  'workspace.exists': 'Workspace already exists: {name} ({id})',
  'workspace.none': 'No workspaces.',
  'workspace.none.hint': 'wevir workspace add <path>',
  'workspace.col.name': 'Name',
  'workspace.col.path': 'Path',
  'workspace.col.added': 'Added',

  'host.noBin': '{path} has no bin.wevir-host',
  'host.noEntry': 'Host entry point not found: {path}.',
  'host.noEntry.hint': 'Run pnpm build at the repository root first',
  'host.invalidRuntime': 'The runtime file {path} is malformed.',
  'host.invalidRuntime.hint': 'Once no Host is running, delete it and run wevir host start',
  'host.invalidRuntime.stopHint': 'Run wevir host status',
  'host.alreadyRunning': 'Host already running: pid {pid} · Host {version}',
  'host.dataDir': 'Data directory {path}',
  'host.logFile': 'Log {path}',
  'host.unreachable': 'The Host process (pid {pid}) is running but cannot be reached: {error}',
  'host.unreachable.startHint':
    'Check the log {log}; if needed, end the process and run wevir host start',
  'host.unreachable.statusHint': 'Check the log {log}',
  'host.waitingStart': 'Host is starting (pid {pid}); waiting for it to be ready…',
  'host.started': 'Host started: pid {pid} · Host {version} · protocol {protocol}',
  'host.spawnFailed': 'Cannot start the Host: {error}',
  'host.startFailed': 'The Host failed to start ({why}).{tail}',
  'host.startFailed.signal': 'signal {signal}',
  'host.startFailed.exitCode': 'exit code {code}',
  'host.startFailed.hint': 'Full output in {stdio} and logs/host.log',
  'host.notReady': 'The Host was not ready within {seconds} s.',
  'host.notReadyWhy': 'The Host was not ready within {seconds} s ({error}).',
  'host.seeLog': 'See {log}',
  'host.notRunning': 'The Host is not running.',
  'host.notRunning.hint': 'Run wevir host start',
  'host.stale': 'The Host is not running (pid {pid} exited and left its runtime file behind).',
  'host.stale.hint': 'Run wevir host start (it cleans up the old file)',
  'host.starting': 'The Host is starting (pid {pid}).',
  'host.starting.stopHint': 'Run wevir host stop once it is ready',
  'host.running': 'Host running',
  'host.row.pidValue': '{pid} (started {time})',
  'host.row.address': 'Address',
  'host.row.version': 'Version',
  'host.row.versionValue': 'Host {version} · protocol {protocol}',
  'host.row.latency': 'Latency',
  'host.row.dataDir': 'Data directory',
  'host.stopping': 'Host (pid {pid}) is shutting down…',
  'host.stopped': 'Host stopped.',
  'host.stopTimeout': 'Host (pid {pid}) did not exit within {seconds} s.',
  'host.stopTimeout.hint': 'See {log}; if it still does not exit, end the process manually',

  'provider.flagProblem': '--{flag}: {problem}',
  'provider.missingFlag': 'Missing --{flag}',
  'provider.missingFlag.hint':
    'Run wevir provider add interactively in a terminal, or pass every value as an option',
  'provider.empty': 'Cannot be empty',
  'provider.chatgpt': 'ChatGPT accounts do not use provider add',
  'provider.chatgpt.hint': 'Run wevir provider login',
  'provider.badKind': '--kind must be deepseek-official or openai-compatible: {kind}',
  'provider.missingKind': 'Missing --kind (deepseek-official or openai-compatible)',
  'provider.kindQuestion': 'Provider type:',
  'provider.kind.deepseek': 'DeepSeek official (deepseek-official)',
  'provider.kind.compatible':
    'OpenAI-compatible endpoint (Qwen, Kimi, Zhipu, local model servers, etc.)',
  'provider.fixedId': "The DeepSeek official provider's ID is always {id}",
  'provider.ask.name': 'Display name ',
  'provider.ask.deepseekModel': 'Default model (deepseek-flash or deepseek-v4-pro) ',
  'provider.ask.id':
    'Provider ID (starts with a lowercase letter; letters, digits and -; cannot be changed later): ',
  'provider.ask.api': 'Protocol (openai-completions or openai-responses) ',
  'provider.ask.baseUrl': 'Service address (for example https://api.moonshot.cn/v1) ',
  'provider.ask.model': 'Default model ID ',
  'provider.ask.contextWindow': 'Context window (tokens, optional) ',
  'provider.ask.key': 'API key (input hidden): ',
  'provider.ask.keyKeep': 'API key (input hidden; press Enter to keep the stored key): ',
  'provider.badId':
    'Use lowercase letters, digits and -, starting with a letter, up to 32 characters',
  'provider.reservedId': '{id} is reserved by dsh; choose another ID',
  'provider.idTaken': 'ID {id} is already used by a {kind} provider.',
  'provider.badApi': 'Must be openai-completions or openai-responses',
  'provider.engineFailed':
    'Provider saved, but the engine could not apply the new configuration: {error}',
  'provider.engineFailed.hint':
    'Check the Host log logs/host.log; fix the problem and run wevir provider add again',
  'provider.added': 'Added provider {id} ({name}, default model {model}, key {key})',
  'provider.updated': 'Updated provider {id} ({name}, default model {model}, key {key})',
  'provider.key.set': 'set',
  'provider.key.unset': 'not set',
  'provider.noKeyWarning':
    'No key set: sessions with services that need a key will fail for missing credentials.',
  'provider.url.scheme': 'Only http / https addresses are supported',
  'provider.url.extras': 'The address cannot contain a user name, password, query or #',
  'provider.url.invalid': 'Not a valid address',
  'provider.badContextWindow': 'The context window must be a positive integer: {text}',
  'provider.none': 'No providers.',
  'provider.none.hint': 'wevir provider add',
  'provider.col.name': 'Name',
  'provider.col.kind': 'Kind',
  'provider.col.model': 'Default model',
  'provider.col.address': 'Address',
  'provider.chatgptLogin': 'ChatGPT sign-in',
  'provider.subscriptionLogin': 'Subscription sign-in',
  'provider.officialAddress': '(official default)',
  'provider.manyToTest': '{count} providers configured; specify which one to test: {ids}',
  'provider.manyToTest.hint': 'For example: wevir provider test <ID>',
  'provider.testing': 'Testing {id}…',
  'provider.testingModel': 'Testing {id} (model {model})…',
  'provider.testOk': '✓ Connection OK',
  'provider.testOkLatency': '✓ Connection OK, {ms} ms',
  'provider.testFailed': '✗ Test failed ({reason})',
  'provider.testFailedHttp': '✗ Test failed ({reason}, HTTP {status})',

  'account.unknownKind': 'Unknown account: {kind}',
  'account.unknownKind.hint': 'Only chatgpt is supported',
  'account.terms':
    "Sign in only for your personal use of Wevir on this machine: sign-in uses OpenAI's own Codex flow, the credentials stay on this machine, and Wevir neither reads nor forwards them.",
  'account.alreadySignedIn': 'Already signed in to ChatGPT: {account}',
  'account.alreadySignedIn.hint': 'To switch accounts, run wevir provider logout first',
  'account.noDeviceCode': 'The Host did not return a device code',
  'account.noDeviceCode.hint': "Retry later, or sign in from the desktop app's settings",
  'account.step1': '1. Open {url} in a browser and sign in to ChatGPT',
  'account.step2': '2. Enter the one-time code {code} (valid for 15 minutes)',
  'account.codeWarning':
    'This code is for the sign-in you just started in Wevir; if you did not start it, do not enter it.',
  'account.waiting': 'Waiting… (Ctrl-C to cancel)',
  'account.loginCancelled': 'Sign-in cancelled.',
  'account.replaced': 'This sign-in was replaced by one started elsewhere',
  'account.retry.hint': 'Run wevir provider login again',
  'account.signedIn': '✓ Signed in to ChatGPT: {account}',
  'account.signedIn.hint': 'wevir session new -w <path> --provider chatgpt "<prompt>"',
  'account.loginFailed': 'Sign-in failed: {error}',
  'account.cancelled': 'cancelled',
  'account.status.signedIn': 'ChatGPT: signed in as {account}',
  'account.status.signingIn':
    'ChatGPT: signing in (started from the desktop app or another terminal)',
  'account.status.signedOut': 'ChatGPT: not signed in',
  'account.status.lastError': 'Last sign-in failed: {error}',
  'account.status.signedOut.hint': 'wevir provider login',
  'account.loggedOut':
    'Signed out of ChatGPT (local credentials deleted). Sessions using ChatGPT continue after you sign in again.',
  'account.unsupported': 'This Host has no ChatGPT account (only the Codex engine does)',
  'account.unsupported.hint':
    'Restart the Host with the default Codex engine: wevir host stop && wevir host start',
  'account.unknownEmail': '(unknown email)',
  'account.window.usage': 'Usage',
  'account.window.weekly': 'Weekly',
  'account.window.days': '{count}-day window',
  'account.window.hours': '{count}-hour window',
  'account.window.minutes': '{count}-minute window',
  'account.window.used': '{span}: {percent}% used',
  'account.window.resets': '{usage}, resets {time}',
  'account.window.date': '{month}/{day} {time}',

  'prompt.cancelled': 'Cancelled.',
  'prompt.choose': 'Choose ',
  'prompt.invalidChoice': 'Invalid choice: {answer}',
  'prompt.chooseRange': 'Enter a number from 1 to {count}.',
  'prompt.inputEnded': 'Input ended before the required value was read.',
  'prompt.inputEnded.hint': 'Run interactively in a terminal, or pass every value as an option',

  'identity.unwritable': 'Cannot read or write {path}',
  'identity.invalid': '{path} does not contain a valid ID',
};
