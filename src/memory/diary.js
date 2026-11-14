/**
 * 她的小日记（2026-11-11）
 *
 * 用户口径：
 *   · 每天写一篇日记，睡前（22:30）发说说；
 *   · 配一张她任何形式的自拍，表情跟日记心情走；
 *   · 本地给她建一个日记文件夹；侧栏能看。
 *
 * 这里只负责：把当天日程整理成一篇**日记正文**并落盘，供 qzone 睡前预览/发布。
 * 不虚构：只写日程里真实写了的片段；没有的部分不补。
 */
import fs from 'node:fs'
import path from 'node:path'

export const DIARY_DIR = 'diary'

export function diaryDir(home) {
  return path.join(home, DIARY_DIR)
}

export function diaryPath(home, date) {
  return path.join(diaryDir(home), `${date}.md`)
}

function oneLine(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim()
}

/** 把当天日程整理成日记正文（Markdown）。只使用已经写进日程的片段。 */
export function buildDiary(plan = {}, date = new Date().toLocaleDateString('sv-SE')) {
  const mood = oneLine(plan.mood)
  const parts = []
  parts.push(`# ${date}`)
  if (mood) parts.push(`心情：${mood}`)
  parts.push('')
  parts.push('## 今天')
  const slots = [
    ['早上', plan.morning],
    ['中午', plan.noon],
    ['下午', plan.afternoon],
    ['晚上', plan.evening],
  ]
  for (const [label, text] of slots) {
    const t = oneLine(text)
    if (t) parts.push(`- ${label}：${t}`)
  }
  parts.push('')
  if (oneLine(plan.outing)) {
    parts.push('## 出门')
    parts.push(`- ${oneLine(plan.outing)}`)
    parts.push('')
  }
  if (oneLine(plan.smallThing)) {
    parts.push('## 一件小事')
    parts.push(`- ${oneLine(plan.smallThing)}`)
    parts.push('')
  }
  parts.push('## 睡前')
  parts.push(diaryClosing(mood))
  return parts.join('\n')
}

/** 日记的收尾句：只表达心情，不新增事实。 */
export function diaryClosing(mood = '') {
  const m = String(mood)
  if (/松快|轻松|舒服|平静/.test(m)) return '今天没什么大事，心里倒是挺松快的。'
  if (/开心|高兴|愉快/.test(m)) return '今天过得还行，心情是好的。'
  if (/烦|累|闷/.test(m)) return '今天有点累，先这样吧。'
  return '今天就这样过去了。'
}

/** 睡前说说正文（≤40 字、事实来自日记，不能出现第二人称）。 */
export function diaryQzoneLine(plan = {}) {
  const m = oneLine(plan.mood)
  if (/松快|轻松|舒服|平静/.test(m)) return '今天没什么大事，心里倒是挺松快'
  if (/开心|高兴|愉快/.test(m)) return '今天过得还行，心情挺好'
  if (/烦|累|闷/.test(m)) return '今天有点累，准备早点睡'
  return '今天就这样过去了'
}

/** 写今天的日记（已存在则不覆盖，除非 overwrite）。 */
export function writeDiary(plan = {}, { home, date = new Date().toLocaleDateString('sv-SE'), overwrite = false } = {}) {
  const dir = diaryDir(home)
  fs.mkdirSync(dir, { recursive: true })
  const file = diaryPath(home, date)
  if (!overwrite && fs.existsSync(file)) return { file, created: false, text: fs.readFileSync(file, 'utf8') }
  const text = buildDiary(plan, date)
  fs.writeFileSync(file, text)
  return { file, created: true, text }
}

/** 侧栏用：日记索引（日期 + 心情 + 文件路径），新到旧。 */
export function listDiaries(home) {
  const dir = diaryDir(home)
  try {
    return fs.readdirSync(dir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .sort()
      .reverse()
      .map((f) => {
        const full = path.join(dir, f)
        let mood = ''
        try {
          const t = fs.readFileSync(full, 'utf8')
          mood = (/心情：([^\n]+)/.exec(t)?.[1] ?? '').trim()
        } catch { /* ignore */ }
        return { date: f.replace(/\.md$/, ''), mood, file: full }
      })
  } catch { return [] }
}

export function readDiary(home, date) {
  try { return fs.readFileSync(diaryPath(home, date), 'utf8') } catch { return '' }
}

/** 心情 → 自拍表情（给配图提示词用） */
export function moodExpression(mood = '') {
  const m = String(mood)
  if (/松快|轻松|舒服|平静/.test(m)) return '表情放松，嘴角自然微松，不摆拍，像睡前随手拍'
  if (/开心|高兴|愉快/.test(m)) return '表情轻快，带一点自然笑意'
  if (/烦|累|闷/.test(m)) return '表情偏倦，眼神安静，不要强笑'
  return '表情自然放松'
}
