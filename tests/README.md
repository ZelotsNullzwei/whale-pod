# tests

## 自动测试（可以随时跑）

```bash
node tests/run.mjs          # 全跑
node tests/check-xxx.mjs    # 单个
```

这些**不依赖网络、不依赖 QQ**，纯逻辑 + mock，改代码后应该一直是绿的。
`run.mjs` 会跳过下面那批 `probe-*`。

## 探针脚本（`probe-*.mjs`，需要真实环境）

这些**不是测试**，是排查问题时用的手动工具。它们会连真实的 magpie
（`127.0.0.1:3425`）、真实的 NapCat（`127.0.0.1:3000`）、真实的 DSH 安装目录。

**没起这些服务就会失败，属于正常现象，不要以为是代码坏了。**

| 脚本 | 用途 | 依赖 |
|---|---|---|
| `probe-decision-model.mjs` | 跑一组私聊/群聊用例，看模型判断是否合理 | magpie |
| `probe-verdict-prompt.mjs` | 复现「模型不输出 reply/wait/stop」的问题 | magpie |
| `probe-maxtokens-scan.mjs` | 扫 maxTokens 对判断准确率的影响（改这个值前先跑） | magpie |
| `probe-private-reply.mjs` | 验证私聊提示词里没有 wait/stop | 无 |
| `probe-image-download.mjs` | 用真实 QQ 图片 URL 测下载 + 代理兜底 | NapCat |
| `probe-image-pipeline.mjs` | 测「下载 → 入库 → ImageBlock」整条链 | NapCat + DSH |
| `probe-image-forward.mjs` | 测 ImageBlock 转成上游 `image_url` 是否正确 | DSH |
| `probe-vision.mjs` | 直接问 magpie「这张图是什么」，验证模型真的能看图 | magpie |
| `probe-verify-fixes.mjs` | 一次跑完代理/判断/图片三处修复的验证 | 全部 |

## 为什么单独放

它们**需要真实凭据和外部服务**，放进 CI 只会一直红。
但删掉又不行 —— 下次再出「图片看不见」「判断全是 badParse」这类问题，
这些脚本能省掉大量手工复现时间。

判断标准：**能 mock 的进 `check-*.mjs`，需要真东西的进 `probe-*.mjs`。**
