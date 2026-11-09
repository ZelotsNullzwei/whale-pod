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
