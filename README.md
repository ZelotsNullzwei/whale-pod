<div align="center">

<img src="assets/icon-256.png" width="140" alt="WhalePod">

# WhalePod

<b>简体中文</b> | <a href="#english">English</a>

![license](https://img.shields.io/badge/license-MIT-blue.svg)
![dsh](https://img.shields.io/badge/dsh-plugin-4B6BFB.svg)
![node](https://img.shields.io/badge/node-%E2%89%A522.19-339933.svg)
![status](https://img.shields.io/badge/status-beta-orange.svg)

</div>

<div align="center">

<b>DSH 里的 QQ 聊天机器人。</b><br>
<sub>一个托盘进程管全部 —— 网关、桥接、决策、人格、协议端。</sub>

<br>

<sub>装好后不用碰命令行：启停、配模型、看用量都在侧栏面板里。内置 DeepSeek 账户凭证，也支持任何 OpenAI 兼容供应商。</sub>

</div>

---

## 30 秒判断这东西适不适合你

<table>
<tr><td width="50%" valign="top">

**✅ 适合你，如果**

- 你**已经在用 [DSH Desktop](https://github.com/deepseek-ai/deepseek-harness)**
- 你有自己的 DeepSeek API Key（几块钱够跑很久）
- 你想要一个**会看场合**的群聊机器人，而不是「问一句答一句」的客服
- 你不介意它是 beta —— 可能有 bug，但你会拿它当自己用的工具

</td><td width="50%" valign="top">

**❌ 不适合，如果**

- 你**没有 DSH** —— 这首先是个 DSH 插件，不是独立程序
- 你以为是一键脚本 —— 还要装 NapCat、配 QQ 号、扫码登录
- 你想要开箱即用的成品 —— 现在还在 beta
- 你想要的是「自动回复机器人」—— 它**经常故意不说话**，这是设计

</td></tr>
</table>

> **为什么先说这些**：这个项目是给「已经有 DSH」的人省事的，不是给所有人
> 降低门槛的。如果你没有 DSH，先去把它装上 —— 没有它，这个插件跑不起来。

---

<div align="center">

<b>它会先判断该不该说话，再决定说什么。</b><br>
<sub>真人不会每条消息都回 —— 他们会看场合、看气氛、看刚才是不是自己说的。</sub>

</div>

---

## 它能做什么

```
┌──────────────────────────────────────────────────────────┐
│ WhalePod（托盘 / 后台）                                   │
│  ├─ LLM 网关  OpenAI 兼容，内置 DeepSeek + 自定义供应商     │
│  ├─ QQ 桥接   消息 → 决策 → 生成 → 发言                    │
│  ├─ 决策层    Jev / 规则 / 自定义（可插拔）                 │
│  ├─ 记忆层    短期上下文 + 长期摘要                        │
│  ├─ 人格层    角色提示词（可编辑）                          │
│  ├─ 组件管理  内置下载 NapCat（含协议端托管）               │
│  └─ 管理界面  Web UI（10 个页面，可折叠侧栏 + 线性图标）    │
└──────────────────────────────────────────────────────────┘
```

**当前可用的运行模式：**

| 模式 | 谁接 QQ | 状态 |
|---|---|---|
| **whale-pod** | WhalePod 自己 | ✅ 可用 |
| **astrbot** | AstrBot | ⚠️ **有框架，未完善** |

> **关于 AstrBot 模式**
>
> 代码里保留了完整的架子（后端定义、uv 安装流程、启停、模式切换、
> 网关接入提示都已经写了），但**尚未在真机上跑通验证**：
> `initArgs` 从未被调用、启动后不做就绪校验、OneBot 侧的对接也还是照
> NapCat 的逻辑推的。**现在不要指望切过去就能用。**
>
> 保留它的原因是安装与托管这套逻辑（自带 uv + Python）本身有复用价值，
> 以后要补的是 AstrBot 专属的那部分 —— 而不是从零重写。
>
> 只想要一个能跑的 QQ 机器人，用 `whale-pod` 模式就够了。

---

## 要花钱吗

**面板上的「折合费用」按官网价折算，不是你实际扣的钱。**

这两件事要分开看：

| | 面板显示 | 实际扣费 |
|---|---|---|
| **QQ 聊天** | 按模型官网价折算（如 ¥0.02 / 万 token） | **当前渠道不扣你的钱** |
| **联网搜索** | ¥0.005/次 + 总结的 token | **真扣**（走你的 DeepSeek Key） |
| **NapCat / 协议端** | — | ¥0 |

### 为什么聊天按官网价显示

因为想知道「**这些用量如果按原价买要多少钱**」—— 这比「我在这个渠道花了 0」
有用得多。面板那一行注脚写的就是这个意思：

```
费用按各厂商官网挂牌价折算，与实际渠道无关
```

### 那聊天到底花不花钱

**聊天走 DSH 的渠道池（`channel-pack` 里那 14 个渠道），不经过你的
DeepSeek 账户，所以不扣你钱。** 但它也不是"无限免费"：

- 免费额度可能限速、可能用完
- 渠道随时可能下线
- 换模型/换渠道后实际能不能跑，得看当时的情况

想看真实用量就开面板 —— 那里分开记「聊天」和「搜索」。

### 搜索是真花钱

| 项目 | 单价 |
|---|---|
| Search API | 每 1,000 次成功请求 ¥5 → **¥0.005/次** |
| 总结那一步 | 几百 token → 约 ¥0.002 |

按群里一天搜十几次算，**一个月大概 ¥2~3**，从你的 DeepSeek 余额里扣。

余额低于 ¥2 时它会自己提一句（大肥鱼会念叨 Token，这是她的性格）。

> **不想花这笔钱**：设置里可以关掉搜索，纯聊天不受影响。
> 关掉之后遇到新番、新人名这类问题，它会说「不太确定」而不是硬编。

---

## 为什么做这个

QQ 机器人常见的两个痛点，WhalePod 各解决一个：

| 痛点 | 常见做法 | WhalePod |
|---|---|---|
| **要开一堆窗口** | NapCat + 框架 + 桥接，2-3 个 cmd/node 挂着 | **一个托盘进程**，Web 管所有 |
| **烧钱** | 每条消息都调付费 API | **免费渠道优先**，付费仅兜底 |
| **说话很呆** | 逢消息必回 | **决策层**先判断该不该说 |
| **装组件要自己折腾** | 去 GitHub 找 Release、装 Python、配环境 | **内置下载**，一键装 NapCat |

第三点是关键。真人不会每条消息都回 —— 他们会判断「这是在问我吗」
「我刚说过话要不要歇会」「现在插话合适吗」。WhalePod 把这件事拆成两层：

```
决策层（便宜、快）→ 该不该说话？概率多少？
表达层（贵、慢）  → 说什么
```

**省钱和活人感是同一个设计带来的。**

---

## 内置组件下载

WhalePod 能自己把协议端装好，不需要用户去 GitHub 翻 Release：

| 组件 | 许可 | 自动安装 | 说明 |
|---|---|---|---|
| **NapCat** | Limited Redistribution License | ✅ 下载官方 Release | OneBot v11 协议端，约 0.9 MB |
| **AstrBot** | AGPL-3.0 | ⚠️ 框架已有，**未完善** | 见上文说明，当前不可用 |
| **SnowLuma** | 源码可见非商业许可 | ❌ **刻意不支持** | EULA 禁止自动化部署 |

### 自带运行时（为 AstrBot 预留）

AstrBot 需要 Python，而用户机器上不一定有。为了让「选这个模式」不变成
「先去装 Python」，代码里做了一套**自带的隔离运行时**：

```
WhalePod 下载 uv（14.6 MB，单文件）
   └─ uv python install 3.12   → 自动下载 Python（约 60 MB）
        └─ uv tool install astrbot  → 隔离环境里装好
             └─ uv tool run astrbot run  → 跑起来
```

设计目标是**不碰系统 Python / pip / PATH**：

| 位置 | 内容 |
|---|---|
| `~/.whale-pod/runtime/uv/` | uv 本体 |
| `~/.whale-pod/runtime/python/` | uv 管理的 Python 3.12 |
| `~/.whale-pod/runtime/uv-tools/` | 装好的工具 |

**卸载 = 删 `~/.whale-pod/runtime/`。**

> ⚠️ 这套流程**尚未端到端验证过**。`whale-pod` 模式不需要它，
> 所以日常使用不会碰到。要启用 AstrBot 模式之前，先按上面的说明做好
> 「可能跑不通」的准备。

### 为什么 SnowLuma 不做自动安装

SnowLuma 的 EULA 明确规定「将其并入第三方安装包或 Docker 镜像、
**通过自动化脚本部署**」须事先取得书面授权。同类项目 `qq-bridge`
也因此移除过该功能。WhalePod 只探测、不部署 —— 安装与扫码由用户自己完成。

### 许可合规

「内置下载」与「打包分发」是**两件不同的事**：

- **下载官方 Release** → 用户主动从上游获取，**不是 WhalePod 再分发** ✅
- **打进 WhalePod 发行包** → 属于再分发，受各自许可约束 ⚠️

所以 WhalePod **只做下载器 + 进程托管**，不把协议端代码放进自己的仓库。
下载前 UI 会强制展示许可名称、链接与要点，用户显式确认后才开始；
下载后自动把上游 LICENSE 与来源说明 (`WHALE-POD-NOTICE.md`) 一并存下来。

---

## 快速开始

### 先选一条路

| 你想做什么 | 走哪条 |
|---|---|
| **在 DSH 里用**（推荐，也是这个插件的主用途） | ↓ [装成 DSH 插件](#装成-dsh-插件) |
| **只要那个 LLM 网关**（用 OpenAI 客户端接） | ↓ [独立跑](#独立跑) |

两条路互不冲突：装成插件之后，网关也照样能用。

---

### 装成 DSH 插件

假设你已经装好 [DSH Desktop](https://github.com/deepseek-ai/deepseek-harness)。

**① 下载 Release 解压**

到 [Releases](https://github.com/ZelotsNullzwei/whale-pod/releases) 下最新的
`dsh-whale-pod-vX.Y.Z.zip`，解压到任意目录（下面用 `<解压目录>` 代指）。

**② 挂进 profile**

```bash
dsh plugin --profile desktop add link:<解压目录>/plugin
```

**③ 重启 DSH**

侧栏会出现「鲸舱」。第一次点「一键启动」，它会：

- 自己拉 WhalePod 进程
- 自己下载 NapCat（如果还没有）
- 弹二维码让你扫码登录

**④ 扫码登录 QQ**

登录成功后在群里 @ 它就能用。默认**只在被 @ 或提到名字时**说话。

> **装不上怎么办**：先看 [已知限制](#已知限制)。如果卡在某一步，去
> [Issues](https://github.com/ZelotsNullzwei/whale-pod/issues) 说清楚卡在哪，
> 附上 DSH 的日志（`~/.dsh/logs/host/` 下最新的那个）。

---

### 独立跑

不用 DSH，直接跑这个仓库（能拿到 LLM 网关，但**没有**插件面板和 channel-pack
复用 —— 要自己配供应商）：

```bash
cd whale-pod
node src/index.js
```

启动后会打印：

```
[INF] 已注册 provider 14 个：codearts, buddy, ..., gemini, ..., opencode
[INF] 决策层：order = [rule]，阈值 0.5
[INF] LLM 网关：http://127.0.0.1:18899/v1
[INF] 网关 key：gdn-xxxxxxxx
[INF] 管理界面：http://127.0.0.1:18898?token=gdn-yyyyyyyy
[INF] WhalePod 就绪
```

### 前置

| 依赖 | 说明 |
|---|---|
| **DSH Desktop** | 装成插件时必需（复用它的 `channel-pack` 和凭据）；独立跑时可选 |
| **Node 22+** | 独立跑必需；用 DSH 自带的运行时也行 |
| **QQ 协议端** | NapCat / SnowLuma —— **可以在「组件」页一键装**，不用手动折腾 |

### 立刻用起来（任何 OpenAI 客户端）

```bash
curl http://127.0.0.1:18899/v1/chat/completions \
  -H "Authorization: Bearer gdn-xxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "auto",
    "messages": [{"role":"user","content":"你好"}]
  }'
```

**兼容性**：这是标准 OpenAI 协议，所以 **Cherry Studio / Continue / AstrBot /
任何 OpenAI SDK 都能直接接**：

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:18899/v1", api_key="gdn-xxxxxxxx")
```

---

## 命令行参数

| 参数 | 说明 |
|---|---|
| `--home <dir>` | 数据目录（默认 `~/.whale-pod`） |
| `--port <n>` | LLM 网关端口（默认 18899） |
| `--web-port <n>` | 管理界面端口（默认 18898） |
| `--no-web` | 不启动管理界面 |
| `--no-tray` | 不创建托盘图标 |
| `--dsh-app <dir>` | 手动指定 DSH 安装目录 |
| `--profile <name>` | 用哪个 DSH profile 的 channel-pack |
| `-h, --help` | 帮助 |

---

## 模型路由

客户端给的 `model` 字段支持这些写法：

| 写法 | 含义 |
|---|---|
| `auto` | 按策略自动选（**推荐**） |
| `free/gemini/gemini-3.8-flash` | 指定免费渠道 + 模型 |
| `free/gemini-3.8-flash` | 在所有免费渠道里找这个模型 |
| `paid/deepseek-chat` | 指定付费兜底 |
| `<provider>/<model>` | 直接指定（透传） |
| `<裸模型名>` | 按已发现的模型目录匹配 |

**`auto` 的行为**：按「免费渠道 → 付费兜底」的顺序依次尝试，
第一个成功的就用它。失败会自动跳到下一个，客户端无感。

响应头里会带上实际用的是谁：

```
x-whale-pod-provider: gemini
x-whale-pod-model: gemini-3.8-flash
```

---

## 决策层（活人感）

默认用**内置规则**（零成本，永远可用）：

```
被 @          → 95% 回复
刚说过话      → 冷却期内不说
连说 3 轮     → 主动收尾
群聊没人理我  → 4% 概率随机插话
私聊          → 默认回复
```

**升级选项**（改 `~/.whale-pod/config.json`）：

### Jev（TypeSafe System One）—— 真正的活人感

```json
{
  "decision": {
    "provider": "jev",
    "threshold": 0.5,
    "jev": { "enabled": true, "credentialRef": "TYPESAFE_API_KEY" }
  }
}
```

把 `TYPESAFE_API_KEY` 加进 `~/.dsh/.credentials.yaml` 的 `refs` 里。

**成本**：约 **$0.00002/次**（社区数据），按每天 500 次判断算 **≈ ¥0.07/天**。

**Jev 是可选增强，不是依赖** —— 关掉它、key 失效、服务超时，
都会自动降级到内置规则，机器照常跑。

### 自定义 HTTP 决策服务

```json
{
  "decision": {
    "provider": "custom",
    "custom": { "enabled": true, "url": "http://127.0.0.1:5000/decide" }
  }
}
```

WhalePod 会 POST：

```json
{
  "scene": { "kind": "group", "groupId": "123" },
  "self": { "qq": "10001", "nickname": "WhalePod" },
  "sinceMyLastMessageMs": 45000,
  "consecutiveTurns": 1,
  "messages": [{ "sender": "小明", "text": "在吗", "mentionsMe": true }]
}
```

期望返回（宽松解析）：

```json
{ "reply": true, "probability": 0.8, "reason": "被点名了", "delayMs": 1200 }
```

### 降级链

```
[jev] → 失败 → [custom] → 失败 → [rule]（永远可用）
```

**任何一层出问题都不会让机器人失联**，最差退回规则判断。

---

## QQ 配置

```json
{
  "qq": {
    "enabled": true,
    "onebot": {
      "wsUrl": "ws://127.0.0.1:3001",
      "httpUrl": "http://127.0.0.1:3000",
      "accessToken": ""
    },
    "allow": {
      "groups": [123456789],
      "private": [987654321],
      "allowAllWhenEmpty": false
    },
    "reply": { "segment": true, "maxChars": 500 },
    "model": "auto"
  }
}
```

⚠️ **白名单是 fail-closed 的**：`groups`/`private` 都为空且
`allowAllWhenEmpty: false` 时，WhalePod **不响应任何消息**。
这是刻意的 —— 防止误配置导致机器人在陌生群里乱说话。

### 表情与图片

模型可以在回复里写标记，WhalePod 会把它转成真正的表情段：

| 标记 | 效果 |
|---|---|
| `[表情:0]` | QQ 内置小黄脸（id 见 `src/qq/faces.json`，含全部 105 个经典表情） |
| `[表情包]` | 随机发一张（优先用你账号里收藏的表情） |
| `[表情包:猫猫]` | 按名字挑 —— 先查 `faces.json` 按名匹配，挑不到再退到收藏表情 |

**关于"按关键词搜表情"**：QQ 没有公开的表情搜索 API（实测候选接口全 404），
所以 WhalePod 在**本地**完成匹配 —— `src/qq/faces.json` 是从 NapCat 内嵌的
QQ face_config 导出的表情索引（105 个经典小黄脸 + 动画表情）。

如果你下载过 QQ 表情商城的表情包，可以生成自己的索引：

```bash
node scripts/extract-stickers.mjs [QQ数据目录]
```

它会读 `marketface/json/*.jtmp`（QQ 自己存的表情包清单，**带每个表情的名字和关键词**），
输出 `src/qq/stickers.json`。这个文件是**你个人的数据，已在 .gitignore 里**。

### 别人发来的表情/图片

WhalePod 会把送进模型的文本里的 `[表情包:xx]`/`[图片]` 改写成
「（对方发了一个表情包）」这类**行为说明**，并附上图片本体。
人格提示里明确要求模型**不要去描述图里有什么** —— 真人收到梗图不会说
「这是一张猫的图片」，而是直接回个表情或接一句情绪话。

### 被戳一戳

别人戳它，默认**戳回去**（`qq.poke.chance` 控制理会概率，默认 0.75），
并按 `textChance` 概率补一句话。真人在群里被戳也很少正经回文字。

```json
{
  "qq": {
    "poke": { "enabled": true, "chance": 0.75, "textChance": 0.25 }
  }
}
```

### 谁在跟它说话

三种情况它会认为「这是对我说」：

1. **被 @** 了（`mentionsMe`）
2. **叫了它的名字** —— 昵称会被切成 2~4 字片段去匹配（`蓝色大肥鱼` → `蓝色`/`肥鱼`/`大肥`）
3. **引用了它的消息** —— 有人回复它刚说的话，也算（靠比对被引用消息 id）

三者都走同一条"几乎必回"的分支，**不受冷却限制**。

### 协议端

WhalePod 只**连接**协议端，**不下载、不安装**。
你需要自己装好 NapCat 或 SnowLuma，在里面开启：

- **WebSocket 服务端**（正向 WS）→ 填到 `wsUrl`
- **HTTP API** → 填到 `httpUrl`

> NapCat 与 SnowLuma 的关系：NapCat 官方 README 推荐用 SnowLuma 作为
> GUI 替代品。两者都实现 OneBot v11，WhalePod 都支持。
>
> ⚠️ SnowLuma 的 EULA 对「通过自动化脚本部署」有限制，
> 所以 WhalePod 刻意不做自动安装。

---

## 人格

角色文件在 `~/.whale-pod/persona/roles/<name>.md`，**直接编辑或从 Web UI 改**。

首次启动会写入两个模板：

| 角色 | 风格 |
|---|---|
| `default.md` | 普通群友（短句、口语、不客套） |
| `quiet.md` | 潜水版（很少说话） |

**人格提示词的关键**：写**具体的说话习惯**，不要写形容词。
「你很幽默」没用；「偶尔只发个『草』或者『？』」才有用。

Web UI 的「人格」页可以直接编辑并切换当前角色。

---

## 记忆

| 层 | 作用 | 成本 |
|---|---|---|
| **短期** | 每个会话最近 N 条上下文（内存） | ¥0 |
| **长期** | 滚动摘要（谁在群里、在聊什么） | 一次便宜模型调用 |

长期记忆**默认关闭**。开启：

```json
{ "memory": { "long": { "enabled": true, "summarizeAfter": 200 } } }
```

它**不用向量库** —— 群聊的长期记忆价值在「最近发生的事」，
滚动摘要比语义检索更合适，而且零额外依赖。

---

## 管理界面

`http://127.0.0.1:18898?token=<启动日志里的 token>`

| 页 | 内容 |
|---|---|
| **总览** | 运行状态、渠道、用量、凭据 |
| **QQ** | 连接状态、消息统计、最近交互、暂停开关 |
| **模型** | **路由策略 / 渠道优先级 / 默认模型 / token 上限 / 试跑** |
| **渠道** | 自备渠道管理（添加、测试连接、删除） |
| **组件** | **模式切换 + 内置下载 NapCat + 启停 + 日志**（AstrBot 为未完善） |
| **决策** | 提供者可用性、**在线试判断**（不真的发消息） |
| **人格** | 编辑角色、切换当前角色 |
| **记忆** | 各会话上下文、长期摘要、清空 |
| **日志** | 实时日志流（SSE） |
| **配置** | 当前配置（密钥脱敏） |

**界面约定**：长表单与长列表默认**折叠**（点标题展开，状态记在浏览器里），
图标统一用单色线性 SVG（跟随主题），删除/清空等危险操作走二次确认弹层。

### 「模型」页能调什么

四组设置改完**立即生效**，不需要重启：

| 设置 | 说明 |
|---|---|
| **路由策略** | `free-first` 免费优先 / `free-only` 完全不花钱 / `self-only` 只用自备 |
| **渠道优先级与开关** | **拖整行排序**（或用箭头微调）＋ **开关控制是否参与路由**；改动自动保存 |
| **默认模型** | **输入 + 分组下拉共存**；只填模型名，厂商由上面优先级决定 |
| **token 上限** | 带推理的模型要给够（建议 ≥1024），否则推理吃光预算、正文变空 |
| **模型清单** | 按模型归纳，渠道跟在模型名后面；点渠道 chip 一步选定；带「刷新目录」按钮 |

**默认模型选择器**是自定义组合框（不是原生 `datalist`）：
可以直接打字过滤，也可以展开按系列浏览。分组按模型的**系列名**——
`deepseek-*` 一组、`openai/*` 一组；常用厂商（deepseek、openai、google、
anthropic、qwen…）排在前面，其余按模型数量降序。每项右侧标出哪几家渠道有它。
输入框保留手输，列表里没有的模型名也能直接填。

**渠道优先级与开关都是真·生效的**：顺序写进 `gateway.freeProviders`、
开关写进 `gateway.disabledProviders`，由 `router.applyFreeOrder()` 与
禁用过滤在每次请求时应用。首次启动会按内置的 `DEFAULT_FREE_ORDER`
（gemini 优先，已验证最稳）初始化一次。

> ⚠️ 顺序与开关是**两个独立关注点**：顺序只管顺序，开关只管开关。
> 把开关状态混进顺序数组会让读写都容易出错，所以单开了一个列表。

---

## 数据与安全

| 文件 | 说明 |
|---|---|
| `~/.whale-pod/config.json` | 配置（含网关 key、Web token） |
| `~/.whale-pod/credentials-overlay.json` | 续期后的凭据（**不碰 DSH 的文件**） |
| `~/.whale-pod/persona/roles/*.md` | 人格 |
| `~/.whale-pod/memory-long.json` | 长期摘要 |
| `~/.whale-pod/whale-pod.log` | 日志 |

### 凭据的 overlay 设计

WhalePod **读** DSH 的 `~/.dsh/.credentials.yaml`，但**写**只写自己的
`credentials-overlay.json`。原因是 DSH 和 WhalePod 可能同时活着，
两边都写同一个文件会互相覆盖。

读取时 overlay 优先，缺失回落到 DSH 文件 —— 所以你在 DSH 里重新登录，
WhalePod 也能立刻用上新凭据。

模式可在配置里改：

| mode | 行为 |
|---|---|
| `overlay`（默认） | 读合并、写自己的文件 |
| `direct` | 读写都走 DSH 文件（原子写 + 备份） |
| `readonly` | 只读（续期会失败，但不会崩） |

### 其它

- **只绑回环地址**（`127.0.0.1`），不对外暴露
- **密钥不回传明文**（Web API 只给前缀）
- **凭据值不进日志**
- Web/网关各自有独立 token

---

## 架构

### 仓库布局

本仓库同时包含**核心运行时**与**DSH 插件**两部分，它们是一体的：

```
whale-pod/
├── src/                 核心运行时（独立进程，可脱离 DSH 单独跑）
├── plugin/              DSH 插件（宿主适配层：透传 API + 侧栏面板 + 进程托管）
│   ├── index.js         Host 半身：/api/whale-pod/* 透传 + 启停本地处理
│   ├── client.js        客户端半身：侧栏仪表盘 + 设置页
│   └── daemon.js        拉核心进程 / 心跳 / 彻底关闭
├── assets/              图标（多尺寸，打包用）
├── scripts/             辅助脚本（提取表情索引、启动器等）
└── tests/               自检脚本
```

**为什么放一个仓库**：插件本身没有业务逻辑，它只做三件事 —— 把 HTTP 透传给核心、
把 UI 挂到 DSH 侧栏、保证核心进程活着。两者版本必须同步，分仓会导致
「插件 0.2 + 核心 0.1」这种错配。插件通过相对路径 `../src/index.js` 定位核心，
仓库内直接可用。

### 核心模块

```
src/
├── index.js              主入口（组装 + 优雅退出）
├── logger.js             环形缓冲日志
├── config/
│   ├── store.js          配置（原子写 + 深合并 + 损坏自愈）
│   └── credentials.js    凭据（overlay 读写 + YAML 解析）
├── gateway/
│   ├── llm-core.js       cordis Context + channel-pack（13 渠道）
│   ├── router.js         路由策略（免费优先 → 兜底）
│   ├── openai.js         OpenAI 协议 ↔ dsh-llm 转换
│   └── server.js         HTTP 端点（/v1/chat/completions）
├── decision/
│   ├── provider.js       接口 + 降级注册表
│   ├── rule.js           内置规则（零成本兜底）
│   ├── jev.js            Jev（可选，付费）
│   ├── custom.js         自定义 HTTP
│   └── index.js          装配
├── memory/
│   ├── short.js          会话短期上下文
│   └── long.js           滚动摘要
├── persona/store.js      角色提示词
├── qq/
│   ├── onebot.js         OneBot v11 客户端
│   ├── protocol.js       协议端托管（下载、启停、端口探测）
│   ├── runtime.js        自带 uv + Python（AstrBot 预留，未完善）
│   ├── modes.js          运行模式（whale-pod 可用 / astrbot 未完善）
│   └── bridge.js         消息 → 决策 → 生成 → 发送
├── web/
│   ├── server.js         HTTP 端点 + 页面骨架
│   ├── assets.js         前端 CSS/JS（内嵌字符串）
│   ├── api.js            插件兼容层用的 API
│   └── icons.js          线性图标库（内联 SVG，48 个）
└── tray/index.js         托盘（可选，优雅降级）
```

### 关键技术点

**复用 DSH 的渠道适配器**：WhalePod 不重新实现 Gemini/EAC/账号渠道，
而是用 cordis 的真实 `Context` 装载宿主的 `channel-pack`：

```js
const ctx = new Context()
new LlmRuntime(ctx)                     // ctx.llm 自动注册
new MinimalCredentials(ctx)             // 读 ~/.dsh/.credentials.yaml
pack.apply(ctx, {})                     // 13 个渠道就绪
```

只需要补三个最小服务（credentials/commands/tools），各有几行代码。

---

## 测试

```bash
# 用 DSH 自带运行时跑（本机没装独立 Node 时）
ELECTRON_RUN_AS_NODE=1 "D:/DSH Desktop/DSH Desktop.exe" tests/check-decision.mjs
ELECTRON_RUN_AS_NODE=1 "D:/DSH Desktop/DSH Desktop.exe" tests/check-qq.mjs
ELECTRON_RUN_AS_NODE=1 "D:/DSH Desktop/DSH Desktop.exe" tests/check-boot.mjs
```

| 测试 | 覆盖 |
|---|---|
| `check-decision.mjs` | 决策层 31 项（降级、阈值、规则分支） |
| `check-qq.mjs` | QQ 桥接 43 项（CQ 码、白名单、端到端、记忆） |
| `check-boot.mjs` | 启动自检 13 项（各服务、API、鉴权） |
| `check-gateway.mjs` | 网关端到端（含真实 Gemini 调用） |
| `check-overlay.mjs` | 凭据 overlay 写隔离 |
| `check-llm-core.mjs` | channel-pack 装载 |
| `check-providers.mjs` | provider / 模型枚举 |

---

## English

<a id="english"></a>

<div align="center">

<img src="assets/icon-256.png" width="96" alt="WhalePod">

<b>A QQ chat bot that lives inside DSH.</b><br>
<sub>One tray process handles everything — gateway, bridge, decision layer, persona, protocol host.</sub>

</div>

You install the plugin, open the sidebar, and press Start. No command line, no manual process juggling — *after* the one-line install.

**Before you start — is this for you?**

This is a **DSH plugin**, not a standalone app.

- ✅ **Yes, if** you already run [DSH Desktop](https://github.com/deepseek-ai/deepseek-harness),
  you have a DeepSeek API key, and you want a group-chat bot that knows when to
  stay quiet.
- ❌ **No, if** you don't have DSH, you expected a one-click script (you'll still
  configure NapCat and scan a QR code), or you want a "reply to everything" bot —
  this one deliberately stays silent most of the time.

**Does it cost anything?**

Two different things — don't conflate them:

- **Chatting** runs through DSH's channel pool, so it **doesn't bill your
  DeepSeek account**. The panel still shows a "converted cost", but that's the
  *list price* of the tokens (what they'd cost from the vendor directly), not
  what you paid. Free channels can rate-limit or disappear, so it's not
  "unlimited free" either.
- **Web search** does bill you: about **¥0.005 per lookup** (DeepSeek's paid
  Search API, billed per request) plus a few hundred tokens to summarize —
  roughly **¥2–3/month** for a typical group.

You can turn search off and keep chat working; it'll just say "not sure" instead
of looking things up.


**What it does**

- **LLM gateway (OpenAI-compatible).** Ships with DeepSeek account credentials; any OpenAI-compatible endpoint can be added as a custom provider.
- **QQ bridge.** OneBot v11 in and out. A decision layer first asks *should I speak at all*, then the model decides *what to say* — which is both cheaper and more human than replying to everything.
- **Protocol host.** Downloads and supervises NapCat for you, including QR-less quick login.

**Modes**

| Mode | Who talks to QQ | Status |
|---|---|---|
| `whale-pod` | WhalePod itself | ✅ Works |
| `astrbot` | AstrBot | ⚠️ Scaffolded, not finished |

> The AstrBot path has the full skeleton (backend definition, uv install flow, start/stop,
> mode switching, gateway hint) but has **never been verified end-to-end**: `initArgs` is
> never called, there is no readiness check after spawn, and the OneBot wiring is inferred
> from the NapCat path. Do not expect it to work yet. Use `whale-pod` mode.

**Design notes**

- Reuses the host's installed channel pack and credentials instead of reimplementing each vendor adapter.
- Decision and expression are separate layers — that separation is what makes it feel less like a bot.
- Data lives in `~/.whale-pod`; deleting that directory uninstalls everything.

**Requirements:** DSH Desktop · Node 22.19+ · a QQ protocol host (NapCat can be installed from the UI)

See the Chinese sections above for configuration details, the full CLI reference, and the API surface.

---

## 已知限制

- **reverse WS 未实现** —— 只支持 WhalePod 主动连协议端（forward）。
  NapCat/SnowLuma 都支持正向 WS，够用。
- **图片只记占位** —— 收到图片存 `[图片]`，不送多模态（可扩展）。
- **托盘需要额外包** —— 未装 `systray2` 时回退控制台模式，核心功能不受影响。
- **长期记忆用摘要而非向量检索** —— 见上文取舍说明。
- **Jev 的 HTTP 契约按社区插件描述实现** —— 官方 schema 未公开稳定，
  若不符只需改 `src/decision/jev.js` 的两个方法。

---

## 合规

- WhalePod **不下载、不安装、不修改** QQ 客户端或协议端。
- 使用第三方协议端（NapCat / SnowLuma 等）请自行阅读其许可与
  《QQ 用户协议》。**建议使用小号**，账号风险自负。
- WhalePod 本身 MIT 许可，不含任何腾讯专有代码。

---

## 许可

MIT
