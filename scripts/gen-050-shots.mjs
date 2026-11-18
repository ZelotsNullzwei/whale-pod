// 用鲸舱自己的生图链路（planShot + generateImage）跑「按日程表的四套穿着」。
// 产物落到 ~/.dsh/whale-pod/050/ 下。
import fs from 'node:fs'
import path from 'node:path'
import { planShot } from '../src/photo/index.js'
import { outfitForDay, outingOutfitForDay, sleepwearForDay } from '../src/memory/wardrobe.js'
import { generateImage } from '../src/qq/mcpImage.js'

const HOME = 'C:/Users/Null_zwei/.dsh/whale-pod'
const REFS = [path.join(HOME, 'refs/her-face-front.png'), path.join(HOME, 'refs/her-body-front.png')].filter(fs.existsSync)
const OUT = path.join(HOME, '050')
const MC_URL = 'http://127.0.0.1:3425/mcp/magpie/image'
fs.mkdirSync(OUT, { recursive: true })
const dayKey = new Date().toISOString().slice(0, 10)

const plan = [
  { id: 'morning', slot: 'morning', scene: '刚起床，在卧室窗边拿手机自拍，晨光很淡', hair: '头发随便挽起来，用蓝色发圈', outfit: outfitForDay(dayKey) },
  { id: 'outing', slot: 'afternoon', scene: '出门在街上，靠着一面干净的墙自拍，下午的自然光', hair: '扎成低马尾，用蓝色发圈，刘海自然', outfit: outingOutfitForDay(dayKey) },
  { id: 'evening', slot: 'evening', scene: '傍晚回到家，在客厅沙发边自拍，暖色灯和窗外余光', hair: '披着，用蓝色发圈松松扎在脑后', outfit: outfitForDay(dayKey) },
  { id: 'night', slot: 'night', scene: '夜里在卧室床边自拍，只有一盏小夜灯', hair: '披着，额前夹一枚白色小发夹', outfit: sleepwearForDay(dayKey) },
]

const only = process.argv[2]
for (const p of plan) {
  if (only && p.id !== only) continue
  console.log(`\n=== ${p.id} ===`)
  const shot = planShot({
    scene: p.scene, slot: p.slot, outfit: p.outfit, hair: p.hair,
    weather: '晴', mood: '松弛', scope: 'private:2129024700', mode: 'daily',
  })
  if (shot.skip) { console.log('skip:', shot.skipReason); continue }
  console.log('mode:', shot.mode, '| framing:', shot.framing)
  const r = await generateImage({
    url: MC_URL,
    prompt: shot.prompt,
    aspect: '3:4',
    refImages: REFS,
    home: HOME,
    log: { info: (m) => console.log('  ', m), warn: (m) => console.log('  WARN', m) },
  })
  console.log('result:', r.ok, r.error ?? '', String(r.url ?? '').slice(0, 120))
  if (r.ok && r.url) {
    const dest = path.join(OUT, `${p.id}.png`)
    try {
      const resp = await fetch(String(r.url));
      const buf = Buffer.from(await resp.arrayBuffer());
      fs.writeFileSync(dest, buf);
      console.log('  saved →', dest, buf.length, 'bytes')
    } catch (e) { console.log('  download fail', e.message) }
  }
}
