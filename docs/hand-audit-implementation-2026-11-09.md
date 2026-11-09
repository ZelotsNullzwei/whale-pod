# 手部专项整改实施报告（2026-11-09）

基线 `cd25078` → 本次提交（分支 `review/photo-v3-character-audit`，未合并 main）。

## 一、实现内容

| 模块 | 改动 |
|---|---|
| `src/photo/handContract.js`（新增） | 6 个模式的唯一手部契约：`maxVisibleHands / holderHand / baselineHands`；`handRuleLine()` 生成权威 Prompt 行 |
| `src/photo/photo-prompt.js` | 末尾注入**唯一一条**【手部契约】；删除 POV 旧"最多两只手"表述 |
| `src/qq/captureCheck.js` | 新增 `reviewHands`（手数/左右同侧/解剖 + 边缘第二手复核）与 `combineCaptureResults`；`mk()` 支持 severity/hands/arms |
| `src/qq/photoCapturePipeline.js` | 在 Codex 未提交门禁基础上细化：`shouldBlockSend` 只拦 **fatal 手部/结构违规** 与 **审核不可用**；按最终图（重拍优先）判定；`requireReview` 才生效 |
| `src/qq/bridge.js` | 合成 reviewer（模式审核 + 手部审核）、传入 `requireReview`、**缓存与发送前门禁**：`qcSel.block → 不写缓存、不构造发送图**（并记录 drawSkipReason） |

保留不变：缩图统一入口、两审核器共用缩图、缩图失败判据、最多一次重拍、复用 `shot`、缓存只写最终图、`retry.skipped` 日志。

## 二、离线测试（新增 39 项，全绿）

- `check-hand-contract` 14/0：6 模式契约矩阵 + 真实 `planShot` Prompt 恰好 1 条手部契约 + POV 无旧表述
- `check-capture-hands` 13/0：pass/extra_hands/limb_count/hand_mismatch/hand_anatomy/uncertain/空图/异常 + 合并优先级
- `check-hand-gate` 12/0：fatal→重拍修好则不阻断；复审仍 fatal→阻断且**缓存/发送均不发生**；审核服务异常→fail closed；legacy 失败不再当严重；`requireReview=false` 不拦

原有回归全绿：capture-check 18/0、pipeline-wiring 15/0、orchestration 25/0、draw-pipeline 32/0、append 13/0、reference-wiring 16/0、close-persona 20/0、shadow 24/0、pipeline-v3 11/0、character-profile 12/0(+2 skip)。

## 三、真实出图验证（第 11b 轮，3 场景）

| 场景 | mode | 初审 | 复审 | 门禁 | 视觉复核 |
|---|---|---|---|---|---|
| 第一人称看漫画 | first_person | pass（hands=1） | 未重拍 | 放行 | ✅ 只有一只手翻页 |
| 把漫画拍给你看 | rear_selfie | body_subject（非 fatal）+ hands pass | body_subject（非 fatal） | 放行（用重拍图） | 手部正常；仍有少量身体边缘 |
| 对镜全身自拍 | mirror_selfie | extra_hands（2 手） | extra_hands（2 手） | **阻断：未写缓存、未发送** | 2 只手（持机+下垂），按当前契约超限 |

产物：`_scratch/photo-v3/step11b/<场景>/{prompt.txt,1-original.jpg,2-retry.jpg?,final.jpg,audit.json,run.log}`；对比图 `contact-sheet.png`；汇总 `summary.json`。

## 四、门禁行为实测

- fatal 手部违规 → 重拍 1 次；重拍修好 → 放行（POV 场景：初审 extra_hands→复审 pass，最终只有 1 只手）。
- 重拍仍 fatal → **不写缓存、不发送**（mirror 场景）。
- `body_subject`、`phone_visible` 维持既有"重拍后放行"，不阻断（rear 场景）。

## 五、遗留问题（需确认）

1. **mirror 契约是否过严**：当前 `maxVisibleHands=1`，所以"持机手+自然下垂的另一只手"会被判 fatal 并阻断。产品上是否允许 mirror 出现 2 只手（持机+自然手），需要你拍板。
2. **手部审核准确率仍有波动**：曾出现"图上 2 只手、模型数 1 只"的漏数（已加边缘第二手复核缓解）；复杂构图仍可能 uncertain。
3. **rear_selfie 的 body_subject 不阻断**：仍可能发出"少量身体边缘"的图（按既有策略）。
4. **QQ 实际发送**依旧未验证（无 onebot 会话），只验证了"不发送"分支在门禁下的行为。
