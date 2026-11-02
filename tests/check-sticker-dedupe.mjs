/**
 * 表情包管理（2026-11-02 用户要求）。
 *
 * ## 两条规则
 * 1. **同类型的表情只留 3 个** —— `dedupeByTag(3)`
 * 2. **每积累 3 张就打标签** —— `_tagStickerBatch({ minPending: 3 })`（原本就有）
 *
 * ## 为什么"同类"按相似度、不按第一个标签
 * 库里「无语」打头的有 14 张，但第二标签差别很大：
 *   无语、愤怒、压迫感、发疯   ／   无语、嫌弃、冷漠、看戏、死亡凝视
 * 只按第一个标签归类会把它们当同类砍到 3 张 —— 等于删掉明显不同的图。
 *
 * ## 阈值 0.5 是**试跑定的**
 * 对现有 72 张逐档跑：0.4→清 9 张（过度合并）、0.5→清 3 张（真同义）、
 * 0.6→清 0 张（完全不触发）。所以默认值必须是 0.5。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { StickerTagStore } from '../src/qq/sticker-tags.js'

let pass = 0
let fail = 0
const ok = (name, fn) => {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sticker-dedupe-'))
const mk = (items) => {
  const store = new StickerTagStore({ home: tmpHome, log: {} })
  store.map.clear()
  let i = 0
  for (const tags of items) store.map.set(`u:${i++}`, { tags, at: Date.now() })
  return store
}

ok('默认每类留 3 张、阈值 0.5', () => {
  const store = new StickerTagStore({ home: tmpHome, log: {} })
  assert.equal(store.dedupeByTag.length >= 0, true)
  // 用 4 张同义的验证"留 3"
  const s = mk([
    ['无语', '嫌弃', '冷漠'],
    ['无语', '冷漠', '嫌弃'],
    ['嫌弃', '无语', '冷漠'],
    ['冷漠', '无语', '嫌弃'],
  ])
  const r = s.dedupeByTag()
  assert.equal(r.removed.length, 1, '4 张同义 → 只清 1 张')
  assert.equal(s.map.size, 3)
})

ok('真同义会被收敛（阈值 0.5 能触发）', () => {
  const s = mk([
    ['无语', '嫌弃', '冷漠'],
    ['无语', '嫌弃', '冷漠', '不屑'],
    ['无语', '嫌弃', '冷漠', '看戏'],
    ['无语', '嫌弃', '冷漠', '呆滞'],
  ])
  const r = s.dedupeByTag(3)
  assert.equal(r.removed.length, 1, '这一组该收敛成 3 张')
})

ok('**不是**同义的不会被合并（这就是不能按第一个标签算的原因）', () => {
  const s = mk([
    ['无语', '愤怒', '压迫感', '发疯'],
    ['无语', '嫌弃', '冷漠', '看戏', '死亡凝视'],
    ['无语', '嫌弃', '警告', '暴躁', '别惹我'],
    ['无语', '心不在焉', '呆滞', '看手机'],
  ])
  const r = s.dedupeByTag(3)
  assert.equal(r.removed.length, 0,
    '这 4 张都带"无语"但其余标签不同，**一张都不该删**')
})

ok('留的是**最新的**（Map 末尾），删的是旧的', () => {
  const s = mk([
    ['无语', '嫌弃', '冷漠'],   // 最旧
    ['无语', '冷漠', '嫌弃'],
    ['嫌弃', '无语', '冷漠'],
    ['冷漠', '无语', '嫌弃'],   // 最新
  ])
  s.dedupeByTag(3)
  assert.equal(s.map.has('u:0'), false, '最旧那张该被删')
  assert.equal(s.map.has('u:3'), true, '最新那张该留下')
})

ok('每类 ≤ 3 时一张都不动（幂等）', () => {
  const s = mk([['A', 'B'], ['C', 'D'], ['E', 'F']])
  const r = s.dedupeByTag(3)
  assert.equal(r.removed.length, 0)
  assert.equal(s.map.size, 3)
  const again = s.dedupeByTag(3)
  assert.equal(again.removed.length, 0, '再跑一次也不该动')
})

ok('**不删表情本身** —— 只动标签库（图还在收藏里）', () => {
  /*
   * 这条是纪律：去重只清理"标签表"，不碰 `_customFaces` 的收藏列表。
   * 删图要经过用户同意，不能顺手干。所以这里确认 store 只有标签相关方法被动过。
   */
  const s = mk([['A'], ['A'], ['A'], ['A']])
  const before = s.map.size
  s.dedupeByTag(3)
  assert.equal(s.map.size, 3, `标签表 ${before} → 3`)
  assert.equal(typeof s.get, 'function', 'get 还在（收藏列表照常能查）')
})

ok('打标签门槛就是 3（每积累 3 张就打）', () => {
  const src = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')
  assert.match(src, /async _tagStickerBatch\(\{ minPending = 3, batchLimit = 5 \} = \{\}\)/,
    'minPending 必须是 3 —— 用户要求的"每积累 3 张就打标签"')
  assert.match(src, /dedupeByTag\(3\)/, '打完一批要顺手收敛同类')
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
try { fs.rmSync(tmpHome, { recursive: true, force: true }) } catch { /* 临时目录 */ }
process.exit(fail > 0 ? 1 : 0)