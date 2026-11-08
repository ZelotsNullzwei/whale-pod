# V3.0 复核包（第 2、3 步）

> 状态：**第 2 步已实现并测试通过；第 3 步只做了"影子对比"（只算不用，行为零改变），尚未切换。**
> 请重点复核：intent 的维度划分是否够后续机位/构图直接使用，以及 9 条误判的处理是否合理。

## 一、当前边界（未改动的东西）

- `photo-modes.js`：**未改**（0 处修改）
- `photo-prompt.js`：**未改**（提示词生成器原样）
- `index.js`：只加了一段"算 intent + 记差异"，**没有改变任何输出行为**
- 下游（bridge 5 处 planShot 调用）**零改动**

调用链审计：`planPhoto` 只有 1 个调用点（index.js:85）；下游只读
`mode / modeLabel / shooter / device / camera / look / rules / needsCharacterRef / hidePhone / fixedFrom / fixReason`。

## 二、intent 实现（photo-planner.js 尾部）

```js
const SUBJECT_RULES = [
  { re: /(拍给你看|给你看这个|拍下它|拍这个|拍一下这个|给你看看这个)/, subject: "object" },
  { re: /(站在|坐在|靠着|望着|看着|望向).{0,6}(窗|外面|窗外|阳台)/, subject: "character" },
  { re: /(窗外|阳台|楼下|街景|风景|日落|整个房间|环境)/, subject: "scene" },
  { re: /(手里|手上的|端着的|桌上|碗里|锅里|台面上|捧着的|眼前)/, subject: "object" },
  { re: /(穿着|穿上|这身|全身|半身|自拍|看我|看我一眼|背影)/, subject: "character" },
]

const ACTIVITY_RULES = [
  { re: /(整理|收拾|擦拭|打扫|叠|洗|挑|翻找|摆弄)/, activity: "tidying" },
  { re: /(看漫画|看书|翻书|翻页|刷手机|看手机)/, activity: "reading" },
  { re: /(做饭|煮|炒|洗碗|切菜|蒸|熬)/, activity: "cooking" },
  { re: /(吃|喝|端|拿着|举着|捧着)/, activity: "holding_item" },
  { re: /(躺|窝在|靠|坐|站|蹲)/, activity: "resting" },
]

const FRAMING_RULES = [
  { re: /(怼脸|面部特写|只拍脸|脸贴镜头)/, framing: "face" },
  { re: /(头肩|锁骨以上)/, framing: "head_shoulder" },
  { re: /(半身)/, framing: "half" },
  { re: /(全身|三分之二身)/, framing: "full" },
  { re: /(局部|特写|手上的|手里)/, framing: "part" },
]

/** 明确要求（优先级最高，不可被时段/目的覆盖） */
const EXPLICIT_RULES = [
  { re: /(怼脸|面部特写|只拍脸|脸贴镜头)/, cameraMode: "face_closeup", device: "front_cam", position: "close" },
  { re: /(对镜|照镜子|穿衣镜|镜前|对着镜子|镜子里)/, cameraMode: "mirror_selfie", device: "mirror", position: "mirror_front" },
  { re: /(第一人称|第一视角|POV|pov)/, cameraMode: "first_person", device: "phone", position: "eye" },
  { re: /(背影|后脑|背对)/, cameraMode: "back_view", device: "phone", position: "behind" },
  { re: /(前置|自拍)/, cameraMode: "front_selfie", device: "phone", position: "arm_length" },
  { re: /(视频通话|视频里|通话中)/, cameraMode: "video_call", device: "phone", position: "desk" },
  { re: /(后置|拍这块|拍它)/, cameraMode: "rear_object", device: "rear_cam", position: "rear" },
]

function grab(rules, text, key) {
  for (const r of rules) {
    const m = r.re.exec(text)
    if (!m) continue
    if (r.notNear) {
      const near = text.slice(Math.max(0, m.index - 6), m.index + m[0].length + 6)
      if (r.notNear.test(near)) continue
    }
    return { hit: r, match: m }
  }
  return null
}

export function planIntent({ scene = "", slot = "afternoon", sceneOnly = false } = {}) {
  const text = String(scene)
  if (sceneOnly) {
    return {
      subject: "scene", activity: null, framing: "object",
      camera: { mode: "scene_only", device: "rear_cam", position: "rear" },
      scene: { location: "current", background: [] },
      explicitRequirements: [], confidence: { subject: 0.99, activity: 0.9, camera: 0.99 },
    }
  }

  /* ---- 动作（含对象判定：整理她自己身上的东西 ≠ 整理物品） ---- */
  let activity = null
  let activityAboutHer = false
  for (const r of ACTIVITY_RULES) {
    const m = r.re.exec(text)
    if (!m) continue
    activity = r.activity
    const near = text.slice(Math.max(0, m.index - 6), m.index + m[0].length + 6)
    activityAboutHer = /(裙|衣|发|袖|领|围裙|袜|鞋|头饰|刘海|裙摆|肩带|吊带|妆)/.test(near)
    break
  }

  /* ---- 主体：先看明确指向，再看动作对象，最后看穿着/自拍 ---- */
  let subject = null
  const sHit = grab(SUBJECT_RULES, text)
  if (sHit) subject = sHit.hit.subject
  if (!subject && activity) {
    if (activityAboutHer) subject = "character"
    else if (activity === "reading") subject = /(拍|给你看|记录)/.test(text) ? "object" : "character"
    /* 站着/坐着/躺着 = 她本人在画面里，不是"拍眼前的东西"（2026-11-08 修） */
    else if (activity === "resting") subject = "character"   // resting 是人在画面里
    else subject = "object"
  }
  if (!subject) subject = /(穿着|站在|坐在|躺|妆|头发)/.test(text) ? "character" : "scene"

  /* ---- 构图 ---- */
  const fHit = grab(FRAMING_RULES, text)
  const framing = fHit ? fHit.hit.framing : (subject === "character" ? "half" : "object")

  /* ---- 机位：明确要求 → 目的 → 主体兜底 ---- */
  const explicitRequirements = []
  let camera = null
  for (const r of EXPLICIT_RULES) {
    if (r.re.test(text)) {
      camera = { mode: r.cameraMode, device: r.device, position: r.position }
      explicitRequirements.push(r.cameraMode)
      break
    }
  }
  if (!camera) {
    if (/(穿搭|这身|新衣服|好不好看|试衣)/.test(text)) camera = { mode: "mirror_selfie", device: "mirror", position: "mirror_front" }
    else if (subject === "object") {
      const fp = framing === "part" || /(桌面|桌上|碗里|锅里|手里|手上|台面|眼前)/.test(text) || activity === "tidying" || activity === "cooking" || activity === "holding_item"
      camera = fp
        ? { mode: "first_person", device: "phone", position: "eye" }
        : { mode: "rear_object", device: "rear_cam", position: "rear" }
    }
    else if (subject === "scene") camera = { mode: "scene_only", device: "rear_cam", position: "rear" }
    else camera = { mode: "front_selfie", device: "phone", position: "arm_length" }
  }

  /* ---- 环境（只作背景信息，绝不据此定机位） ---- */
  const background = []
  if (/(窗|窗帘|窗台)/.test(text)) background.push("window")
  if (/(书桌|桌子|台面)/.test(text)) background.push("desk")
  if (/(床|被|枕头)/.test(text)) background.push("bed")
  if (/(衣柜|镜子)/.test(text)) background.push("closet")
  const location = /(外面|街上|店里|公园|阳台)/.test(text) ? "outdoor" : "indoor"

  const conf = { subject: 0.9, activity: activity ? 0.9 : 0.6, camera: explicitRequirements.length ? 0.98 : 0.75 }
  return { subject, activity, framing, camera, scene: { location, background }, explicitRequirements, confidence: conf }
}

/**
 * 投影：intent → 旧 mode id（供 index.js 及所有下游无痛迁移）。
 * 这只是**过渡层**，等 camera/framing planner 就位后可以拆掉。
 */
export function projectMode(intent) {
  const m = String(intent?.camera?.mode ?? "")
  if (m === "rear_object") return "rear_selfie"
  if (m === "scene_only") return "rear_selfie"
  if (m) return m
  return "front_selfie"
}

```

## 三、新旧对照（16 条真实场景）

| 场景 | 旧 mode | 新 mode | 主体 | 动作 | 构图 | 机位 | 差异 |
|---|---|---|---|---|---|---|---|
| 对镜全身自拍，站在衣柜前 | mirror_selfie | mirror_selfie | character | resting | full | mirror_front | 一致 |
| 拍张全身的 | front_selfie | front_selfie | character | - | full | arm_length | 一致 |
| 穿着短款女仆装站在房间里，侧身低头整理裙边，窗边有绿萝 | front_selfie | front_selfie | character | tidying | half | arm_length | 一致 |
| 坐在床边看漫画 | first_person | front_selfie | character | reading | half | arm_length | DIFF |
| 把漫画拍给你看 | rear_selfie | rear_selfie | object | - | object | rear | 一致 |
| 站在窗边看着外面 | front_selfie | front_selfie | character | resting | half | arm_length | 一致 |
| 拍一下窗外的雨 | rear_selfie | rear_selfie | scene | - | object | rear | 一致 |
| 想要个背影 | mirror_selfie | back_view | character | - | half | behind | DIFF |
| 展示今天的穿搭 | mirror_selfie | mirror_selfie | scene | - | object | mirror_front | 一致 |
| 第一人称，手里端着杯子 | first_person | first_person | object | holding_item | part | eye | 一致 |
| 书桌前把抽屉里的笔挑出来扔掉 | first_person | first_person | object | tidying | object | eye | 一致 |
| 第一人称，双手捧着碗 | first_person | first_person | object | holding_item | object | eye | 一致 |
| 前置自拍，躺在床上 | front_selfie | front_selfie | character | resting | half | arm_length | 一致 |
| 视频通话中 | video_call | video_call | scene | - | object | desk | 一致 |
| 怼脸拍一张 | face_closeup | face_closeup | scene | - | face | close | 一致 |
| 桌上那碗面 | first_person | first_person | object | - | object | eye | 一致 |

## 四、影子对比实测（behavior unchanged）

```
DIFF 坐在床边看漫画 | 旧= first_person 新= front_selfie
DIFF 想要个背影   | 旧= mirror_selfie 新= back_view
影子差异 2 / 8（行为未改，仅记录）
```

## 五、回归测试

`tests/check-intent-v3.mjs` — **13 / 0**，覆盖 9 条误判 + 结构契约 + 子型区分。

## 六、想请复核的具体问题

1. **维度是否够用**：`subject/activity/framing/camera/scene/explicitRequirements/confidence`
   是否足够让后面的 camera-planner / pose-planner 直接消费？缺什么维度？
2. **`subject=scene` 与 `camera.mode=scene_only` 的关系**：现在两个都表达"纯场景"，是否冗余？
   建议只保留 `subject=scene`，由 camera-planner 推导 mode 吗？
3. **`explicitRequirements` 只存 mode 字符串**：是否应改成
   `[{type:'camera', mode, source:'explicit', spans:[...]}]`，便于后面"明确要求压过默认"的可解释性？
4. **confidence 目前是硬编码常量**（0.9/0.6/0.98），并非真实置信度。
   是否应该：要么去掉，要么改成"命中规则数 / 是否显式 / 是否有冲突"的确定性推导？
5. **`activity` 单值**：她说"边看漫画边吃面"这种复合动作，单值会丢信息。
   是否需要 `activities: []`（有序数组）？
6. **投影层的边界**：`projectMode` 把 `rear_object / scene_only` 都映到旧 `rear_selfie`。
   这在过渡期是对的，但会不会掩盖"纯场景 vs 拍物"的区别，导致切换时漏测？
7. **称呼一致性**：代码里还有旧名 `rear_selfie`，V3 设计里叫 `rear_object`。
   建议现在就把新名固定进 intent（已做），旧名只在 projectMode 出现 —— 这样对吗？

## 七、我建议的下一步（等复核后执行）

1. 按复核意见调 intent 结构（只动 photo-planner，风险最低）
2. 影子跑一段时间，确认差异全部可解释
3. 切换 `plan.mode = projectMode(intent)`
4. 再做 camera-planner / framing-planner / pose-planner / reference-manager
