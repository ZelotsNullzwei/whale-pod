# 给在本仓库里干活的 agent

> 本文件是**协作约定**，不是产品文档。动代码前请先读一遍（30 秒）。

## 一句话

**同一个工作树里可能有多条会话在同时改代码** —— 尤其是 `src/qq/bridge.js`。

## 三条规矩

1. **短改动、立刻提交**
   动 `bridge.js` 时一次只做一个改动，改完马上 `git commit`。
   不要把"半成品"留在工作区过夜。
2. **动手前看现场**
   ```bash
   git status --short      # 有没有别人的未提交改动
   git log --oneline -3    # 最近的提交是谁做的
   ```
   看到不属于自己的未提交改动 → **先别动同一个文件**。
3. **提交信息写清 scope**
   `fix(photo)` / `fix(qzone)` / `test(...)` / `fix(persona-code)`。
   人格 `.md` 永不入库（`.gitignore` 已挡 `persona/roles/*.md`）。

## 详细版

见 [CONCURRENCY.md](CONCURRENCY.md)：风险说明、冲突排查步骤（`git log -S` 定位自己的改动）、
以及 2026-11-08 当天的提交归属表。

## 出问题时

```bash
git log -S '<只有我写过的字符串>' --oneline   # 我的改动在哪个提交里
git show --stat <提交>                        # 它动了哪些文件
```
