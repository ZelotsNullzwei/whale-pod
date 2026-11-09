# P1-1b 第 5 步：最小接入方案（先审方案，未动代码）

> 状态：**只出方案，代码未改**。等你确认后我才动手。

## 一、必须先纠正一个前提：接入点不是 `photo-prompt.js`

对照源码，参考图是在 **`src/photo/index.js` 的 `planShot()` 里决定的**：

```js
// src/photo/index.js
167  const baseRef = pickRefImage(plan, framing, imageCfg, anime)
168  const canon = sceneOnly ? null : canonFor(String(outfit ?? ''))
169  const refImage = canon ? canon.file : baseRef      // ← 就是这里决定"用哪张图"
...
179  canonRef: Boolean(canon),
181  character: { faceRef: imageCfg.refImage, bodyRef: imageCfg.bodyRefImage },
197  refImage,                                          // ← 返回给 bridge 的 generateImage
```

`photo-prompt.js` 只消费 `refImage`（通过 `hasRef` / `canonRef` 布尔）与 `character`（仅用于措辞），**它不做选图决策**。
所以最小接入必须改 `index.js` —— 这与你原定"接 photo-prompt.js"不同，需要你确认是否授权改 `index.js`。

## 二、最小改动（3 处 + 1 个 import，约 +8 / −4 行）

```diff
+ import { resolveReference } from './reference-manager.js'

  const baseRef = pickRefImage(plan, framing, imageCfg, anime)
  const canon = sceneOnly ? null : canonFor(String(outfit ?? ''))
- const refImage = canon ? canon.file : baseRef
+ /* 最小接入：只有配置了 faceRef 才走 resolver；否则保持旧逻辑（anime 档一律走旧逻辑） */
+ const refDecision = (!anime && imageCfg.faceRef)
+   ? resolveReference({
+       outfitText: String(outfit ?? ''),
+       outfitId: String(imageCfg.outfitId ?? ''),
+       canon: canon ? { file: canon.file, outfitId: imageCfg.canonOutfitId ?? '', outfitText: imageCfg.canonOutfitText ?? '', version: imageCfg.characterVersion ?? '' } : null,
+       faceRef: String(imageCfg.faceRef),
+       faceRefKind: String(imageCfg.faceRefKind ?? 'unknown'),
+       mode: plan.mode,
+       characterVersion: imageCfg.characterVersion ?? '',
+       bodyRef: String(imageCfg.bodyRef ?? ''),
+       bodyRefVersion: imageCfg.bodyRefVersion ?? '',
+     })
+   : null
+ const refImage = refDecision ? (refDecision.refImage || '') : (canon ? canon.file : baseRef)

- canonRef: Boolean(canon),
+ canonRef: refDecision ? refDecision.strategy === 'canon' : Boolean(canon),
...
- character: { faceRef: imageCfg.refImage, bodyRef: imageCfg.bodyRefImage },
+ character: {
+   faceRef: refDecision ? (refDecision.strategy === 'face' ? refDecision.identityRef ?? '' : '') : imageCfg.refImage,
+   bodyRef: imageCfg.bodyRefImage,
+ },
```

### 预计 diff 范围

| 文件 | 行数 | 说明 |
|---|---|---|
| `src/photo/index.js` | **约 +8 / −4**（净 +4） | 1 个 import + 选图分支 + canonRef/character 对齐 |
| `photo-prompt.js` | **0** | 不改（它只消费 refImage/布尔） |
| `bridge.js` / `index.js 其他部分` / Planner / `reference-manager.js` / `canon.json` | 0 | 不动 |

## 三、行为矩阵（接上之后）

| 场景 | 现在（旧） | 接上之后（预期） |
|---|---|---|
| 日程「浅灰吊带」+ canon 是女仆装 | 用 canon 女仆定妆照 → 出女仆装 | canon 冲突 → **用 A 版 face-front.png（只锁脸）** → 衣服回到日程 |
| 日程正好是女仆装短款 | canon | canon（不变） |
| `first_person` / 场景图 / 后置拍物 | 会给 refImage（POV 会被拉成第三人称） | `strategy:'none'` → **refImage 为空**（POV 成立） |
| 未配置 `faceRef`（回滚后） | 旧逻辑 | **完全不变**（有开关保护） |
| anime 插画档 | 旧逻辑 | **完全不变**（被 `!anime` 短路） |

## 四、为什么这是"最小"

1. **有开关**：仅当 `qq.image.faceRef` 存在才启用，删掉即回滚到旧行为。
2. **不改提示词结构**：只让 `canonRef` 与 `character.faceRef` 跟实际选的图对齐，避免文案与图不一致。
3. **不动 Planner / bridge / canon.json**。
4. anime 档、sceneOnly、canon 命中的路径都有明确保留。

## 五、已知风险 / 需要你知道

1. **`outfitId` 目前没有**：衣柜 47 套都没有稳定 ID，`imageCfg.outfitId` 也为空 → 会走 `outfitText` 比较 → 只有"完全一致/高度相似"才认 canon；日常服装大多会判"不同套"→ 一律用 face ref（这符合我们要的效果：衣服听日程）。
2. **canon 侧 `outfitText`**：`canonFor()` 现在只返回 `{file,note,match}`，**不返回 outfitText/outfitId/version**。方案里用 `imageCfg.canonOutfitText` 占位是错的方向 —— 正确做法是让 `canon.js` 的 `canonFor()` 多返回这几个字段（**这就要改 canon.js，超出当前授权**）。
   → 两个选择：
   - **5A（严格最小）**：本次不改 canon.js，canon 一律按"冲突"处理（即只要不是完全无法判断的近似，就走 face ref）。风险：女仆装那套也会被判冲突 → 用脸图而不用定妆照，可能损失"款式一致性"。
   - **5B（需扩权）**：给 `canonFor()` 增加返回 `outfitText/outfitId/version`（`canon.js` +3 行），这样 canon 匹配才准确。
   **我建议 5B**，否则 canon 机制等于废掉。
3. **prompt 文案**：`canonRef=false` 时会走"照参考图"的另一支措辞，需实拍确认文案与新图不冲突（第 6 步验证）。

## 六、等你确认的三件事

1. **授权修改 `src/photo/index.js`**（实际接入点，非 `photo-prompt.js`）？
2. 选 **5A**（不改 canon.js，canon 保守判冲突）还是 **5B**（`canon.js` +3 行返回 outfitText/outfitId/version）？
3. 是否允许新增 `tests/check-reference-wiring.mjs`（最小 smoke：日程吊带时 `planShot().refImage` 应指向 face-front，POV 应为空）？

## 七、预计总改动（若 5B + 测试）

| 文件 | 预计 |
|---|---|
| `src/photo/index.js` | +8 / −4 |
| `src/photo/canon.js` | +3（返回字段透传） |
| `tests/check-reference-wiring.mjs` | 新增 ~60 行 |
| 其他 | 0 |

**仍不接真实生图验证（第 6 步单独授权）。**

## 八、实施结果（已按 5B 接入，2026-11-09）

### 与方案的三处修正（评审要求）

| 问题 | 实施 |
|---|---|
| canon 元数据不能来自全局 config | `canon.js` 的 `loadEntries()` **保留** `outfitText/outfitId/version`，`canonFor()` 透传；`index.js` 用**命中条目**的元数据。当前日程服装无稳定 ID → 传空 `outfitId`，走完整文本比较 |
| sceneOnly 不能只看 `plan.mode` | 显式语义映射：`sceneOnly || plan.needsCharacterRef === false → 'scene_only'`；`plan.mode === 'rear_selfie' → 'rear_object'`；其余透传。实测 sceneOnly 的 plan.mode 是 `rear_selfie` |
| bodyRef 字段与版本 | 用真实字段 `imageCfg.bodyRefImage`；版本**运行时 sha256 核验**（A 版 body = `f75c7d779c173f73`），匹配才记 A，否则 `UNKNOWN` → `body_version_invalid` 冲突，绝不静默当 A |

### 一致性保证

- `planShot().refImage` = `refDecision.refImage`（ resolver 启用时）；**fallback 不回退旧 refImage**
- `canonRef` = `refDecision.strategy === 'canon'`
- `character.faceRef` = 仅当 `strategy === 'face'` 时为 `identityRef`，否则空
- 未配置 `faceRef` 或 `anime` → `refDecision = null`，完整走旧逻辑
- 新增返回字段 `refDecision`（仅供测试/排查，不改变生成）

### 测试

`tests/check-reference-wiring.mjs` — **15 / 0**，覆盖：日程吊带+女仆 canon、canon 命中但不同套、同套+版本一致、canon 版本 B、元数据缺失、outfitId 不同、sceneOnly、first_person、rear_object、未配 faceRef、anime、fallback 不回退旧图、canonRef/prompt 一致、bodyRef 指向 B 版被拒。

### 已知未解决

1. 日程服装无稳定 `outfitId` → 只能靠文本 Dice；同款不同色仍可能判"不同套"（保守，偏安全）。
2. `BODY_REF_VERSION` 由代码内哈希常量识别 A 版；若将来新增 C 版身体素材，需要更新该常量或改为配置声明。
3. 本步未做真实生图验证（第 6 步单独授权）。