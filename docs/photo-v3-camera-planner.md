# camera-planner 接口与静态输出审查（V3.0 第二阶段）

> 状态：**只新增模块 + 测试**，未接入 index.js / bridge / photo-prompt，真实生图行为未改变。

## 一、接口契约

输入 = photo-planner.planIntent() 的输出：
```js
{ subject, secondarySubjects, intent:{purpose,source}, activities:[{type,target,order}],
  framing:{type,source}, composition:null, camera:{mode,device,position,source}|null,
  scene:{location,background:[]}, explicitRequirements:[{type,mode,source,spans}],
  constraints:[{type,source,scope}],
  diagnostics:{matchedRules,conflicts,unresolved,decisionTrace} }
```

输出：
```js
{ mode, source, device, povSubtype,
  geometry:{position,height,orientation,distance,direction},
  visibility:{face,hands:[],arms:[],phone,bodyParts:[]},
  unresolved:[] }
```

**null 是有意义的**：没有依据时一律 null，不编造相机位置。

## 二、七种模式几何

| mode | device | position | height | orientation | distance | face | phone |
|---|---|---|---|---|---|---|---|
| face_closeup | front_cam | in_front_of_face | eye_level | toward_face | 20-35cm | 是 | 不入画 |
| front_selfie | front_cam | arm_length_front | slightly_high | toward_face | 40-60cm | 是 | 不入画 |
| mirror_selfie | rear_via_mirror | in_front_of_mirror | chest_level | toward_mirror | 60-120cm | 是 | **必须可见** |
| back_view | rear_cam | behind_subject | shoulder_level | toward_back | 60-150cm | 否 | 否 |
| rear_object | rear_cam | in_front_of_object | eye_level | toward_object | 30-70cm | 否 | 否 |
| scene_only | rear_cam | scene_viewpoint | null | toward_scene | null | 否 | 否 |
| video_call | front_cam | desk_stand | chest_level | toward_face | 50-80cm | 是 | 不入画 |

## 三、第一人称五套几何（互不共用 eye）

| 子型 | position | orientation | distance | direction | 手 | 典型 |
|---|---|---|---|---|---|---|
| eye_pov | at_eyes | forward | n/a | forward | 0 | 看窗外/看环境 |
| hand_action_pov | beside_head_tilted_down | toward_hands | 40-60cm | forward_down | 1 | 拿杯子/切菜/整理 |
| tabletop_pov | above_table | down_to_table | 40-70cm | down_60_90 | 0或2 | 桌面食物/书本 |
| lap_pov | at_eyes_seated | down_to_lap | 40-60cm | down_45_60 | 0或1 | 腿上放东西 |
| close_object_pov | near_object | toward_object | 15-30cm | forward_down | 0或1 | 小物件/细节 |

第一人称恒为：phone=false（手机不入画）、face=false。
手数量唯一真源 = limbsFromActivities()（双手动作必须有明确依据）。

## 四、静态输出样本（真实运行）

### camera=null → 不猜 ｜「坐在床边看漫画」
- intent: subject=character purpose=daily_moment activities=resting+reading framing=null
- camera: mode=null source=unresolved device=null
- geometry: position=null height=null orientation=null distance=null direction=null
- visibility: face=null hands=[] arms=[] phone=null bodyParts=[]
- unresolved: ["camera_mode","camera_position"]

### 前置自拍 ｜「前置自拍」
- intent: subject=character purpose=daily_moment activities=- framing=null
- camera: mode=front_selfie source=explicit device=front_cam
- geometry: position=arm_length_front height=slightly_high orientation=toward_face distance=40-60cm direction=forward
- visibility: face=true hands=["phone"] arms=["one"] phone=false bodyParts=["head","shoulder","upper_body"]
- unresolved: []

### 镜拍 ｜「对镜拍一张，展示今天的穿搭」
- intent: subject=character purpose=show_outfit activities=- framing=full
- camera: mode=mirror_selfie source=explicit device=rear_cam_via_mirror
- geometry: position=in_front_of_mirror height=chest_level orientation=toward_mirror distance=60-120cm direction=forward
- visibility: face=true hands=["phone"] arms=["one"] phone=true bodyParts=["full_or_half_body"]
- unresolved: []

### 背影 ｜「想要个背影」
- intent: subject=character purpose=daily_moment activities=- framing=null
- camera: mode=back_view source=explicit device=rear_cam
- geometry: position=behind_subject height=shoulder_level orientation=toward_back distance=60-150cm direction=forward
- visibility: face=false hands=[] arms=["zero_or_one"] phone=false bodyParts=["back","back_of_head"]
- unresolved: []

### POV hand_action ｜「第一人称，端着杯子喝」
- intent: subject=object purpose=share_object activities=holding_item+holding_item framing=object
- camera: mode=first_person source=explicit device=phone pov=hand_action_pov
- geometry: position=beside_head_tilted_down height=eye_level_minus orientation=toward_hands distance=40-60cm direction=forward_down
- visibility: face=false hands=["action_hand"] arms=["one"] phone=false bodyParts=["hand","forearm"]
- unresolved: [] ｜ 拿杯子/切菜/整理：只出现做动作的那只手

### POV tabletop ｜「第一人称，书桌上写字」
- intent: subject=object purpose=share_object activities=- framing=object
- camera: mode=first_person source=explicit device=phone pov=tabletop_pov
- geometry: position=above_table height=above_chest orientation=down_to_table distance=40-70cm direction=down_60_90
- visibility: face=false hands=[] arms=[] phone=false bodyParts=["table","object"]
- unresolved: [] ｜ 桌面承载：没有拿取动作时手不应强行入镜

### POV lap ｜「第一人称，腿上放着漫画」
- intent: subject=character purpose=daily_moment activities=- framing=null
- camera: mode=first_person source=explicit device=phone pov=lap_pov
- geometry: position=at_eyes_seated height=seated_eye_level orientation=down_to_lap distance=40-60cm direction=down_45_60
- visibility: face=false hands=[] arms=[] phone=false bodyParts=["lap","object"]
- unresolved: [] ｜ 腿上放东西：坐姿视线

### POV close ｜「第一人称，小物件 特写」
- intent: subject=character purpose=daily_moment activities=- framing=part
- camera: mode=first_person source=explicit device=phone pov=close_object_pov
- geometry: position=near_object height=object_level orientation=toward_object distance=15-30cm direction=forward_down
- visibility: face=false hands=[] arms=[] phone=false bodyParts=["object_detail"]
- unresolved: [] ｜ 拍小物件/局部细节

### POV eye ｜「第一人称，窗外 远处」
- intent: subject=scene purpose=share_scene activities=- framing=object
- camera: mode=first_person source=explicit device=phone pov=eye_pov
- geometry: position=at_eyes height=eye_level orientation=forward distance=n/a direction=forward
- visibility: face=false hands=[] arms=[] phone=false bodyParts=[]
- unresolved: [] ｜ 看窗外/观察环境：画面是眼前景象，通常没有手

### 视频通话 ｜「视频通话中」
- intent: subject=character purpose=conversation activities=- framing=null
- camera: mode=video_call source=explicit device=front_cam
- geometry: position=desk_stand height=chest_level orientation=toward_face distance=50-80cm direction=forward
- visibility: face=true hands=[] arms=["zero_or_one"] phone=false bodyParts=["head","shoulder","upper_body"]
- unresolved: []

### 后置拍物 ｜「拍给你看这个」
- intent: subject=object purpose=share_object activities=- framing=object
- camera: mode=rear_object source=inferred device=rear_cam
- geometry: position=in_front_of_object height=eye_level orientation=toward_object distance=30-70cm direction=forward_down
- visibility: face=false hands=[] arms=[] phone=false bodyParts=["object"]
- unresolved: []

## 五、测试结果

tests/check-camera-planner.mjs — **18 / 0**，覆盖复核要求的 14 项。
相关旧套件：check-intent-v3 23/0、check-mode-matrix 8/0、check-draw-pipeline 32/0、check-photo-v3-append 13/0。

## 六、未解决问题

1. **back_view 在旧 photo-modes.js 中仍未定义**：camera-planner 能输出，但旧投影/提示词不认识。接入前必须决定是新增正式 mode，还是降级为 mirror/front 的构图变体。
2. **POV 子型判定仍是文本正则**，未使用 activities.type 的语义组合，复杂句可能判错。
3. **geometry 目前是语义标签**（如 above_table），尚未量化成角度/距离数值；framing-planner 需要数值时要再加一层。
4. **lap_pov / close_object_pov 尚未实拍验证**（五子型只做了几何区别测试）。
5. 本轮按要求**没有接入影子对比**，也没有切换 index.js 输出。