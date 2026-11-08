# Shadow Test v2 差异分类与结论

## 统计（唯一来源：本次运行）
- 场景总数：17
- identical（行为一致）：11
- expected_correction（预期修正）：6
- regression（未登记）：0
- not_comparable（旧链路无对应能力）：subject 语义、activities、hands、phone、constraints、unresolved

## 预期修正逐项

- **后置拍物·漫画**：rear_selfie → rear_object；原因：命名规范化 rear_selfie→rear_object
- **背影**：mirror_selfie → back_view；原因：背影独立模式 mirror_selfie→back_view
- **未知机位·看漫画**：first_person → (context)；原因：机位依据不足 → 不猜（旧默认 first_person）
- **未知机位·窗边**：front_selfie → (context)；原因：机位依据不足 → 不猜（旧默认 front_selfie）
- **明确约束·不露脸**：rear_selfie → (context)；原因：机位依据不足 → 不猜（旧默认 rear_selfie）
- **明确约束·不出现人物**：first_person → (context)；原因：机位依据不足 → 不猜（旧默认 first_person）

## 回归风险

- 无

## 结论

1. 统计数字由本次运行生成，文档与测试同源，不会再出现口径不一致。
2. 旧链路没有 subject 词表/activities/手部模型/constraints，这些字段一律 not_supported，未强行比较。
3. `strict` 的四个条件（intent/camera/framing/pose 的 unresolved、visibility conflict、core）已逐条测试。
4. 手的身份检查覆盖：持机手不进动作手、第一人称动作手不含 camera_hand、双手不被压缩、镜拍必须保留 camera_hand、同一只手不重复计数。
5. 约束语义：no_face/no_person/no_phone 互不替代；no_phone 会压过镜拍的 phone 默认并记冲突。
6. 测试不依赖个人路径（仓库根由 import.meta.url 推导，可用 WHALE_POD_HOME 覆盖）。