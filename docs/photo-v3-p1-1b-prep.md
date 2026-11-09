# P1-1b 准备（设计稿，未改代码）

> 状态：**只出设计**。本文件提交后不改 `reference-manager.js`、不改配置、不接正式入口、未授权不动 `photo-prompt.js`。

## 一、必须修正的两处语义（你指出的）

### 1. `canon.match` 是正则，不是服装描述 —— 不能拿它比 `outfitText`

**现状（有缺陷）**：`reference-manager.js` 的 `sameOutfit(outfitText, canon.match ?? canon.label)` 把 `match` 当描述用。
但 `canon.json` 里 `match: "女仆装短款"` 是**正则**，用来在 `canonFor()` 里挑选条目；它不代表"这套衣服长什么样"。
一旦 `outfitText` 是「浅灰吊带+米色短裤」，拿它跟正则串比，必然判"不同套"，逻辑上只是碰巧正确，遇到相近词就会误判。

**修正方案（待授权实施）**

```js
// canon 条目扩展（canon.json）
{ "match": "女仆装短款",            // 仅用于命中（canonFor 用），不参与比较
  "outfitText": "白色蕾丝头带，女仆装短款（藏青渐变连身裙、三层白蕾丝裙摆），白棉袜，玛丽珍鞋",
  "outfitId": "maid-short-v3",      // 稳定 ID（可选，优先于文本比较）
  "version": "A" }                  // 角色版本标识（见第三节）

// resolveReference 输入改为
{ outfitText, canon: { outfitId, outfitText, file, version }, faceRef, faceRefKind, mode }
```

比较规则：**优先 `outfitId` 相等**；无 ID 时用 `sameOutfit(outfitText, canon.outfitText)`；**永不使用 `match`**。
若 canon 条目缺 `outfitText`/`outfitId` → 视为"无法确认是否同套" → 按**冲突**处理（保守，不用 canon）。

反向用例（必须进测试）：`match='女仆装短款'` + 当天「浅灰吊带…」→ 必须判 `conflict`，且不得因为正则命中就使用 canon。

### 2. `first_person` 的 `none` ≠ 画面不能有人体局部

**现状风险**：`strategy:'none'` 可能被上层误读成"这张不能有手/手臂/腿"，与 POV 摄影逻辑冲突。

**修正方案**：输出增加一个独立字段，明确"仅指身份参考图"：

```js
{ strategy: 'none',
  identityRef: null,        // 不使用人物身份参考图（脸/体型都锁不了）
  humanPartsAllowed: true,  // 画面里仍可出现手/小臂/腿——由 camera/pose 决定，与本模块无关
  reason: 'mode_has_no_person' }
```

并在文档/注释里写死：**none 只约束"参考图"，不约束画面内容**。

## 二、`faceRefKind: 'head'` 的处理逻辑（确认）

| 输入 | 行为 |
|---|---|
| `faceRefKind === 'head'` | 可用作脸参考（只在"需要看得见脸"的模式下） |
| `faceRefKind === 'costume'`（当前这张就是） | **拒用** → fallback，避免女仆装/棕胸/棕瞳污染 |
| `'unknown'` | 同样拒用（保守） |

判定方式：**由配置显式声明**，不做图像识别（避免再次误判）。同一张图不得既当 faceRef 又当 bodyRef。

## 三、A / B 版本成为明确标识，禁止跨版本混用

- 新增 `characterVersion: 'A' | 'B'`，**默认 A**。
- `canon` 条目带 `version`；`resolveReference()` 校验 `canon.version === 当前版本`，不相等 → 视为冲突、不用。
- body 参考图同理：A 用 `version-a-original-body/body-3view.png`，B 用 `version-b-new-design/body-3view.png`。
- **B 版不得进入默认链路**：默认调用不传 `characterVersion` 时按 A 处理；B 只能由显式参数进入（如未来做"新版形象"试拍）。

## 四、接线顺序（全部待授权）

1. `canon.json` 增加 `outfitText`/`outfitId`/`version`（配置，非代码）
2. 修 `reference-manager.js`：改用 `outfitId/outfitText` 比较；加 `identityRef` / `humanPartsAllowed` / `version` 校验
3. 单元测试补：正则不得参与比较、版本不匹配即冲突、first_person 的 none 不限制人体局部
4. 配 `qq.image.faceRef = .../version-a-original-body/face-front.png`，`faceRefKind: 'head'`，`characterVersion: 'A'`
5. 接 `resolveReference()` 进 `photo-prompt.js` 参考图分支（**需单独授权**）
6. 实拍 2~3 张验证：日程「浅灰吊带」时不再出女仆装

## 五、当前未做（遵守边界）

- `reference-manager.js` 未改
- `config.json` / `canon.json` 未改
- `photo-prompt.js` / `index.js` / `bridge.js` / 各 Planner 未改
- 未接入生图、未提交 main

## 六、实现与设计稿的差异（第 1~3 步已实施，2026-11-09）

| 设计稿 | 实际实现 | 原因 |
|---|---|---|
| `characterVersion` 默认 `A` | 默认**空串**；归一为 A，并置 `version.assumed=true` | 需要区分"显式 A"与"未声明"，否则无法证明确实没走 B |
| 未提诊断字段 | 增加 `checks:[{name, ok, detail}]` | 便于接入后追查"为什么没用 canon" |
| `sameOutfitText` 未定阈值 | 共享主体词 ≥3；或 =2 且双方各 ≥3 个主体词 | 防止"白色/蕾丝"这类通用词被判同套 |
| 只说"检查身体参考图版本" | 入参 `bodyRef` / `bodyRefVersion`，不匹配记 `body_version_mismatch` | 让调用方显式传版本，不猜 |
| `canon.json` 补 `outfitText` | 取 `SIGNATURE_OUTFITS` 里「女仆装短款」原文（该套本身含尾巴挂件描述，按 P0 规则保留） | 保证 outfitText 与衣柜同源 |

### 实施范围确认

- 已改：`src/photo/reference-manager.js`、`tests/check-reference-manager.mjs`、`canon.json`（运行时配置，**不在仓库**，已备份 `canon.json.bak-before-p1b`）
- 未改：`photo-prompt.js` / `bridge.js` / `index.js` / `config.json` / 任何 Planner / `main`
- 未接入生图。