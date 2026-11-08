# pose-planner 接口与样例（V3.0 第四阶段）

> 只新增模块与测试：不改 index.js / bridge / photo-prompt，不改变原有生图流程。

## 一、职责边界

Pose Planner 只负责：身体姿势、四肢职责、动作所需肢体数量、身体与物体的接触关系、
以及"动作需要"与"画面可见"的区分。**不修改 subject / camera / framing**。

## 二、输出契约

- pose: { type, orientation, posture }
- limbs: { leftArm, rightArm, leftLeg, rightLeg }
- hands: { requiredCount, actionHands, poseHands, cameraHands, left:{role,action}, right:{role,action} }
- contacts: [{ source, target, relation }]，relation ∈ holding/touching/supporting/resting_on/manipulating/releasing
- visibility: { visibleHands, visibleArms, visibleBodyParts }
- source, unresolved

**手数量唯一真源 = hands.requiredCount**（action + camera 去重；第一人称相机在眼位，不占手）。
**未知一律 null / []**，并在 unresolved 记录（posture / hand_sides_unknown / two_hand_assignment_incomplete / action_exceeds_visible_range / framing_band_unknown）。

## 三、十组输入输出样例（真实运行）

### 自拍｜前置自拍
- camera: mode=front_selfie ｜ framing band=head_shoulder
- pose: posture=null orientation=facing_camera
- hands: required=1 action=0 camera=1 left={"role":null,"action":null} right={"role":null,"action":null}
- contacts: []
- visibility: hands=[] arms=[]
- unresolved: ["posture","hand_sides_unknown","action_exceeds_visible_range"]

### POV 单手｜第一人称 端着杯子喝
- camera: mode=first_person pov=hand_action_pov ｜ framing band=hand_object
- pose: posture=null orientation=facing_camera
- hands: required=1 action=1 camera=1 left={"role":null,"action":null} right={"role":null,"action":null}
- contacts: [{"source":"hand","target":"杯","relation":"holding"}]
- visibility: hands=["hand"] arms=["one"]
- unresolved: ["posture","hand_sides_unknown"]

### POV 双手｜第一人称 双手捧着碗
- camera: mode=first_person pov=hand_action_pov ｜ framing band=hand_object
- pose: posture=null orientation=facing_camera
- hands: required=2 action=2 camera=1 left={"role":null,"action":null} right={"role":null,"action":null}
- contacts: [{"source":"hand","target":"碗","relation":"holding"}]
- visibility: hands=["left","right"] arms=["both"]
- unresolved: ["posture","hand_sides_unknown","two_hand_assignment_incomplete"]

### 左右手｜第一人称 右手拿杯子，左手扶着桌沿
- camera: mode=first_person pov=hand_action_pov ｜ framing band=hand_object
- pose: posture=null orientation=facing_camera
- hands: required=1 action=1 camera=1 left={"role":"action","action":"扶"} right={"role":"action","action":"拿"}
- contacts: [{"source":"hand","target":"support","relation":"supporting"}]
- visibility: hands=["hand"] arms=["one"]
- unresolved: ["posture"]

### POV 无动作｜第一人称 窗外 远处 风景
- camera: mode=first_person pov=eye_pov ｜ framing band=scene
- pose: posture=null orientation=facing_camera
- hands: required=0 action=0 camera=1 left={"role":null,"action":null} right={"role":null,"action":null}
- contacts: []
- visibility: hands=[] arms=[]
- unresolved: ["posture"]

### 桌面写字｜第一人称 书桌上写字
- camera: mode=first_person pov=tabletop_pov ｜ framing band=object
- pose: posture=null orientation=facing_camera
- hands: required=1 action=1 camera=1 left={"role":null,"action":null} right={"role":null,"action":null}
- contacts: [{"source":"hand","target":"book","relation":"manipulating"}]
- visibility: hands=["hand"] arms=["one"]
- unresolved: ["posture","hand_sides_unknown"]

### 小物件｜第一人称 小物件 特写
- camera: mode=first_person pov=close_object_pov ｜ framing band=object
- pose: posture=null orientation=facing_camera
- hands: required=0 action=0 camera=1 left={"role":null,"action":null} right={"role":null,"action":null}
- contacts: []
- visibility: hands=[] arms=[]
- unresolved: ["posture"]

### 镜拍｜对镜拍一张
- camera: mode=mirror_selfie ｜ framing band=full
- pose: posture=null orientation=facing_camera
- hands: required=1 action=0 camera=1 left={"role":null,"action":null} right={"role":null,"action":null}
- contacts: []
- visibility: hands=[] arms=[]
- unresolved: ["posture","hand_sides_unknown","action_exceeds_visible_range"]

### 背影｜想要个背影
- camera: mode=back_view ｜ framing band=back
- pose: posture=null orientation=back_to_camera
- hands: required=1 action=0 camera=1 left={"role":null,"action":null} right={"role":null,"action":null}
- contacts: []
- visibility: hands=[] arms=[]
- unresolved: ["posture","hand_sides_unknown","action_exceeds_visible_range"]

### 机位未定｜坐在床边看漫画
- camera: mode=null ｜ framing band=null
- pose: posture=sitting orientation=null
- hands: required=0 action=0 camera=0 left={"role":null,"action":null} right={"role":null,"action":null}
- contacts: []
- visibility: hands=[] arms=[]
- unresolved: ["framing_band_unknown"]

## 四、测试

tests/check-pose-planner.mjs — **20 / 0**：单手不生成第二只 / 双手 / 左右手明确与未知 /
持物·支撑·放置·写字接触关系 / 第一人称无动作与单手双手 / 动作存在但不可见 /
镜拍持机去重 / 背影朝向 / 同一只手连续动作不重复计数 / 不反向改上游 / 输出契约（无 undefined）。

## 五、明确回答两个问题

1. **是否仍有模块重复决定手部数量？** 没有。camera-planner 的 `hands.cameraHands` 只表示"用不用手举机"，
   现在 pose-planner 把它当输入并**去重**，最终数量只由 `pose.hands.requiredCount` 决定。
2. **是否仍有模块重复决定可见性？** camera 的 `visibility` 描述"机位能看到什么"，pose 的 `visibility` 描述"这个动作在取景内能看到什么"；
   二者尚未合并为单一字段 —— 这是**已知遗留**，在接入前需要一次合并（见未解决问题 1）。

## 六、未解决问题

1. camera.visibility 与 pose.visibility 存在语义重叠，接入前应合并成一份最终可见性（谁优先需定规则）。
2. 左右手分配仍需她说清楚；目前"双手动作但没分左右"只记 unresolved，不会自动分配。
3. 姿势 posture 只按关键词（站/坐/躺/蹲/跪）判定，复杂姿态（半躺、侧躺、盘腿）识别不到。
4. 接触关系的 target 多为粗粒度（cup/table/book），没有具体物体实例。
5. 未做 Composition Planner；`composition` 仍是 null。
6. 全链路仍未接入生图，未做 Shadow Test 与端到端静态合并测试。