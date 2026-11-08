# Shadow Test v2 明细（字段级）

> 场景总数 **17**｜一致 **11**｜发生变化 **6**｜未登记 **0**

## 表 1 · 模式对比

| # | 场景 | 旧 mode | 新 mode | 分类 |
|---|---|---|---|---|
| 1 | 前置自拍 | front_selfie | front_selfie | identical |
| 2 | 前置自拍·表情 | front_selfie | front_selfie | identical |
| 3 | 镜面自拍·全身 | mirror_selfie | mirror_selfie | identical |
| 4 | 镜面自拍·穿搭 | mirror_selfie | mirror_selfie | identical |
| 5 | 后置拍物·漫画 | rear_selfie | rear_object | expected_correction |
| 6 | 后置拍物·杯子 | first_person | first_person | identical |
| 7 | 第一人称动作·端杯 | first_person | first_person | identical |
| 8 | 第一人称动作·双手 | first_person | first_person | identical |
| 9 | 桌面 POV | first_person | first_person | identical |
| 10 | 环境 POV | first_person | first_person | identical |
| 11 | 背影 | mirror_selfie | back_view | expected_correction |
| 12 | 特写 | face_closeup | face_closeup | identical |
| 13 | 未知机位·看漫画 | first_person | (context) | expected_correction |
| 14 | 未知机位·窗边 | front_selfie | (context) | expected_correction |
| 15 | 明确约束·不露脸 | rear_selfie | (context) | expected_correction |
| 16 | 明确约束·不出现人物 | first_person | (context) | expected_correction |
| 17 | 明确约束·不出现手机 | first_person | first_person | identical |

## 表 2 · 字段级对比（旧链路无能力处标 not_supported）

| 场景 | subject 旧→新 | mode | activities | framing 旧→新 | 手需/见 | face 旧→新 | phone | constraints |
|---|---|---|---|---|---|---|---|---|
| 前置自拍 | 她自己 → character | front_selfie→front_selfie | not_supported → null | 半身 → head_shoulder | 1/0 | true → true | false | no_phone |
| 前置自拍·表情 | 她自己 → character | front_selfie→front_selfie | not_supported → null | 半身 → head_shoulder | 1/0 | true → true | false | no_phone |
| 镜面自拍·全身 | 她自己 → character | mirror_selfie→mirror_selfie | not_supported → resting | 全身 → full | 1/1 | true → true | true | - |
| 镜面自拍·穿搭 | 今天的穿搭 → character | mirror_selfie→mirror_selfie | not_supported → null | 全身 → full | 1/1 | true → true | true | - |
| 后置拍物·漫画 | 她自己 → object | rear_selfie→rear_object | not_supported → null | 环境照 → object | 1/1 | false → false | false | no_person |
| 后置拍物·杯子 | 她自己 → object | first_person→first_person | not_supported → null | 局部 → object | 0/0 | false → false | false | no_face+no_phone |
| 第一人称动作·端杯 | 她自己 → character | first_person→first_person | not_supported → null | 局部 → hand_object | 1/1 | false → false | false | no_face+no_phone |
| 第一人称动作·双手 | 她自己 → character | first_person→first_person | not_supported → null | 局部 → hand_object | 2/2 | false → false | false | no_face+no_phone |
| 桌面 POV | 她自己 → character | first_person→first_person | not_supported → null | 局部 → object | 1/1 | false → false | false | no_face+no_phone |
| 环境 POV | 她自己 → character | first_person→first_person | not_supported → null | 局部 → scene | 0/0 | false → false | false | no_face+no_phone |
| 背影 | 镜子里的自己 → character | mirror_selfie→back_view | not_supported → null | 三分之二身 → back | 1/0 | true → false | false | no_face |
| 特写 | 她自己 → character | face_closeup→face_closeup | not_supported → null | 面部特写 → face | 1/0 | false → true | false | no_phone |
| 未知机位·看漫画 | 窝在沙发上的自己 → character | first_person→(context) | not_supported → resting+reading | 局部 → null | 0/0 | false → null | null | - |
| 未知机位·窗边 | 她自己 → character | front_selfie→(context) | not_supported → resting | 半身 → null | 0/0 | true → null | null | - |
| 明确约束·不露脸 | 她自己 → character | rear_selfie→(context) | not_supported → null | 环境照 → null | 0/0 | false → null | null | no_face |
| 明确约束·不出现人物 | 她自己 → character | first_person→(context) | not_supported → null | 局部 → null | 0/0 | false → null | null | no_person |
| 明确约束·不出现手机 | 她自己 → object | first_person→first_person | not_supported → null | 局部 → object | 0/0 | false → false | false | no_face+no_phone |