// check-preset-yml.mjs — 每个预设的**选择器元数据**（名字 / 描述 / 排序）解析得出来吗？
//
// 为什么需要它：这几个字段只影响选择器怎么显示，填错了**不会有任何报错**——预设照常能开，
// 只是名字变成一串 id、描述空着、或者排序随机。所以它必须有人盯着。
//
// ═══ 2026-09-22 重写（0.1.7）═══════════════════════════════════════════════════
// 上一版读 `.agent-presets/<id>/preset.yml`。0.1.7 删掉了那个目录的自动发现，
// 元数据搬进了 `@deepseek-ai/dsh-agent-preset` 声明的 `config.{name,description,order}`。
// 上一版在升级后依然全绿——因为旧文件还在，只是**没人读了**。
// 这正是 F16（断言结构上问不到问题）的又一次复发：检查必须问"现在谁在读它"。
import { readFileSync } from 'node:fs'
import { presetDeclarations } from '../tools/presets.mjs'

let bad = 0
const fail = (msg) => { bad += 1; console.log(`❌ ${msg}`) }

const decls = presetDeclarations()
const mine = decls.filter((d) => !d.shipped)

console.log(`预设声明 ${decls.length} 条（用户 ${mine.length}）· 来源 ${mine[0]?.layer ?? '?'}\n`)

for (const d of mine) {
  const problems = []
  if (typeof d.name !== 'string' || d.name.trim().length === 0) problems.push('缺 name（选择器里会显示成一串 id）')
  else if (d.name.length > 60) problems.push(`name 太长（${d.name.length} 字），选择器里会被截断`)
  if (typeof d.description !== 'string' || d.description.trim().length === 0) problems.push('缺 description（选择器里没有一行说明）')
  if (typeof d.order !== 'number') problems.push('缺 order（排序会随机/落到最后）')
  if (d.plugins.length === 0) problems.push('plugins 是空的（挂上去什么也没有）')

  // 描述里的换行：YAML 折行（>-）之后应是单行文本，夹带真实换行会让选择器里显示成两行。
  if (typeof d.description === 'string' && /\n/.test(d.description)) problems.push('description 里含真实换行')

  const okMark = problems.length === 0 ? '✅' : '❌'
  console.log(`${okMark} ${d.id.padEnd(18)} name=${JSON.stringify(d.name)} order=${d.order ?? '-'} desc=${typeof d.description === 'string' ? `${d.description.length} 字` : 'MISSING'}`)
  for (const p of problems) { console.log(`     · ${p}`); bad += 1 }
}

// ── 行结构：preset 行后面的插件 name: 不能丢 ────────────────────────────────
// config 里的 name/description/order 只影响选择器显示；宿主挂载一行靠的是行上的
// `name:`（插件包名）。少了 name 行时：YAML 合法、上面的元数据检查全绿、doctor 也
// 能解析出声明，但宿主会**静默跳过**——预设在选择器里根本不存在。
// 2026-10-29 `model-tutor` 就是克隆 preset 块时漏了这一行才“看不见”。
for (const layerFile of new Set(mine.map((d) => d.layer))) {
  if (typeof layerFile !== 'string') continue
  let lines
  try { lines = readFileSync(layerFile, 'utf8').split(/\r?\n/) } catch { continue }
  let rows = 0
  let rowBad = 0
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)- id: "?preset-[\w-]+"?$/.exec(lines[i])
    if (!m) continue
    rows += 1
    const pad = m[1] + '  '
    let j = i + 1
    while (j < lines.length && lines[j].trim() === '') j += 1
    if (!lines[j].startsWith(pad + 'name:')) {
      rowBad += 1
      fail(`${layerFile}: ${lines[i].trim()} 下一非空行不是 \`name:\`（宿主会静默跳过该预设）`)
    }
  }
  if (rowBad === 0) console.log(`行结构：${layerFile} 的 ${rows} 条 preset 行都带插件 name:`)
}

// 只报问题数会丢掉"哪个预设坏的"，所以上面逐条打印、这里只汇总。
if (mine.length === 0) fail('一条用户预设声明都没读到——presets.mjs 或组合树出问题了')

// 对照：shipped 预设本来就不写 name（选择器用内置标签），所以它们不该被上面那套规则要求。
const shippedNoName = decls.filter((d) => d.shipped && d.name === undefined).length
console.log(`\n（shipped ${decls.length - mine.length} 条里 ${shippedNoName} 条不写 name —— 那是正常的，选择器用内置标签）`)
console.log(`\n有问题的字段 ${bad} 处`)
process.exit(bad === 0 ? 0 : 1)