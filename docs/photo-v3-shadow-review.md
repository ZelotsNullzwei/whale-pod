# Shadow Test v2.1 差异分类与结论

## 统计（唯一来源：本次运行）
- 场景总数：17
- mode 相同：11（**不能**等同于行为一致）
- identical（可比较字段全一致）：8
- expected_correction：9
- regression：0
- not_comparable：0

## expected_correction 逐项

- **后置拍物·漫画**：差异字段 subject/mode；原因：命名规范化；主体词表更精确（场景→物品）
- **后置拍物·杯子**：差异字段 subject；原因：主体词表更精确（旧把拍物记为场景/手边）
- **背影**：差异字段 face/mode；原因：背影独立模式 mirror_selfie→back_view；不露脸
- **特写**：差异字段 face；原因：旧链路把 face_closeup 当不露脸，新链路认为特写必露脸
- **未知机位·看漫画**：差异字段 face/mode；原因：机位依据不足 → 不猜
- **未知机位·窗边**：差异字段 face/mode；原因：机位依据不足 → 不猜
- **明确约束·不露脸**：差异字段 face/mode；原因：机位依据不足 → 不猜
- **明确约束·不出现人物**：差异字段 face/mode；原因：机位依据不足 → 不猜
- **明确约束·不出现手机**：差异字段 subject；原因：主体词表更精确（手边→物品）

## identical 逐项

- 前置自拍（mode=front_selfie，subject=character，band=head_shoulder，face=true）
- 前置自拍·表情（mode=front_selfie，subject=character，band=head_shoulder，face=true）
- 镜面自拍·全身（mode=mirror_selfie，subject=character，band=full，face=true）
- 镜面自拍·穿搭（mode=mirror_selfie，subject=character，band=full，face=true）
- 第一人称动作·端杯（mode=first_person，subject=character，band=hand_object，face=false）
- 第一人称动作·双手（mode=first_person，subject=character，band=hand_object，face=false）
- 桌面 POV（mode=first_person，subject=character，band=object，face=false）
- 环境 POV（mode=first_person，subject=character，band=scene，face=false）

## 回归

- 无

## 结论
1. `identical` 现在要求 subject / band / face / mode 全部一致；前置自拍这类"mode 相同但 subject/band 变了"的场景不再被误标为一致。
2. 旧链路不支持的字段标 `not_supported`，整行可能因此为 `not_comparable`，不伪装成一致。
3. 合成用例验证了 classification 本身：未登记差异 → regression；命中白名单 → expected_correction；仅不可比较 → not_comparable。