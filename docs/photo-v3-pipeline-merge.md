# V3.0 四层静态合并结果（Intent → Camera → Framing → Pose）

> 未接入生图。本表由 buildShotPlan() 真实运行生成。

| 场景 | subject | camera | framing | posture | 手(需/见) | resolved | unresolved 层 |
|---|---|---|---|---|---|---|---|
| 对镜全身自拍，站在衣柜前 | character | mirror_selfie | full | standing | 1/0 | 是 | pose |
| 拍张全身的 | character | null | null | null | 0/0 | 否 | intent,camera,framing,pose |
| 坐在床边看漫画 | character | null | null | sitting | 0/0 | 否 | intent,camera,framing,pose |
| 把漫画拍给你看 | object | rear_object | object | null | 1/1 | 是 | pose |
| 站在窗边看着外面 | character | null | null | standing | 0/0 | 否 | intent,camera,framing,pose |
| 拍一下窗外的雨 | scene | scene_only | scene | null | 1/0 | 是 | pose |
| 想要个背影 | character | back_view | back | null | 1/0 | 是 | intent,pose |
| 展示今天的穿搭 | character | mirror_selfie | full | null | 1/0 | 是 | pose |
| 前置自拍 | character | front_selfie | head_shoulder | null | 1/0 | 是 | intent,pose |
| 视频通话中 | character | video_call | head_shoulder | null | 0/0 | 是 | intent,pose |
| 怼脸拍一张 | character | face_closeup | face | null | 1/0 | 是 | pose |
| 第一人称 端着杯子喝 | character | first_person/hand_action_pov | hand_object | null | 1/1 | 是 | intent,pose |
| 第一人称 双手捧着碗 | character | first_person/hand_action_pov | hand_object | null | 2/2 | 是 | intent,pose |
| 第一人称 书桌上写字 | character | first_person/tabletop_pov | object | null | 1/1 | 是 | intent,pose |
| 第一人称 窗外 远处 风景 | character | first_person/eye_pov | scene | null | 0/0 | 是 | intent,pose |
| 第一人称 小物件 特写 | character | first_person/close_object_pov | object | null | 0/0 | 是 | intent,pose |

## 检查结论

1. **字段覆盖**：四层各自持有命名空间（intent/camera/framing/pose），合并层只读不改；测得 pose 不含 geometry/band，intent.subject 不被下游改写。
2. **重复推断**：手数量只有 `pose.hands.requiredCount` 一个真源；camera 的 `cameraHands` 是"用不用手举机"的输入，已在 pose 去重。
3. **null 未被默认值替换**：`camera=null` 的 4 个场景，framing/pose 全部保持 null/空，且 resolved=false。
4. **冲突被记录**：`two_hand_assignment_incomplete`、`action_exceeds_visible_range`、`framing_band_unknown` 均写入 unresolved 而非静默补齐。
5. **已知遗留**：camera.visibility 与 pose.visibility 语义重叠，尚未合并为单一最终可见性（接入前需处理）。

测试：tests/check-pipeline-v3.mjs — **11 / 0**。