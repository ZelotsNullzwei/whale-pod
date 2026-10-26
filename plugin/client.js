/**
 * WhalePod — 浏览器半身（DSH 客户端插件）。
 *
 * ## 「看」与「调」分离
 *
 *   侧栏面板（main key=whale-pod）→ **实时仪表盘**：连接状态大字、消息计数、
 *     最近对话流、启停/暂停快捷键。适合常开、盯消息。
 *   设置页（settings.section）   → **低频配置**：QQ/决策字段、NapCat 管理、日志。
 *
 * ## 它往界面里加什么
 *
 *   1. `settings.section`  —— 设置页里的「WhalePod」页（日志/NapCat/低频配置）
 *   2. `sidebar.panellist` —— 左侧栏快捷入口（点一下切到仪表盘）
 *   3. `main`              —— 该面板的正文（键 `whale-pod`）
 *
 * ## 为什么是手写 bundle
 *
 * 同样的取舍：**不引入构建步骤**。DSH 的客户端加载器
 * （`window.__ModuleLoader__`）在页面里已经提供了 `react` 等，本文件只 `require`。
 * 因此这个文件是「已经编译好」的形态 —— 改它不需要 pnpm run build。
 *
 * ## 数据从哪来
 *
 * 走同源的 `/api/whale-pod/*`（Host 半身注册的前缀路由），不用 RPC 绑定：
 * 那些路由由同一个宿主进程服务，且在插件支持的所有内核线上都可用。
 *
 * ## 安全边界
 *
 * 只读接口回状态；**任何凭据值都不会出现在这里**（Host 侧只回 ref 名）。
 * 写请求（保存配置、启停桥接）由 Host 侧再卡一道「必须本机来源」。
 */

window.__ModuleLoader__.load({
  id: 'dsh-whale-pod',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { createElement: h, useState, useEffect, useCallback } = React

    const NS = 'settings.whale-pod'
    /** 侧栏面板 id，同时也是 main 槽位的 key。 */
    const PANEL_ID = 'whale-pod'

    /**
     * 项目仓库地址。
     *
     * 设置页右上角那个「点个 Star」按钮跳这里。
     * 单独提出来是因为：README、安装说明、issue 入口都在这个仓库，
     * 用户想反馈问题或看文档时需要它 —— 藏在下拉菜单里找不到。
     */
    const REPO_URL = 'https://github.com/ZelotsNullzwei/whale-pod'

    /**
     * 模型分类标签（与渠道界面同一套分法）。
     *
     * 顺序按"常用程度"：白嫖渠道放第一 —— 用户接了账号的就是那几个渠道，
     * 打开面板第一眼应该看到它们，而不是先去点标签。
     */
    const MODEL_GROUPS = [
      { id: 'channel' },  // 白嫖渠道：codearts/buddy/workbuddy/…
      { id: 'free' },     // 免费渠道池
      { id: 'eac' },      // 协同付费车道
      { id: 'kilo' },     // 白嫖模型接入（Kilo 网关）
    ]

    const inject = ['slots', 'locale']

    // ── 文案 ────────────────────────────────────────────────────────────────
    const DICT = {
      zh: {
        nav: '鲸舱',
        title: '鲸舱',
        sub: 'DSH 内置的 QQ 聊天机器人：NapCat 协议端 + 免费优先的 LLM 网关。',
        loading: '正在加载…',
        loadFailed: '无法连接鲸舱后端',
        retry: '重试',
        refresh: '刷新',
        save: '保存',
        saving: '保存中…',
        saved: '已保存',
        saveFailed: '保存失败',
        'repo.star': '点个 Star',

        // 仪表盘
        'dash.subtitle': 'QQ 机器人实时状态',
        'dash.off': '机器人未启用',
        'dash.offHint': '到「设置 → WhalePod」打开启用开关。',
        'dash.online': '在线',
        'dash.offline': '离线',
        'dash.paused': '已暂停（不回复）',
        'dash.connecting': '连接中…',
        'dash.self': '账号',
        'dash.uptime': '在线时长',
        'dash.counters': '消息统计',
        'dash.received': '收到',
        'dash.replied': '已回',
        'dash.silent': '保持沉默',
        'dash.dropped': '丢弃',
        'dash.failed': '失败',
        'dash.recent': '最近消息',
        'dash.recentEmpty': '还没有消息往来',
        'dash.searchOk': '联网可用',
        'dash.searchNo': '联网不可用',
        'dash.openSettings': '打开设置',
        'dash.autoRefresh': '每 4 秒自动刷新',
      'dash.activeDays': '已活跃',
      'dash.activeDaysUnit': '天',
        'dash.refreshHint': '立即刷新状态与消息',
        'dash.backendOff': '后端未运行 —— 点下面「一键启动」',
        'set.backendOffHint': '后端进程还没起来，所以这里读不到配置。回侧栏点「一键启动」，起来后这里会自动刷新。',
        'dash.img': '[图片]',

        'usage.calls': '模型调用',
        'usage.tokens': 'tokens 用量',
        'usage.cost': '折合费用（估算）',

        'mem.title': '记忆管理',
        'mem.hint': '按会话清空短期上下文；摘要属长期记忆',
        'mem.empty': '还没有活跃会话',
        'mem.scope': '会话',
        'mem.messages': '条消息',
        'mem.clearOne': '清空',
        'mem.cleared': '已清空',
        'mem.long': '长期摘要',
        'mem.longEmpty': '暂无长期摘要',
        'mem.viewSummary': '查看摘要',
        'mem.summaryTitle': '长期记忆摘要',
        'mem.close': '关闭',

        'persona.editor': '人格编辑器',
        'persona.editorHint': '新建、编辑或删除角色提示词',
        'persona.new': '新建角色',
        'persona.name': '角色名',
        'persona.content': '提示词内容（Markdown）',
        'persona.create': '创建',
        'persona.delete': '删除',
        'persona.edit': '编辑',
        'persona.selectFirst': '选择要编辑的角色',
        'persona.saved': '已保存',
        'persona.created': '已创建',
        'persona.removed': '已删除',
        'persona.defaultNoDelete': 'default 不能删除',
        'persona.customized': '已自定义',
        'persona.restore': '恢复内置',
        'persona.restoreWarn': '当前内容会被内置版本覆盖，你的修改将丢失。',
        'persona.restored': '已恢复内置版本',

        // 设置页
        'section.napcat': 'NapCat 协议端',
        'section.napcatHint': '下载、启停与运行日志',
        'section.startup': '启动行为',
    'section.startupHint': 'DSH 启动时要不要自动拉起 WhalePod',
    'startup.autoStart': '随 DSH 自动启动',
    'startup.autoStartHint': '关掉后不会自动跑，需要时在侧栏点「一键启动」',
    'startup.note': '关掉只影响「下次 DSH 启动时是否自动拉起」，不会停掉正在运行的进程。',
    'section.qq': 'QQ 配置',
        'section.qqHint': '启用开关、地址与白名单',
        'section.decision': '决策与人格',
        'section.decisionHint': '什么时候说话、以什么身份说',
        'section.logs': '运行日志',
        'section.logsHint': '最近的运行记录',

        'status.home': 'DSH 数据目录',
        'status.dataDir': 'WhalePod 数据目录',
        'status.providers': '可用渠道',
        'status.persona': '当前人格',
        'status.threshold': '发言阈值',
        'status.memory': '记忆会话数',

        on: '已开启',
        off: '已关闭',
        running: '运行中',
        stopped: '未运行',
        connected: '已连接',
        disconnected: '未连接',
        installed: '已安装',
        notInstalled: '未安装',
        none: '（无）',

        'qq.enabled': '启用 QQ 机器人',
        'qq.mode': '运行模式',
        'qq.model': '对话模型',
        'qq.maxTokens': '单次最大 token',
        'qq.wsUrl': 'OneBot 正向 WS 地址',
        'qq.httpUrl': 'OneBot HTTP 地址',
        'qq.allowAll': '白名单为空时允许所有人',
        'qq.private': '私聊白名单',
        'qq.groups': '群白名单',
        'qq.reply.maxChars': '单条回复字数上限',
        'qq.reply.quote': '回复时引用原消息',
        'qq.reply.imagesEnabled': '允许发送图片',
        'qq.poke.enabled': '允许戳一戳',
        'qq.poke.chance': '戳一戳概率',
        'qq.supervisor': '自动托管 NapCat',
        'qq.supervisor.start': '启动 NapCat',
        'qq.supervisor.stop': '停止 NapCat',
        'qq.start': '一键启动',
        'qq.stop': '完全关闭',
        'qq.startHint': '启动 WhalePod 进程、NapCat 协议端与 QQ 桥接',
        'qq.stopHint': '关闭桥接、停止 NapCat，并结束 WhalePod 进程（配置保留）',
        'actionRestarting': '已发出指令，状态刷新中…',
        'qq.paused': '已暂停',
        'qq.pause': '暂停',
        'qq.resume': '恢复',
        'qq.pauseHint': '暂停响应消息（连接保持）',
        'qq.resumeHint': '恢复响应消息',
        // 后端进程窗口
        'proc.title': '后端进程',
        'proc.empty': '当前没有 WhalePod / NapCat 进程',
        'proc.other': '其它',

        // ── 模型卡片（侧栏）──────────────────────────────────────────
        'model.title': '模型与渠道',
        'model.llm': 'LLM（纯文本）',
        'model.vlm': 'VLM（能看图）',
        'model.current': '当前模型',
        'model.auto': 'auto（按下方顺序自动选）',
        'model.backToAuto': '切回自动选择',
        'section.search': '联网搜索',
        'section.searchHint': '遇到新番 / 人名 / 时效性问题时先查再答',
        'search.enabled': '启用联网搜索',
        'search.enabledHint': '关掉之后完全不联网，遇到不确定的会说不知道而不是硬编',
        'search.images': '顺便配一张封面图',
        'search.imagesHint': '聊到具体作品时会附一张图',
        'search.maxUses': '最多搜几次',
        'search.maxUsesHint': '每次搜索固定取 10 个网页；这个数字是上限',
        'search.lowBalance': '余额提醒阈值',
        'search.lowBalanceHint': '低于这个数（元）会让它念叨一句',
        'model.strategy': '路由策略',
        'model.freeFirst': '免费优先 → 付费兜底',
        'model.freeOnly': '只用免费',
        'model.selfOnly': '只用自备',
        'model.order': '渠道优先级',
        'model.empty': '还没有发现可用渠道',
        'model.off': '已关闭',
        'model.noModel': '无已知模型，auto 会跳过',
        'model.untested': '未测速',
        'model.up': '上移一位',
        'model.down': '下移一位',
        'model.enable': '启用',
        'model.disable': '关闭',
        'model.drag': '拖动调整顺序',
        'model.group.lane': '免费车道',
        'model.group.account': '账号型渠道',
        'model.group.accountHint': '吃单账号额度，可能整天冷却',
        'model.group.other': '其它渠道',
        'model.group.off': '已关闭',
        // 模型分类标签（与渠道界面同名）
        'model.group.channel': '白嫖接入',
        'model.group.free': '免费模型',
        'model.group.eac': 'EAC 模型',
        'model.group.kilo': '白嫖模型',
        'model.groupEmpty': '这一类暂无可用模型',
        'model.kindBuiltin': '内置',
        'model.needsProxy': '需代理',
        'model.credReady': 'API Key 已配置',
        'model.credMissing': 'API Key 未配置',
        'model.effort': '推理等级',
        'model.effortDefault': '默认',
        // 等级名称（未知等级会原样显示英文 id）
        'model.effortLevel.disabled': '关闭思考',
        'model.effortLevel.off': '关闭思考',
        'model.effortLevel.none': '关闭思考',
        'model.effortLevel.minimal': '极低',
        'model.effortLevel.low': '低',
        'model.effortLevel.medium': '中',
        'model.effortLevel.high': '高',
        'model.effortLevel.xhigh': '很高',
        'model.effortLevel.max': '最高',
        'model.effortLevel.tiered': '分级',

        'napcat.install': '安装 NapCat（内置运行）',
        'napcat.installing': '安装中…',
        'napcat.logs': 'NapCat 运行日志',
        'napcat.logsEmpty': '暂无日志',
        'napcat.webui': '打开管理面板',
        'napcat.webuiStopped': 'NapCat 未运行，先启动它',
        'napcat.webuiNoToken': '未读到登录令牌，面板打开后需手动输入（首次登录后会生成）',
        'napcat.webuiAt': '管理面板：',
        'napcat.accept': '我已阅读 NapCat 的许可（Limited Redistribution License）与《QQ 用户协议》，同意从官方 Release 下载到本机',
        'napcat.progress': '安装进度',
        'napcat.builtIn': '内置托管：NapCat 由 DSH 自动拉起，无需手动开窗口',

        'decision.provider': '决策提供者',
        'decision.threshold': '发言阈值',
        'decision.fallbackOnError': '出错时降级到内置规则',
        'decision.delayMin': '最短延迟（ms）',
        'decision.delayMax': '最长延迟（ms）',
        'decision.cooldown': '冷却时间（ms）',
        'decision.maxTurns': '最大连续发言轮数',
        'decision.mention': '被 @ 时发言概率',
        'decision.idle': '冷场主动发言概率',
        'decision.probe': '探测决策提供者',
        'decision.probing': '探测中…',

        'persona.active': '当前人格',
        'persona.hint': '人格文件位于 WhalePod 数据目录的 persona/ 下',
        'memory.stats': '记忆统计',
        'memory.clear': '清空记忆',
        'memory.cleared': '已清空',

        'logs.empty': '暂无日志',

        'list.hint': '每行一个，留空表示不限制',
      },
      en: {
        nav: 'WhalePod',
        title: 'WhalePod',
        sub: 'A QQ chat bot inside DSH: NapCat protocol side plus a free-first LLM gateway.',
        loading: 'Loading…',
        loadFailed: 'Cannot reach the WhalePod backend',
        retry: 'Retry',
        refresh: 'Refresh',
        save: 'Save',
        saving: 'Saving…',
        saved: 'Saved',
        saveFailed: 'Save failed',
        'repo.star': 'Star us',

        'dash.subtitle': 'QQ bot live status',
        'dash.off': 'Bot is disabled',
        'dash.offHint': 'Enable it under Settings → WhalePod.',
        'dash.online': 'Online',
        'dash.offline': 'Offline',
        'dash.paused': 'Paused (not replying)',
        'dash.connecting': 'Connecting…',
        'dash.self': 'Account',
        'dash.uptime': 'Uptime',
        'dash.counters': 'Message counters',
        'dash.received': 'Received',
        'dash.replied': 'Replied',
        'dash.silent': 'Stayed silent',
        'dash.dropped': 'Dropped',
        'dash.failed': 'Failed',
        'dash.recent': 'Recent messages',
        'dash.recentEmpty': 'No message traffic yet',
        'dash.searchOk': 'Web search available',
        'dash.searchNo': 'Web search unavailable',
        'dash.openSettings': 'Open settings',
        'dash.autoRefresh': 'Auto-refresh every 4s',
      'dash.activeDays': 'Active',
      'dash.activeDaysUnit': 'd',
        'dash.refreshHint': 'Refresh status and messages now',
        'dash.backendOff': 'Backend is not running — press Start below',
        'set.backendOffHint': 'The backend process is not up yet, so settings cannot be read here. Go to the sidebar and press Start; this page refreshes once it is running.',
        'dash.img': '[image]',

        'usage.calls': 'Model calls',
        'usage.tokens': 'Token usage',
        'usage.cost': 'Estimated cost',

        'mem.title': 'Memory management',
        'mem.hint': 'Clear short-term context per session; summaries are long-term memory',
        'mem.empty': 'No active sessions yet',
        'mem.scope': 'Session',
        'mem.messages': 'messages',
        'mem.clearOne': 'Clear',
        'mem.cleared': 'Cleared',
        'mem.long': 'Long-term summaries',
        'mem.longEmpty': 'No long-term summaries yet',
        'mem.viewSummary': 'View summary',
        'mem.summaryTitle': 'Long-term memory summary',
        'mem.close': 'Close',

        'persona.editor': 'Persona editor',
        'persona.editorHint': 'Create, edit, or delete role prompts',
        'persona.new': 'New persona',
        'persona.name': 'Persona name',
        'persona.content': 'Prompt content (Markdown)',
        'persona.create': 'Create',
        'persona.delete': 'Delete',
        'persona.edit': 'Edit',
        'persona.selectFirst': 'Pick a persona to edit',
        'persona.saved': 'Saved',
        'persona.created': 'Created',
        'persona.removed': 'Removed',
        'persona.defaultNoDelete': 'default cannot be deleted',
        'persona.customized': 'customized',
        'persona.restore': 'Reset to builtin',
        'persona.restoreWarn': 'Current content will be replaced by the builtin version and your edits will be lost.',
        'persona.restored': 'Restored to builtin version',

        'section.napcat': 'NapCat protocol side',
        'section.napcatHint': 'Install, start/stop, and its run log',
        'section.startup': 'Startup',
    'section.startupHint': 'Whether DSH should launch WhalePod on start',
    'startup.autoStart': 'Auto-start with DSH',
    'startup.autoStartHint': 'Off = do not launch automatically; use "Start" in the sidebar',
    'startup.note': 'This only affects the next DSH launch — it does not stop a running process.',
    'section.qq': 'QQ configuration',
        'section.qqHint': 'Enable switch, endpoints, and allowlists',
        'section.decision': 'Decision and persona',
        'section.decisionHint': 'When to speak and in whose voice',
        'section.logs': 'Runtime log',
        'section.logsHint': 'Recent runtime records',

        'status.home': 'DSH data directory',
        'status.dataDir': 'WhalePod data directory',
        'status.providers': 'Available providers',
        'status.persona': 'Active persona',
        'status.threshold': 'Reply threshold',
        'status.memory': 'Memory sessions',

        on: 'On',
        off: 'Off',
        running: 'Running',
        stopped: 'Stopped',
        connected: 'Connected',
        disconnected: 'Disconnected',
        installed: 'Installed',
        notInstalled: 'Not installed',
        none: '(none)',

        'qq.enabled': 'Enable the QQ bot',
        'qq.mode': 'Run mode',
        'qq.model': 'Chat model',
        'qq.maxTokens': 'Max tokens per reply',
        'qq.wsUrl': 'OneBot forward WS URL',
        'qq.httpUrl': 'OneBot HTTP URL',
        'qq.allowAll': 'Allow everyone when the allowlist is empty',
        'qq.private': 'Private-chat allowlist',
        'qq.groups': 'Group allowlist',
        'qq.reply.maxChars': 'Max characters per reply',
        'qq.reply.quote': 'Quote the original message',
        'qq.reply.imagesEnabled': 'Allow sending images',
        'qq.poke.enabled': 'Allow pokes',
        'qq.poke.chance': 'Poke probability',
        'qq.supervisor': 'Supervise NapCat automatically',
        'qq.supervisor.start': 'Start NapCat',
        'qq.supervisor.stop': 'Stop NapCat',
        'qq.start': 'Start',
        'qq.stop': 'Shut down',
        'qq.startHint': 'Start the WhalePod process, NapCat and the QQ bridge',
        'qq.stopHint': 'Stop the bridge, NapCat and the WhalePod process (settings kept)',
        'actionRestarting': 'Command sent, refreshing…',
        'qq.paused': 'Paused',
        'qq.pause': 'Pause',
        'qq.resume': 'Resume',
        'qq.pauseHint': 'Stop replying (connection kept)',
        'qq.resumeHint': 'Resume replying',
        // Backend process panel
        'proc.title': 'Backend processes',
        'proc.empty': 'No WhalePod / NapCat process running',
        'proc.other': 'Other',

        // ── Model card (sidebar) ─────────────────────────────────────
        'model.title': 'Model & channels',
        'model.llm': 'LLM (text)',
        'model.vlm': 'VLM (vision)',
        'model.current': 'Current model',
        'model.auto': 'auto (pick by the order below)',
        'model.backToAuto': 'Back to automatic',
        'section.search': 'Web search',
        'section.searchHint': 'Look things up before answering — new releases, names, current events',
        'search.enabled': 'Enable web search',
        'search.enabledHint': 'When off, it will say it is not sure instead of making things up',
        'search.images': 'Attach a cover image',
        'search.imagesHint': 'Shows a poster when talking about a specific work',
        'search.maxUses': 'Max searches per question',
        'search.maxUsesHint': 'Each search returns 10 pages; this caps how many searches',
        'search.lowBalance': 'Low-balance threshold',
        'search.lowBalanceHint': 'Below this amount (CNY) it will complain about tokens',
        'model.strategy': 'Routing strategy',
        'model.freeFirst': 'Free first → paid fallback',
        'model.freeOnly': 'Free only',
        'model.selfOnly': 'Self-hosted only',
        'model.order': 'Channel priority',
        'model.empty': 'No channel discovered yet',
        'model.off': 'Disabled',
        'model.noModel': 'No known model; auto skips it',
        'model.untested': 'not probed',
        'model.up': 'Move up one',
        'model.down': 'Move down one',
        'model.enable': 'Enable',
        'model.disable': 'Disable',
        'model.drag': 'Drag to reorder',
        'model.group.lane': 'Free lanes',
        'model.group.account': 'Account channels',
        'model.group.accountHint': 'Burns one account quota; may cool down all day',
        'model.group.other': 'Other channels',
        'model.group.off': 'Disabled',
        // Model category tabs (same names as the channel UI)
        'model.group.channel': 'Channels',
        'model.group.free': 'Free',
        'model.group.eac': 'EAC',
        'model.group.kilo': 'Kilo',
        'model.groupEmpty': 'No usable model in this category',
        'model.kindBuiltin': 'Built-in',
        'model.needsProxy': 'Proxy',
        'model.credReady': 'API key set',
        'model.credMissing': 'API key missing',
        'model.effort': 'Reasoning effort',
        'model.effortDefault': 'Default',
        // Effort level names (unknown ids fall back to the raw id)
        'model.effortLevel.disabled': 'Thinking off',
        'model.effortLevel.off': 'Thinking off',
        'model.effortLevel.none': 'Thinking off',
        'model.effortLevel.minimal': 'Minimal',
        'model.effortLevel.low': 'Low',
        'model.effortLevel.medium': 'Medium',
        'model.effortLevel.high': 'High',
        'model.effortLevel.xhigh': 'Very high',
        'model.effortLevel.max': 'Max',
        'model.effortLevel.tiered': 'Tiered',

        'napcat.install': 'Install NapCat (built-in)',
        'napcat.installing': 'Installing…',
        'napcat.logs': 'NapCat run log',
        'napcat.logsEmpty': 'No log entries yet',
        'napcat.webui': 'Open web panel',
        'napcat.webuiStopped': 'NapCat is not running; start it first',
        'napcat.webuiNoToken': 'No login token found; enter it manually in the panel (generated after first login)',
        'napcat.webuiAt': 'Web panel:',
        'napcat.accept': 'I have read NapCat\'s license (Limited Redistribution License) and the QQ Terms of Service, and agree to download from the official Release to this machine',
        'napcat.progress': 'Install progress',
        'napcat.builtIn': 'Built-in hosting: DSH starts NapCat automatically; no manual window needed',
        'napcat.webuiAt': 'Web panel:',

        'decision.provider': 'Decision provider',
        'decision.threshold': 'Reply threshold',
        'decision.fallbackOnError': 'Fall back to built-in rules on error',
        'decision.delayMin': 'Minimum delay (ms)',
        'decision.delayMax': 'Maximum delay (ms)',
        'decision.cooldown': 'Cooldown (ms)',
        'decision.maxTurns': 'Max consecutive turns',
        'decision.mention': 'Reply probability when mentioned',
        'decision.idle': 'Idle chatter probability',
        'decision.probe': 'Probe decision providers',
        'decision.probing': 'Probing…',

        'persona.active': 'Active persona',
        'persona.hint': 'Persona files live under persona/ in the WhalePod data directory',
        'memory.stats': 'Memory stats',
        'memory.clear': 'Clear memory',
        'memory.cleared': 'Cleared',

        'logs.empty': 'No log entries yet',

        'list.hint': 'One entry per line; empty means unrestricted',
      },
    }

    // ── 与 Host 通信 ───────────────────────────────────────────────────────
    // 用页面 base 解析，避免 DSH 挂在反向代理子路径下时丢掉前缀。
    const API = (() => {
      try { return new URL('api/whale-pod', document.baseURI).pathname } catch { return '/api/whale-pod' }
    })()

    /**
     * 图标的 URL（Host 半身注册的独立路由）。
     *
     * 同样用页面 base 解析 —— DSH 挂在反向代理子路径下时，
     * 写死 '/dsh-whale-pod/icon.png' 会丢掉前缀变成 404。
     *
     * @param {1|2} [scale=1] 1 = 128px（1x 屏），2 = 256px（2x 屏）
     */
    function iconUrl(scale = 1) {
      const name = scale === 2 ? 'icon@2x.png' : 'icon.png'
      try { return new URL(`dsh-whale-pod/${name}`, document.baseURI).pathname } catch { return `/dsh-whale-pod/${name}` }
    }

    /**
     * 调 Host 的 /api/whale-pod/*。
     * 8 秒超时兜底：后端路由未注册时 fetch 不该永久挂起。
     */
    /**
     * 最近一次请求失败的记录。
     *
     * 桌面版 DSH 没有 F12，出问题时界面上只有一句「后端未运行」，
     * 看不到 HTTP 状态码和响应体 —— 排查全靠猜。
     * 这里把失败细节留在模块作用域，面板上直接显示出来。
     */
    const lastApiError = { path: '', status: 0, body: '' }

    async function api(path, options) {
      const { timeout = 8000, ...rest } = options ?? {}
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), timeout)
      try {
        const response = await fetch(`${API}${path}`, { ...rest, redirect: 'error', signal: ctrl.signal })
        const text = await response.text()
        let payload
        try { payload = text === '' ? {} : JSON.parse(text) } catch { payload = { error: text.slice(0, 200) } }
        if (!response.ok) {
          // ⚠️ 502/503 是"后端进程没起"的正常信号，**不算错误**。
          //
          //    透传那头在 WhalePod 不可达时回 502（ECONNREFUSED），
          //    这是用户主动关掉后端之后的**常态** —— 面板上应当安静地显示
          //    「后端未运行 · 点一键启动」，而不是甩一行红字报错。
          //    只有 4xx/5xx 里真正由我们代码引起的（400/403/500）才记录。
          if (response.status !== 502 && response.status !== 503) {
            lastApiError.path = path
            lastApiError.status = response.status
            lastApiError.body = text.slice(0, 160)
          }
          throw new Error(payload?.error ?? `HTTP ${response.status}`)
        }
        if (lastApiError.status !== 0) { lastApiError.path = ''; lastApiError.status = 0; lastApiError.body = '' }
        return payload
      } catch (error) {
        // ⚠️ 只记录"真的出问题"的异常。
        //
        //    后端进程没起时这条链路上会出现两种异常，都是**常态**，不该报红：
        //      ① 上游回 502/503 → 上面已跳过记录，但 throw 会落到这里，
        //         若不加判断就会被记成 -1，又甩一行红字出来。
        //      ② 浏览器侧网络异常（ECONNREFUSED / Failed to fetch），
        //         同样是后端不在。
        //
        //    只有「接口通了但返回了非 4xx/5xx 之外的东西」或真正的前端异常
        //    才值得让用户看见。
        const msg = String(error?.message ?? error)
        const isBackendDown = /WhalePod 进程不可达|ECONNREFUSED|Failed to fetch|NetworkError|aborted|ECONNRESET|socket hang up/i.test(msg)
        if (lastApiError.status === 0 && !isBackendDown) {
          lastApiError.path = path
          lastApiError.status = -1
          lastApiError.body = msg.slice(0, 160)
        }
        throw error
      } finally {
        clearTimeout(timer)
      }
    }

    const post = (path, body, timeout) => api(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      ...body === undefined ? {} : { body: JSON.stringify(body) },
      ...timeout === undefined ? {} : { timeout },
    })

    // ── 基础样式 ───────────────────────────────────────────────────────────
    // 全部走主题变量，切换配色方案时不用改。
    const CSS = `
/* ── 根容器 ───────────────────────────────────────────────────────
 *
 * ⚠️ 这里是 height:100% 换成 min-height:0 的原因（2026-10-19 实测）：
 *
 *   这个 .gd_root 同时被两处复用：
 *     · 侧栏面板（main slot）—— 父容器有确定高度，height:100% 正常
 *     · 设置页（settings.section）—— 父容器是**可滚动的 section**，
 *       高度由内容撑开，不是确定的
 *
 *   height:100% 在"父容器高度不确定"时会解析成 auto/0 ——
 *   于是整块内容被压成 0 高，用户看到的就是**一片空白**。
 *   实际踩到：后端关掉后进设置页，标题和提示都看不见，只有白板。
 *
 *   改成 min-height:0（=.min-height:auto 语义）让内容自己撑开；
 *   滚动交给外层容器，这里只在"内容确实超高"时兜底滚动。
 *
 * ⚠️ 2026-10-23 又删掉了 overscroll-behavior:contain（实测踩过）：
 *
 *   它和上面那句「滚动交给外层容器」**直接冲突** —— contain 会阻止
 *   滚动向父级链式传递。
 *
 *   而且 .gd_root 在设置页里**没有高度约束**（height/max-height/flex 都没设），
 *   高度就撑到内容高 → 自己永远滚不动（实测 scrollHeight === clientHeight
 *   === 2578）→ 于是它成了「滚不动的 scroll container」：
 *
 *     滚轮落在 .gd_root 上 → 它自己滚不动，contain 又不让父级滚 → 谁都不滚
 *     只有落在它外面（宿主那 24px 左右内边距、或滚动条）才滚得到
 *
 *   用户的原话是「滚动只有边上能用」，就是这个现象。
 *   用真实滚轮事件验证过：去掉 contain 后，父容器 scrollTop 0 → 360。
 *
 *   overflow-y:auto 保留 —— 那是侧栏面板（父容器高度确定）下的兜底滚动。
 *
 *   ⚠️ 本注释不能写反引号：这段 CSS 本身在模板字符串里，裸反引号会截断它
 *      （这个坑历史上踩过 4 次，2026-10-23 写上面这段时又踩了一次）。
 * ──────────────────────────────────────────────────────────────── */
.gd_root{display:flex;flex-direction:column;gap:14px;padding:4px 2px 28px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.6;overflow-y:auto}
/* 整页视图（main 槽位）下内容会被拉到一千多像素宽，而侧栏只有 ~300px。
   同一份 CSS 要同时服务两种宽度，所以用容器查询分别调布局：
     · 宽（整页）→ 限宽 + 两栏网格，不把按钮/卡片拉满
     · 窄（侧栏）→ 单栏铺满
   限宽用 max-width 而不是写死宽度，窄容器不受影响。 */
.gd_root{container-type:inline-size;max-width:860px;margin:0 auto;width:100%}
/* 侧栏容器高度有限，内容比视口高时必须自己能滚 —— 否则下半部分永远看不见。
   用 100% 而不是 100vh：面板被嵌在侧栏里，vh 会把顶栏高度也算进去。 */
.gd_hero{display:flex;flex-direction:column;gap:6px}
.gd_hero h2{margin:0;font-size:17px;font-weight:600;line-height:26px}
.gd_hero p{margin:0;color:var(--dsw-alias-label-secondary);font-size:12.5px}
/* 图标 + 标题并排（设置页头部） */
.gd_herotop{display:flex;align-items:center;gap:11px;min-width:0}
/* 右上角「点个 Star」——参考同类插件的做法：圆角胶囊 + 主题色描边。
   用 <a> 而不是 button：它是外链跳转，中键/右键「新标签打开」应该能用。 */
.gd_herotop .gd_repobtn{margin-left:auto;flex:none;display:inline-flex;align-items:center;gap:6px;padding:6px 14px;border-radius:999px;border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent);color:var(--dsw-alias-brand-primary);font-size:12.5px;font-weight:600;text-decoration:none;white-space:nowrap;transition:background .15s,border-color .15s}
.gd_herotop .gd_repobtn:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 20%,transparent);border-color:var(--dsw-alias-brand-primary)}
.gd_repobtnstar{font-size:13px;line-height:1}
.gd_heroicon{flex:none;width:40px;height:40px;border-radius:10px;object-fit:cover;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1)}
.gd_herotext{display:flex;flex-direction:column;gap:2px;min-width:0}
.gd_herotext h2{margin:0;font-size:17px;font-weight:600;line-height:1.35}
.gd_herotext p{margin:0;color:var(--dsw-alias-label-secondary);font-size:12.5px;line-height:1.45}
.gd_sec{display:flex;flex-direction:column;gap:10px;padding:14px 16px;border-radius:14px;border:1px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 82%,transparent)}
.gd_sechead{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
/* 标题行：图标 + 标题 + 右侧提示 */
.gd_titlewrap{display:flex;align-items:center;gap:9px;min-width:0}
.gd_titleicon{flex:none;width:28px;height:28px;border-radius:7px;object-fit:cover;display:block}
/* 标题行右侧：刷新按钮 + 自动刷新提示 */
.gd_headright{display:flex;align-items:center;gap:7px;flex:none}
/* 右上角两行小字：自动刷新提示 + 活跃天数 */
.gd_headmini{display:flex;flex-direction:column;align-items:flex-end;gap:1px;line-height:1.25}
.gd_refresh{width:24px;height:24px;padding:0;display:flex;align-items:center;justify-content:center;border-radius:7px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1;cursor:pointer;font-family:inherit;transition:border-color .12s,color .12s}
.gd_refresh:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary)}
.gd_refresh:disabled{opacity:.5;cursor:default}
.gd_refresh.spin{animation:gd-spin .8s linear infinite}
@keyframes gd-spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}
.gd_titletext{margin:0;font-size:16px;font-weight:620;line-height:1.4}
.gd_sectitle{margin:0;font-size:13px;font-weight:620}
.gd_sechint{color:var(--dsw-alias-label-tertiary);font-size:11.5px}
/* 计数/用量格子：
   · 窄容器（侧栏）→ 两列（4 个格子排 2×2，太高就浪费）
   · 宽容器（整页）→ 四列（一行放完）
   用容器查询切换，不再依赖 auto-fit（那会在中等宽度挤出 3 列这种怪布局）。 */
.gd_grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
@container (min-width:560px){.gd_grid{grid-template-columns:repeat(4,minmax(0,1fr))}}
/* 用量卡片只有 3 项，宽屏下用三列而不是四列 */
@container (min-width:560px){.gd_grid.gd_grid3{grid-template-columns:repeat(3,minmax(0,1fr))}}
.gd_kv{display:flex;flex-direction:column;gap:2px;padding:8px 10px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 55%,transparent);min-width:0}
.gd_kv b{font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gd_kv span{color:var(--dsw-alias-label-tertiary);font-size:10.5px;letter-spacing:.2px}
.gd_row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:7px 0;border-bottom:1px solid color-mix(in srgb,var(--dsw-alias-border-l1) 55%,transparent)}
.gd_row:last-child{border-bottom:none}
.gd_rowlabel{display:flex;flex-direction:column;gap:1px;min-width:0}
.gd_rowlabel b{font-size:12.5px;font-weight:520}
.gd_rowlabel i{font-style:normal;color:var(--dsw-alias-label-tertiary);font-size:10.5px}
.gd_actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.gd_pill{display:inline-flex;align-items:center;gap:5px;padding:2px 9px;border-radius:99px;font-size:11px;border:1px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 60%,transparent)}
.gd_pill.ok{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 40%,transparent)}
.gd_pill.off{color:var(--dsw-alias-label-tertiary)}
.gd_pill.warn{color:var(--dsw-alias-state-warning-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-warning-primary) 40%,transparent)}
.gd_input,.gd_textarea,.gd_select{width:100%;box-sizing:border-box;padding:6px 9px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12.5px;font-family:inherit}
.gd_textarea{min-height:74px;resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;line-height:1.55}
.gd_input:focus,.gd_textarea:focus,.gd_select:focus{outline:none;border-color:var(--dsw-alias-state-business-primary)}
.gd_num{width:104px;flex:none}
.gd_note{color:var(--dsw-alias-label-tertiary);font-size:11px}
.gd_err{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:1.5;word-break:break-word}
.gd_logs{margin:0;padding:9px 11px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);max-height:280px;overflow:auto;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:1.65;white-space:pre-wrap;word-break:break-all}
.gd_logwarn{color:var(--dsw-alias-state-warning-primary)}
.gd_logerror{color:var(--dsw-alias-state-error-primary)}
.gd_btn{padding:5px 13px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12.5px;cursor:pointer;font-family:inherit}
.gd_btn:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary)}
.gd_btn:disabled{opacity:.55;cursor:default}
.gd_btn.primary{border-color:var(--dsw-alias-state-business-primary);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 14%,transparent)}
/* 一键启停：占满宽度，好点 */
.gd_btn.wide{flex:1;padding:7px 13px;font-size:13px;font-weight:600;max-width:340px}
/* ── 后端进程窗口 ─────────────────────────────────────────────── */
.gd_procbox{border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 45%,transparent);overflow:hidden}
.gd_prochead{display:flex;align-items:center;gap:6px;padding:7px 10px;cursor:pointer;user-select:none;min-width:0;font-size:11.5px}
.gd_prochead:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 4%,transparent)}
.gd_procsum{margin-left:auto;font-size:10px;color:var(--dsw-alias-label-tertiary);flex:none}
.gd_procok{color:var(--dsw-alias-state-success-primary)}
.gd_procdead{color:var(--dsw-alias-state-warning-primary)}
.gd_proclist{display:flex;flex-direction:column;gap:3px;padding:0 8px 8px}
.gd_procrow{display:flex;align-items:center;gap:7px;padding:4px 7px;border-radius:7px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 60%,transparent);font-size:10.5px;min-width:0}
.gd_prockind{flex:none;padding:1px 6px;border-radius:5px;font-size:9px;font-weight:600;border:1px solid transparent}
.gd_prockind.whale-pod{color:var(--dsw-alias-state-business-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 12%,transparent)}
.gd_prockind.napcat{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent)}
.gd_prockind.other{color:var(--dsw-alias-label-tertiary);border-color:var(--dsw-alias-border-l2)}
.gd_procpid{flex:none;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.gd_procmeta{margin-left:auto;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* 侧栏的只读模型行 */.gd_modelrow{display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:9px;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 55%,transparent);min-width:0}
.gd_modelrowlabel{font-size:10.5px;color:var(--dsw-alias-label-tertiary);flex:none}
.gd_modelrow b{font-size:12px;font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* 保存状态提示：紧跟在模型名后面，不占额外一行 */
.gd_savestate{font-size:10.5px;flex:none;margin-left:2px;transition:opacity .2s}
.gd_savestate.saving{color:var(--dsw-alias-label-tertiary)}
.gd_savestate.done{color:var(--dsw-alias-state-success-primary)}
/* ── 渠道优先级列表（侧栏模型卡片）───────────────────────────── */
.gd_chlist{display:flex;flex-direction:column;gap:8px}
/* ── 模态大类切换（LLM / VLM）────────────────────────────────── */
.gd_modaltabs{display:flex;gap:6px}
.gd_modaltab{flex:1;padding:7px 9px;border-radius:9px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;font-family:inherit;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:5px;transition:border-color .12s,background .12s}
.gd_modaltab:hover:not(:disabled){border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}
.gd_modaltab.on{border-color:var(--dsw-alias-state-business-primary);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 13%,transparent);color:var(--dsw-alias-label-primary);font-weight:600}
.gd_modaltab:disabled{opacity:.35;cursor:default}
/* ── 渠道卡片（照渠道卡片形态：标题行 + 可折叠模型列表）────────── */
/* 固定两列。
   ⚠️ 不要用 auto-fit —— 它随容器宽度变化，设置页被拖宽时会变成三列、
      拖窄时又变一列，卡片宽度跳来跳去（实测观感很差）。
      设置页的宽度是相对固定的，直接写死两列更稳。
   容器过窄时（侧栏复用这个组件）用 minmax(0,1fr) 保证两列都能压缩，
   不会因为内容撑破而溢出。 */
.gd_chcards{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;align-items:start;container-type:inline-size}
.gd_chcard{border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 45%,transparent);overflow:hidden;transition:border-color .12s,opacity .12s}
/* 展开的卡片横跨整行 —— 模型列表很长，挤在半列里读不了 */
.gd_chcard.expanded{grid-column:1/-1}
/* 极窄容器（<420px，比如把模型卡片塞进侧栏时）退回单列，
   否则两列各剩不到 200px，渠道名会被截成「workb…」。 */
@container (max-width:420px){.gd_chcards{grid-template-columns:1fr}}
.gd_chcard.hasCurrent{border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 55%,transparent)}
.gd_chcard.off{opacity:.5}
.gd_chcard.drag{opacity:.4}
.gd_chcard.over{border-color:var(--dsw-alias-state-business-primary);border-style:dashed}
.gd_chcardhead{display:flex;align-items:center;gap:6px;padding:7px 9px;cursor:pointer;user-select:none;min-width:0}
.gd_chcardhead:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 4%,transparent)}
.gd_chcardname{display:flex;flex-direction:column;gap:0;min-width:0;flex:1}
.gd_chcardtitle{display:flex;align-items:center;gap:5px;min-width:0}
.gd_chcardtitle b{font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
/* 标记小徽章：内置 / 需代理 */
.gd_tagchip{flex:none;font-size:9px;padding:1px 5px;border-radius:5px;line-height:1.5;white-space:nowrap;border:1px solid transparent}
.gd_tagchip.builtin{color:var(--dsw-alias-label-secondary);border-color:var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-label-primary) 7%,transparent)}
.gd_tagchip.proxy{color:var(--dsw-alias-state-warning-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-warning-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warning-primary) 12%,transparent);cursor:help}
.gd_chcardname b{font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gd_chcardmeta{font-size:9.5px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* 顶部摘要行里的推理等级下拉 */
.gd_effortsel{flex:none;margin-left:auto;padding:2px 6px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);font-size:10.5px;font-family:inherit;cursor:pointer;max-width:120px}
/* ── 下拉选项配色 ───────────────────────────────────────────────
   ⚠️ 必须显式给 option 设 background + color。
   select 自身用了透明背景 + 主题色文字，但**展开的选项列表是浏览器
   原生渲染的**，它默认白底；文字继承主题的浅色 → 白底白字，几乎看不见
   （实测截图里就是这个现象）。
   这里给 option 明确的前景/背景，并加 color-scheme 让原生控件跟随主题。 */
.gd_select,.gd_effortsel{color-scheme:dark}
.gd_select option,.gd_effortsel option{background:var(--dsw-alias-bg-layer-2,#1f1f1f);color:var(--dsw-alias-label-primary,#e6e6e6)}
.gd_select optgroup{background:var(--dsw-alias-bg-layer-2,#1f1f1f);color:var(--dsw-alias-label-tertiary,#9a9a9a)}
/* ── 模型分类标签页 ───────────────────────────────────────────── */
.gd_tabs{display:flex;gap:4px;flex-wrap:wrap}
.gd_tab{flex:1;min-width:0;padding:5px 7px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);font-size:11px;font-family:inherit;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:4px;white-space:nowrap;overflow:hidden}
.gd_tab:hover:not(:disabled){border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}
.gd_tab.on{border-color:var(--dsw-alias-state-business-primary);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 13%,transparent);color:var(--dsw-alias-label-primary);font-weight:600}
.gd_tab:disabled{opacity:.35;cursor:default}
.gd_tabcount{font-size:9.5px;opacity:.7;font-variant-numeric:tabular-nums}
/* ── 模型清单（小窗，可滚）────────────────────────────────────── */
.gd_modellist{display:flex;flex-direction:column;gap:3px;max-height:190px;overflow-y:auto;padding-right:2px}
.gd_modelitem{display:flex;align-items:center;gap:6px;width:100%;padding:5px 8px;border-radius:8px;border:1px solid transparent;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 45%,transparent);color:var(--dsw-alias-label-primary);font-size:11.5px;font-family:inherit;cursor:pointer;text-align:left;min-width:0}
.gd_modelitem:hover:not(:disabled){border-color:var(--dsw-alias-border-l2)}
.gd_modelitem.on{border-color:var(--dsw-alias-state-business-primary);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 12%,transparent)}
.gd_modelitem:disabled{opacity:.55;cursor:default}
.gd_modelname{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gd_modelbadge{flex:none;font-size:9px;padding:1px 5px;border-radius:5px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 9%,transparent);color:var(--dsw-alias-label-tertiary)}
.gd_modelcheck{flex:none;font-size:10px;color:var(--dsw-alias-state-business-primary)}
.gd_autoitem{width:100%;padding:5px 8px;border-radius:8px;border:1px dashed var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);font-size:11.5px;font-family:inherit;cursor:pointer;text-align:left}
.gd_autoitem.on{border-style:solid;border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 10%,transparent)}
.gd_autoitem:disabled{opacity:.55;cursor:default}
/* ── 表单字段（下拉框）────────────────────────────────────────── */
.gd_field{display:flex;flex-direction:column;gap:3px;min-width:0}
.gd_fieldlabel{font-size:10.5px;color:var(--dsw-alias-label-tertiary)}
.gd_select{width:100%;padding:5px 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px;font-family:inherit;cursor:pointer}
.gd_select:disabled{opacity:.55;cursor:default}
/* ── 可折叠区块 ─────────────────────────────────────────────── */
.gd_foldhead{cursor:pointer;user-select:none;border-radius:7px;padding:2px 4px;margin:-2px -4px;transition:background .12s}
.gd_foldhead:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 5%,transparent)}
.gd_foldhead:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.gd_chevron{display:inline-block;font-size:9px;line-height:1;color:var(--dsw-alias-label-tertiary);transition:transform .15s;transform-origin:center}
.gd_chevron.open{transform:rotate(90deg)}
.gd_group{display:flex;flex-direction:column;gap:4px}
.gd_grouptitle{display:flex;align-items:baseline;gap:6px;font-size:10.5px;font-weight:600;letter-spacing:.02em;color:var(--dsw-alias-label-tertiary);padding:2px 2px 0}
.gd_grouphint{font-weight:400;opacity:.8;font-size:9.5px}
.gd_chrow{display:flex;align-items:center;gap:7px;padding:5px 8px;border-radius:9px;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 55%,transparent);min-width:0;transition:border-color .12s,opacity .12s}
.gd_chrow[draggable="true"]{cursor:grab}
.gd_chrow.drag{opacity:.4;cursor:grabbing}
.gd_chrow.over{border-color:var(--dsw-alias-state-business-primary);border-style:dashed}
.gd_chrow.off{opacity:.5}
.gd_grip{flex:none;font-size:10px;line-height:1;color:var(--dsw-alias-label-tertiary);cursor:grab;letter-spacing:-1px;user-select:none}
.gd_chnum{flex:none;width:15px;text-align:center;font-size:10.5px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.gd_chname{display:flex;flex-direction:column;gap:0;min-width:0;flex:1}
.gd_chname b{font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gd_chmeta{font-size:10px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gd_chacts{display:flex;gap:3px;flex:none}
.gd_mini{width:21px;height:21px;padding:0;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1;cursor:pointer;font-family:inherit;display:flex;align-items:center;justify-content:center}
.gd_mini:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary)}
.gd_mini:disabled{opacity:.35;cursor:default}
.gd_mini.on{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}
/* ── 仪表盘专属 ─────────────────────────────────────────────── */
.gd_heroBig{display:flex;flex-direction:column;gap:8px}
.gd_statusBig{display:flex;align-items:center;gap:10px}
.gd_dot{width:14px;height:14px;border-radius:99px;flex:none;background:var(--dsw-alias-label-tertiary)}
.gd_dot.ok{background:var(--dsw-alias-state-success-primary);box-shadow:0 0 10px color-mix(in srgb,var(--dsw-alias-state-success-primary) 55%,transparent)}
.gd_dot.warn{background:var(--dsw-alias-state-warning-primary)}
.gd_statusText{font-size:19px;font-weight:640;line-height:1.2}
.gd_statusSub{color:var(--dsw-alias-label-tertiary);font-size:12px}
.gd_count{display:flex;flex-direction:column;gap:1px;padding:10px 12px;border-radius:12px;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 55%,transparent)}
.gd_count b{font-size:21px;font-weight:650;font-variant-numeric:tabular-nums;line-height:1.15}
.gd_count span{color:var(--dsw-alias-label-tertiary);font-size:10.5px;letter-spacing:.3px}
.gd_feed{display:flex;flex-direction:column;gap:7px;max-height:330px;overflow:auto;padding-right:2px}
.gd_msg{display:flex;flex-direction:column;gap:3px;padding:8px 11px;border-radius:11px;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 55%,transparent)}
.gd_msghead{display:flex;align-items:baseline;gap:7px;flex-wrap:wrap}
.gd_msghead b{font-size:12px;font-weight:600}
.gd_msghead time{color:var(--dsw-alias-label-tertiary);font-size:10.5px;margin-left:auto}
.gd_msgtext{font-size:12px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.gd_msgreply{font-size:12px;padding:6px 9px;border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 9%,transparent);border-left:2px solid color-mix(in srgb,var(--dsw-alias-state-business-primary) 55%,transparent);overflow-wrap:anywhere}
.gd_msgtags{display:flex;gap:6px;flex-wrap:wrap}
.gd_tag{font-size:10px;padding:1px 7px;border-radius:99px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-tertiary)}
.gd_tag.at{color:var(--dsw-alias-state-business-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 40%,transparent)}
.gd_tag.fail{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 40%,transparent)}
.gd_sidehead{display:flex;align-items:center;justify-content:space-between;gap:8px}
.gd_sidehint{color:var(--dsw-alias-label-tertiary);font-size:10.5px}
@media (prefers-reduced-motion:reduce){.gd_dot{box-shadow:none}}
`

    // ── 小组件 ─────────────────────────────────────────────────────────────
    function Section({ title, hint, children }) {
      return h('section', { className: 'gd_sec' },
        h('div', { className: 'gd_sechead' },
          h('h3', { className: 'gd_sectitle' }, title),
          hint === undefined ? null : h('span', { className: 'gd_sechint' }, hint)),
        children)
    }

    /**
     * 可折叠区块。
     *
     * 侧栏高度有限，日志和渠道列表这类"内容可能很长、但不需要一直看"的
     * 区块默认收起，需要时点开 —— 否则它们会把下面真正要盯的东西（状态、
     * 计数）挤出视口。折叠状态记在组件内，刷新后回到默认值。
     *
     * @param {boolean} [defaultOpen=false] 初始是否展开
     * @param {string}  [summary] 收起时在标题右侧显示的一句话摘要
     */
    function Fold({ title, hint, summary, defaultOpen = false, children }) {
      const [open, setOpen] = useState(defaultOpen)
      return h('section', { className: 'gd_sec' },
        h('div', {
          className: 'gd_sechead gd_foldhead',
          onClick: () => setOpen((v) => !v),
          role: 'button',
          tabIndex: 0,
          onKeyDown: (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              setOpen((v) => !v)
            }
          },
        },
          h('span', { className: `gd_chevron${open ? ' open' : ''}` }, '▸'),
          h('h3', { className: 'gd_sectitle' }, title),
          // 收起时显示摘要，展开时显示 hint —— 信息密度最大化
          h('span', { className: 'gd_sechint' }, open ? (hint ?? '') : (summary ?? hint ?? ''))),
        open ? children : null)
    }

    function KV({ label, value }) {
      return h('div', { className: 'gd_kv' },
        h('span', null, label),
        h('b', { title: String(value ?? '') }, value === undefined || value === null || value === '' ? '—' : String(value)))
    }

    function Pill({ tone, children }) {
      return h('span', { className: `gd_pill${tone === undefined ? '' : ' ' + tone}` }, children)
    }

    /** 一行：左侧标签+说明，右侧控件。 */
    function Row({ label, hint, children }) {
      return h('div', { className: 'gd_row' },
        h('div', { className: 'gd_rowlabel' },
          h('b', null, label),
          hint === undefined ? null : h('i', null, hint)),
        children)
    }

    function Toggle({ checked, onChange, disabled }) {
      return h('input', {
        type: 'checkbox',
        checked: checked === true,
        disabled: disabled === true,
        onChange: (event) => onChange(event.target.checked),
        style: { width: '16px', height: '16px', cursor: 'pointer', flex: 'none' },
      })
    }

    /** 受控文本输入；失焦或回车时提交。 */
    function TextField({ value, onCommit, placeholder, disabled, numeric }) {
      const [draft, setDraft] = useState(value ?? '')
      useEffect(() => { setDraft(value ?? '') }, [value])
      const commit = () => {
        if (String(draft) === String(value ?? '')) return
        onCommit(numeric === true ? Number(draft) : draft)
      }
      return h('input', {
        className: `gd_input${numeric === true ? ' gd_num' : ''}`,
        type: numeric === true ? 'number' : 'text',
        value: draft,
        placeholder: placeholder ?? '',
        disabled: disabled === true,
        onChange: (event) => setDraft(event.target.value),
        onBlur: commit,
        onKeyDown: (event) => { if (event.key === 'Enter') { event.preventDefault(); commit() } },
      })
    }

    /**
     * 下拉选择。
     *
     * 为什么要有它：决策模式（rule / model）这类字段，用自由文本框
     * 让用户手打很容易打错（写成 `Model`、`现代化`、`rule ` 带空格），
     * 打错了不报错、只是行为变得莫名其妙 —— 排查成本极高。
     *
     * @param {object} o
     * @param {Array<{value:string,label:string,hint?:string}>} o.options
     */
    function Select({ value, options, onCommit, disabled }) {
      const list = Array.isArray(options) ? options : []
      // 当前值不在选项里（比如旧配置写了别的词）时，补一个只读项，
      // 否则 <select> 会自动跳到第一项，看起来像「被偷偷改了」。
      const known = list.some((o) => o.value === value)
      return h('select', {
        className: 'gd_input',
        value: known ? value : (value ?? ''),
        disabled: disabled === true,
        onChange: (event) => onCommit(event.target.value),
        style: { cursor: disabled === true ? 'not-allowed' : 'pointer' },
      },
        known ? null : h('option', { value: value ?? '' }, `${value ?? '(未设置)'}（当前值）`),
        ...list.map((o) => h('option', { value: o.value }, o.label)),
      )
    }

    /** 多行列表编辑（每行一项）。 */
    function ListField({ value, onCommit, disabled, placeholder }) {
      const text = Array.isArray(value) ? value.join('\n') : ''
      const [draft, setDraft] = useState(text)
      useEffect(() => { setDraft(text) }, [text])
      return h('textarea', {
        className: 'gd_textarea',
        value: draft,
        placeholder: placeholder ?? '',
        disabled: disabled === true,
        onChange: (event) => setDraft(event.target.value),
        onBlur: () => {
          const next = draft.split('\n').map((line) => line.trim()).filter((line) => line !== '')
          if (next.join('\n') === (Array.isArray(value) ? value.join('\n') : '')) return
          onCommit(next)
        },
      })
    }

    // ── 数据加载 ───────────────────────────────────────────────────────────
    function useAsync(loader, deps) {
      const [state, setState] = useState({ status: 'loading', data: undefined, error: '' })
      const run = useCallback(() => {
        let alive = true
        // ⚠️ 重载时**不把 status 打回 'loading'**，只保持已有状态。
        //
        //    原来这里是 `setState(c => ({...c, status: 'loading'}))`，于是每次
        //    4 秒轮询都会让界面上所有依赖 status 的判定短暂失效 —— 面板在
        //    「在线」和「后端未运行」之间每 4 秒闪一次。data 保留着，状态就不该抖。
        //
        //    首次加载时 status 本来就是 'loading'，不需要额外设置。
        //    （原来这里有一句 setState(current => current)，是纯 no-op，删掉。）
        loader()
          .then((data) => { if (alive) setState({ status: 'ready', data, error: '' }) })
          .catch((error) => { if (alive) setState({ status: 'error', data: undefined, error: String(error?.message ?? error) }) })
        return () => { alive = false }
      }, deps)
      useEffect(() => run(), [run])
      return { ...state, reload: run }
    }

    /**
     * 轻量的「数据已变更」广播器。
     *
     * ## 为什么需要它
     *
     * 设置页改了模型后，侧栏那行「当前模型」要等**下一个 20 秒轮询**才更新。
     * 用户点完保存切到侧栏一看还是旧模型，自然以为没存上。
     *
     * 这里做一个极简事件总线：谁改了数据就 broadcast()，
     * 所有 usePoll 组件立刻 reload()，不用等轮询周期。
     *
     * ⚠️ 刻意不用 Context / 全局 store：这只是「通知别人刷新」，
     *    不需要共享状态 —— 订阅者自己重新打接口，数据源始终是后端，
     *    本地不留副本，也就没有同步问题。
     */
    const refreshBus = (() => {
      const listeners = new Set()
      return {
        subscribe(fn) {
          listeners.add(fn)
          return () => listeners.delete(fn)
        },
        broadcast() {
          for (const fn of [...listeners]) {
            try { fn() } catch { /* 单个订阅者出错不影响其它 */ }
          }
        },
      }
    })()

    /** 定时轮询 hook：仪表盘与日志共用。间隔毫秒；0 = 不轮询。 */
    function usePoll(loader, deps, intervalMs) {
      const state = useAsync(loader, deps)
      // ① 定时刷新
      useEffect(() => {
        if (!intervalMs || intervalMs <= 0) return undefined
        const timer = setInterval(() => state.reload(), intervalMs)
        return () => clearInterval(timer)
      }, [state.reload, intervalMs])
      // ② 变更广播：别处刚改过数据 → 立刻刷新，不等轮询
      //
      // ⚠️ cleanup 必须包一层返回 undefined。
      //    refreshBus.subscribe() 返回的是 `() => listeners.delete(fn)`，
      //    而 Set.delete 返回 boolean —— React 会把它当 cleanup 函数调用，
      //    拿到 true 就报警告（"useEffect must not return anything
      //    besides a function"），在严格模式下甚至直接抛错。
      useEffect(() => {
        const unsubscribe = refreshBus.subscribe(() => {
          try { state.reload() } catch { /* ignore */ }
        })
        return () => { unsubscribe() }
      }, [state.reload])
      return state
    }

    // ── 仪表盘（侧栏面板正文）──────────────────────────────────────────────
    // 设计目标：常开不违和 —— 大状态灯、消息计数、最近对话流、快捷操作。
    // 所有数据 4 秒一轮；动作失败只闪一条提示，不打断面板。
    function WhalePodPanel(props) {
      const { t } = props
      const status = usePoll(() => api('/status'), [], 4000)
      const qq = usePoll(() => api('/qq'), [], 4000)
      // 活跃天数随 /status 一起回来（不用多开一个轮询）
      const activity = status.data?.activity ?? null
      const [busy, setBusy] = useState(false)
      const [flash, setFlash] = useState(null)

      useEffect(() => {
        if (flash === null) return undefined
        const timer = setTimeout(() => setFlash(null), 3500)
        return () => clearTimeout(timer)
      }, [flash])

      const s = status.data
      const q = qq.data
      const stats = q?.stats
      const enabled = s?.qq?.enabled === true || stats?.enabled === true
      const online = stats?.connected === true || s?.qq?.bridge === true
      const counters = stats?.counters ?? {}
      const recent = stats?.recent ?? q?.recent ?? []

      /**
       * 启停桥接 / 切暂停。
       *
       * ⚠️ 关闭动作会让 WhalePod **进程本身退出** —— 请求的响应可能在
       *    连接被掐断时就丢了，前端拿到的是网络错误而不是 JSON。
       *    如果只在成功时 reload，UI 就会永远停在旧数据上（"点一次能用，
       *    第二次报错"就是这么来的）。
       *
       *    所以：**无论成败都刷一次**，让界面按真实状态重新渲染；
       *    失败只闪提示，不阻塞后续操作。
       */
      const act = async (path, body) => {
        setBusy(true)
        try {
          await post(path, body)
        } catch (error) {
          // 关闭类动作的"错误"往往只是进程退出导致的连接中断，
          // 属于预期内，提示写得模糊一点，别吓人。
          const msg = String(error?.message ?? error)
          const benign = /ECONNRESET|ECONNREFUSED|socket hang up|aborted|network/i.test(msg)
          setFlash({
            ok: benign,
            text: benign ? t('actionRestarting') : msg,
          })
        } finally {
          // 无论如何都刷新 —— 这一条是修复"只能点一次"的关键
          status.reload()
          qq.reload()
          setBusy(false)
        }
      }

      // 三种状态要分清，否则「在线」会把暂停也盖住：
      //   未启用  → 灰点 + "机器人未启用"
      //   暂停中  → 黄点 + "已暂停"（连着但不会回复）
      //   在线    → 绿点 + "在线"
      //   离线    → 黄点 + "离线"（连不上协议端）
      const paused = stats?.paused === true
      const dotTone = !enabled ? '' : online ? (paused ? 'warn' : 'ok') : 'warn'
      const statusText = !enabled
        ? t('dash.off')
        : paused
          ? t('dash.paused')
          : online ? t('dash.online') : t('dash.offline')
      const selfName = stats?.self?.name || stats?.self?.id || null

      return h('div', { className: 'gd_root' },
        h('style', null, CSS),

        // ── 大状态 ───────────────────────────────────────────────────
        //
        // 侧栏只负责「看」：状态、计数、消息流。
        // 所有配置（模型、渠道优先级、白名单、回复设置）都在设置页 ——
        // 之前把模型卡片也塞进来，侧栏变成配置面板，一屏装不下、
        // 真正要盯的东西反被挤到看不见（用户反馈「这个页面不合理」）。
        h('div', { className: 'gd_heroBig' },
          h('div', { className: 'gd_sidehead' },
            h('div', { className: 'gd_titlewrap' },
              // 侧栏标题用同一张「肥鱼」图标，与设置页保持视觉一致。
              // 尺寸从 18px 提到 28px —— 18px 在这个标题行里几乎看不清是只鲸鱼。
              h('img', {
                className: 'gd_titleicon',
                src: iconUrl(),
                alt: '',
                srcSet: `${iconUrl()} 1x, ${iconUrl(2)} 2x`,
                width: 28,
                height: 28,
              }),
              h('h2', { className: 'gd_titletext' }, t('title'))),
            // 右侧：刷新按钮 + 自动刷新提示 + 活跃天数
            h('div', { className: 'gd_headright' },
              h('button', {
                className: `gd_refresh${busy ? ' spin' : ''}`,
                title: t('dash.refreshHint'),
                disabled: busy,
                onClick: () => {
                  // 三个数据源一起刷（状态/计数/消息流）
                  status.reload(); qq.reload()
                },
              }, '⟳'),
              h('div', { className: 'gd_headmini' },
                h('span', { className: 'gd_sidehint' }, t('dash.autoRefresh')),
                // 活跃天数：纯文字，不占卡片位置。
                // 从今天起累计，没有历史数据时显示 0。
                activity ? h('span', { className: 'gd_sidehint' },
                  `${t('dash.activeDays')} ${activity.totalDays ?? 0}${t('dash.activeDaysUnit')}`) : null))),
          // ⚠️ 用 `||` 而不是 `&&`。
          //
          //    status 和 qq 是两个独立的轮询（间隔都是 4s，但启动时刻差几十毫秒），
          //    后端没起时它们**不会同时**变成 error —— 总有一个还停在上一轮的 ready。
          //    用 && 就要求"两个同时失败"才显示后端未运行，实际几乎永远不成立，
          //    于是界面上一直显示「机器人未启用」，偶尔两个恰好都 error 才闪一下
          //    「后端未运行」—— 这就是用户看到的闪烁。
          //
          //    任一失败就说明后端不可达，按后端未运行处理。
          // ⚠️ 判定依据是「上次拿到的数据在不在」，不是当前的 loading/ready。
          //
          //    每次轮询都会把 status 置成 'loading'（见 useAsync），而 /status 和
          //    /qq 是两条独立轮询，它们不会同步 -— 若按 status === 'error' 判断，
          //    后端没起时会出现"一个 error 一个 loading"和"两个都 error"交替，
          //    界面就在「机器人未启用」和「后端未运行」之间闪。
          //
          //    改成看 data：只要还没成功拿到过一次数据，就按后端不可达处理。
          //    这样 loading → ready 的过渡期间不会跳变。
          status.data === undefined || qq.data === undefined
            // ⚠️ 不显示「无法连接后端」这种红字。
            //    后端不可达是**常态**（用户主动关掉它之后就是这样），
            //    下面就有「一键启动」按钮 —— 一条红字只让人以为出故障了。
            //    真正的诊断信息放在「后端进程」窗口里。
            //
            // 但**接口本身报错**（403/400/500）和「后端没起」是两回事：
            // 前者是我们的 bug，必须让它可见，否则桌面版没 F12 只能靠猜。
            ? h('div', null,
              h('p', { className: 'gd_note' }, t('dash.backendOff')),
              // 只有**真正的接口错误**才显示（4xx/5xx 里非 502/503 的）
              //
              // ⚠️ 不要显示 status === -1 那条。它对应的是"网络异常"，
              //    后端没起时每次轮询都会产生，而且 /status 和 /qq 两条
              //    请求的 message 措辞不同 —— 交替显示就是用户看到的闪烁。
              //    这类情况下面第一行已经说了"后端未运行"，不需要再补一句。
              lastApiError.status > 0 && lastApiError.status !== 502 && lastApiError.status !== 503
                ? h('p', {
                  className: 'gd_err',
                  style: { fontSize: '11px', marginTop: '4px', wordBreak: 'break-all' },
                }, `接口出错：${lastApiError.path} → HTTP ${lastApiError.status} ${lastApiError.body}`)
                : null)
            : h('div', { className: 'gd_statusBig' },
              h('span', { className: `gd_dot ${dotTone}` }),
              h('div', { style: { display: 'flex', flexDirection: 'column', gap: '1px', minWidth: 0 } },
                h('span', { className: 'gd_statusText' }, statusText),
                h('span', { className: 'gd_statusSub' }, !enabled
                  ? t('dash.offHint')
                  : `${selfName ? `${t('dash.self')}：${selfName} · ` : ''}${s?.qq?.napcatRunningLabel ?? (s?.qq?.running === true ? t('running') : t('stopped'))}`))),

          // ── 一键启停 ─────────────────────────────────────────────────
          //
          // 完全启停：启动 = NapCat + 桥接；停止 = 两个都关。
          // 只停桥接会把 NapCat 留在后台占内存/端口（用户要的"完全关闭"）。
          h('div', { className: 'gd_actions' },
            h('button', {
              className: `gd_btn wide${enabled ? '' : ' primary'}`,
              // ⚠️ 这里**不能**写 `busy || s === undefined`。
              //    WhalePod 停止后 /status 拿不到数据，`s` 就是 undefined ——
              //    那样按钮会永久禁用，用户点不动，只能重启 DSH。
              //    启动按钮恰恰是"后端不可达"时最该能用的东西。
              //    只有 busy 时才禁用（防连点）。
              disabled: busy,
              title: enabled ? t('qq.stopHint') : t('qq.startHint'),
              onClick: () => act(enabled ? '/qq/stop' : '/qq/start'),
            }, busy ? '…' : enabled ? t('qq.stop') : t('qq.start')),
            // 暂停开关：按钮上只写**动作**（暂停 / 恢复），不写状态。
            // 之前是「已暂停 ↔ 开启」，两个词一个像状态一个像动作，
            // 用户分不清按下去会发生什么（"已暂停"看着像当前状态标签，
            // 实际是"点我暂停"）。现在统一成动词。
            online ? h('button', {
              className: `gd_btn${stats?.paused === true ? ' primary' : ''}`,
              disabled: busy,
              title: stats?.paused === true ? t('qq.resumeHint') : t('qq.pauseHint'),
              onClick: () => act('/qq/pause', { paused: !(stats?.paused === true) }),
            }, stats?.paused === true ? t('qq.resume') : t('qq.pause')) : null,
            flash === null ? null : h('span', { className: flash.ok ? 'gd_note' : 'gd_err' }, flash.text))),

        // ── 消息计数 ─────────────────────────────────────────────────
        enabled ? h('div', { className: 'gd_grid' },
          h('div', { className: 'gd_count' }, h('b', null, String(counters.received ?? 0)), h('span', null, t('dash.received'))),
          h('div', { className: 'gd_count' }, h('b', null, String(counters.replied ?? 0)), h('span', null, t('dash.replied'))),
          h('div', { className: 'gd_count' }, h('b', null, String(counters.silent ?? 0)), h('span', null, t('dash.silent'))),
          h('div', { className: 'gd_count' }, h('b', null, String(counters.failed ?? 0)), h('span', null, t('dash.failed'))))
          : null,

        // ── 用量（tokens / 估算费用）─────────────────────────────────
        // 费用按模型官网价折算，与走哪个渠道无关 —— 看的是"这些用量按原价值多少"。
        enabled ? h(UsageCards, { t }) : null,

        // ── 当前模型（只读一行，点它跳设置页改）─────────────────────
        enabled ? h(CurrentModelRow, { t }) : null,

        // ── 后端进程窗口（可折叠，5 秒刷新）──────────────────────────
        // 放在启停按钮之后、消息流之前：排查"到底什么在跑"时最先想到它。
        h(ProcessPanel, { t }),

        // ── 最近消息流（可折叠；默认展开 —— 这是常看的部分）───────────
        enabled ? h(Fold, {
          title: t('dash.recent'),
          defaultOpen: true,
          summary: recent.length === 0 ? t('dash.recentEmpty') : `${recent.length} 条`,
          hint: `${recent.length} 条`,
        },
          recent.length === 0
            ? h('p', { className: 'gd_note' }, t('dash.recentEmpty'))
            : h('div', { className: 'gd_feed' },
              recent.map((item, index) => h('div', { className: 'gd_msg', key: item.at ?? index },
                h('div', { className: 'gd_msghead' },
                  h('b', null, item.senderName ?? '?'),
                  h('time', null, new Date(item.at ?? Date.now()).toLocaleTimeString()),
                  item.scope ? h('span', { className: 'gd_tag' }, item.scope) : null,
                  item.mentionsMe ? h('span', { className: 'gd_tag at' }, '@') : null,
                  item.outcome === 'failed' ? h('span', { className: 'gd_tag fail' }, t('dash.failed')) : null),
                h('div', { className: 'gd_msgtext' }, (function () {
                  // ⚠️ 图片标记只能出现一次。
                  //
                  // 数据流：parseMessage 已经把图片段变成 `text` 里的
                  // 「[图片]」占位符（见 src/qq/onebot.js），`_record` 原样存下。
                  // 而这里早先无条件补了一个 `[图片] ` —— 于是同一条消息
                  // 显示成「[图片] [图片]是你吗」（2026-10-25 实测反馈）。
                  //
                  // 所以：text 里**已经有**占位符就不再补；
                  // 只有「有图但 text 没占位符」的旧记录才补一个。
                  const body = String(item.text ?? '')
                  const hasImgMark = /\[(?:图片|表情包(?::[^\]]*)?|表情(?::\d+)?)\]/.test(body)
                  const needMark = (item.images ?? []).length > 0 && !hasImgMark
                  const head = needMark ? `${t('dash.img')} ` : ''
                  return `${head}${body}`.slice(0, 200) || '—'
                })()),
                item.reply ? h('div', { className: 'gd_msgreply' }, String(item.reply).slice(0, 200)) : null))))
          : null)
    }
    /**
     * 当前模型（侧栏只读一行）。
     *
     * 侧栏不提供修改 —— 只显示"现在用的是什么"，改去设置页。
     * 这样侧栏保持短，且不会因为误点改了线上行为。
     */
    function CurrentModelRow({ t }) {
      const data = usePoll(() => api('/models'), [], 20000)
      const d = data.data
      if (!d?.settings) return null
      const qqModel = d.settings.qqModel ?? 'auto'
      let label = t('model.auto')
      if (qqModel !== 'auto') {
        const hit = (d.models ?? []).find((m) => `${m.provider}/${m.id}` === qqModel)
        label = hit?.label ?? qqModel
      }
      return h('div', { className: 'gd_modelrow' },
        h('span', { className: 'gd_modelrowlabel' }, t('model.current')),
        h('b', { title: label }, label))
    }

    /**
     * 后端进程窗口（侧栏常驻，可折叠）。
     *
     * ## 为什么需要它
     *
     * 启停按钮只给出"成/败"，看不到背后到底跑着什么。
     * 实际踩过的困惑：
     *   · "关了但 QQ 还在线" → 其实 WhalePod 进程还在
     *   · "启动了但没反应"   → 其实 NapCat 没起来
     *   · "有两个 node 占着端口" → NapCat 是 launcher + core 两个进程
     *
     * 这个窗口把 whale-pod / napcat 进程列出来（pid、类型、内存、启动时间），
     * 让"现在到底有什么在跑"一目了然。
     *
     * ## 数据来源
     *
     * 走插件的 `/daemon/alive`（**不经过 WhalePod**）—— WhalePod 挂掉时
     * 正是最需要看这个窗口的时候，不能依赖它。
     */
    function ProcessPanel({ t }) {
      const alive = usePoll(() => api('/daemon/alive'), [], 5000)
      const [open, setOpen] = useState(false)

      const procs = alive.data?.processes ?? []
      const isUp = alive.data?.alive === true
      const kindLabel = (k) => (k === 'whale-pod' ? 'WhalePod' : k === 'napcat' ? 'NapCat' : t('proc.other'))
      const fmtTime = (iso) => {
        if (!iso) return '—'
        try { return new Date(iso).toLocaleTimeString() } catch { return '—' }
      }

      return h('div', { className: 'gd_procbox' },
        h('div', {
          className: 'gd_prochead',
          role: 'button',
          tabIndex: 0,
          onClick: () => setOpen((v) => !v),
          onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen((v) => !v) } },
        },
          h('span', { className: `gd_chevron${open ? ' open' : ''}` }, '▸'),
          h('b', null, t('proc.title')),
          // 收起时也给出关键摘要：总数 + 是否在服务
          h('span', { className: 'gd_procsum' },
            `${procs.length} 个`,
            isUp ? h('span', { className: 'gd_procok' }, ' · 在服务') : h('span', { className: 'gd_procdead' }, ' · 未服务'))),

        open
          ? (procs.length === 0
            ? h('p', { className: 'gd_note', style: { padding: '2px 4px 6px' } }, t('proc.empty'))
            : h('div', { className: 'gd_proclist' },
              procs.map((p) => h('div', { className: 'gd_procrow', key: p.pid },
                h('span', { className: `gd_prockind ${p.kind}` }, kindLabel(p.kind)),
                h('span', { className: 'gd_procpid' }, `pid ${p.pid}`),
                h('span', { className: 'gd_procmeta' },
                  [p.memMB === null ? null : `${p.memMB} MB`, fmtTime(p.startedAt)].filter(Boolean).join(' · '))))))
          : null)
    }

    /**
     * 模型卡片（**设置页专用**）：分类标签 + 模型列表 + 推理等级 + 渠道优先级。
     *
     * 原先放在侧栏，但内容太多把状态和消息流挤出了视口。侧栏只留只读的一行
     * （CurrentModelRow），真正的配置搬到这里。
     *
     * 换模型 / 调顺序是低频动作（限流了才换一次），放设置页更合适；
     * 改完立刻生效（`POST /api/models/settings` 每次请求现读，不需要重启）。
     *
     * ## 数据形状（来自 GET /api/models）
     *
     *   settings.qqModel          当前对话模型（'auto' 或 provider/model）
     *   settings.strategy         路由策略
     *   settings.disabledProviders 被关掉的渠道
     *   defaultOrder              实际生效的顺序（已应用配置）
     *   orderDetail[{provider, usable, enabled, reason, needsProxy}]
     *
     * ⚠️ 数据未就绪时返回 null，绝不在下面 map —— 整棵 React 树会崩（白屏）。
     */
    function ModelCards({ t }) {
      const data = usePoll(() => api('/models'), [], 15000)
      const [busy, setBusy] = useState(false)
      const [flash, setFlash] = useState(null)
      // 拖拽中的渠道名；null 表示没在拖
      const [dragging, setDragging] = useState(null)
      // 拖到哪个渠道上（显示插入位置）
      const [overTarget, setOverTarget] = useState(null)
      // 本地乐观顺序：拖完立刻显示新顺序，不等网络往返
      const [localOrder, setLocalOrder] = useState(null)
      // 展开的渠道卡片（一次只展开一个；null = 全收起）
      const [expanded, setExpanded] = useState(null)
      // 大类：LLM（纯文本） / VLM（能看图）
      const [modal, setModal] = useState('llm')

      useEffect(() => {
        if (flash === null) return undefined
        const timer = setTimeout(() => setFlash(null), 3000)
        return () => clearTimeout(timer)
      }, [flash])

      const d = data.data
      // 门卫：任何一个必需字段缺失都不渲染，避免白屏
      if (d === undefined || d === null) return null
      if (!d.settings || !Array.isArray(d.orderDetail)) return null

      const settings = d.settings
      const detail = d.orderDetail
      // 服务端回来的顺序；拖拽期间优先用本地乐观顺序
      const serverOrder = d.defaultOrder ?? detail.map((x) => x.provider)
      const order = localOrder ?? serverOrder
      const byProvider = new Map(detail.map((x) => [x.provider, x]))
      // 顺序里可能有 detail 里没有的（理论不会），兜底过滤
      const ordered = order.map((p) => byProvider.get(p)).filter(Boolean)

      /**
       * 只保留**有账号**的渠道。
       *
       * accounts === 0 表示该渠道一个账号都没接（渠道卡片上标"未接入"那种），
       * 选它必然失败 —— 列出来只会误导。undefined 表示查不到（内置/自备渠道），
       * 那种要保留：查不到 ≠ 没有。
       */
      const usable = ordered.filter((x) => x.accounts !== 0)
      const hiddenCount = ordered.length - usable.length

      /**
       * 分类标签与模型清单。
       *
       * 分组由服务端给出（`group` 字段，依据渠道包的 channel 分类）：
       *   channel —— 白嫖渠道（codearts/buddy/workbuddy/…），有账号才可用
       *   free    —— 免费渠道池
       *   eac     —— 协同付费车道
       *   kilo    —— 白嫖模型接入（Kilo 网关）
       * 空分类的标签会禁用，不会出现"点了空白"。
       */
      const allModels = d.models ?? []
      /**
       * 按模态过滤：LLM = 不能看图，VLM = 能看图。
       *
       * 判定用 `vision` 字段（服务端从 inputModalities 里算出来的）：
       *   'yes'     → VLM
       *   'no'      → LLM
       *   'unknown' → 渠道没上报，**两边都算** —— 不能断言它不支持，
       *               否则未上报的渠道会在两个标签里都消失。
       */
      const isVlm = (m) => m.vision === 'yes'
      const inModal = (m) => (m.vision === 'unknown' ? true : modal === 'vlm' ? isVlm(m) : !isVlm(m))
      const modalModels = allModels.filter(inModal)

      const modelsOfGroup = (gid) => modalModels.filter((m) => (m.group ?? 'channel') === gid)
      /** 某渠道的模型清单（按当前模态过滤）。 */
      const modelsForProvider = (provider) => modalModels.filter((m) => m.provider === provider)

      /**
       * 两个大类的计数（用全部模型算，不受当前 tab 影响）。
       * 空的那类把按钮禁用，避免点进去一片空白。
       */
      const countOf = (which) => allModels.filter((m) => (m.vision === 'unknown' ? true : which === 'vlm' ? isVlm(m) : !isVlm(m))).length
      const llmCount = countOf('llm')
      const vlmCount = countOf('vlm')

      /**
       * 只保留**当前模态下有模型**的渠道。
       *
       * 否则切到 VLM 时会出现一堆展开后空白的渠道卡片（比如某个渠道
       * 全是纯文本模型），看着像加载失败。
       */
      const usableForModal = usable.filter((x) => modelsForProvider(x.provider).length > 0)
      const enabled = usableForModal.filter((x) => x.enabled)
      const disabled = usableForModal.filter((x) => !x.enabled)

      /**
       * 当前模型的显示名（含渠道给的倍率后缀）。
       * 找不到时退回原始 id，不要显示成空白。
       */
      const selectedValue0 = settings.qqModel ?? 'auto'
      const currentLabel = selectedValue0 === 'auto'
        ? t('model.auto')
        : (allModels.find((m) => `${m.provider}/${m.id}` === selectedValue0)?.label ?? selectedValue0)

      /**
       * 当前模型的推理等级。
       *
       * 与 DSH 原生一致：等级跟着**选中的模型**走，而不是每个模型各挂一串。
       * 取当前模型的 efforts；auto 模式取所有模型里出现过的等级并集。
       *
       * ⚠️ 必须按**强度**排序，不能直接用上游给的顺序。
       *    `listModels` 回来的 efforts 是各模型自己声明的，集合合并后顺序
       *    随机（实测出现过 off/low/high/max/medium/tiered 这种乱序）。
       *    下拉框里等级从低到高排才符合直觉。
       */
      const EFFORT_RANK = ['disabled', 'off', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'tiered']
      const sortEfforts = (list) => [...new Set(list)].sort((a, b) => {
        const ia = EFFORT_RANK.indexOf(String(a).toLowerCase())
        const ib = EFFORT_RANK.indexOf(String(b).toLowerCase())
        // 未知等级排最后，但保持它们之间的相对顺序
        return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib)
      })

      const selectedValue = settings.qqModel ?? 'auto'
      const selectedModel = selectedValue === 'auto'
        ? null
        : allModels.find((m) => `${m.provider}/${m.id}` === selectedValue)
      /**
       * 可选等级。
       *
       * ⚠️ auto 模式下**不再列出所有模型的并集**。
       *    之前就是这么做的，结果用户选了一个只有 gemini 支持的 `tiered`，
       *    之后模型切到 buddy（不支持 tiered）→ 每次生成都失败，机器人
       *    整个不回复了（实测踩过）。
       *    现在 auto 模式不提供等级选择（各模型默认不同，强行统一没有意义），
       *    只有**明确选中某个模型**时才列出它自己支持的等级。
       */
      const currentEfforts = selectedModel?.efforts?.length > 0
        ? sortEfforts(selectedModel.efforts)
        : []
      const currentEffortDefault = selectedModel?.effortDefault ?? null

      /**
       * 已存的等级如果不在当前模型的集合里，说明它过期了（换过模型）。
       * 显示为空（=默认），避免下拉框显示一个根本不存在的选项。
       */
      const savedEffort = settings.effort ?? ''
      const effortValue = currentEfforts.includes(savedEffort) ? savedEffort : ''

      /**
       * 渠道分类：决定分组的标题与顺序。
       *
       * 依据是**额度模型**，不是厂商：
       *   lane —— 免费车道（opencode 的 *-free、cline 的 stealth/*）：按请求
       *           限速，没有"额度用光"状态，最可靠
       *   account —— 账号型（buddy / workbuddy）：吃单账号配额，会整天冷却
       *   other —— 其余免费渠道
       * 分组只是**展示**上的归类，实际路由仍按下面的完整顺序走。
       */
      const LANE = ['opencode', 'cline']
      const ACCOUNT = ['buddy', 'workbuddy']
      const groupOf = (p) => (LANE.includes(p) ? 'lane' : ACCOUNT.includes(p) ? 'account' : 'other')

      /** 提交设置；成功后刷新。 */
      const apply = async (patch) => {
        setBusy(true)
        try {
          await post('/models/settings', patch)
          data.reload()
        } catch (error) {
          setFlash({ ok: false, text: String(error?.message ?? error) })
          setLocalOrder(null)
        } finally {
          setBusy(false)
        }
      }

      /**
       * 拖拽落位：把 from 插到 to 的位置。
       *
       * 写回的是**完整顺序**（含被关闭的渠道，追加在末尾）——
       * 只提交启用中的渠道会让被关闭的渠道从配置里消失。
       */
      const dropOn = (from, to) => {
        if (from === to || from === null || to === null) return
        const list = enabled.map((x) => x.provider)
        const i = list.indexOf(from)
        const j = list.indexOf(to)
        if (i < 0 || j < 0) return
        list.splice(i, 1)
        list.splice(j, 0, from)
        const next = [...list, ...disabled.map((x) => x.provider)]
        setLocalOrder(next)
        apply({ freeOrder: next })
      }

      /** 开关某个渠道。 */
      const toggle = (provider, on) => {
        const next = on
          ? disabled.map((x) => x.provider).filter((p) => p !== provider)
          : [...disabled.map((x) => x.provider), provider]
        setLocalOrder(null)
        apply({ disabledProviders: next })
      }

      const latencyOf = (provider) => {
        const hit = (d.latency ?? []).find((x) => x.provider === provider)
        return hit === undefined ? null : hit.ms
      }

      return h(Section, {
        title: t('model.title'),
        hint: flash === null ? null : flash.text,
      },
        // ── 大类：LLM / VLM ────────────────────────────────────────
        //
        // 为什么分两大类：这两类模型的用途完全不同 —— VLM 能看图（发图
        // 才有意义），LLM 不能（发图等于没传）。混在一个列表里用户没法
        // 判断"我选这个能不能看图"，只能试。
        // 判定依据是 `vision`（服务端从 inputModalities 算），不是模型名。
        h('div', { className: 'gd_modaltabs' },
          [['llm', t('model.llm'), llmCount], ['vlm', t('model.vlm'), vlmCount]].map(([id, label, n]) =>
            h('button', {
              key: id,
              className: `gd_modaltab${modal === id ? ' on' : ''}`,
              disabled: busy || n === 0,
              onClick: () => { setModal(id); setExpanded(null) },
            },
              label,
              h('span', { className: 'gd_tabcount' }, String(n))))),

        // ── 当前模型 + 推理等级（顶部一行摘要）──────────────────────
        //
        // 这一行是**保存状态的锚点**：点模型是即时生效的（不需要按保存），
        // 但用户看不出来"到底存上没有"。
        //
        // ⚠️ 用本组件自己的 `flash`（第 1246 行）判断，**不要用 justSaved**。
        //    justSaved 是 SettingsPage 的 state，作用域不覆盖这里 ——
        //    直接引用会抛 ReferenceError: justSaved is not defined，
        //    而它在渲染期抛出 → 整个设置页白屏（2026-10-19 实测踩到，
        //    表现为"设置里鲸舱那一栏全白"，且不报任何可见错误）。
        h('div', { className: 'gd_modelrow' },
          h('span', { className: 'gd_modelrowlabel' }, t('model.current')),
          h('b', { title: currentLabel }, currentLabel),
          busy
            ? h('span', { className: 'gd_savestate saving' }, t('saving'))
            : (flash?.ok === true
              ? h('span', { className: 'gd_savestate done' }, `✓ ${t('saved')}`)
              : null),
          currentEfforts.length > 0
            ? h('select', {
              className: 'gd_effortsel',
              value: effortValue,
              disabled: busy,
              title: t('model.effort'),
              onChange: (event) => apply({ effort: event.target.value }),
            },
              h('option', { value: '' }, `${t('model.effort')}：${t('model.effortDefault')}`),
              currentEfforts.map((e) => h('option', { key: e, value: e }, t(`model.effortLevel.${e}`) === `model.effortLevel.${e}` ? e : t(`model.effortLevel.${e}`))))
            : null),

        // ── 切回自动（只在已选具体模型时出现）─────────────────────
        //
        // 之前这里**永远**有一个 auto 按钮，而上面的摘要行在 auto 模式下
        // 已经写着"auto（按下方顺序自动选）"—— 同一个信息显示两遍，
        // 还占一行高度。现在它只在"你选了具体模型、想切回来"时才有意义。
        (settings.qqModel ?? 'auto') === 'auto' ? null : h('button', {
          className: 'gd_autoitem',
          disabled: busy,
          onClick: () => { setLocalOrder(null); apply({ qqModel: 'auto' }) },
        }, t('model.backToAuto')),

        // ── 渠道卡片：每个渠道一张，模型列表可折叠 ──────────────────
        //
        // 形态照渠道卡片：标题行 = 渠道名 + 账号数 + 模型数 + 展开箭头；
        // 展开后才是模型清单（每行点一下即选中）。
        //
        // 为什么不用"标签页 + 扁平列表"（之前那版）：用户是按**渠道**思考的
        // （"我要用 buddy 的模型"），不是按分类。分类只作为分组小标题。
        usable.length === 0
          ? h('p', { className: 'gd_note' }, t('model.empty'))
          : h('div', { className: 'gd_chcards' },
            // 按额度模型分组：免费车道 → 账号型 → 其它 → 已关闭
            ['lane', 'account', 'other', 'off'].map((g) => {
              const items = g === 'off'
                ? disabled
                : enabled.filter((x) => groupOf(x.provider) === g)
              if (items.length === 0) return null
              return h('div', { className: 'gd_group', key: g },
                h('div', { className: 'gd_grouptitle' },
                  t(`model.group.${g}`),
                  g === 'account' ? h('span', { className: 'gd_grouphint' }, t('model.group.accountHint')) : null),
                items.map((item) => {
                  const list = modelsForProvider(item.provider)
                  const open = expanded === item.provider
                  const currentIn = list.some((m) => `${m.provider}/${m.id}` === (settings.qqModel ?? 'auto'))
                  const ms = latencyOf(item.provider)
                  return h('div', {
                    className: `gd_chcard${item.enabled ? '' : ' off'}${currentIn ? ' hasCurrent' : ''}${open ? ' expanded' : ''}${dragging === item.provider ? ' drag' : ''}${overTarget === item.provider && dragging !== null && dragging !== item.provider ? ' over' : ''}`,
                    key: item.provider,
                    // 拖拽落点：把拖着的渠道插到这个位置
                    onDragOver: (e) => {
                      if (dragging === null || !item.enabled) return
                      e.preventDefault()
                      try { e.dataTransfer.dropEffect = 'move' } catch {}
                      setOverTarget(item.provider)
                    },
                    onDragLeave: () => setOverTarget((prev) => (prev === item.provider ? null : prev)),
                    onDrop: (e) => {
                      e.preventDefault()
                      const from = dragging
                      setDragging(null)
                      setOverTarget(null)
                      if (from !== null) dropOn(from, item.provider)
                    },
                  },
                    // 标题行（点它展开/收起）
                    h('div', {
                      className: 'gd_chcardhead',
                      role: 'button',
                      tabIndex: 0,
                      onClick: () => setExpanded(open ? null : item.provider),
                      onKeyDown: (e) => {
                        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded(open ? null : item.provider) }
                      },
                    },
                      h('span', { className: `gd_chevron${open ? ' open' : ''}` }, '▸'),
                      h('div', { className: 'gd_chcardname' },
                        h('div', { className: 'gd_chcardtitle' },
                          h('b', { title: item.provider }, item.provider),
                          // 内置渠道标记：这两个不是 channel-pack 的账号渠道，
                          // 而是 DSH 自带的（API Key / OAuth），凭据来源完全不同。
                          item.kind === 'builtin'
                            ? h('span', { className: 'gd_tagchip builtin' }, t('model.kindBuiltin'))
                            : null,
                          // 需要代理标记：不标的话用户只看到"试跑很慢/超时"，
                          // 想不到是境外端点不通。
                          item.needsProxy
                            ? h('span', { className: 'gd_tagchip proxy', title: item.needsProxy }, t('model.needsProxy'))
                            : null),
                        h('span', { className: 'gd_chcardmeta' },
                          // 内置渠道不说"账号"——它没有账号概念，说凭据
                          item.kind === 'builtin'
                            ? `${list.length} 模型 · ${item.credentialReady ? t('model.credReady') : t('model.credMissing')}`
                            : `${list.length} 模型`,
                          item.kind === 'builtin' ? '' : (item.accounts !== undefined && item.accounts >= 0 ? ` · ${item.accounts} 账号` : ''),
                          ms === null ? '' : ` · ${ms}ms`,
                          item.enabled === false ? ` · ${t('model.off')}` : '')),
                      // 开关渠道
                      h('button', {
                        className: `gd_mini${item.enabled ? '' : ' on'}`,
                        title: item.enabled ? t('model.disable') : t('model.enable'),
                        disabled: busy,
                        onClick: (e) => { e.stopPropagation(); toggle(item.provider, !item.enabled) },
                      }, item.enabled ? '✓' : '○'),
                      // 拖拽排序手柄（整卡可拖）
                      h('span', {
                        className: 'gd_grip',
                        title: t('model.drag'),
                        draggable: true,
                        onDragStart: (e) => {
                          e.stopPropagation()
                          setDragging(item.provider)
                          try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', item.provider) } catch {}
                        },
                        onDragEnd: () => { setDragging(null); setOverTarget(null) },
                      }, '⋮⋮')),
                    // 模型清单（展开时）
                    open
                      ? (list.length === 0
                        ? h('p', { className: 'gd_note', style: { padding: '4px 8px' } }, t('model.groupEmpty'))
                        : h('div', { className: 'gd_modellist' },
                          list.map((m) => {
                            const value = `${m.provider}/${m.id}`
                            const active = (settings.qqModel ?? 'auto') === value
                            return h('button', {
                              key: value,
                              className: `gd_modelitem${active ? ' on' : ''}`,
                              disabled: busy,
                              title: `${m.provider} / ${m.id}`,
                              onClick: () => { setLocalOrder(null); apply({ qqModel: value }) },
                            },
                              h('span', { className: 'gd_modelname' }, m.label ?? m.id),
                              m.efforts?.length > 0
                                ? h('span', { className: 'gd_modelbadge' }, `${m.effortDefault ?? m.efforts[0]}`)
                                : null,
                              active ? h('span', { className: 'gd_modelcheck' }, '✓') : null)
                          })))
                      : null)
                }))
            })),

        // ── 策略 ───────────────────────────────────────────────────
        h('label', { className: 'gd_field' },
          h('span', { className: 'gd_fieldlabel' }, t('model.strategy')),
          h('select', {
            className: 'gd_select',
            value: settings.strategy ?? 'free-first',
            disabled: busy,
            onChange: (event) => apply({ strategy: event.target.value }),
          },
            h('option', { value: 'free-first' }, t('model.freeFirst')),
            h('option', { value: 'free-only' }, t('model.freeOnly')),
            h('option', { value: 'self-only' }, t('model.selfOnly')))))
    }


    /**
     * 用量卡片：总调用 / tokens / 折合费用 + 按渠道前三。
     * 8 秒轮询（比状态灯慢 —— 计数不需要那么急）。
     */
    function UsageCards({ t }) {
      const usage = usePoll(() => api('/usage'), [], 8000)
      const u = usage.data?.usage
      // 活跃天数：真正有消息往来的天数（关机那天不算）。
      // 和 usage.startedAt 不同 —— 那个是「装了多久」，这个才是「聊了几天」。
      const act = usage.data?.activity
      if (usage.status === 'error' || u === null || u === undefined) return null
      const top = (u.byProvider ?? []).slice(0, 3)
      const fmtTok = (n) => {
        const v = Number(n) || 0
        if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 1)}M`
        if (v >= 1000) return `${(v / 1000).toFixed(v >= 10_000 ? 0 : 1)}K`
        return String(v)
      }
      // 费用一律按模型官网价折算，**不再标「免费」**。
    //
    // 原来写的是 `usd > 0 ? '≈¥xx' : '¥0（免费）'`，但：
    //   · 走免费渠道时确实花了 0，可用户想看的是"这些用量按官网价值多少"
    //   · 金额小的时候 toFixed(2) 会显示成 0.00，看着也像免费
    // 所以：有 token 用量就按官网价折算，金额太小就多留几位小数。
    const money = (usd, cny) => {
      const y = Number(cny) || 0
      if (!(Number(usd) > 0) && y <= 0) return '¥0'
      if (y >= 1) return `≈¥${y.toFixed(2)}`
      if (y >= 0.01) return `≈¥${y.toFixed(3)}`
      return `≈¥${y.toFixed(4)}`
    }
      return h('div', null,
        h('div', { className: 'gd_grid gd_grid3' },
          h('div', { className: 'gd_count' }, h('b', null, String(u.calls ?? 0)), h('span', null, t('usage.calls'))),
          h('div', { className: 'gd_count' }, h('b', null, fmtTok(u.tokensTotal ?? 0)), h('span', null, t('usage.tokens'))),
          h('div', { className: 'gd_count' }, h('b', null, money(u.costUsd, u.costCny)), h('span', null, t('usage.cost')))),
        top.length === 0 ? null : h('div', { className: 'gd_grid' },
          top.map((p) => h('div', { className: 'gd_kv', key: p.id },
            h('span', null, p.id),
            h('b', null, `${p.calls} 次 · ${fmtTok((p.tokensIn ?? 0) + (p.tokensOut ?? 0))} tok`)))),
        h('p', { className: 'gd_note' }, u.note ?? ''))
    }

    // ── 设置页（低频配置 + NapCat + 日志）──────────────────────────────────
    // 只留：NapCat 管理、QQ 地址/白名单、决策参数、日志。
    // 「看」的部分（状态灯/消息流/启停）都在侧栏仪表盘。
    function SettingsPage(props) {
      const { t } = props
      const status = useAsync(() => api('/status'), [])
      const config = useAsync(() => api('/config'), [])
      const backends = usePoll(() => api('/backends'), [], 8000)
      const napcatLogs = usePoll(() => api('/backends/logs?n=120'), [], 8000)
      // 安装进度：轮询频率自适应 —— 安装中 2 秒，空闲 15 秒（拿最终结果）。
      const installProgress = usePoll(
        () => api('/backends/progress'),
        [],
        backends.data?.installing !== null && backends.data?.installing !== undefined ? 2000 : 15000,
      )
      // ⚠️ usePoll 首次渲染时整个 state 只有 {status,data,error}，log/installing
      //    都是 undefined —— 下方直接 .map() / !== null 比较会抛错，
      //    数据一到（上面的门卫放行）整块设置页就空白（实测踩过）。
      //    消费点读的是**顶层**字段，所以在顶层统一兜底。
      installProgress.data ??= { installing: null, log: [], result: null, error: '' }
      installProgress.log ??= installProgress.data.log ?? []
      installProgress.installing ??= installProgress.data.installing ?? null
      installProgress.error ??= installProgress.data.error ?? ''
      installProgress.result ??= installProgress.data.result ?? null
      const [busy, setBusy] = useState(false)
      const [toast, setToast] = useState(null)
      const [probe, setProbe] = useState(null)
      /**
       * 「刚保存完成」的短暂标记。
       *
       * 点模型是**即时生效**的（不需要额外按保存），但用户看不出反应。
       * 这个 state 让顶部那行显示 1.8 秒的 ✓ 已保存，然后自动消失。
       */
      const [justSaved, setJustSaved] = useState(false)

      const cfg = config.data?.config
      const qq = cfg?.qq ?? {}
      const dec = cfg?.decision ?? {}
      const sr = cfg?.search ?? {}
      const napcatInstalled = (backends.data?.installed ?? []).includes('napcat')

      /** 提交一个配置补丁；成功后刷新。 */
      const apply = useCallback(async (patch) => {
        setBusy(true)
        setToast(null)
        try {
          await post('/config', patch)
          config.reload()
          status.reload()
          // ⚠️ 关键：广播出去，让侧栏等其它面板**立刻**刷新。
          //    没有这一行的话，侧栏的「当前模型」要等 20 秒轮询才更新，
          //    用户会以为没存上（实测反馈过）。
          refreshBus.broadcast()
          setToast({ ok: true, text: t('saved') })
          setJustSaved(true)
        } catch (error) {
          setToast({ ok: false, text: `${t('saveFailed')}：${String(error?.message ?? error)}` })
        } finally {
          setBusy(false)
        }
      }, [config, status, t])

      // 「已保存」标记 1.8 秒后自动消失
      useEffect(() => {
        if (!justSaved) return undefined
        const timer = setTimeout(() => setJustSaved(false), 1800)
        return () => clearTimeout(timer)
      }, [justSaved])

      useEffect(() => {
        if (toast === null) return undefined
        const timer = setTimeout(() => setToast(null), 4000)
        return () => clearTimeout(timer)
      }, [toast])

      // ── 数据就绪门卫（同款模式）─────────────────
      //
      // 页面依赖三个接口（status / config / backends）。任何一个未就绪时
      // **整个组件提前 return**，绝不在下面渲染区块——否则任何一处
      // `data.xxx.map()` 都会让整棵 React 树崩掉（白屏，实测踩过）。
      // 零散的 `?.` / `??` 打不完这个地鼠；门卫一次解决。
      //
      //      installProgress 的字段在声明处（第 699 行起）已统一兜底。
      if (config.status === 'error') {
        // ⚠️ 后端没启动时，`/config` 必然 ECONNREFUSED —— 那是**常态**，
        //    不是故障。把底层 socket 错误原样抛给用户（"connect
        //    ECONNREFUSED 127.0.0.1:18898"）只会让人以为插件坏了，
        //    而真正的操作是回侧栏点「一键启动」。
        //
        //    所以这里区分两种情况：
        //      · 连不上（进程没起）→ 中性提示 + 引导去侧栏
        //      · 别的错误（404/500/解析失败）→ 才显示具体原因
        const raw = String(config.error ?? '')
        const unreachable = /ECONNREFUSED|ECONNRESET|socket hang up|aborted|network|不可达/i.test(raw)
        return h('div', { className: 'gd_root' },
          h('style', null, CSS),
          h('div', { className: 'gd_hero' },
            h('h2', null, t('title')),
            h('p', null, t('sub'))),
          unreachable
            ? h('div', null,
              h('p', { className: 'gd_note' }, t('dash.backendOff')),
              h('p', { className: 'gd_note', style: { marginTop: '6px' } }, t('set.backendOffHint')),
              h('div', { className: 'gd_actions' },
                h('button', { className: 'gd_btn primary', onClick: () => { config.reload(); status.reload() } }, t('retry'))))
            : h('div', null,
              h('p', { className: 'gd_err' }, `${t('loadFailed')}：${config.error}`),
              h('div', { className: 'gd_actions' },
                h('button', { className: 'gd_btn', onClick: config.reload }, t('retry')))))
      }
      if (config.data === undefined || status.data === undefined || backends.data === undefined) {
        return h('div', { className: 'gd_root' },
          h('style', null, CSS),
          h('div', { className: 'gd_hero' },
            h('h2', null, t('title')),
            h('p', null, t('sub'))),
          h('p', { className: 'gd_note' }, t('loading')))
      }

      const s = status.data
      const napStatus = backends.data
      const napcatRunning = napStatus.running === true
      return h('div', { className: 'gd_root' },
        h('style', null, CSS),
        h('div', { className: 'gd_hero' },
          // 设置页用真实图标（用户提供的「肥鱼」），比内置风车更有辨识度。
          // 走独立路由 /dsh-whale-pod/icon.png（Host 半身提供，可缓存）。
          h('div', { className: 'gd_herotop' },
            h('img', {
              className: 'gd_heroicon',
              src: iconUrl(),
              alt: '',
              // 2x 屏用 256px 那档，避免糊
              srcSet: `${iconUrl()} 1x, ${iconUrl(2)} 2x`,
              width: 40,
              height: 40,
            }),
            h('div', { className: 'gd_herotext' },
              h('h2', null, t('title')),
              h('p', null, t('sub'))),
            // 右上角：跳转仓库。
            //
            // 参考同类插件（OFM 那排是「★ 点个 Star」）。放这里而不是塞进
            // 下面某个 Section，是因为它属于"关于这个项目"的动作，
            // 和具体配置项不是一类东西。
            h('a', {
              className: 'gd_repobtn',
              href: REPO_URL,
              target: '_blank',
              rel: 'noopener noreferrer',
              title: REPO_URL,
            },
              h('span', { className: 'gd_repobtnstar' }, '★'),
              t('repo.star')))),

        toast === null ? null : h('p', { className: toast.ok ? 'gd_note' : 'gd_err' }, toast.text),

        // ── NapCat 协议端 ───────────────────────────────────────────────
        h(Section, { title: t('section.napcat'), hint: t('section.napcatHint') },
          h('div', { className: 'gd_grid' },
            h(KV, { label: t('status.napcat'), value: napcatRunning ? t('running') : t('stopped') }),
            h(KV, { label: t('installed'), value: (napStatus.installed ?? []).includes('napcat') ? t('installed') : t('notInstalled') })),
          h('p', { className: 'gd_note' }, t('napcat.builtIn')),
          h('div', { className: 'gd_actions' },
            // 未安装 → 安装按钮（内置下载官方 Release）；已装 → 启停按钮
            !napcatInstalled
              ? h('button', {
                className: 'gd_btn primary',
                disabled: busy || installProgress.installing !== null,
                onClick: async () => {
                  // 许可确认：NapCat 是 Limited Redistribution License，
                  // 下载前必须让用户明确同意（合规要求，不可省略）。
                  if (!window.confirm?.(t('napcat.accept'))) return
                  setBusy(true)
                  try { await post('/backends/install', { acceptLicense: true }) }
                  catch (error) { setToast({ ok: false, text: String(error?.message ?? error) }) }
                  finally { setBusy(false) }
                },
              }, installProgress.installing !== null ? t('napcat.installing') : t('napcat.install'))
              : h('button', {
                className: 'gd_btn',
                disabled: busy,
                onClick: async () => {
                  setBusy(true)
                  try { await post(napcatRunning ? '/backends/stop' : '/backends/start', {}, 30000); backends.reload() }
                  catch (error) { setToast({ ok: false, text: String(error?.message ?? error) }) }
                  finally { setBusy(false) }
                },
              }, napcatRunning ? t('qq.supervisor.stop') : t('qq.supervisor.start')),
            // 打开 NapCat 自己的管理面板（WebUI）。
            // token 从它的 webui.json 读出并以 URL 参数带上 —— 官方启动日志
            // 打的就是 /webui?token=xxx 形式，等效自动登录，不用手抄 token。
            // 跑在新标签页：DSH 界面不被顶掉，NapCat 面板保持独立会话。
            h('button', {
              className: 'gd_btn',
              disabled: busy || !napcatRunning,
              title: napcatRunning ? undefined : t('napcat.webuiStopped'),
              onClick: async () => {
                try {
                  const info = await api('/backends/webui')
                  const target = info.autoLoginUrl ?? info.url
                  if (info.autoLoginUrl === null) {
                    // 拿不到 token（比如还没登录过）：退化为打开裸地址，
                    // 用户按 NapCat 面板提示自行输入。
                    setToast({ ok: false, text: t('napcat.webuiNoToken') })
                  }
                  window.open?.(target, '_blank', 'noopener')
                } catch (error) { setToast({ ok: false, text: String(error?.message ?? error) }) }
              },
            }, t('napcat.webui')),
            h('button', { className: 'gd_btn', onClick: backends.reload }, t('refresh'))),
          // 安装进度（下载/解压实时日志；安装中 2 秒轮询）
          installProgress.installing !== null || installProgress.log.length > 0
            ? h('div', null,
              h('div', { className: 'gd_rowlabel' }, h('b', null, t('napcat.progress')),
                installProgress.installing !== null ? h('i', null, t('napcat.installing')) : null,
                installProgress.error ? h('i', { className: 'gd_err' }, installProgress.error) : null),
              h('pre', { className: 'gd_logs' }, installProgress.log.map((l) => l.text).join('\n')))
            : null,
          napStatus.webui?.hasToken === true
            ? h('p', { className: 'gd_note' }, `${t('napcat.webuiAt')} ${napStatus.webui.url}`)
            : null,
          h(Fold, {
            title: t('napcat.logs'),
            defaultOpen: false,
            summary: `${(napcatLogs.data?.lines ?? []).length} 行`,
            hint: `${(napcatLogs.data?.lines ?? []).length} 行`,
          },
            (napcatLogs.data?.lines ?? []).length === 0
              ? h('p', { className: 'gd_note' }, t('napcat.logsEmpty'))
              : h('pre', { className: 'gd_logs' }, (napcatLogs.data?.lines ?? []).slice(-80).join('\n')))),

        // ── 模型与渠道（配置在这里；侧栏只显示一行当前模型）──────────────
        h(ModelCards, { t }),

        // ── 启动行为 ────────────────────────────────────────────────────
        //
        // 为什么单独一节而不是塞进「QQ 配置」：这个开关管的不是 QQ，
        // 是**整个 WhalePod 进程**要不要在 DSH 启动时被拉起来。
        //
        // 关闭后的语义要说清楚：不是「关掉机器人」，而是「不自动启动」——
        // 已经跑着的进程不受影响，想用时在侧栏点「一键启动」。
        // 用户点开关时最容易误解的就是这一点。
        h(Section, { title: t('section.startup'), hint: t('section.startupHint') },
          h(Row, { label: t('startup.autoStart'), hint: t('startup.autoStartHint') },
            h(Toggle, {
              checked: cfg.autoStart !== false,
              disabled: busy,
              onChange: (v) => apply({ autoStart: v }),
            })),
          h('p', { className: 'gd_note' }, t('startup.note'))),

        // ── QQ 配置 ─────────────────────────────────────────────────────
        h(Section, { title: t('section.qq'), hint: t('section.qqHint') },
          h(Row, { label: t('qq.enabled') },
            h(Toggle, { checked: qq.enabled === true, disabled: busy, onChange: (v) => apply({ 'qq.enabled': v }) })),
          h(Row, { label: t('qq.supervisor'), hint: 'NapCat' },
            h(Toggle, {
              checked: qq.supervisor?.enabled === true,
              disabled: busy,
              onChange: (v) => apply({ 'qq.supervisor.enabled': v }),
            })),
          h(Row, { label: t('qq.wsUrl') },
            h(TextField, {
              value: qq.onebot?.wsUrl ?? '',
              disabled: busy,
              onCommit: (v) => apply({ 'qq.onebot.wsUrl': v }),
            })),
          h(Row, { label: t('qq.httpUrl') },
            h(TextField, {
              value: qq.onebot?.httpUrl ?? '',
              disabled: busy,
              onCommit: (v) => apply({ 'qq.onebot.httpUrl': v }),
            })),
          h(Row, { label: t('qq.allowAll') },
            h(Toggle, {
              checked: qq.allow?.allowAllWhenEmpty === true,
              disabled: busy,
              onChange: (v) => apply({ 'qq.allow.allowAllWhenEmpty': v }),
            })),
          h(Row, { label: t('qq.reply.maxChars') },
            h(TextField, {
              value: qq.reply?.maxChars ?? 500,
              numeric: true,
              disabled: busy,
              onCommit: (v) => apply({ 'qq.reply.maxChars': v }),
            })),
          h(Row, { label: t('qq.reply.quote') },
            h(Toggle, {
              checked: qq.reply?.quote === true,
              disabled: busy,
              onChange: (v) => apply({ 'qq.reply.quote': v }),
            })),
          h(Row, { label: t('qq.reply.imagesEnabled') },
            h(Toggle, {
              checked: qq.reply?.imagesEnabled !== false,
              disabled: busy,
              onChange: (v) => apply({ 'qq.reply.imagesEnabled': v }),
            })),
          h(Row, { label: t('qq.poke.enabled') },
            h(Toggle, {
              checked: qq.poke?.enabled !== false,
              disabled: busy,
              onChange: (v) => apply({ 'qq.poke.enabled': v }),
            })),
          h(Row, { label: t('qq.poke.chance') },
            h(TextField, {
              value: qq.poke?.chance ?? 0.75,
              numeric: true,
              disabled: busy,
              onCommit: (v) => apply({ 'qq.poke.chance': v }),
            })),
          h('div', null,
            h('div', { className: 'gd_rowlabel' }, h('b', null, t('qq.private')), h('i', null, t('list.hint'))),
            h(ListField, {
              value: qq.allow?.private ?? [],
              disabled: busy,
              onCommit: (v) => apply({ 'qq.allow.private': v }),
            })),
          h('div', null,
            h('div', { className: 'gd_rowlabel' }, h('b', null, t('qq.groups')), h('i', null, t('list.hint'))),
            h(ListField, {
              value: qq.allow?.groups ?? [],
              disabled: busy,
              onCommit: (v) => apply({ 'qq.allow.groups': v }),
            }))),

        // ── 联网搜索 ────────────────────────────────────────────────────
        //
        // 这块是**唯一会真花钱**的部分（搜索走 DeepSeek 官方付费 API，
        // 每次 ¥0.005 + 总结的 token），所以放在显眼位置、能一键关掉。
        h(Section, { title: t('section.search'), hint: t('section.searchHint') },
          h(Row, { label: t('search.enabled'), hint: t('search.enabledHint') },
            h(Toggle, {
              checked: sr.enabled !== false,
              disabled: busy,
              onChange: (v) => apply({ 'search.enabled': v }),
            })),
          h(Row, { label: t('search.images'), hint: t('search.imagesHint') },
            h(Toggle, {
              checked: sr.images !== false,
              disabled: busy,
              onChange: (v) => apply({ 'search.images': v }),
            })),
          h(Row, { label: t('search.maxUses'), hint: t('search.maxUsesHint') },
            h(TextField, {
              value: sr.maxUses ?? 3,
              numeric: true,
              disabled: busy,
              onCommit: (v) => apply({ 'search.maxUses': Number(v) || 3 }),
            })),
          h(Row, { label: t('search.lowBalance'), hint: t('search.lowBalanceHint') },
            h(TextField, {
              value: sr.lowBalanceCny ?? 2,
              numeric: true,
              disabled: busy,
              onCommit: (v) => apply({ 'search.lowBalanceCny': Number(v) || 2 }),
            }))),

        // ── 决策与人格 ──────────────────────────────────────────────────
        h(Section, { title: t('section.decision'), hint: t('section.decisionHint') },
          // 决策模式：从自由输入改成下拉。
          //
          // 为什么改：这四个值是**枚举**，手打容易写错（`Model`、`rule `、
          // 甚至中文），而且写错不报错 —— 只会静默落回 rule，用户完全看不出。
          h(Row, {
            label: t('decision.provider'),
            hint: '规则＝零成本零延迟；模型＝更像人，但每条多一次调用',
          },
            h(Select, {
              value: dec.provider ?? 'rule',
              disabled: busy,
              options: [
                { value: 'rule', label: '内置规则（快、省钱、但僵硬）' },
                { value: 'model', label: '模型判断（像人，慢 1~3 秒、要花 token）' },
                { value: 'jev', label: 'Jev（TypeSafe，付费）' },
                { value: 'custom', label: '自定义 HTTP 接口' },
                { value: 'auto', label: '自动（模型 → jev → custom → 规则）' },
              ],
              onCommit: (v) => apply({ 'decision.provider': v }),
            })),

          // 只有选了 model / auto 才显示这两项 —— 否则是噪音。
          (dec.provider === 'model' || dec.provider === 'auto')
            ? h(Row, {
              label: '判断用哪个模型',
              hint: '留空＝跟随「模型」页里选的。建议用便宜快的，它每条消息都会调一次',
            },
              h(TextField, {
                value: dec.model?.model ?? '',
                placeholder: '留空＝用默认模型',
                disabled: busy,
                onCommit: (v) => apply({ 'decision.model.model': String(v).trim() }),
              }))
            : null,
          (dec.provider === 'model' || dec.provider === 'auto')
            ? h(Row, { label: '判断时看多少条上下文', hint: '越多越懂语境，也越费 token' },
              h(TextField, {
                value: dec.model?.maxMessages ?? 15,
                numeric: true,
                disabled: busy,
                onCommit: (v) => apply({ 'decision.model.maxMessages': Number(v) || 15 }),
              }))
            : null,

          h(Row, { label: t('decision.threshold'), hint: '0 ~ 1' },
            h(TextField, {
              value: dec.threshold ?? 0.5,
              numeric: true,
              disabled: busy,
              onCommit: (v) => apply({ 'decision.threshold': v }),
            })),
          h(Row, { label: t('decision.fallbackOnError') },
            h(Toggle, {
              checked: dec.fallbackOnError !== false,
              disabled: busy,
              onChange: (v) => apply({ 'decision.fallbackOnError': v }),
            })),
          h(Row, { label: t('decision.delayMin') },
            h(TextField, {
              value: dec.delay?.min ?? 800,
              numeric: true,
              disabled: busy,
              onCommit: (v) => apply({ 'decision.delay.min': v }),
            })),
          h(Row, { label: t('decision.delayMax') },
            h(TextField, {
              value: dec.delay?.max ?? 3500,
              numeric: true,
              disabled: busy,
              onCommit: (v) => apply({ 'decision.delay.max': v }),
            })),
          h(Row, { label: t('decision.cooldown') },
            h(TextField, {
              value: dec.rule?.cooldownMs ?? 15000,
              numeric: true,
              disabled: busy,
              onCommit: (v) => apply({ 'decision.rule.cooldownMs': v }),
            })),
          h(Row, { label: t('decision.maxTurns') },
            h(TextField, {
              value: dec.rule?.maxConsecutiveTurns ?? 3,
              numeric: true,
              disabled: busy,
              onCommit: (v) => apply({ 'decision.rule.maxConsecutiveTurns': v }),
            })),
          h(Row, { label: t('decision.mention') },
            h(TextField, {
              value: dec.rule?.mentionProbability ?? 0.95,
              numeric: true,
              disabled: busy,
              onCommit: (v) => apply({ 'decision.rule.mentionProbability': v }),
            })),
          h(Row, { label: t('decision.idle') },
            h(TextField, {
              value: dec.rule?.idleChatterProbability ?? 0.04,
              numeric: true,
              disabled: busy,
              onCommit: (v) => apply({ 'decision.rule.idleChatterProbability': v }),
            })),
          h('div', { className: 'gd_actions' },
            h('button', {
              className: 'gd_btn',
              disabled: busy,
              onClick: async () => {
                setBusy(true)
                try { setProbe(await api('/decision/probe', { timeout: 20000 })) }
                catch (error) { setToast({ ok: false, text: String(error?.message ?? error) }) }
                finally { setBusy(false) }
              },
            }, busy ? t('decision.probing') : t('decision.probe'))),
          probe === null ? null : h('div', { className: 'gd_grid' },
            (probe.providers ?? []).map((p) => h(KV, {
              key: p.id,
              label: `${p.label ?? p.id}`,
              value: `${p.ok ? '✓' : '✗'} ${p.detail ?? ''}`.slice(0, 60),
            }))),
          h(Row, { label: t('persona.active'), hint: t('persona.hint') },
            h('select', {
              className: 'gd_select',
              value: s?.persona?.active ?? '',
              disabled: busy,
              onChange: (event) => post('/persona', { active: event.target.value })
                .then(() => { status.reload() })
                .catch((error) => setToast({ ok: false, text: String(error?.message ?? error) })),
              style: { width: '160px', flex: 'none' },
            }, (s?.persona?.list ?? []).map((name) => h('option', { key: name, value: name }, name)))),
          h('div', { className: 'gd_actions' },
            h('button', {
              className: 'gd_btn',
              disabled: busy,
              onClick: async () => {
                setBusy(true)
                try { await api('/memory', { method: 'DELETE' }); status.reload(); setToast({ ok: true, text: t('memory.cleared') }) }
                catch (error) { setToast({ ok: false, text: String(error?.message ?? error) }) }
                finally { setBusy(false) }
              },
            }, t('memory.clear')))),

        // ── 记忆管理（按会话）───────────────────────────────────────────
        h(MemorySection, { t, setToast }),

        // ── 人格编辑器 ──────────────────────────────────────────────────
        h(PersonaSection, { t, setToast, status }),

        // ── 运行日志 ────────────────────────────────────────────────────
        h(LogSection, { t }))
    }

    /**
     * 记忆管理：列出活跃会话（短期）与长期摘要，支持按会话清空。
     * 8 秒轮询；全部清空的核弹按钮留在上面的决策区（那是"低频且危险"的）。
     */
    function MemorySection({ t, setToast }) {
      const mem = usePoll(() => api('/memory'), [], 8000)
      const [viewing, setViewing] = useState(null)
      const [busy, setBusy] = useState(false)

      const clearOne = async (scope) => {
        setBusy(true)
        try {
          await api(`/memory?scope=${encodeURIComponent(scope)}`, { method: 'DELETE' })
          mem.reload()
          setToast({ ok: true, text: `${t('mem.cleared')}：${scope}` })
        } catch (error) {
          setToast({ ok: false, text: String(error?.message ?? error) })
        } finally { setBusy(false) }
      }

      // ⚠️ 2026-10-25 修：原来读 `mem.data.scopes`，但那是**字符串数组**
      //    （["group:704291282", ...]）。对字符串取 `.scope` / `.messages`
      //    全是 undefined，界面就显示成「undefined 条消息」——
      //    看着像记忆功能没生效，其实 2 个会话 17 条消息都在。
      //
      //    接口现在多回一个 `scopeDetails`（对象数组，带消息数）。
      //    这里优先用它；没有就退回旧字段（老版本 Host 也能跑）。
      const rawScopes = mem.data?.scopeDetails ?? mem.data?.scopes ?? []
      const scopes = rawScopes.map((s) => (typeof s === 'string'
        ? { scope: s, messages: 0 }
        : s))
      const longs = mem.data?.longScopes ?? []
      return h(Section, { title: t('mem.title'), hint: t('mem.hint') },
        mem.status === 'error'
          ? h('p', { className: 'gd_err' }, mem.error)
          : h('div', null,
            scopes.length === 0
              ? h('p', { className: 'gd_note' }, t('mem.empty'))
              : h('div', { className: 'gd_actions', style: { flexDirection: 'column', alignItems: 'stretch', gap: '6px' } },
                scopes.map((row) => h('div', {
                  key: row.scope, className: 'gd_row',
                  style: { borderBottom: '1px solid color-mix(in srgb,var(--dsw-alias-border-l1) 55%,transparent)', padding: '6px 0' },
                },
                  h('div', { className: 'gd_rowlabel' },
                    h('b', null, row.scope),
                    h('i', null, `${row.messages} ${t('mem.messages')}`)),
                  h('button', {
                    className: 'gd_btn', disabled: busy,
                    onClick: () => clearOne(row.scope),
                  }, t('mem.clearOne'))))),
            h('div', { style: { marginTop: '10px' } },
              h('div', { className: 'gd_rowlabel' }, h('b', null, t('mem.long'))),
              longs.length === 0
                ? h('p', { className: 'gd_note' }, t('mem.longEmpty'))
                : h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '6px' } },
                  longs.map((row) => h('div', { key: row.scope, className: 'gd_row' },
                    h('div', { className: 'gd_rowlabel' },
                      h('b', null, row.scope),
                      h('i', null, `${row.chars} 字 · ${row.summarizedCount} 条已摘要`)),
                    h('button', {
                      className: 'gd_btn',
                      onClick: async () => {
                        try {
                          const detail = await api(`/memory/summary?scope=${encodeURIComponent(row.scope)}`)
                          setViewing({ scope: row.scope, text: detail.summary ?? '' })
                        } catch (error) { setToast({ ok: false, text: String(error?.message ?? error) }) }
                      },
                    }, t('mem.viewSummary'))))))),
            viewing === null ? null : h('div', {
              style: {
                position: 'fixed', inset: 0, zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: 'rgba(0,0,0,.45)', backdropFilter: 'blur(2px)',
              },
              onClick: () => setViewing(null),
            },
              h('div', {
                className: 'gd_sec',
                style: { width: 'min(640px, 90vw)', maxHeight: '80vh', overflow: 'auto', background: 'var(--dsw-alias-bg-layer-2)' },
                onClick: (e) => e.stopPropagation(),
              },
                h('div', { className: 'gd_sechead' },
                  h('h3', { className: 'gd_sectitle' }, `${t('mem.summaryTitle')}：${viewing.scope}`),
                  h('button', { className: 'gd_btn', style: { marginLeft: 'auto' }, onClick: () => setViewing(null) }, t('mem.close'))),
                h('div', { style: { whiteSpace: 'pre-wrap', fontSize: '12.5px', lineHeight: 1.7 } }, viewing.text || '—'))))
    }

    /**
     * 人格编辑器：新建 / 编辑 / 删除角色提示词。
     * 保存走 persona write（Host 侧原子写盘）；切换激活在上方决策区。
     */
    function PersonaSection({ t, setToast, status }) {
      const [list, setList] = useState(null)
      const [editing, setEditing] = useState(null)   // { name, content, isNew }
      const [busy, setBusy] = useState(false)

      const reloadList = useCallback(() => {
        api('/persona')
          .then((d) => setList({
            active: d.active,
            items: d.list ?? [],
            // detailed 带中文名 / 是否内置 / 是否被改过；老内核没有这个字段时回退
            detailed: d.detailed ?? (d.list ?? []).map((name) => ({ name, label: name, builtin: false, custom: false })),
          }))
          .catch(() => setList({ active: null, items: [], detailed: [] }))
      }, [])
      useEffect(() => { reloadList() }, [reloadList])

      const openEditor = async (name) => {
        try {
          const d = await api(`/persona?name=${encodeURIComponent(name)}`)
          setEditing({ name, content: d.content ?? '', isNew: false })
        } catch (error) {
          setToast({ ok: false, text: String(error?.message ?? error) })
        }
      }

      const create = () => {
        const name = window.prompt?.(t('persona.name')) ?? ''
        const trimmed = String(name).trim()
        if (trimmed === '') return
        setEditing({ name: trimmed, content: '', isNew: true })
      }

      const save = async () => {
        if (editing === null) return
        setBusy(true)
        try {
          await post('/persona', {
            action: editing.isNew ? 'create' : 'save',
            name: editing.name,
            content: editing.content,
          })
          setToast({ ok: true, text: editing.isNew ? t('persona.created') : t('persona.saved') })
          setEditing(null)
          reloadList()
          status.reload()
        } catch (error) {
          setToast({ ok: false, text: String(error?.message ?? error) })
        } finally { setBusy(false) }
      }

      /** 把改过的内置角色恢复成出厂内容。 */
      const restore = async (name) => {
        if (!window.confirm?.(`${t('persona.restore')}：${name}？${t('persona.restoreWarn')}`)) return
        setBusy(true)
        try {
          await post('/persona', { action: 'restore', name })
          setToast({ ok: true, text: t('persona.restored') })
          reloadList()
          status.reload()
          // 正在编辑同一角色时重载内容，否则用户看到的是旧文本
          if (editing?.name === name) {
            const d = await api(`/persona?name=${encodeURIComponent(name)}`)
            setEditing({ name, content: d.content ?? '', isNew: false })
          }
        } catch (error) {
          setToast({ ok: false, text: String(error?.message ?? error) })
        } finally { setBusy(false) }
      }

      const remove = async (name) => {
        if (name === 'default') { setToast({ ok: false, text: t('persona.defaultNoDelete') }); return }
        if (!window.confirm?.(`${t('persona.delete')}：${name}?`)) return
        setBusy(true)
        try {
          await post('/persona', { action: 'remove', name })
          setToast({ ok: true, text: t('persona.removed') })
          if (editing?.name === name) setEditing(null)
          reloadList()
        } catch (error) {
          setToast({ ok: false, text: String(error?.message ?? error) })
        } finally { setBusy(false) }
      }

      const entries = list?.detailed ?? []
      return h(Section, { title: t('persona.editor'), hint: t('persona.editorHint') },
        h('div', { className: 'gd_actions' },
          h('button', { className: 'gd_btn primary', onClick: create }, t('persona.new')),
          editing === null ? null : h('span', { className: 'gd_note' }, `${t('persona.edit')}：${editing.name}`)),
        editing === null
          ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
            entries.map((item) => {
              // 用中文展示名 + 名字（自定义角色没有展示名，就用 id）
              const label = item.label && item.label !== item.name
                ? `${item.label}（${item.name}）`
                : item.name
              return h('div', { key: item.name, className: 'gd_row' },
                h('div', { className: 'gd_rowlabel' },
                  h('b', null, label),
                  item.active ? h('i', null, t('on')) : null,
                  // 改了内置角色的内容时标出来，否则用户不知道自己用的是哪一版
                  item.custom && item.builtin ? h('i', { style: { opacity: 0.65 } }, ` · ${t('persona.customized')}`) : null),
                h('div', { className: 'gd_actions' },
                  h('button', { className: 'gd_btn', onClick: () => openEditor(item.name) }, t('persona.edit')),
                  item.builtin && item.custom
                    ? h('button', { className: 'gd_btn', disabled: busy, onClick: () => restore(item.name) }, t('persona.restore'))
                    : null,
                  item.name === 'default' ? null : h('button', {
                    className: 'gd_btn', disabled: busy, onClick: () => remove(item.name),
                  }, t('persona.delete'))))
            }))
          : h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
            h('textarea', {
              className: 'gd_textarea',
              style: { minHeight: '200px' },
              value: editing.content,
              onChange: (event) => setEditing((cur) => ({ ...cur, content: event.target.value })),
              placeholder: t('persona.content'),
            }),
            h('div', { className: 'gd_actions' },
              h('button', { className: 'gd_btn primary', disabled: busy, onClick: save },
                busy ? t('saving') : editing.isNew ? t('persona.create') : t('save')),
              h('button', { className: 'gd_btn', onClick: () => setEditing(null) }, t('cancel')))))
    }

    /** 日志区：自带轮询，因为它变化最快。 */
    function LogSection({ t }) {
      const logs = usePoll(() => api('/logs?n=200'), [], 5000)
      const lines = logs.data?.lines ?? []
      return h(Section, { title: t('section.logs'), hint: t('section.logsHint') },
        lines.length === 0
          ? h('p', { className: 'gd_note' }, t('logs.empty'))
          : h('pre', { className: 'gd_logs' },
            lines.map((line, index) => h('div', {
              key: index,
              className: line.level === 'error' ? 'gd_logerror' : line.level === 'warn' ? 'gd_logwarn' : undefined,
            }, `${new Date(line.at).toLocaleTimeString()} [${line.level}] ${line.message}`))))
    }

    /** 侧栏图标：复用内置的插件风车图标，避免自带资源。 */
    function WhalePodIcon({ size }) {
      try {
        const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
        const Icon = primitives.IconCordisPluginOutlineRegular
        if (typeof Icon === 'function') return h(Icon, { size })
      } catch { /* 拿不到就退化为文字 */ }
      return h('span', { style: { fontSize: '12px', fontWeight: 600 } }, 'G')
    }

    // ── 装配 ───────────────────────────────────────────────────────────────
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, DICT), 'dsh-whale-pod: dictionaries')
      const t = ctx.locale.bind(NS)

      // 设置页：DSH 设置里的一个 section。
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'whale-pod',
        order: 40,
        label: () => t('nav'),
        locale: NS,
      }, (props) => h(SettingsPage, { ...props, t })))

      // 侧栏快捷入口：点它切到 whale-pod 面板。
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 20,
        label: () => t('nav'),
        locale: NS,
      }, WhalePodIcon))

      // 该面板的正文。key 必须与侧栏条目的 id 一致，否则
      // layout.selectPanel 会抛 "main panel ... is not registered"。
      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
        locale: NS,
      }, (props) => h(WhalePodPanel, { ...props, t })))
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = 'whale-pod'
    exports.NS = NS
    exports.PANEL_ID = PANEL_ID
    return module.exports
  },
})
