// 界面文案的源语言目录（简体中文，T5.2）。所有导航与界面文案都从这里经 t() 取，组件里不写字面量。
//
// 约定（为以后接 i18n 库留口）：
// - key 是扁平的点分格式 `<区域>.<名称>`，值是纯字符串，可以直接导出给翻译工具；
// - 插值写 `{name}`（ICU 的简单参数），t() 的类型从这里推出每条文案需要哪些参数；
// - 新增语言时另建一个满足 `Messages` 类型的目录，key 以本文件为准。
// 产品名（Wevir）、Host、Provider、MCP 等术语保留英文。

export const zhCN = {
  'app.name': 'Wevir',

  'common.close': '关闭',
  'common.loading': '正在加载…',
  'common.comingSoon': '即将推出',

  'host.connecting': 'Host 连接中…',
  'host.connected': 'Host 已连接',
  'host.reconnecting': 'Host 重连中（第 {attempt} 次）',
  'host.closed': 'Host 已断开',
  'host.failed': '无法连接 Host',

  'layout.expandSidebar': '展开侧栏',
  'layout.collapseSidebar': '收起侧栏',
  'layout.resizeSidebar': '拖动调整侧栏宽度',
  'layout.openRightPanel': '打开右栏',
  'layout.closeRightPanel': '收起右栏',

  'sidebar.workspaces': '工作区',
  'sidebar.addWorkspace': '添加工作区',
  'sidebar.newSession': '在此工作区新建会话',
  'sidebar.expandWorkspace': '展开 {name}',
  'sidebar.collapseWorkspace': '收起 {name}',
  'sidebar.noWorkspaces': '还没有工作区',
  'sidebar.noSessions': '还没有会话',
  'sidebar.loadFailed': '读取工作区失败：{error}',
  'sidebar.settings': '设置',

  'session.untitled': '未命名会话',
  'session.draftTitle': '新会话',
  'session.marker.running': '运行中',
  'session.marker.awaitingApproval': '待审批',
  'session.marker.error': '出错',
  'session.marker.unread': '有未读内容',
  'session.state.idle': '空闲',
  'session.state.running': '运行中',
  'session.state.awaiting_approval': '等待审批',
  'session.state.cancelling': '正在取消',
  'session.state.error': '出错',
  'session.state.closed': '已关闭',
  'session.placeholderTitle': '会话内容会显示在这里',
  'session.placeholderBody':
    '当前状态：{state}。消息流、工具调用与审批卡片会在会话视图接入后出现。',
  'session.draftBody': '在 {workspace} 中开始一个新会话。',
  'session.composerPlaceholder': '描述你要完成的任务…',
  'session.send': '发送',
  'session.composerDisabled': '会话功能即将接入',

  'home.title': '选择一个会话',
  'home.body': '从左侧选择会话，或在工作区下新建会话。',
  'home.noWorkspacesTitle': '还没有工作区',
  'home.noWorkspacesBody': '在设置里添加一个本地文件夹作为工作区，就可以开始会话。',
  'home.goAddWorkspace': '去添加工作区',

  'notFound.title': '未找到',
  'notFound.workspace': '工作区“{id}”不存在，可能已被移除。',
  'notFound.session': '这个工作区里没有会话“{id}”。',
  'notFound.page': '没有这个页面：{path}',
  'notFound.settingsTab': '没有这个设置页：{tab}',
  'notFound.goHome': '回到首页',

  'connection.failedTitle': '无法连接 Host',

  'rightPanel.tab.overview': '概览',
  'rightPanel.workspacePath': '工作区目录',
  'rightPanel.files': '本会话涉及的文件',
  'rightPanel.filesEmpty': '会话读写过的文件会列在这里。',
  'rightPanel.noSession': '选择一个会话后，这里显示它的工作区与相关文件。',

  'settings.title': '设置',
  'settings.back': '返回',
  'settings.tab.appearance': '外观',
  'settings.tab.providers': '模型 Provider',
  'settings.tab.workspaces': '工作区',
  'settings.tab.about': '关于',
  'settings.appearance.theme': '主题',
  'settings.appearance.themeHint': '跟随系统时随操作系统的浅色 / 深色设置切换。',
  'settings.appearance.theme.system': '跟随系统',
  'settings.appearance.theme.light': '浅色',
  'settings.appearance.theme.dark': '深色',
  'settings.appearance.language': '语言',
  'settings.appearance.languageValue': '简体中文',
  'settings.placeholder': '这一页的内容即将推出。',
  'settings.about.host': 'Host',
  'settings.about.status': '连接状态',
  'settings.about.protocolVersion': '协议版本',
  'settings.about.hostVersion': 'Host 版本',
  'settings.about.hostId': 'Host ID',

  'error.title': '界面出错了',
  'error.reload': '重新加载',
} as const;

export type MessageKey = keyof typeof zhCN;
/** 其他语言的目录必须覆盖全部 key。 */
export type Messages = Record<MessageKey, string>;
