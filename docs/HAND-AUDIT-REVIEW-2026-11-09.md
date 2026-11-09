# 手部专项整改 · 交接与复核包（2026-11-09）

> 给复核者：本文件是**可独立阅读**的交接说明。代码在 `review/photo-v3-character-audit`，证据在 `docs/hand-audit-evidence/`。
> 基线 `cd25078` → 本次提交 **`54fccc5`**（ahead 33 / behind 0，**未合并 main**）。

## 0. 一句话结论

按拍摄模式建立了**唯一手部契约**（手数/持机手），Prompt 与审核器共用；新增手部结构审核与**缓存/发送前 fatal 门禁**。离线 20 个套件全绿（含新增 39 项）；真实验证：第一人称重拍后只一只手；镜自拍在**新上限 2** 下判定 pass 并放行（旧上限 1 时曾被阻断）。**仍存的限制见 §6。**

## 1. 改动清单（`git show --stat 54fccc5`）

| 文件 | 类型 | 作用 |
|---|---|---|
| `src/photo/handContract.js` | 新增 | 6 模式契约 `maxVisibleHands/holderHand/baselineHands`；`handRuleLine()` 唯一 Prompt 行 |
| `src/photo/photo-prompt.js` | 改 | 末尾注入唯一【手部契约】；删除 POV 旧"最多两只手" |
| `src/qq/captureCheck.js` | 改 | 新增 `reviewHands`（手数/左右同侧/解剖/边缘第二手复核）、`combineCaptureResults`；`mk()` 支持 severity/hands/arms |
| `src/qq/photoCapturePipeline.js` | 改 | 在 Codex 未提交 `shouldBlockSend/requireReview/block` 基础上细化：只拦 fatal 手部/结构 + 审核不可用；按**最终图（重拍优先）**判定；仅 `requireReview` 生效 |
| `src/qq/bridge.js` | 改 | 合成 reviewer；`requireReview`；**缓存与发送前门禁**：`block → 不写缓存、不构造发送图`（记录 `drawSkipReason`）|
| `tests/check-hand-contract.mjs` | 新增 | 14 项：契约矩阵 + 真实 planShot Prompt 恰 1 条契约 + POV 无旧表述 |
| `tests/check-capture-hands.mjs` | 新增 | 13 项：pass/extra_hands/limb_count/hand_mismatch/hand_anatomy/uncertain/异常/合并优先级 |
| `tests/check-hand-gate.mjs` | 新增 | 12 项：fatal→重拍可修复不阻断；复审仍 fatal→**缓存/发送不发生**；服务异常 fail-closed；legacy 不再当严重 |
| `docs/hand-audit-evidence/` | 新增 | summary.json + 3 场景 audit.json/prompt.txt + contact-sheet.png |

**保留未动**：缩图统一入口、两审核器共用缩图、缩图失败判据、最多一次重拍、复用 `shot`、缓存只写最终图、`retry.skipped` 日志、空间配图路径。

## 2. 契约（唯一真源）

| mode | maxVisibleHands | holderHand |
|---|---|---|
| first_person | 1 | none（默认不出手）|
| rear_object | 1 | hidden |
| rear_selfie | 1 | hidden |
| front_selfie | 1 | hidden（手机/持机手画外）|
| mirror_selfie | **2** | visible（持机手 + 一只自然手；第三只手仍违规）|
| back_view | 0 | hidden |

未登记模式 → `handContractFor()=null`，**不门禁**（保持旧行为）。

## 3. 门禁语义（`shouldBlockSend`）

- **阻断**：`extra_hands / limb_count / hand_mismatch / hand_anatomy`（severity=fatal），按**最终图**判定（重拍修好则不阻断）；
- **阻断**：审核不可用（`requireReview` 且无 reviewer，或视觉服务异常/超时导致 uncertain）；
- **不阻断**：`phone_visible` / `body_subject`（沿用既有"重拍后放行"）；旧审核失败**不再**视为严重；
- `requireReview=false`（`cfg.actions.handGate===false`）→ 整条门禁不生效。

## 4. 离线测试（全绿）

```
check-hand-contract 14/0   check-capture-hands 13/0   check-hand-gate 12/0
check-capture-check 18/0   pipeline-wiring 15/0       orchestration 25/0
draw-pipeline 32/0         photo-v3-append 13/0       reference-wiring 16/0
close-persona 20/0         shadow 24/0                pipeline-v3 11/0
character-profile 12/0(+2 skip)
```

## 5. 真实出图验证（3 场景，真实网关）

| 场景 | mode | 初审 → 复审 | 门禁 | 视觉结论 |
|---|---|---|---|---|
| 第一人称看漫画 | first_person | extra_hands(2) → **pass(1)** | 放行（用重拍）| ✅ 只有一只手翻页 |
| 把漫画拍给你看 | rear_selfie | body_subject(非fatal) → 同 | 放行 | 手部正常，仍有少量身体边缘 |
| 对镜全身自拍（旧上限 1） | mirror_selfie | extra_hands(2) → extra_hands(2) | block：未缓存、未发送 | 持机+下垂=2 只 → 旧规则超限 |
| 对镜全身自拍（新上限 2，18:50 重跑） | mirror_selfie | **pass（2 手，结构正常）** | **放行：已缓存、可发送** | ✅ 持机手+自然下垂手，构图正常 |

证据：
- `docs/hand-audit-evidence/summary.json`
- `docs/hand-audit-evidence/<场景>/audit.json`（含 details、hands/arms、severity、block/reason、cached/sent）
- `docs/hand-audit-evidence/<场景>/prompt.txt`（实际最终 Prompt，含唯一【手部契约】行）
- `docs/hand-audit-evidence/contact-sheet.png`（6 张对比：原图/最终图）
- 本地原始样图：`_scratch/photo-v3/step11b/<场景>/{1-original,2-retry,final}.jpg`（**不在仓库**）

## 6. 已知限制 / 请复核者重点看

1. **mirror 契约已按自然姿势修正并复核**：允许持机手 + 一只自然手（最多 2 只）；超过两只、左右错配或解剖异常仍拦截。**18:50 已重跑镜自拍：pass、放行、已缓存**，证据见 `docs/hand-audit-evidence/mirror-rerun/`。
2. **手部审核仍有漏数**：实测出现过"图上 2 只手、模型数 1 只"。已加**边缘第二手复核**（`SECOND_HAND_SYSTEM`），但不保证 100%。
3. **rear 的 `body_subject` 不阻断**：仍可能发出少量身体边缘的图（沿用旧策略）。
4. **QQ 实际发送未验证**（无 onebot 会话）：仅验证"门禁不发送"分支与"缓存不写入"。
5. **单次样本**：3 场景各 1 次运行，无固定种子。

## 7. 复现方式

```bash
# 离线
node tests/check-hand-contract.mjs
node tests/check-capture-hands.mjs
node tests/check-hand-gate.mjs
# 真实（需本地网关 127.0.0.1:18899 与 config.json gateway.key）
node _scratch/photo-v3/step11b-hands-e2e.mjs   # 脚本在 default-workspace/_scratch，非仓库
```

## 8. 明确的"未做"

- 未接入 Pose Planner（V3）作为更强真源；当前仍是静态契约 + 视觉审核。
- 未改 `photo-modes.js` 的 `rear_selfie` 文案（仅 Prompt 末尾契约覆盖）。
- 未合并 main、未跑 QQ 端到端发送。

## 镜自拍双手识别专项（2026-11-09 19:01 复核）

### 1) 诊断：为什么曾判 uncertain
- 旧审核明细（step11c）：`status=uncertain, hands=1, arms=2, why="只看到一只拿手机的手，结构正常"`。
- 用同一张图重跑 5 次（旧提示词）：**5/5 都数到 hands=2 / arms=2**，但 `same_side`、`anatomy_ok` 多为 `null` → 被判定为 `uncertain`。
- 结论：问题不在"解析"，而在**提示词口径**：① 没说清"左右半边分别数、部分可见也算"；② 没强制要求 `same_side / anatomy_ok` 给布尔；③ 没把"允许上限"告诉模型。

### 2) 修复（`src/qq/captureCheck.js`，仅提示词与结果透传）
- HANDS 提示词：分左右半边计数、部分可见也计入；明确 `same_side=true 表示两只同侧（异常）/false 表示左右各一（正常）`；`anatomy_ok` 正常→true；只有完全遮挡才给 null；每次调用追加"本图最多允许 N 只手"。
- `combineCaptureResults` 透传 `hands/arms`，便于审计日志留痕；裁决逻辑不变（仍 fatal 才阻断）。

### 3) 修复后同一张图复测
`5/5 pass，hands=2 arms=2，conf 0.95`（why 均能说明"一手持机、一手垂放，左右各一"）。

### 4) 新增自动化用例（`tests/check-capture-hands.mjs`，17/0）
- 对镜自拍 2 手 @max2 → pass；
- 3 手 @max2 → `extra_hands`（fatal）；
- 2 手同侧 → `hand_mismatch`；
- 2 手但左右无法判断（`same_side=null`）→ `uncertain`（不冒充通过）。

### 5) 三种姿势真实复测（`docs/hand-audit-evidence/mirror-hands/`）
| 场景 | 审核 | 手数 | 门禁 | 视觉 |
|---|---|---|---|---|
| a 基本对镜 | pass 0.95 | 2/2 | 放行、已缓存 | 一手持机、一手自然垂 |
| b 一手叉腰 | pass 0.95 | 2/2 | 放行、已缓存 | 一手持机、一手叉腰 |
| c 手机挡脸 | pass 0.95 | 2/2 | 放行、已缓存 | 一手持机、一手下垂 |

每张另做 3 次复跑：**9/9 pass，hands=2 arms=2，conf ≥0.95**；人工看均无第三只手。

### 6) 当前 `uncertain` 策略（明确）
- `uncertain` **不阻断**（按既有"审核失败放行"），但会写入 `photo-qc` 记录（含 why/confidence）。
- 对镜自然双手现在会稳定判 `pass`，不再以 `uncertain` 放行；只有"左右确实无法判断"之类才 uncertain。

### 7) 仍然存在
- 复杂遮挡/极端角度仍可能 uncertain 或漏数（需更多样本评估）。
- 本轮只改了 `captureCheck` 提示词与结果透传 + 测试；**代码改动尚未提交**（等确认）。
## P0-1：Pose Planner 手部职责接入生产（2026-11-09 19:20）

### 实现
- `src/photo/index.js`：`planShot()` 内**旁路调用** `buildShotPlan({scene,slot})` 取 `pose`（纯函数、失败降级不影响生成），并随结果返回 `posePlan`。
- `src/photo/handContract.js`：新增 `handDutyLine(contract, pose)` —— 输出「动作手 N 只 / 持机手（可见/不入画）/ 左右手职责」；动作需求 > 模式上限时附 **⚠️ 拆分动作** 提示，**不放宽上限**。
- `src/photo/photo-prompt.js`：在【手部契约】后追加【动作手部】行（来自 Pose Planner）。
- `src/qq/bridge.js`：记录 `photo-qc poseHands`（required/camera/left/right）；超上限打 warn；审核上限仍取模式契约。

### 测试（`check-hand-contract` 18/0，其余全绿）
- 第一人称：动作手 1 + 持机手 1 → 只写「动作手 1 只」，不写持机手；
- 对镜：写明「持机手 1 只（镜中可见）」；
- 动作需求 3 > 上限 1 → 带 ⚠️ 拆分提示；
- 真实 `planShot` 4 模式都返回 `posePlan.hands.requiredCount`（数字）。
回归：capture-hands 17/0、hand-gate 12/0、orchestration 25/0、pipeline-wiring 15/0、draw 32/0、capture-check 18/0。

### 真实出图（POV 端杯）
`pass｜hands=1 arms=1｜conf 0.95｜why=仅见一只左手握杯`；Prompt 同时含：
- `【手部契约】…最多 1 只手（画面中不出现持机手）…`
- `【动作手部】动作手 1 只。`
门禁放行、已缓存（证据：`docs/hand-audit-evidence/p01-pose/`）。

### 已知限制
- Pose 的动作识别基于正则（如「把漫画拍给你看」识别不到"翻书"，只报持机手）；`requiredCount` 已接入但动作语义覆盖有限。
- 上限仍由模式契约决定（Pose 只提供职责与告警），因此"双手动作"不会自动放宽。