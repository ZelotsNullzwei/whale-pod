# 实机测试发现（2026-10-23）

> 在真实 QQ 私聊里跑 PR #1 的改动时发现的问题。
>
> **状态更新（同日晚些时候）**：#1、#2 已修复（提交 `ad600fa`），
> #3、#4 仍未确认，保持 `[未确认]` 标记不动。
>
> 每条都附了可复核的证据（配置原文 / 日志行 / 代码位置）。
> 标注 `[未确认]` 的是我还没拿到决定性证据的，请不要当成结论。

---

## 修复状态一览

| # | 问题 | 状态 | 对应提交 |
|---|---|---|---|
| 1 | 长期记忆从未启用 + 阈值死锁 | ✅ **已修复** | `ad600fa` |
| 2 | 私聊沿用群聊 15s 冷却 | ✅ **已修复** | `ad600fa` |
| 3 | 同一毫秒触发两次决策 | ⏸ 未确认，待取证 | — |
| 4 | 图片后无发送记录 | ⏸ 未确认 | — |

修复内容见文末「修复记录」一节。

---

## 环境

| 项 | 值 |
|---|---|
| 代码 | `feature/social-decision-v2` @ `2bec28e` |
| 进程 | PID 14416，2026-10-23 13:48:25 启动（晚于代码修改，确认加载的是新代码） |
| 模型 | `workbuddy/deepseek-v4.1-flash`（用户自述用老版本 OFM，不在本次范围） |
| 决策层 | `decision.provider = rule` |
| 日志 | `~/.dsh/whale-pod/whale-pod.log`（9182 行） |

---

## 1. 长期记忆从未启用，且阈值与窗口自相矛盾

### 证据

配置（`~/.dsh/whale-pod/config.json`）：

```json
"memory": {
  "short": { "maxMessages": 30 },
  "long":  { "enabled": false, "summarizeAfter": 200 }
}
```

`~/.dsh/whale-pod/memory-long.json` **不存在** —— 说明摘要从未生成过一次。

### 两个独立的问题

**(a) 长期记忆是关闭的。** `LongTermStore` 的构造里 `this.enabled = this.cfg.enabled === true`
（`src/memory/long.js:72`），而 `maybeSummarize()` 第一行就是
`if (!this.enabled || ...) return false`（`src/memory/long.js:137`）。
所以整个长期记忆链路**一次都没跑过**。

**(b) 即使打开，也永远不会触发。** 摘要阈值判断是：

```js
// src/memory/long.js:141-143
const msgs = ctx.messages ?? []
const unsummarized = msgs.length - (mem.summarizedCount ?? 0)
if (unsummarized < this.summarizeAfter) return false
```

而 `ctx.messages` 来自 `bridge._maybeSummarize()` 传入的 `mem.recent()`，
`mem` 的窗口上限是 `memory.short.maxMessages = 30`
（`src/memory/short.js:60` 赋值，`src/memory/short.js:111` 在 `_trim()` 里强制裁剪）。

**`msgs.length` 最多 30，`summarizeAfter` 要 200 → 条件永远不成立。**

即使把窗口调大也不行：`_trim()` 会按条数、字符数、年龄三重裁剪，
`msgs.length` 始终被压在 `maxMessages` 以内。

### 影响

用户实际感受是「记忆没生效」。短期窗口只有 30 条，超出即遗忘，
且没有任何跨会话累积。`memory-long.json` 不存在这一点可以自证。

### 建议（未实施）

- 把 `long.enabled` 改为 `true`
- `summarizeAfter` 降到 **20 左右**（必须小于 `short.maxMessages`）
- 或者改判断口径：用「距上次摘要新增的消息数」而不是「当前窗口长度」

> 注意：仅改配置就能生效，不需要改代码。但 `summarizeAfter >= maxMessages`
> 这个组合是**配置层的死锁**，值得在启动时校验并告警，否则用户永远发现不了。

---

## 2. 私聊沿用群聊冷却，导致对话严重卡顿

### 证据

配置 `decision.rule.cooldownMs = 15000`（15 秒）。

日志里的典型模式（`05:51` 段，几乎每条都一样）：

```
05:51:40.687 「记忆逻辑感觉没有生效」→ 沉默（私聊：距我上次发言 7s，仍在冷却（8s 后补回））
05:51:42.247 「不是」              → 沉默（私聊：距我上次发言 9s，仍在冷却（7s 后补回））
05:51:48.675 「不是」              → 发言
```

全日志统计：

| 指标 | 次数 |
|---|---|
| 冷却中（`冷却中` 命中） | **193** |
| 决策 → 发言 | 306 |
| 决策 → 沉默 | 548 |

### 根因

`src/decision/rule.js` 里私聊分支和群聊分支用的是**同一个** `cooldownMs`：

```js
// 私聊分支（rule.js:97 附近）
if (input.sinceMyLastMessage < this.cfg.cooldownMs) { ... defer ... }

// 群聊分支（rule.js:123 附近）
if (input.sinceMyLastMessage < this.cfg.cooldownMs) { ... defer ... }
```

群聊冷却的目的是**防刷屏**（别人在聊，别插嘴）。私聊里所有消息都是对机器人
一个人说的，不存在"刷屏"这回事 —— 15 秒纯粹是让对话卡顿，用户看到的是
「它答的是我十几秒前那句话」。

### 与我上次改动的关系

**这条是我判断失误。** 我在 PR 里说「私聊连发多条会丢回复」并修了
`_checkSuperseded` 的私聊误判（那确实是个真 bug），但**没有一并处理冷却**。
实际上冷却才是用户感知更强的问题。

### 建议（未实施）

- 私聊单独一个更短的冷却（2~3 秒），或只防连续同质消息
- 或者私聊干脆不冷却，改用 `maxConsecutiveTurns` 兜底

---

## 3. 同一条消息在同一毫秒触发两次决策

### 证据

```
2026-10-23T05:58:37.629Z [info] bridge：private:123450002「[图片]」 图×1 决策 → 沉默（冷却中…）
2026-10-23T05:58:37.630Z [info] bridge：private:123450002「[图片]」 图×1 决策 → 沉默（冷却中…）
```

两条**同一毫秒**、同样文本、同样决策结果，而且**各自排了一个「16s 后补回」**。

全日志扫描「同一时间戳出现多条决策」：**14 处**，最早可追到 2026-10-17。

### 状态：`[未确认]`

我的去重是按 `(scope, messageId)` 做的（`bridge._isDuplicate()`，在 `onEvent` 里、
决策之前）。没拦住只有两种可能：

1. 两条事件的 `messageId` **不同** → 那可能是用户真的发了两张图（不是 bug）
2. 两条事件的 `messageId` **为空** → `_isDuplicate` 直接放行
   （代码里刻意「没有 messageId 就不判重，宁可放行也不要误杀」）

**还差决定性证据**：需要确认用户当时发了几张图，或者把 `messageId` 打进日志。

### 建议（未实施，等证据）

- 先在 `_isDuplicate` 放行时补一条 debug 日志（`messageId` 为空 → 放行）
- 如果确认是「空 messageId 导致重复」，考虑用 `(scope, sender, text, at)` 做兜底判重
- 如果确认是用户发了两张图，那就**不是 bug**，不用改

---

## 4. 图片链路：能看到图，但日志在「发给模型」之后没有下文

### 证据

```
05:58:33.377 发现 1 张待取图片
05:58:33.645 已附图 1 张（多模态）
05:58:35.784 本条带 1 张图发给 workbuddy/deepseek-v4.1-flash（若模型不支持视觉，图等于没传）
（之后没有发送记录、没有 outcome、没有报错）
```

### 状态：`[未确认]`

用户反馈「**看得到图**」，所以视觉本身是通的。日志里"发给模型"之后没有
发送记录，可能只是**发送成功但没打日志**（`_record` 只进内存 + Web UI，
不写文件日志）。

这条**不建议现在改**，因为现象和用户感受不一致。需要先确认：
发送环节是否有落盘日志。如果没有，属于**可观测性缺失**，不是功能 bug。

---

## 优先级建议

| # | 问题 | 确定性 | 影响 | 建议 |
|---|---|---|---|---|
| 1 | 长期记忆未启用 + 阈值死锁 | **已确认** | 高（记忆完全不工作） | 先改配置验证，再加启动校验 |
| 2 | 私聊冷却 15s | **已确认** | 高（对话体验） | 私聊独立冷却 |
| 3 | 重复决策 | 未确认 | 中（可能重复回复） | 先补日志取证 |
| 4 | 图片后无下文 | 未确认 | 低（用户说看得到） | 补可观测性 |

---

## 附：本次实机验证到的部分（PR #1 的改动确实生效）

私聊连发多条时，**没有出现 `superseded` 计数**，也没有丢回复
（对比改前：`stats { replied: 2, superseded: 1 }`）。
说明 `_checkSuperseded` 的私聊放行生效了。

但这只解决了我原先假设的问题；用户实际感受到的卡顿来自 #2 的冷却，
**这一点我在 PR 里判断错了**。

---

# 修复记录（提交 `ad600fa`）

## #1 长期记忆累计计数

**改法**：

- `ConversationMemory` 新增 `totalPushed` —— 单调递增的累计入队数，
  不随 `_trim()` 裁剪回退
- `LongTermMemory` 新增 `summarizedTotal` —— 已摘要到的累计总数
- 判断从 `msgs.length - summarizedCount` 改为 `total - summarizedTotal`
- `bridge._maybeSummarize()` 显式传 `total: mem.totalPushed`
- `clear()` 同时归零 `totalPushed`（否则清空后两边基准错位）
- 老文件迁移：缺 `summarizedTotal` 时回退用 `summarizedCount`

**出厂配置**：`store.js` 默认从 `{enabled:false, summarizeAfter:200}`
改为 `{enabled:true, summarizeAfter:20}`。

**启动校验**：`src/index.js` 在 `summarizeAfter >= maxMessages` 时打 warn，
未启用时也提示「超出窗口的对话不会被记住」。这类死锁不报错、只静默失效，
不喊出来用户永远发现不了。

## #2 私聊独立冷却

新增 `privateCooldownMs`（默认 **1500ms**），私聊不再共用群聊的
`cooldownMs`（15000ms）。设为 0 则私聊完全不冷却。群聊冷却不变。

## 测试

新增 `tests/check-memory-cooldown.mjs`（36 项）。其中第 2 项是
**连续多轮摘要**：窗口 6 条、阈值 5，连跑 3 轮全部触发
（改前只可能触发 1 次）。第 3 项用「窗口 5 条 + 100 条消息」
验证触发约 10 次。

## 仍未修

#3（同毫秒两次决策）和 #4（图片后无发送记录）保持未确认。
前者需要确认「用户发了几张图」或把 `messageId` 打进日志；
后者需要确认发送环节是否有落盘日志。

