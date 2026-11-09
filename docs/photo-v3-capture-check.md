# Capture Check 离线验证报告（P1-a / P1-c）

日期：2026-11-09
范围：新增 `src/qq/captureCheck.js` + `tests/check-capture-check.mjs` + 本报告。
**未修改** `bridge.js`、`photo-validator`、`photo-modes.js`、`photo-prompt.js`、`photo-planner.js`、图片缓存、群消息、重拍流程、日程/continuity/参考图/canon；**未触发任何真实重拍**；未合并 main。

## 一、视觉能力审计（实现前）

| 检查项 | 结论 |
|---|---|
| 现有视觉接口 | ✅ `src/qq/imageReview.js`：`reviewImage` / `countLimbs` / `reviewMatches`，走本地网关 `/chat/completions` |
| 能否直接给图片 | ✅ 传 `Buffer`（base64 data URL 内嵌） |
| 结构化返回 | ⚠️ 现有只回 `{ok|match, why}`，**没有违规类型**；因此新建 reviewer 输出严格契约 |
| 超时/异常 | ✅ 支持 `AbortSignal.timeout`；本模块统一转 `uncertain`（**绝不静默 pass**） |
| 是否需新依赖/配置 | ❌ 不需要。复用同一网关（`127.0.0.1:<gateway.port>/v1` + `gateway.key`） |

**未使用任何 mock 冒充真实识别**：单元测试用注入 `ask`（mock），真实图片测试走真实网关。

## 二、模块契约

```js
{ status: 'pass'|'violation'|'uncertain', ok: true|false|null,
  reviewer: 'no_phone'|'no_body_subject',
  violation: null|'phone_visible'|'body_subject',
  why: string, confidence: number|null }
```

- `pass→ok:true`、`violation→ok:false`、`uncertain→ok:null`
- 底层不给置信度 → `confidence:null`（不编造）
- `pickReviewer(mode)`：`front_selfie→no_phone`、`rear_selfie→no_body_subject`、**`first_person`/`mirror_selfie` → null（不检查）**

## 三、单元测试（14 / 0，mock 底层）

覆盖：pass / violation / uncertain；空图；调用抛异常→uncertain；解析失败→uncertain；只有手/前臂→pass；漫画人物→pass；躯干腿脚→violation；手臂躯干分不清→uncertain；两 reviewer 不互相污染；`pickReviewer` 选择；置信度缺失为 null；ok 与 status 严格对应。

## 四、8 张真实图片离线验证（真实调用视觉模型）

参与审核 5 张（`mirror-1/2` 与 `rear-3`(实际 `first_person`) 按规则**不调用 reviewer**）。

| 图片 | mode | reviewer | status | violation | why（模型原话） | confidence | 预期 | 一致 |
|---|---|---|---|---|---|---|---|---|
| front-1 | front_selfie | no_phone | pass | — | 画面中未见手机 | 0.95 | pass | ✅ |
| front-2 | front_selfie | no_phone | pass | — | 画面中未见手机 | 0.95 | pass | ✅ |
| front-3 | front_selfie | no_phone | violation | phone_visible | 右侧手中举着手机及摄像头 | 0.99 | violation | ✅ |
| rear-1 | rear_selfie | no_body_subject | violation | body_subject | 画面左侧可见肩部躯干及衣物 | 0.95 | violation | ✅ |
| rear-2 | rear_selfie | no_body_subject | violation | body_subject | 露出白色衬衫躯干和腿部 | 0.98 | violation | ✅ |

**统计（分母=5）**：一致 5；误报 0/5；漏报 0/5；uncertain 0/5。
耗时：约 3.0–4.4 秒/张（网关本地推理）。

### 重复性（同一张图多次调用）

| 图片 | 次数 | pass | violation | uncertain |
|---|---|---|---|---|
| front-1 | 5 | 5 | 0 | 0 |
| front-2 | 5 | 5 | 0 | 0 |
| front-3 | 5 | 0 | 5 | 0 |
| rear-1 | 3 | 0 | 3 | 0 |
| rear-2 | 3 | 0 | 3 | 0 |

共 21 次调用，**0 次异常、0 次超时、判定完全一致**。

### 需要如实记录的一次抖动

在收紧提示词**之前**的两轮里，`front-2` 出现过一次 `violation`（"右手举着手机自拍，边缘可见"），与人工预期 `pass` 不一致（当时统计：一致 4/5、误报 1/5）。
收紧措辞为"看不到手机 → false；只有疑似但被遮挡才 null"后，`front-2` 连续 5 次稳定 `pass`。
**结论：reviewer 在同一图片上的重复稳定性良好，但跨提示词版本的判定边界对"极小手机边缘"仍需人工抽检。**

## 五、项目回归

`node --check` 通过；`check-draw-pipeline 32/0`、`check-photo-v3-append 13/0`、`check-reference-wiring 16/0`、`check-reference-manager 30/0`、`check-close-persona 20/0`、`check-photo-v3-shadow 24/0`、`check-pipeline-v3 11/0`、`check-capture-check 14/0`。

## 六、结论与限制

1. **接口稳定**、单元测试覆盖主要分支、8 张真实图全部实际执行对应检查（5 张参与，3 张按规则不参与）。
2. 真实识别**确实调用了视觉模型**（非 mock），返回 `status/violation/why/confidence`。
3. 已知限制：
   - `front_selfie` 对"极小手机边缘"偶有边界抖动（已在上一节如实记录）。
   - `rear_selfie` 的"手 / 前臂 vs 躯干"边界依赖模型判断；若出现"手臂紧贴躯干"的构图，可能给 `uncertain`（保守，不误报）。
   - 本模块**未接入**生图流程；重拍、缓存一致性、原图落盘均未做（下一轮单独授权）。

## 七、复核补强（第二轮，2026-11-09）

| 复核意见 | 处理 |
|---|---|
| 缺可重复执行的真实图片测试入口 | 新增 `tests/check-capture-check-real.mjs`：内置期望表（front-1/2=pass、front-3=violation、rear-1/2=violation、mirror-1/2 与 rear-3 跳过），图片目录由 `CAPTURE_CHECK_IMAGES` 指定（默认本机 `_scratch/photo-v3/step9`）。**缺目录或缺网关 key → 打印 SKIPPED 并 exit 0（不算通过）**；有图则真实调模型并逐张比对，不一致 exit 1。 |
| 超时路径未被真正覆盖 | 单元测试新增两条：抛 `AbortError`、抛 `TimeoutError`（DOMException 形态）→ 均必须 `uncertain`、`ok=null`，不得 pass。 |
| confidence 未限定范围 | 新增 `normConf()`：仅接受 `Number.isFinite` 且 `0 ≤ v ≤ 1`，否则 `null`；测试覆盖 `-0.1 / 1.01 / 2 / NaN / Infinity / "0.9" / undefined` 全部→null，`0/0.5/1` 透传。 |

### 本轮结果

- 单元测试：**18 / 0**（原 14 项 + 超时 2 项 + 置信度 2 项）
- 真实入口（`node tests/check-capture-check-real.mjs`）：**参与 5 / 一致 5 / 误报 0/5 / 漏报 0/5 / uncertain 0/5 / 跳过 3**
- 跳过的 3 张：`mirror-1/2`（按设计不审）、`rear-3`（实际 mode=first_person，不审）

### 仍然存在的限制（未改）

1. 真实图片依赖本机实验目录，**不入仓库**（私人角色素材）；干净环境跑 `check-capture-check-real` 会 SKIPPED —— 这是设计，不是通过。
2. “极小手机边缘”仍是判定边界（历史记录见第五节）。
3. 未接入生图流程；接线时的重拍策略建议见交接（violation→重拍 1 次；pass→发送；uncertain→放行不重拍；重拍后必须更新缓存并记录）。