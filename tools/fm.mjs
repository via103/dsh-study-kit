// fm.mjs —— 安全地读写 `failure-modes.json`。
//
// 为什么有这个工具（2026-09-28，同一个坑的**第四次**）：
//   我用编辑工具手写这个 JSON 时，值里带了**直引号** `"`（中文句子里的引号本该用 「」），
//   于是整份文件 `JSON.parse` 失败。前三次也是同一原因。手写 JSON 就是不该做的事——
//   正确做法是**让序列化器落盘**：`JSON.stringify` 会自动转义，语法错误这一类问题彻底消失。
//
// 用法：
//   node tools/fm.mjs list                 列出全部条目 + 覆盖统计
//   node tools/fm.mjs check                校验（能否解析 + 是否规范序列化）；坏在哪一行会直接指出
//   node tools/fm.mjs fix                  重新序列化（JSON 坏了会**报错并指出行号**，不会覆盖）
//   node tools/fm.mjs add '<json 对象>'     追加/更新一条（按 id 覆盖同名）
import { readFileSync, writeFileSync } from 'node:fs'

const FILE = new URL('../failure-modes.json', import.meta.url)
const raw = readFileSync(FILE, 'utf8')
const canon = (obj) => `${JSON.stringify(obj, null, 2)}\n`

const cmd = process.argv[2] ?? 'check'

const parse = () => {
  try {
    return { ok: true, data: JSON.parse(raw) }
  } catch (e) {
    // JSON 报的 position 换成行号更好用（这一次就是靠它一眼看到问题行的）
    const m = /position (\d+)/.exec(String(e.message))
    const pos = m === null ? -1 : Number(m[1])
    const line = pos < 0 ? -1 : raw.slice(0, pos).split('\n').length
    return { ok: false, message: `${e.message}${line > 0 ? `　→ 第 ${line} 行` : ''}` }
  }
}

const p = parse()
if (!p.ok && cmd !== 'check' && cmd !== 'fix') {
  console.log(`❌ failure-modes.json 解析失败：${p.message}\n   先跑 \`node tools/fm.mjs fix\`（或手工修），再来做别的`)
  process.exit(1)
}

if (cmd === 'list') {
  const counts = {}
  for (const m of p.data.modes) counts[m.status] = (counts[m.status] ?? 0) + 1
  console.log(`failure-modes.json · ${p.data.modes.length} 条 ${JSON.stringify(counts)}\n`)
  for (const m of p.data.modes) console.log(`  ${m.id.padEnd(5)} [${m.status.padEnd(7)}] ${m.name.slice(0, 70)}`)
  process.exit(0)
}

if (cmd === 'check') {
  if (!p.ok) { console.log(`❌ 解析失败：${p.message}`); process.exit(1) }
  const isCanon = canon(p.data) === raw
  console.log(`✅ 可解析 · ${p.data.modes.length} 条`)
  // 「值里含直引号」不做成警告：**已经正确转义的直引号是正当内容**
  // （例如 F19 里引的就是一个真实的错误串 `ToolOutputError("value is not lossless JSON")`）。
  // 真正的判据是"能不能解析"；下面这条只管"这份文件是不是由序列化器落盘的"——
  // 手写才是引号出事的来源，所以盯住"手写"就够了。
  console.log(`${isCanon ? '✅' : '❌'} ${isCanon ? '是规范序列化（JSON.stringify 落盘）' : '不是规范序列化——多半手写过，而手写正是引号坏掉四次的原因；跑 `node tools/fm.mjs fix` 归正'}`)
  process.exit(isCanon ? 0 : 1)
}

if (cmd === 'fix') {
  if (!p.ok) { console.log(`❌ 解析失败，**不会覆盖**：${p.message}\n   请先按行号手工修好引号（中文句子里用 「」），再跑 fix`); process.exit(1) }
  writeFileSync(FILE, canon(p.data), 'utf8')
  console.log(`✅ 已重新序列化 · ${p.data.modes.length} 条 · ${Buffer.byteLength(canon(p.data), 'utf8')} B`)
  process.exit(0)
}

if (cmd === 'add') {
  const arg = process.argv.slice(3).join(' ')
  if (arg.length === 0) { console.log('用法：node tools/fm.mjs add \'{"id":"F24","name":"…","status":"partial",…}\''); process.exit(1) }
  let entry
  try { entry = JSON.parse(arg) } catch (e) { console.log(`❌ 参数不是合法 JSON：${e.message}`); process.exit(1) }
  if (typeof entry.id !== 'string' || typeof entry.name !== 'string') { console.log('❌ 至少要有 id 与 name'); process.exit(1) }
  const modes = p.data.modes.filter((m) => m.id !== entry.id)
  modes.push(entry)
  modes.sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)))
  writeFileSync(FILE, canon({ ...p.data, modes }), 'utf8')
  console.log(`✅ 已写入 ${entry.id}（共 ${modes.length} 条）`)
  process.exit(0)
}

console.log('用法：node tools/fm.mjs list | check | fix | add \'<json>\'')
process.exit(1)