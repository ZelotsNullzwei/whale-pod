# 交接：连发两张图 / 参考图不符（2026-11-10 13:30）

> 请 GPT 复核下面三件事：**根因判断对不对、修法有没有副作用、两处待定项怎么定**。
> 所有结论都能用文末的复现命令重跑，不靠日志猜测。
> 本轮**未提交、未推送**；未改动任何未跟踪的摄影证据/交接文件。

---

## 0. 事故原样（日志，12:47，private:2129024700）

```
12:47:12  收到「来张自拍看看」        决策 → 发言
12:47:16  垫场「别急，正在挑一张像样的。」 + 画图「自拍，前置自拍，坐在床边举着手机对着脸拍…」
12:47:16  拍摄方案 → 前置自拍｜头肩｜参考图=her-body-front.png
12:47:37  图发出（446KB）
12:47:46  收到「挑呗」               决策 → 发言
12:47:47  又画图「对镜自拍，雾霾蓝细吊带…」→ 拍摄方案 → 镜子自拍｜全身｜参考图=her-body-front.png
12:48:06  第二张图发出（420KB）      → 两分钟内两张
```

用户补充的关键前提：**「挑呗」是在回应她那句「别急，正在挑一张像样的」**，不是对已发图片的挑选。

---

## 1. 根因 A：闸门条件写错（已修）

`src/qq/bridge.js` 画图闸门（原 5874 行；现见 decideDrawGate 调用处）：

```js
if (askBeforeDraw !== false && !allowDraw && !drewRecently) { 跳过 }
```

`drewRecently`（5 分钟内刚画过）把**整个拦截分支**跳过 → 落到 `else` → `drawAllowed = true`。
语义被写成「刚拍过就允许再画」，而原意只是「刚拍过就别再问『拍什么怎么拍』」。

**改法**：抽成纯函数 `decideDrawGate`（bridge.js 末尾导出），`_handle` 调它。

```js
export function decideDrawGate({ askBeforeDraw = true, allowDraw = false, drewRecently = false, drawEnabled = true } = {}) {
  if (askBeforeDraw !== false && !allowDraw) {
    if (drewRecently) return { draw: false, ask: false, reason: '刚画过，没明确要新的' }
    return { draw: false, ask: true, reason: '没确认（已改为询问）' }
  }
  if (drawEnabled === false) return { draw: false, ask: false, reason: '功能开关关闭' }
  return { draw: true, ask: false, reason: '' }
}
```

**顺带补的（重要，防矫枉过正）**：`换一张 / 重拍 / 换个姿势 / 再来一张 / 再发一张…`
原来 `classifyDrawIntent` 全是 `wantsPic=false`——以前靠 `drewRecently` 漏洞"碰巧"能画。
漏洞堵上后不补这些，就会变成"明确要重画却不画"。已加进 `PIC_REQUEST_PHRASES`（bridge.js:13392）。

**待复核**：这个"重画词汇表"放在 `PIC_REQUEST_PHRASES` 里是否合适？它和"第一次要图"混在一张表，会不会影响别处对这个表的语义假设（比如群聊限制、部位特写）？

---

## 2. 根因 B：构图档没参与参考图选择（已修）

`src/photo/reference-manager.js` 的 B 版身体分支（原 247 行；现 255 行附近）只看 `mode`、不看构图：

```js
if (bodyRef && bodyV === 'B' && cur === 'B' && BODY_VISIBLE_MODES.has(mode)) → 用 bodyRef
```

于是 **头肩特写也喂 `her-body-front.png`（全身图）**——全身图里脸很小，脸和耳鳍细节被拉糊。
日志第一张正是 `前置自拍｜头肩｜参考图=her-body-front.png`。

**改法**：`resolveReference` 新增 `framing` 入参（`index.js:234` 传入），身体图只在
`半身 / 三分之二身 / 全身` 时使用；`头肩 / 面部特写 / 局部` 回头像。

```
头肩/面部特写 → strategy=face, ref=her-face-front.png
半身/三分之二身/全身 → strategy=body, ref=her-body-front.png
```

**待复核**：`BODY_VISIBLE_FRAMINGS` 只列了三个构图。`环境照`（人不在画面）在 resolver 里
已经先被 `scene_only` 拦截了吗？请确认没有"构造上会露身体但 framing 字符串不在集合里"的档位
（例如未来新增的构图名），否则会静默退回头像。

---

## 3. 新增：被拦下时不能静默（已修）

场景：她在垫场里承诺「正在挑一张像样的」，用户回「挑呗」，模型这条回复往往**只剩一个 `[画图:]`**，
剥完正文为空；而 `bridge.js:7295` 那句 `拿去。` 要求 `coverForSend`（真有图）→ 跳过时没有图 → 不兜 → 空消息。

**改法**：`gateSkipRecent` 置位 + 兜一句：

```js
if (!drewAny && gateSkipRecent && !String(text ?? '').trim()) {
  text = '刚发你那张就是挑好的，先看那个。'
}
```

**待复核**：这句文案是否太"客服"？我倾向保留模型自己的话，只在**完全空**时才兜。

---

## 4. 待定项一：垫场文案在"挖坑"

`bridge.js:6006` 垫场池里有：

```js
'别急，正在挑一张像样的。',
```

她一次只生成一张，并没有多张可挑。这句话直接诱发用户回「挑呗」。
建议改成 `'别急，这就拍。'` 或删掉该条（池里已有「等我一下，马上就好。」）。
**这是文案不是逻辑，未改，等定。**

---

## 5. 待定项二：用户发来的照片从来不进参考图（能力缺口，未做）

把 bridge 里所有 `refImage:` 赋值点查了一遍（1829 / 2057 / 2106 / 6335 / 6370 / 6494 / 7363），
来源只有 `qq.image.*` 配置的固定文件，**没有任何一处读 `msg.images`**。
所以「他发来的蓝发/精灵耳照片」不会作为外观参考参与生成。

如果要支持，我建议的边界（请评估）：
1. 只在用户**明确说**「照这张 / 像我这样 / 用这张」时才启用；
2. 只接受**人像照**，表情包/截图一律不接（否则会把梗图当参考）；
3. 复用现有 `captureCheck` 审核，不绕过安全逻辑；
4. 记录来源（哪张消息图 → 哪次生成），便于回溯。

**风险点**：`composePhotoPrompt` 的角色段是"身份特征写死"的，喂用户照片后可能出现
「参考图是真人、提示词是二次元特征」的冲突，需要确认参考图优先级。

---

## 6. 测试与验证（当前状态）

```
check-draw-recent-guard        11/11  （分类矩阵 / 闸门矩阵 / 事故时序复演 / 接线锁 / 不静默）
check-reference-version-b      13/13  （B 版本识别 + 构图选参考图）
check-draw-pipeline            OK
check-draw-stage1-nomsg-loss   OK
check-cross-group / close-persona / segments / wear-action  OK
check-photo-plan-bugs / photo-bodypart / qzone-proactive    OK
```

事故时序复演（真函数）结果：`draws=1, asks=0`；修前同链路 `draws=2`。

---

## 7. 复现命令

```bash
# 闸门矩阵 + 事故时序
node tests/check-draw-recent-guard.mjs

# 参考图按构图选
node tests/check-reference-version-b.mjs

# 直接看判定
node -e "import('./src/qq/bridge.js').then(m=>{console.log(m.decideDrawGate({allowDraw:false,drewRecently:true}));console.log(m.classifyDrawIntent('挑呗'), m.classifyDrawIntent('换一张'))})"

# 直接看参考图选择
node -e "import('./src/photo/reference-manager.js').then(m=>{const b={outfitText:'x',faceRef:'F',faceRefKind:'head',mode:'front_selfie',characterVersion:'B',bodyRef:'B',bodyRefVersion:'B'};for(const f of ['头肩','半身','全身'])console.log(f,m.resolveReference({...b,framing:f}).strategy)})"
```

---

## 8. 改动文件清单

| 文件 | 改动 |
| --- | --- |
| `src/qq/bridge.js` | 闸门抽 `decideDrawGate`；`PIC_REQUEST_PHRASES` 补重画词；`gateSkipRecent` 兜底；`_refusalFallback` 阶段词补 停/深/抖；`_stripRefusal` 去掉裸「继续」 |
| `src/photo/reference-manager.js` | 身体分支加 `framing` 判定；新增 `framing` 入参 |
| `src/photo/index.js` | `resolveReference` 调用传 `framing`；`bodyRefVersionOf` 支持 B（SHA256） |
| `src/photo/photo-planner.js` | 家务动作优先于「站在/全身」构图词 |
| `tests/check-draw-recent-guard.mjs` | 新增 11 项 |
| `tests/check-reference-version-b.mjs` | 新增（13 项） |
| `tests/check-refusal-fallback.mjs` | 新增（10 项） |
| `tests/check-photo-plan-bugs.mjs` / `check-photo-bodypart.mjs` | 补行为回归 / 改掉锁旧源码形状的断言 |

---

## 9. 想请 GPT 重点看的三点

1. `decideDrawGate` 的语义表有没有漏掉的组合（尤其 `askBeforeDraw=false` 和 `drawEnabled=false` 同时出现）。
2. 把"重画词汇"混进 `PIC_REQUEST_PHRASES` 会不会影响别处（群聊限制、部位特写、确认状态机）。
3. 第 5 节「用户照片当参考」的边界建议是否可行，以及参考图与提示词角色段的优先级冲突怎么处理。


---

# 评审回执 v2（2026-11-10 14:08）

> 逐项核对了 GPT 的静态检查清单（6 项）。结论：**2 项成立并已修，1 项前提不准确，3 项按建议改了测试/写法。**

## 结论表

| 优先级 | 项 | 核对结果 | 处理 |
| --- | --- | --- | --- |
| 高 | `classifyRedrawIntent` 否定覆盖不足 | **复现（4 例）** | 已修：先摘「否定词…重画短语」片段再判 |
| 中 | `refDecision.checks` 没进日志 | **成立** | 已接：异常项 warn、摘要 info；加了源码锁 |
| 中 | `check-prompt-order` 用真实用户目录 | **成立** | 已改临时目录 + 固定 fixture |
| 中 | 背影模式不给身体参考 | **前提不准确** | 见下（返回 none，不是回头像）；待产品定 |
| 低 | 复杂句/转折判错 | 部分成立 | 已覆盖「不是X，是Y」「先别…等等再说」 |
| 低 | 长度阈值无证据 | **成立** | 去掉 <600 / <1000 硬阈值，只留结构顺序 |

## ① 否定排除（高）—— 复现的 4 例

修前实测：
```
「别换个姿势」        → true  ❌（应为 false）
「不要重新拍」        → true  ❌
「不用再发一张」      → true  ❌
「不要换一张，要重拍」→ false ❌（应为 true，后半句才是真的）
```

修法：`先去掉「否定词 + 重画短语」片段，再看剩下有没有重画短语`。
这样「不是X，是Y」里的 X 被摘掉、Y 留下 → 判对。

修后矩阵（12 例全过）：否定 8 例全 false，转折 2 例 true，普通 2 例 true。
测试：`tests/check-draw-recent-guard.mjs`（19 项）。

## ② checks 可观测性（中）—— 成立

`refDecision.checks` 原来只存在返回对象里，全仓没有任何日志消费它。
已在 `bridge.js:6251` 之后接入：
```
异常项（版本/双身份/未知构图等）→ log.warn「参考图决策有 N 项异常 — …」
其余 → log.info「参考图决策 <strategy>（<reason>），N 项检查通过」
```
测试：`check-reference-version-b` 里有源码锁，防止日志被删。

## ③ check-prompt-order（中）—— 成立

- 原来 `new PersonaStore({ home: 'C:/Users/Null_zwei/.dsh/whale-pod' })` → 读用户真实人格、结果随字数漂移。已改成 `os.tmpdir()` + 固定 fixture（一行 md + 一份 config）。
- 两条绝对长度断言（B站距尾<600、facts距尾<1000）**已删除**，改为结构顺序断言，失败信息里带上位置与长度。原因：提示词末尾有**按设计固定收尾**的规则块（说话风格 / 开口前过一遍 / 知道≠可以说来路），用字数阈值必然误报。
- 结果：**14/14 通过**（原来是历史红项）。

## ④ 背影模式（中）—— 前提不准确

实测：
```
rear_object  → strategy=none  refImage=null  reason=mode_has_no_person
rear_selfie  → strategy=none  refImage=null
front_selfie → strategy=body  refImage=B
```
背影两种模式都在 `NO_PERSON_MODES` 里，**直接返回 none（完全不给参考图）**，并不会"回落到头像或 fallback"。

要不要给背影喂**身体**参考（不用脸）是产品决定。若要，建议单独规则：
`mode ∈ {rear_*} + framing ∈ {半身, 全身} → 用 bodyRef，提示词注明"背影，不出现脸"`，并补测试。
**未实现，等确认。**

## ⑤ 长度阈值（低）—— 同 ③

## 全量测试（本轮结束状态）

```
171 / 182 通过
```
剩余 11 个红项：
- **历史红项（10）**：check-bilibili / check-body-leads / check-memory-limits / check-multimodal / check-nudge / check-prompt-leak / check-qq-actions / check-qq / check-sticker-hint / check-time-anchor
- **待处理（1）**：`check-prompt-style-tail` —— 是早先 commit `1d64918`（按用户要求放宽 close 括号规则）导致的两条过期断言，行为是用户确认过的，等确认后改断言即可。
- `check-prompt-order` 已从红项转为**通过**。

## 守护进程

14:08:27 重启（跑本轮全部改动）。

## 决定记录（2026-11-10 14:12）：rear 模式不加身体参考

- `rear_selfie` / `rear_object` 语义 = **画面不带人物**（`mode_has_no_person` → `strategy=none`）。
- **不**给它们加身体参考。将来若要「人物背对镜头」的照片，应**新增明确的人像模式**（例如 `back_selfie`）后单独决定参考图策略。
- 该决定已被测试锁住：`tests/check-reference-version-b.mjs` 第 8 节断言 rear 两种模式必须 `strategy=none` 且无参考图。
- 剩余 10 个历史红项与 `check-prompt-style-tail` 的过期断言**独立排查**，不计入本轮验收。
