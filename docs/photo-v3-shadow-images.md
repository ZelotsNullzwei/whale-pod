# 12 张真实生图对照（旧链路 × V3）

> 实验脚本隔离在 `_scratch/`：`shadow-v3-prompt-adapter.js`、`shadow-image-test.js`、`results/`。
> **未修改** `index.js` / `bridge` / `photo-prompt.js`，未接入正式链路。

## 实验控制（公平性）

| 项目 | 设置 |
|---|---|
| 生图模型 / 参数 | 两侧完全相同（同一 provider/model/size/aspect/resolution）|
| 画幅 | 9:16 |
| 公共角色设定 | 同一份 `character-profile` 文本 |
| 场景原始输入 | 同一句 |
| Prompt 骨架 | **同一套**（画风/人物/尾巴/场景/机位/取景/手脚/可见性/约束/输出）|
| 唯一变量 | 机位、取景、手部、可见性这些**规划字段的值** |
| 参考图策略 | 由**各自规划结果**导出：旧=`plan.faceVisible`，V3=`visibility.face` |
| 随机种子 | **provider 不支持固定 seed** —— 单次差异含随机性，不能全部归因于规划器 |

## 每场景产物

`results/<场景>/` 内含：`input.txt`、`legacy-plan.json`、`v3-plan.json`、`legacy-prompt.txt`、`v3-prompt.txt`、`params.json`、`legacy.jpg`、`v3.jpg`。

| 场景 | 验收点 | 旧链路 | V3 | 参考图规则 |
|---|---|---|---|---|
| 1-前置自拍 | 自然表情、合理自拍距离、不出现摄影师 | `_scratch/results/1-前置自拍/legacy.jpg` | `_scratch/results/1-前置自拍/v3.jpg` | 旧=plan.faceVisible / V3=visibility.face |
| 2-对镜自拍 | 手机与持机手关系正确、镜中比例合理 | `_scratch/results/2-对镜自拍/legacy.jpg` | `_scratch/results/2-对镜自拍/v3.jpg` | 旧=plan.faceVisible / V3=visibility.face |
| 3-第一人称端杯 | 动作手正确、杯子接触关系自然 | `_scratch/results/3-第一人称端杯/legacy.jpg` | `_scratch/results/3-第一人称端杯/v3.jpg` | 旧=plan.faceVisible / V3=visibility.face |
| 4-桌面写字 | 笔/纸/手关系合理，不多长手 | `_scratch/results/4-桌面写字/legacy.jpg` | `_scratch/results/4-桌面写字/v3.jpg` | 旧=plan.faceVisible / V3=visibility.face |
| 5-后置拍物 | 物品是主体，不出现无意义持机手 | `_scratch/results/5-后置拍物/legacy.jpg` | `_scratch/results/5-后置拍物/v3.jpg` | 旧=plan.faceVisible / V3=visibility.face |
| 6-背影 | 背部朝向正确，不意外露脸 | `_scratch/results/6-背影/legacy.jpg` | `_scratch/results/6-背影/v3.jpg` | 旧=plan.faceVisible / V3=visibility.face |

## 首轮最关键的发现

1. **参考图策略是 POV 成立与否的决定性因素**：第一轮两侧都给了人脸参考图，结果**两张都变成第三人称怼脸自拍**（旧链路的老毛病，V3 也会被拉回去）。
2. 改为「`visibility.face=false` → 不给人脸参考图」后，V3 的第一人称端杯变成**真正的俯视 POV**：只有她的手、杯柄、桌面和腿，没有脸。
3. 结论：**只在规划层写"脸部不可见"不够，必须把参考图策略作为规划输出的一部分并在生成侧执行**。这是接入 Prompt Builder 时必须带走的一条。

## 待人工按五项评估

每个场景分别看：①机位与视角 ②肢体数量与动作合理性 ③人物与物体接触关系 ④取景与构图 ⑤角色表现与真实摄影感。

贯穿检查：**鲸鱼尾巴只作挂件，不生成身体尾巴**。

## 已知局限

- 未固定随机种子，单张差异可能含模型随机性；判断应看"是否存在结构性错误"而不是像素级比较。
- 适配器刻意保持最小：只翻译字段，不补充规划器没输出的内容；因此某些细节（如"手怎么握杯柄"）不会出现在提示词里。
- 这不是接入验收，只是"V3 是否减少不自然拍照行为"的证据收集。