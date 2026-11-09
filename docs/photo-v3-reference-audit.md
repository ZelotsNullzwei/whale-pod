# P1-1 参考图策略：证据与独立设计（未接入正式入口）

> 本文件只交付**证据 + 独立模块 + 测试**。`photo-prompt.js` / `index.js` / `bridge.js` / `canon.js` / 各 Planner **一律未改**。

## 一、根因证据（比"日程没生效"更底层）

| 证据 | 内容 |
|---|---|
| 配置 | `config.json` 里 `qq.image.refImage` 与 `faceRefImage` **都指向** `_scratch/head-video-ahoge.png` |
| 图片实际内容 | 这张"脸参考图"是 **女仆装半身照**：白色蕾丝女仆裙 + 藏青蝴蝶结 + 露肩 + 露事业线，**瞳色是棕色** |
| 后果 | 每一次带参考图的生图，都会同时带入：①女仆装 ②偏丰满的身材 ③棕色瞳孔 —— 与"当天日程的浅灰吊带"和 P0 新设的"蓝色瞳孔"全部冲突 |
| 日程对照 | `day-plan.json` 2026-11-08 `outfit = 浅灰吊带背心 + 米色家居短裤`；而 `canon.json` 只有一条 `女仆装短款`，与日程**不匹配** |
| 复现 | 实拍 `results/3-第一人称端杯/legacy.jpg`：日程是吊带短裤，出图却是女仆装 —— 与上述链路一致 |

**结论：P1-1 不是"canon 覆盖日程"这么简单，而是"脸参考图本身自带服装/瞳色"。**
只把 PROFILE 改成蓝瞳（P0）不会改善出图，因为参考图会覆盖它。

## 二、独立模块：`src/photo/reference-manager.js`

只回答"这一次该用哪张参考图"，不判断该穿什么。

```js
resolveReference({ outfitText, canon, faceRef, faceRefKind, mode })
  → { strategy: 'canon'|'face'|'fallback'|'none', refImage, reason, conflict }
```

| 规则 | 行为 |
|---|---|
| 1 | `mode ∈ {first_person, rear_object, scene_only}` → **none**（画面里不该有人） |
| 2 | canon 存在且与当天服装**同一套** → **canon** |
| 3 | canon 存在但**不一致** → 禁止用 canon；若 `faceRefKind==='head'` 用 face，否则 fallback，并记 `conflict:true` |
| 4 | 无 canon → `faceRefKind==='head'` 用 face；`costume`/未知 → **fallback（不用参考图，走 PROFILE 文字）** |

`faceRefKind` 是本轮新增的关键输入：**参考图性质（只锁脸 / 带服装）**，因为当前这张是 `costume`。

## 三、测试

`tests/check-reference-manager.mjs` — **11 / 0**，覆盖：

- 同套/不同套判定（吊带短裤 vs 女仆装 → 不同套）
- 规则 1/2/3/4 各自断言（含 `conflict` 标记）
- **现实场景**：当前 `faceRefKind='costume'` 时必须返回 `fallback`、`refImage=null`（否则女仆装/棕瞳会串进来）
- 契约：字段齐全、无 undefined、**本模块不 import photo-prompt/index/bridge**（确保未接入）

## 四、建议的落地顺序（待你批准，均未执行）

| 步骤 | 动作 | 影响面 | 需要改的文件 |
|---|---|---|---|
| **P1-1a** | 制作一张**只锁脸**的参考图（头部裁切，不含衣服/胸），配置新增 `faceRefKind:'head'` | 仅配置与素材 | `config.json` + 一张新图 |
| **P1-1b** | 把 `resolveReference()` 接进 `photo-prompt.js` 的参考图分支 | 生图入口（需单独授权） | `photo-prompt.js` |
| **P1-1c** | 落盘"最终 prompt + 参考图策略记录"，供下一轮实拍对照取证 | 实验脚本 | `_scratch/` |

> 我建议先做 **P1-1a**：不碰代码，只换参考图，成本最低、收益最直接（服装和瞳色同时不再被污染）。

## 五、未验证 / 不做

- 未做真实生图对照（换参考图后需实拍才能说改善）。
- 未接入正式链路（`photo-prompt.js` 仍按旧逻辑选图）。
- 未改衣柜、日程、canon.json、Planner。
