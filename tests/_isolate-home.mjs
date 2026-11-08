/**
 * 测试隔离：把 `WHALE_POD_HOME` 指到临时目录（2026-11-08）。
 *
 * ## 为什么必须是独立模块、且**第一个 import**
 * ESM 的 import 是**提升**的：不管写在文件第几行，都会先于任何顶层语句执行。
 * 所以「在 import 之前 setenv」**没用** —— `qqActions.js` 加载时就把
 * `QZONE_STATE = <WHALE_POD_HOME>/qzone-last.json` 算死了，用的是真实数据目录。
 *
 * 实测后果：跑一次 `check-qq-actions` 就在 `C:\Users\...\.dsh\whale-pod\` 里
 * 留下一份 `qzone-last.json`，于是**她 20 小时内发不了说说**（限频闸挡的）。
 *
 * 修法：这个模块只做一件事 —— 在它自己加载时把 env 改掉；
 * 测试里把它写成**第一个 import**，后续 import 才会读到新值。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'whalepod-test-home-'))
process.env.WHALE_POD_HOME = TEST_HOME

export default TEST_HOME
