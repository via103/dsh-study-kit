// replay-file-edits.mjs —— **从会话日志重放一个文件的编辑历史，把它重建出来**。
//
// 为什么会有这个工具（2026-09-25 事故）：
//   我用 PowerShell 的文本 cmdlet 改 `plan-core.js`，PS 5.1 按 ANSI(cp936) 解读无 BOM 的 UTF-8，
//   中文整片变乱码、还吃掉约 130 个换行。**没有任何备份**（包目录不是 git 仓库，profile 里是指向
//   同一份物理文件的符号链接）。
//   救回来靠的是：`write` 与 `edit` 的入参（content / old_string / new_string）**原样存在会话日志里**
//   —— 也就是说，"这个文件是怎么变成现在这样的"是**可重放的**。日志本身就是一份完整的编辑历史。
//
// 做法：按时间顺序取出针对该文件的所有 write/edit，以最后一次完整 `write` 为起点，依次套用每一次 edit。
//
// ⚠️ 两点必须知道，否则会得到一份**看起来对、其实缺东西**的重建：
//   1. 重放**会漏掉**那些 old_string 匹配不上的 edit（原会话里它们可能作用在别处，或因顺序而不同）。
//      所以要逐条报告"跳过"了哪些，并**用测试当验收**——重建完必须跑一遍全量回归。
//   2. 日志里可能有**多次** write（早期版本）。默认取最后一次；进度用 `--from <时间>` 可指定起点。
//
// 用法：
//   node tools/replay-file-edits.mjs plan-core.js                 重建并写到 .verify/replayed-<名字>
//   node tools/replay-file-edits.mjs plan-core.js --out plan-core.js   直接写回（先自己备份！）
//   node tools/replay-file-edits.mjs plan-core.js --list          只列出该文件的编辑历史，不重建
import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { decodeSessionFile, fields, listSessions } from './decode-session.mjs'

const argv = process.argv.slice(2)
const needle = argv.find((a) => !a.startsWith('--'))
const outIdx = argv.indexOf('--out')
const outPath = outIdx >= 0 ? argv[outIdx + 1] : undefined
const listOnly = argv.includes('--list')

if (needle === undefined) {
  console.log('用法：node tools/replay-file-edits.mjs <文件名或路径片段> [--list] [--out <写回路径>]')
  process.exit(1)
}

// ── 收集该文件的所有写操作 ──────────────────────────────────────────────────
const ops = []
let scanned = 0
for (const s of listSessions()) {
  let d
  try { d = decodeSessionFile(s.abs) } catch { continue }
  scanned += 1
  const results = new Map()
  for (const ev of d.lines) {
    if (ev.type !== 'tool/result') continue
    const e = fields(ev)
    const cid = e.message?.source?.callId ?? e.callId
    if (cid !== undefined) results.set(cid, e.error === undefined ? 'ok' : `${e.error.name}/${e.error.code}`)
  }
  for (const ev of d.lines) {
    if (ev.type !== 'tool/call') continue
    const e = fields(ev)
    if (e.name !== 'write' && e.name !== 'edit') continue
    let args
    try { args = JSON.parse(String(e.arguments ?? '')) } catch { continue }
    if (!String(args.file_path ?? '').includes(needle)) continue
    ops.push({ at: ev.time, seq: ev.seq ?? 0, session: s.id, tool: e.name, args, result: results.get(e.callId) })
  }
}
ops.sort((a, b) => a.at - b.at || a.seq - b.seq)
const when = (t) => new Date(t).toISOString().replace('T', ' ').slice(0, 19)

console.log(`扫描 ${scanned} 个会话，找到 ${ops.length} 次针对 "${needle}" 的写操作`)
console.log(`  write ${ops.filter((o) => o.tool === 'write').length} · edit ${ops.filter((o) => o.tool === 'edit').length}\n`)

if (listOnly) {
  for (const op of ops) {
    const size = op.tool === 'write' ? `content ${op.args.content?.length ?? 0} 字` : `old ${op.args.old_string?.length ?? 0} → new ${op.args.new_string?.length ?? 0}`
    console.log(`  ${when(op.at)}  ${op.tool.padEnd(5)} ${String(size).padEnd(26)} ${op.result ?? '?'}  ${op.args.file_path}`)
  }
  process.exit(0)
}

const writes = ops.filter((o) => o.tool === 'write' && typeof o.args.content === 'string')
if (writes.length === 0) {
  console.log('❌ 这个文件从来没有被完整 write 过（只有 edit），无法重放。')
  process.exit(1)
}
const base = writes[writes.length - 1]
console.log(`起点：${when(base.at)} 的 write（${base.args.content.split('\n').length} 行）`)
if (writes.length > 1) console.log(`  （另有 ${writes.length - 1} 次更早的 write，未采用）`)

let text = base.args.content
let applied = 0
const skipped = []
for (const op of ops) {
  if (op.at < base.at) continue
  if (op.tool === 'write') { text = op.args.content; applied += 1; continue }
  const { old_string: oldS, new_string: newS } = op.args
  if (typeof oldS !== 'string' || typeof newS !== 'string') continue
  if (!text.includes(oldS)) { skipped.push(op); continue }
  text = op.args.replace_all === true ? text.split(oldS).join(newS) : text.replace(oldS, newS)
  applied += 1
}

console.log(`\n套用成功 ${applied} · 跳过 ${skipped.length}`)
let faithful = true
for (const op of skipped) {
  const verdict = op.result === undefined ? '？找不到回执' : op.result === 'ok' ? '⚠️ 原会话里**成功**了（说明重放漏了真实改动）' : `✅ 原会话里也失败（${op.result}）`
  if (op.result === 'ok' || op.result === undefined) faithful = false
  console.log(`  跳过 ${when(op.at)}  ${verdict}`)
  console.log(`       ${JSON.stringify(String(op.args.old_string).slice(0, 70))}`)
}
console.log(
  faithful
    ? '\n★ 所有跳过都是"原会话里本来就失败"的调用 —— 重放与真实历史一致。'
    : '\n⚠️ 有跳过的 edit 在原会话里是**成功**的 —— 这是一份**不完整**的重建，必须逐条人工确认。',
)
console.log(`\n重建结果：${text.split('\n').length} 行 · ${text.length} 字符 · U+FFFD ${(text.match(/\uFFFD/g) ?? []).length}`)

const target = outPath ?? join('.verify', `replayed-${basename(needle)}`)
mkdirSync(join(target, '..'), { recursive: true })
writeFileSync(target, text, 'utf8')
console.log(`→ ${target}`)
if (outPath === undefined) {
  console.log('\n下一步（别跳）：')
  console.log('  1) 用 edit/write 工具（或 Node）把它取过去，**不要**用 PowerShell 的文本 cmdlet；')
  console.log('  2) `node --check <文件>`；')
  console.log('  3) **跑一遍全量回归** —— 测试是这份重建的验收标准，不是"看起来对"。')
}