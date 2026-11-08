# Shadow Test 差异分类与结论

## 统计
- 场景总数：17
- 与旧链路一致：11
- 预期修正：6
- 未登记差异（必须修复）：0

## 预期修正（可接受）

- **后置拍物·漫画**：rear_selfie → rear_object；原因：命名规范化（rear_selfie → rear_object）
- **背影**：mirror_selfie → back_view；原因：背影独立模式（旧 mirror_selfie，新 back_view）
- **未知机位·看漫画**：first_person → (context)；原因：未知机位（旧默认 first_person，新选择不猜）
- **未知机位·窗边**：front_selfie → (context)；原因：未知机位（旧默认 front_selfie，新选择不猜）
- **明确约束·不露脸**：rear_selfie → (context)；原因：机位依据不足 → 新链路不猜（旧默认 rear_selfie）
- **明确约束·不出现人物**：first_person → (context)；原因：机位依据不足 → 新链路不猜（旧默认 first_person）

## 必须修复

- 无

## 关键结论

1. 新链路**没有**把 `camera=null` 兜底成自拍（未知机位均带 unresolved）。
2. 持机手不再误入画面（前置/后置类可见手 = 0）。
3. 镜拍出现 `mirror.camera_hand_forced` 裁决记录，冲突可追踪。
4. `strict` 从未在 `core=false` 时为真；且现在会因整链 unresolved 而为 false。
5. 未接入生图，也未修改 index.js / bridge / photo-prompt。