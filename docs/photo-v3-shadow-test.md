# Shadow Test v2.1 明细（字段级一致语义）

> `identical` = **所有可比较字段**一致，而不是 mode 相同。

- 场景总数：**17**
- mode 相同：**11**（仅代表机位相同）
- identical（全部可比较字段一致）：**8**
- expected_correction：**9**
- regression：**0**
- not_comparable：**0**

| # | 场景 | mode 旧→新 | modeSame | subject 旧→新 | band 旧→新 | face 旧→新 | 差异字段 | 分类 |
|---|---|---|---|---|---|---|---|---|
| 1 | 前置自拍 | front_selfie→front_selfie | Y | character→character | half→head_shoulder | true→true | band:not_supported | identical |
| 2 | 前置自拍·表情 | front_selfie→front_selfie | Y | character→character | half→head_shoulder | true→true | band:not_supported | identical |
| 3 | 镜面自拍·全身 | mirror_selfie→mirror_selfie | Y | character→character | full→full | true→true | band:not_supported | identical |
| 4 | 镜面自拍·穿搭 | mirror_selfie→mirror_selfie | Y | not_supported→character | full→full | true→true | subject:not_supported,band:not_supported | identical |
| 5 | 后置拍物·漫画 | rear_selfie→rear_object | N | character→object | not_supported→object | false→false | subject:changed,band:not_supported,mode:changed | expected_correction |
| 6 | 后置拍物·杯子 | first_person→first_person | Y | character→object | part→object | false→false | subject:changed,band:not_supported | expected_correction |
| 7 | 第一人称动作·端杯 | first_person→first_person | Y | character→character | part→hand_object | false→false | band:not_supported | identical |
| 8 | 第一人称动作·双手 | first_person→first_person | Y | character→character | part→hand_object | false→false | band:not_supported | identical |
| 9 | 桌面 POV | first_person→first_person | Y | character→character | part→object | false→false | band:not_supported | identical |
| 10 | 环境 POV | first_person→first_person | Y | character→character | part→scene | false→false | band:not_supported | identical |
| 11 | 背影 | mirror_selfie→back_view | N | character→character | not_supported→back | true→false | band:not_supported,face:changed,mode:changed | expected_correction |
| 12 | 特写 | face_closeup→face_closeup | Y | character→character | face→face | false→true | band:not_supported,face:changed | expected_correction |
| 13 | 未知机位·看漫画 | first_person→null | N | character→character | part→null | false→null | band:not_supported,face:changed,mode:changed | expected_correction |
| 14 | 未知机位·窗边 | front_selfie→null | N | character→character | half→null | true→null | band:not_supported,face:changed,mode:changed | expected_correction |
| 15 | 明确约束·不露脸 | rear_selfie→null | N | character→character | not_supported→null | false→null | band:not_supported,face:changed,mode:changed | expected_correction |
| 16 | 明确约束·不出现人物 | first_person→null | N | character→character | part→null | false→null | band:not_supported,face:changed,mode:changed | expected_correction |
| 17 | 明确约束·不出现手机 | first_person→first_person | Y | character→object | part→object | false→false | subject:changed,band:not_supported | expected_correction |