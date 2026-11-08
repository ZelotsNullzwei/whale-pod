# 鲸鱼娘生活摄影系统 V3.0 — 设计契约

> 本文件是模块间唯一契约。任何模块不得自行发明摄影规则；只能读 `PhotoPlan` 并产出/消费它。

## 0. 人物设定归属（**项目为准**）

人物设定**只**由 `src/photo/character-profile.js`（PROFILE）与人格文件提供，
Intent / Camera / Framing / Composition 任何一层都**不得复制、不得改写**，只能引用。

- 年龄：**十八九岁**（项目设定；不接受任何外部"24 岁以上"之类的改写建议）
- 外观：深蓝长发（发梢渐变浅蓝）、蓝色眼睛、两侧鲸鱼鳍状装饰；尾巴是**挂件/装饰**，不是身体结构
- 生成要求：真实手机摄影质感、自然生活状态（不固定冷脸）

> 以后如需调整人物设定，只改 `character-profile.js` / 人格文件这一处，并单独评审。

## 1. 数据结构：PhotoPlan

```js
PhotoPlan = {
  version: '3.0',
  mode: 'face_closeup' | 'front_selfie' | 'half_selfie' | 'mirror_selfie'
      | 'first_person' | 'rear_object' | 'video_call' | 'scene_only' | 'back_view',

  intent: {                      // 场景理解（唯一由 planner 产出）
    raw: string,                 // 她原话
    purpose: 'share_self' | 'show_thing' | 'record_scene' | 'show_outfit' | 'video_call',
    explicit: boolean,           // 用户是否明确指定拍摄方式
    subtype: string | null,      // 仅 first_person: handheld|desk_work|two_hands|object_only|observe
  },

  camera: {                      // 机位（camera-planner 产出）
    holder: 'self' | 'mirror' | 'other_device',
    device: 'front_cam' | 'rear_cam' | 'mirror_reflection',
    lensAt: 'eye' | 'arm_length' | 'mirror',
    height: 'eye_level' | 'slightly_high' | 'top_down',
    tiltDeg: number,             // 向下为正
    distance: string,            // '30-60cm' | '一臂' | '镜前 1m'
    forbidden: string[],         // 例：['third_person_view']
  },

  framing: {                     // 构图（framing-planner 产出）
    band: 'face' | 'head_shoulder' | 'half' | 'full' | 'part' | 'object',
    aspect: '9:16',
    layout: string | null,       // 例：'上 2/3 物品，下 1/3 手臂'
    forbidSee: string[],         // 例：['face','head','shoulder','torso','leg']
  },

  visible: {                     // 身体可见范围（唯一真源）
    face: boolean, head: boolean, shoulder: boolean, torso: boolean,
    arms: 'none' | 'one' | 'both',
    hands: 'none' | 'one' | 'two',
    legs: boolean, feet: boolean,
    note: string,
  },

  hands: {                       // 手部规则（pose-planner 产出）
    maxHands: number,            // 与 visible.hands 一致，审核用同一数字
    maxArms: number,
    roles: [{ side: 'left'|'right', job: 'hold_phone'|'hold_item'|'support'|'out_of_frame' }],
    contact: string | null,      // 手与物品的接触关系
  },

  pose: { description: string, avoid: string[] },

  reference: {                   // reference-manager 产出
    face: string | null,         // 只有 face/head_shoulder/half/full 且有脸时给
    body: string | null,
    forbidWholeBody: boolean,    // first_person / scene_only / part → true
    appliedTo: 'none' | 'face' | 'body',   // 实际传给 API 的那张（回填，用于自检）
  },

  prompt: { blocks: string[] },  // 只有 compose 负责拼
  audit: {                       // 审核标准（按模式，唯一真源）
    checks: ['limb_count', 'arm_hand_connect', 'camera_consistency', 'mirror_consistency', 'identity'],
    maxHands: number,
    maxArms: number,
    failClosed: boolean,         // 解析失败时是否视为失败（严格模式）
  },
}
```

**铁律**：`visible.hands/arms` → `hands.maxHands/maxArms` → `audit.maxHands/maxArms` 必须是**同一个数**，只在一处计算。

---

## 2. 九种模式矩阵

| mode | 机位 | 可见范围 | 手 | 参考图 | 关键禁止 |
|---|---|---|---|---|---|
| face_closeup | 前置，眼高，30-60cm | 脸（可到锁骨） | 0~1（可托腮） | 脸 | 不出现手机本体 |
| front_selfie | 前置，略高，一臂 | 头肩/半身 | 1（举手机）+ 0~1 | 脸 | 手机本体默认不入画 |
| half_selfie | 前置，略高，一臂 | 半身（到腰） | 1（举手机） | 脸 | 同上 |
| mirror_selfie | 镜面反射，1m | 半身~全身 | 1（举手机，**必须可见**）+ 0~1 | 脸（服装按文字） | 无手机的对镜自拍不成立 |
| **first_person** | **眼位，朝下 30-45°** | **只手臂/手，无脸/头/肩/躯干/腿** | 由动作定（0~2） | **无** | 第三人称机位、参考图整身迁移 |
| rear_object | 后置，眼位，俯视 | 物品+手（可无手） | 0~2，与物品接触 | 无 | 不出现人物 |
| video_call | 前置，屏幕高度 | 头肩 | 0~1 | 脸 | 不出现"另一个人拿手机" |
| scene_only | 后置/环境 | 纯环境，**无人** | 0 | **无** | 不出现任何人体 |
| back_view | 后置，从身后 | 背影（不露脸） | 0~1 | 体型（不锁脸） | 不得用前置自拍顶替 |

### first_person 五个子型（决定手数量与构图）

| 子型 | 触发 | 手 | 构图 |
|---|---|---|---|
| handheld 手持物品 | 端着/拿着/举起某物 | 1 | **上 2/3 物品，下 1/3 手臂**，物品在画面上部 |
| desk_work 桌面操作 | 写字/翻书/择菜/键盘 | 1~2 | 上方桌面+物品，下方双手 |
| two_hands 双手操作 | 明确双手（撕/捧/拧） | 2 + 左右职责 | 双手在下部，物品在中上部 |
| object_only 纯物品 | 没有动作，只记录东西 | 0 | 纯物品，可无手 |
| observe 环境观察 | 看窗外/看房间 | 0 | 环境纵深，无人体 |

---

## 3. 模块职责（不重复、不越界）

| 文件 | 职责 | 明确不做 |
|---|---|---|
| `photo-planner.js` | 原话 → `intent`（含 priority 与 explicit 覆盖） | 不写机位/构图 |
| `pov-planner.js` **新** | intent=first_person → `camera` + `framing` + `visible` + `hands` + 子型 | 不拼提示词 |
| `camera-planner.js` **新** | 其余 8 种模式 → `camera` | 不管手 |
| `framing-planner.js` **新** | → `framing` + `visible` | 不管机位 |
| `pose-planner.js` **新** | → `pose` + `hands.roles/contact` | 不管参照图 |
| `reference-manager.js` **新** | → `reference`（并回填 `appliedTo`） | 不判断模式 |
| `photo-prompt.js` | 只把 `PhotoPlan` 渲染成提示词（按 mode 取块） | 不产生新规则 |
| `photo-validator.js` | 契约自检：字段一致、手数量三处一致、first_person 不得有 face 等 | 不做像素审核 |
| `imageReview.js` | 像素/语义审核，读 `audit` 标准 | 不发明标准 |

---

## 4. 审核与重试

- **严格解析**：模型返回缺 `ok/match` 字段 → 视为 `unknown`，**不放行**（`failClosed`），走重试；重试用尽 → 不发图 + 日志（不再"静默放行"）。
- 视觉模型只做**辅助**：不假设它能数肢体。计数结果仅当 `arms/hands` 为合法数字且**该模式允许计数**时采纳；否则降级为"描述式审核"（把描述交给人/日志）。
- **按模式验肢体**：读 `audit.maxHands/maxArms`（来自 `visible`）。
- **按错误重试**：每次重试把失败原因写进 `pose.avoid` 与 `prompt.blocks`（不是无脑重画）；最多 2 次。
- 机位/透视/镜像/身份各自独立校验项，任一失败都可单独触发定向重试。

---

## 5. 场景判定优先级（重写）

1. **用户明确要求**（"对镜""前置""第一人称""背影""拍这个"）→ 最高
2. 拍摄目的（展示穿搭→mirror；展示物品→rear_object/first_person；记录环境→scene_only）
3. 身体范围词（全身/半身/头肩/脸/局部）
4. 关键词兜底
5. 时段/日程默认

必须避免的误判（各配一条测试）：全身≠第一人称；整理头发/裙边≠整理物品；看漫画/翻书按目的判；窗户作背景≠拍窗外；背影≠前置自拍；穿搭→镜像。

---

## 6. 旧设定清理清单

- `photo-prompt.js` 里散落的"手要进画面/托腮/拨头发"与新模式规则冲突 → 移入 `pose-planner` 的模式化姿势池。
- `SELFIE_POSES` 全局池 → 拆成按模式（自拍/第一人称）两套，禁止跨模式共用。
- 重复的手臂数量表述（"最多一条/两条/最多两只"）→ 只保留 `visible.hands` 一个真源。
- 已停用的 CLOSE/睡衣分支中的摄影残留 → 清理或标注 deprecated。
- `canonFor` 的服装匹配与"她说的衣服优先"合并到 `reference-manager`。

---

## 7. 测试

- **单元**：每模式 1 份契约快照（`PhotoPlan` JSON）+ 手数量三处一致性断言 + `first_person` 不得出现 face 断言。
- **判定**：第 5 节 9 条误判用例。
- **审核**：缺字段/异常返回/多手臂/错误机位/镜像错/身份错，各自必须判失败。
- **重试**：失败原因进入 avoid，最多 2 次，用尽后不发。
- **实拍**：每模式至少 1 张，人工看，记录在 `docs/photo-v3-shots.md`。

**不达标声明**：单元测试全绿 ≠ 摄影效果修好。必须以实拍为准。
