/**
 * shadow-image-test.js（隔离实验，不进正式链路）
 * 6 场景 × 旧/新 = 12 张。同模型、同参考图、同画幅、同参数；只让"规划字段"不同。
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const HERE = 'C:/Users/Null_zwei/Documents/deepseek-harness/default-workspace/_scratch'
const SRC = 'D:/DSH WorkSpace/whale-pod/src'
const HOME = 'C:/Users/Null_zwei/.dsh/whale-pod'

const { planShot } = await import(pathToFileURL(`${SRC}/photo/index.js`).href)
const { buildShotPlan } = await import(pathToFileURL(`${SRC}/photo/plan-photo-v3.js`).href)
const { generateImage, cropBottom, eraseCornerWatermark } = await import(pathToFileURL(`${SRC}/qq/mcpImage.js`).href)
const { fromLegacy, fromV3, renderPrompt } = await import(pathToFileURL(`${HERE}/shadow-v3-prompt-adapter.js`).href)

const cfg = JSON.parse(fs.readFileSync(`${HOME}/config.json`, 'utf8')).qq.image
const today = JSON.parse(fs.readFileSync(`${HOME}/day-plan.json`, 'utf8')).plans['2026-11-08']
const OUTFIT = today.outfit
const HAIR = today.hair ?? ''

const SCENES = [
  ['1-前置自拍', '前置自拍，自然笑一下', null],
  ['2-对镜自拍', '对镜全身自拍，站在衣柜前', null],
  ['3-第一人称端杯', '第一人称', '第一人称 端着杯子喝水'],
  ['4-桌面写字', '第一人称', '第一人称 书桌上写字'],
  ['5-后置拍物', '把漫画拍给你看', null],
  ['6-背影', '想要一个背影', null],
]

const resultsDir = path.join(HERE, 'results')
fs.mkdirSync(resultsDir, { recursive: true })

async function gen(prompt, refImage) {
  const r = await generateImage({
    prompt, url: cfg.url, provider: cfg.provider ?? 'magpie-mcp',
    baseUrl: cfg.baseUrl, apiKeyEnv: cfg.keyEnv, model: cfg.model,
    size: cfg.size, aspect: cfg.aspect ?? '9:16', resolution: cfg.resolution ?? '1K',
    refImage: refImage ?? null,
    home: HOME,
    log: { info: () => {}, warn: (m) => console.log('  !', m) },
  })
  if (!r?.ok || !r?.url) throw new Error(r?.error || 'generate failed')
  let buf = Buffer.from(await (await fetch(r.url)).arrayBuffer())
  try { buf = await eraseCornerWatermark(buf, {}) } catch {}
  try { buf = await cropBottom(buf, Number(cfg.cropBottom ?? 0.1), {}) } catch {}
  return buf
}

const summary = []
const ONLY = process.env.SHADOW_ONLY ? process.env.SHADOW_ONLY.split(',') : null
for (const [name, scene, raw] of SCENES.filter((x) => !ONLY || ONLY.some((k) => x[0].includes(k)))) {
  const dir = path.join(resultsDir, name)
  fs.mkdirSync(dir, { recursive: true })

  const oldShot = planShot({ scene, slot: 'evening', outfit: OUTFIT, hair: HAIR, scope: 'shadow:' + name, mode: 'daily', imageCfg: cfg })
  const v3 = buildShotPlan({ scene, slot: 'evening', raw })

  const oldPrompt = renderPrompt(fromLegacy(oldShot.plan || {}, raw || scene))
  const v3Prompt = renderPrompt(fromV3(v3, raw || scene))

  fs.writeFileSync(path.join(dir, 'input.txt'), String(raw || scene), 'utf8')
  fs.writeFileSync(path.join(dir, 'legacy-plan.json'), JSON.stringify(oldShot.plan ?? {}, null, 2), 'utf8')
  fs.writeFileSync(path.join(dir, 'v3-plan.json'), JSON.stringify(v3, null, 2), 'utf8')
  fs.writeFileSync(path.join(dir, 'legacy-prompt.txt'), oldPrompt, 'utf8')
  fs.writeFileSync(path.join(dir, 'v3-prompt.txt'), v3Prompt, 'utf8')
  fs.writeFileSync(path.join(dir, 'params.json'), JSON.stringify({
    model: cfg.model, size: cfg.size, aspect: cfg.aspect, resolution: cfg.resolution,
    refImageRule: '旧=plan.faceVisible / V3=visibility.face',
    seed: 'unsupported_by_provider（未固定，差异可能含随机性）',
  }, null, 2), 'utf8')

  /*
   * 参考图策略必须由**各自的规划结果**决定：
   *   旧：plan.faceVisible；V3：visibility.face === true
   * 否则 POV 会被参考图强行拉成第三人称（本次实验暴露的真问题）。
   */
  const refOld = oldShot.plan?.faceVisible ? (cfg.faceRefImage ?? cfg.refImage ?? null) : null
  const refV3 = v3.visibility?.face === true ? (cfg.faceRefImage ?? cfg.refImage ?? null) : null
  console.log('[' + name + '] 旧链路生成中… ref=' + (refOld ? 'face' : 'none'))
  const a = await gen(oldPrompt, refOld)
  fs.writeFileSync(path.join(dir, 'legacy.jpg'), a)
  console.log('[' + name + '] V3 生成中… ref=' + (refV3 ? 'face' : 'none'))
  const b = await gen(v3Prompt, refV3)
  fs.writeFileSync(path.join(dir, 'v3.jpg'), b)

  summary.push({ name, dir, legacy: path.join(dir, 'legacy.jpg'), v3: path.join(dir, 'v3.jpg') })
  console.log('[' + name + '] done')
}

fs.writeFileSync(path.join(resultsDir, 'index.json'), JSON.stringify(summary, null, 2), 'utf8')
console.log('ALL DONE:', summary.length, 'scenes')
