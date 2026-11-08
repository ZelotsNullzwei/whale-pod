# 角色一致性专项审查（静态代码 + 已有实拍样本复核）

> 本轮**只审查，不改代码**。所有结论都标了代码位置；无法验证的明确写"无法验证"，不当成通过。
> 依据：`src/photo/character-profile.js`、`src/photo/photo-prompt.js`、`src/memory/wardrobe.js`、`src/memory/dayPlan.js`、`src/qq/bridge.js`、`src/photo/canon.js`，以及 `docs/photo-v3-shadow-images/` 下的 12 张实拍产物。

## A. 角色设定

### A1 真实数据来源
- 唯一真源：`src/photo/character-profile.js` 的 `PROFILE`（face/hair/accessories/body/hands/feet）。
- 注释写明：**有参考图时 PROFILE 不直接进提示词**，只用 `fallbackText()` 兜底（拿不到参考图时）。
- 参考图：`src/photo/canon.js` 的 `canonFor(outfit)` —— 按衣柜原文匹配"那套衣服的定妆照"。

### A2 发现的问题（按严重度）

| # | 问题 | 位置 | 证据 |
|---|---|---|---|
| **C1** | **眼睛颜色与要求不符**：PROFILE 写「**棕色**瞳孔」，而要求是**蓝色眼睛**。这直接导致"只有蓝头发的普通女生" | `character-profile.js:19` | `eyes: '棕色瞳孔，眼型略圆…'` |
| **C2** | **尾巴被写成固定角色特征**（且描述极重）：`PROFILE.accessories.tail` 有 100+ 字，包含"从腰后正中偏下伸出、末端两片叶状尾鳍、不是两条"等强约束 | `character-profile.js:38-42` | 虽然注释写"可有可无"，但字段本身是固定特征，`fallbackText` 也会带出 |
| **C3** | 人格层还在强化尾巴：`store.js` 写「一条鲸鱼尾巴（尾鳍）」「尾巴、耳鳍是她的招牌」 | `persona/store.js:96,1157`（运行时来自人格文件） | 与"没有身体尾巴"直接冲突 |
| C4 | 发色渐变、呆毛、耳侧鳍饰品在 PROFILE 里有，但**只有没参考图时**才进提示词；有参考图时依赖参考图本身是否正确 | `character-profile.js` 注释 + `photo-prompt` 反射图分支 | 属于设计选择，需实拍验证 |

### A3 结论
- **身份不稳的主要来源不是提示词缺字段，而是 C1（瞳色写错）+ 参考图策略**。
- 参考图策略上一轮已证实：给脸参考图 → 人物被画进 POV 画面；不给 → POV 成立但身份靠 PROFILE 兜底文字，容易"只是蓝头发"。

## B. 衣柜与每日计划

### B1 调用链（实际代码）
```
character-profile.js (PROFILE)          ← 固定外观
        ↓
memory/wardrobe.js
  HOME_OUTFITS / OUTING_OUTFITS / SLEEPWEAR / SIGNATURE_OUTFITS   （共 47 套，其中 6 套含尾巴）
  outfitForDay() / outingOutfitForDay() / sleepwearForDay() / signatureOutfitForDay()
  effectivePools()  ← 支持运行时覆盖（<home>/wardrobe.json）
        ↓
memory/dayPlan.js  setToday() 选出 plan.outfit / plan.sleepwear / plan.outfitChange
                   renderDayPlan() 输出「今天穿的：…」
        ↓
qq/bridge.js  outfitText 优先级：
  ① 她说了（extractSaidOutfit → matchOutfit 映射回衣柜）
  ② 临时换的 wearingFor()
  ③ 标志性那套（wearsSignature）
  ④ 外出服 outingOutfitForDay()
  ⑤ 日程 plan.outfit
        ↓
photo-prompt.js  「今天穿着：<outfitText>（服装完全按这句…）」+ 参考图（canon / faceRef / 无）
        ↓
生图请求
```

### B2 结论（逐条回答）
1. **每日计划是否真的决定当天穿什么？** 是。`dayPlan.setToday()` 写 `plan.outfit`，bridge 第 ⑤ 优先级读它。
2. **衣柜系统是否真正参与服装选择？** 是。`outfitForDay/outingOutfitForDay/sleepwearForDay/signature…` 都从衣柜池取。
3. **服装是否被固定角色 Prompt 覆盖？** **部分会**：`SIGNATURE_OUTFITS`（女仆装等）通过"标志性那套"分支优先于日程，且 `photo-prompt` 会额外注入"服装完全按这句"——若外面还有 canon 参考图，参考图的服装会再压一次。
4. **最终 Prompt 是否含互相冲突的服装描述？** **会**：`今天穿着：X` 与参考图（canon 定妆照=另一套）同时存在；`【人物】` 兜底文字（无参考图时）不含服装，问题较小。
5. **计划选了服装但生图层没读？** 未发现漏读；但**优先级里"她说的/标志性"会盖掉日程**，这是设计如此，需确认是否符合预期。
6. **衣柜读取成功但序列化错误？** 未发现。`outfitText` 做 `String(v).replace(/\s+/g,' ').slice(0,120)`，会**截断长描述**（衣柜单套 >120 字时尾部会被切掉，如鞋袜）。

### B3 场景样例（可验证部分）
| 场景 | 日程数据 | 衣柜候选 | 最终 outfit | 冲突 |
|---|---|---|---|---|
| 在家休息 | `day-plan.json` 2026-11-08 `plan.outfit=浅灰吊带+米色短裤` | HOME_OUTFITS | 同上 | 无 |
| 外出 | `plan.outing` 存在且当前时段=outingSlot → OUTING_OUTFITS | 6 套含尾巴的在水手服/女仆系 | 外出服 | 与 canon/脸参考图可能冲突 |
| 睡前 | `slot=night` 或 23 点后 → SLEEPWEAR | SLEEPWEAR | 睡裙 | 无 |
| 特殊活动（标志性） | 她说"穿那套/女仆装" → SIGNATURE | 女仆装（含尾巴） | 标志性套 | **尾巴随之出现** |

**无法验证**：本轮 12 张实验图只保存了 `params.json`（含 refImageRule），**没有保存当次传入的生图请求原文**，所以"那张图实际穿的到底是不是日程那套"只能看 Prompt 文件，无法从生图请求层面确证。

## C. 尾巴（本轮重点）

### C1 出现位置（按影响排序）
| 文件 | 内容 | 影响 |
|---|---|---|
| `character-profile.js:38-42` | `accessories.tail` 100+ 字强描述 | **固定特征级**，会被当角色设定 |
| `photo-prompt.js:480-488` | `if (/尾巴/.test(outfit))` 才注入，但注入的是"只有一条/只能一个根部/不许第二个尾巴"共 5 行强约束 | 只要衣柜那套带尾巴，就**大幅强化**注意力 |
| `wardrobe.js` 6 套（女仆长/短、水手服+鲸尾等） | 描述内含「腰后挂着一条深蓝色鲸鱼尾巴」 | 服装数据本身带尾巴 |
| `canon.js:5-9` | 说明用定妆照锁"款式+体型+尾巴数量" | 参考图带尾巴 |
| 人格 `store.js:96,1157` | 「一条鲸鱼尾巴」「尾巴是招牌」 | 人格层反复强调 |

### C2 结论
- 尾巴**确实仍被当固定角色特征**（PROFILE + 人格两层），而"挂件"的处理方式（只在 outfit 命中时注入严禁令）**适得其反**：命中时反而把"尾巴"这个词在提示词里重复 5 次以上，模型注意力被强化。
- 实测证据：`docs/photo-v3-shadow-images/3-第一人称端杯/legacy.jpg` 是第三人称自拍，画面下方**挂着鲸鱼尾巴挂件**；而 `v3.jpg`（POV）没有。说明尾巴出现与否取决于该次 outfit/参考图，不是"角色必有"。

### C3 建议方向（未实施）
1. 把 `PROFILE.accessories.tail` **从固定设定移除**，只保留在衣柜那几套的衣服描述里（谁的套装带就谁带）。
2. `photo-prompt.js` 的尾巴块**不要写"只有一条/不许第二个"这种负向强调**；改为正向、最小描述，或干脆交给 outfit 原文。
3. 人格层 `store.js` 的「尾巴是招牌」与新设定冲突，应改为"没有身体尾巴，挂件按服装"。

## D. 图片验证（基于已有 12 张）

| 场景 | 角色一致性观察 | 服装是否符合日程 | 尾巴 |
|---|---|---|---|
| 3 第一人称端杯 | legacy：第三人称怼脸，脸像她；v3：POV 无脸，无法判断身份 | 两侧都是女仆装（**不是日程的浅灰吊带**）| legacy 有尾巴挂件；v3 无 |
| 1/2/4/5/6 | **本轮我只逐张看过第 3 组**，其余 5 组文件已生成但未人工判定 → 标记为 **未验证** | 未验证 | 未验证 |

**明确不能判定为通过的项目**：
- 六张是否同一角色（只看了 1 组）；
- 服装是否全部符合当日计划（第 3 组已发现不符合：女仆装 vs 日程吊带）；
- 尾巴在其余 5 组的出现情况。
- 根因（第 3 组已确认）：`SIGNATURE`/canon 参考图路径覆盖了日程服装。

## E. 修复建议（P0/P1/P2）

### P0-1 眼睛颜色改为蓝色
- 文件：`src/photo/character-profile.js:19`
- 改动：`eyes: '蓝色瞳孔（清澈的蓝，不是灰蓝/绿蓝），眼型略圆，双眼皮不明显'`
- 原因：当前写"棕色瞳孔"，与设定冲突，是"不像鲸鱼娘"的直接原因。
- 预期：人物辨识度回到蓝发+蓝眼+鳍饰的一致组合。
- 回归：`check-photo-v3-append`、`check-draw-pipeline`；实拍 1 张前置自拍比对。
- 影响：仅兜底文字与 PROFILE 读取方；不改生图入口。

### P0-2 尾巴从固定特征降级为"服装数据"
- 文件：`character-profile.js`（移除 `accessories.tail`）、`persona/store.js`（改"没有身体尾巴，挂件看服装"）
- 预期：任何不含尾巴的 outfit 都不会出现尾巴；人格不再强调"招牌"。
- 回归：静态 `grep -c 尾巴`，实拍 2 张（日程家居服 / 女仆套）对比。
- 影响：不触及生图入口。

### P1-1 服装优先级：日程应高于 canon 参考图
- 文件：`src/photo/photo-prompt.js`（参考图分支）/ 或 canon 选择处
- 改动：当日程 outfit 与 canon 定妆照不同时装，**不传 canon 全身图**，改用脸参考图。
- 预期：衣服来自衣柜/日程，而不是定妆照。
- 回归：实拍 3 张（家居/外出/睡前）确认衣服与 `day-plan.json` 一致。

### P1-2 `outfitText` 截断 120 字
- 文件：`src/qq/bridge.js`（outfitText 各 return 的 `.slice(0,120)`）
- 改动：放宽到 200 或按字段拼接（衣服/袜/鞋分开），避免丢鞋袜描述。

### P1-3 尾巴提示词块降噪
- 文件：`photo-prompt.js:480-488`
- 改动：删除"只许一条/不许第二个"这类负向强调，改为一行正向描述或直接省略。

### P2-1 实验产物补全
- 在 `shadow-image-test.js` 里把**完整生图请求体**（含参考图路径、最终 prompt）落盘，便于以后核对"衣服是否来自日程"。

## E2. 本轮工作原则（用户明确要求）

> 角色身份稳定，**同时允许服装、表情、动作和场景自然变化**。
> **摄影规划系统只负责拍摄行为，不越权决定角色身份和当天穿着。**
> **先审查，先给证据，再提出最小修改方案。未经确认不要修改正式链路。**

本轮据此执行：只产出本文档（静态审查 + 已有实拍证据），
**未改动** `character-profile.js` / `photo-prompt.js` / `bridge.js` / `index.js` 任何一行；
P0/P1/P2 均待确认后再动，且优先选最小改动面。

## F. 本轮未做（按交接要求）
- 未扩展 Composition Planner、未改 Camera/Pose Planner；
- 未改 `index.js` / `bridge` / `photo-prompt.js` 的正式路径；
- 未接入正式生图；未覆盖任何旧实验数据。
