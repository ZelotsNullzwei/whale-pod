# Shadow Test 明细（旧 planShot × 新 buildShotPlan）

> 只比较、不接管、不触发生图。

| 场景 | 旧 mode | 新 mode | subject | purpose | band | 手需/见 | face | phone | core | strict | unresolved | conflicts | 差异 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 前置自拍 | front_selfie | front_selfie | character | - | head_shoulder | 1/0 | true | false | Y | N | 4 | 1 | 一致 |
| 前置自拍·表情 | front_selfie | front_selfie | character | - | head_shoulder | 1/0 | true | false | Y | N | 4 | 1 | 一致 |
| 镜面自拍·全身 | mirror_selfie | mirror_selfie | character | - | full | 1/1 | true | true | Y | N | 2 | 1 | 一致 |
| 镜面自拍·穿搭 | mirror_selfie | mirror_selfie | character | - | full | 1/1 | true | true | Y | N | 3 | 1 | 一致 |
| 后置拍物·漫画 | rear_selfie | rear_object | object | - | object | 1/1 | false | false | Y | N | 2 | 0 | 预期修正 |
| 后置拍物·杯子 | first_person | first_person | object | - | object | 0/0 | false | false | Y | N | 1 | 0 | 一致 |
| 第一人称动作·端杯 | first_person | first_person | character | - | hand_object | 1/1 | false | false | Y | N | 3 | 0 | 一致 |
| 第一人称动作·双手 | first_person | first_person | character | - | hand_object | 2/2 | false | false | Y | N | 4 | 0 | 一致 |
| 桌面 POV | first_person | first_person | character | - | object | 1/1 | false | false | Y | N | 3 | 0 | 一致 |
| 环境 POV | first_person | first_person | character | - | scene | 0/0 | false | false | Y | N | 2 | 0 | 一致 |
| 背影 | mirror_selfie | back_view | character | - | back | 1/0 | false | false | Y | N | 4 | 0 | 预期修正 |
| 特写 | face_closeup | face_closeup | character | - | face | 1/0 | true | false | Y | N | 3 | 0 | 一致 |
| 未知机位·看漫画 | first_person | (context) | character | - | null | 0/0 | null | null | N | N | 7 | 0 | 预期修正 |
| 未知机位·窗边 | front_selfie | (context) | character | - | null | 0/0 | null | null | N | N | 7 | 0 | 预期修正 |
| 明确约束·不露脸 | rear_selfie | (context) | character | - | null | 0/0 | null | null | N | N | 8 | 0 | 预期修正 |
| 明确约束·不出现人物 | first_person | (context) | character | - | null | 0/0 | null | null | N | N | 8 | 0 | 预期修正 |
| 明确约束·不出现手机 | first_person | first_person | object | - | object | 0/0 | false | false | Y | N | 1 | 0 | 一致 |

## 说明

· 「预期修正」= 新链路有意的行为改变（见 review 文档）
· `(context)` = 新链路认为机位依据不足，选择不猜（旧链路会默认一个模式）
· 手需/见 = pose.hands.requiredCount / visibility.hands.length