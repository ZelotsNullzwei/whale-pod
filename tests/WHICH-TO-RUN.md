# 改哪里跑哪里（别动不动跑全量）

> 2026-11-08 用户：「测试没必要跑全量吧，改了哪里跑那里不就好了」。
> 全量 `node tests/run.mjs` 要几分钟，而且有 **12 个长期红的用例**（见文末），
> 跑全量只会看到一堆红色，对判断"我这次改坏没"没帮助。

## 用法

改完代码，从下表找到你动的地方，**只跑那一行的测试**：

```bash
node tests/check-qzone-memory.mjs
node tests/check-photo-scene-only.mjs
# 一次跑多个
for f in check-segments check-bubble-gap; do node "tests/$f.mjs"; done
```

## 对照表

| 改动位置 | 跑这些 |
| --- | --- |
| `src/qq/qqActions.js`（动作标记） | `check-qq-actions` `check-qzone-own-photo` `check-qzone-memory` `check-marker-leak` `check-outbound-markers` |
| 发说说 / 空间 | `check-qzone-own-photo` `check-qzone-memory` `check-qq-actions` |
| `src/photo/*`（生图构图/提示词） | `check-photo-scene-only` `check-photo-bodypart` `check-photo-v3-append` `check-photo-partmap` `check-photo-mode-fix` `check-photo-plan-bugs` |
| 画图链路 / 发送（`bridge` 的 3c） | `check-draw-pipeline` `check-draw-stage1-nomsg-loss` `check-image-body` `check-image-no-text` |
| 分段 / 气泡 / 自我重复 | `check-segments` `check-bubble-gap` `check-self-repeat-inline` `check-self-repeat` |
| `src/memory/short.js`（短期记忆） | `check-memory-order` `check-memory-limits` `check-short-persist` `check-concurrency` `check-memory-events` |
| 长期记忆 / 摘要 | `check-memory-facts` `check-summary-delta` `check-summary-quality` `check-long-trim` |
| 人格文件（`persona/roles/*.md`） | `check-close-persona` `check-body-leads` `check-persona-scope` `check-persona-hotreload` `check-prompt-style-tail` |
| 提示词顺序 / 注入 | `check-prompt-order` `check-prompt-leak` `check-prompt-style-tail` `check-offline-hint` |
| 搜索 / 配额 | `check-search-quota` `check-search-pacing` `check-search-gate` `check-qq` |
| 主动发言 / 讨钱 | `check-proactive` `check-proactive-not-delivered` `check-beg` `check-beg-whitelist` `check-deadair` |
| 日程 / 外出 / 衣柜 | `check-outing-cadence` `check-dayplan-stream` `check-dayplan-variety` `check-wardrobe-editable` `check-wear-action` |
| 表情包 | `check-sticker-hint` `check-sticker-tags` `check-sticker-gate` `check-sticker-dedupe` `check-sticker-priority` |
| B 站 / 分享卡 / 链接 | `check-share-card` `check-bilibili` `check-bili-visual` `check-link-preview` |
| 配置 / 面板 / 客户端 | `check-config-dots` `check-panel-config` `check-client-syntax` `check-channel-layout` |
| 启动 / 守护进程 | `check-boot` `check-daemon-boot` `check-runtime` |

## 什么时候才跑全量

只在动**公共底座**时：

- `src/memory/short.js` 的 `push` / `_trim` / `render`（谁都依赖）
- `src/qq/segments.js`、`src/qq/bridge.js` 的 `_send`
- `src/config/store.js` 的默认值
- 重命名字段、改函数签名

## 长期红的 12 个（别去追）

这些在基线提交 `1d64918` 上就是红的（已用独立工作树对照过）：

```
check-bilibili  check-body-leads  check-memory-limits  check-multimodal
check-nudge     check-prompt-leak check-prompt-order   check-prompt-style-tail
check-qq-actions check-qq         check-sticker-hint   check-time-anchor
```

它们的断言早于后来几次"有意放宽"（括号规则、表情提示文案、时间锚点措辞等），
是**测试没跟上产品变更**，不是代码坏了。要修就单独一轮统一修，别在业务改动里顺手改。

## 一条硬规矩

**测试不许污染真实数据目录**。
`qzone-last.json`、`people.json` 这类状态文件，测试里必须用
`tests/_isolate-home.mjs`（第一个 import）把 `WHALE_POD_HOME` 指到临时目录 ——
2026-11-08 就被坑过一次：跑测试写了个 `qzone-last.json`，导致她 20 小时发不了说说。
