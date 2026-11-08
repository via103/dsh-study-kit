// tool-timeline.mjs — 「某个工具不能用」时，把它的每次调用与回执按**时间**排出来。
//
// 为什么需要它（2026-09-20 那次教训的直接产物）：
// 同一个会话日志里会**同时**留着"修复前的失败记录"与"修复后的成功记录"。只 grep
// 「有没有报错」必然得出"还是坏的"这个错误结论——我就是这么白修了两轮的（F20）。
// 把时间排出来，一眼就能分开：
//    最后失败 09-20 15:42 → 之后还有 22 次调用，全部正常  ⇒ 已经好了，问题在别处
//    最后失败 今天 13:20  → 之后没有任何调用             ⇒ 还是坏的
//
// 用法：
//   node tools/tool-timeline.mjs <sessionId> [--tool code_run]
//   node tools/tool-timeline.mjs --latest [--tool code_run]     最近的会话（可加 --n 5 多看几个）
//   node tools/tool-timeline.mjs --list 10                      先列最近的会话
//
// 会话日志的文件名不写死版本号（v0~v4+ 都认），见 decode-session.mjs 的头注。
import { decodeSessionFile, fields, listSessions } from './decode-session.mjs'

const argv = process.argv.slice(2)
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt
}
const has = (name) => argv.includes(`--${name}`)

const toolName = flag('tool', 'code_run')
const sessions = listSessions()

if (has('list') || argv.length === 0) {
  const n = Number(flag('list', 10)) || 10
  console.log(`最近 ${n} 个会话（共 ${sessions.length} 个）：\n`)
  for (const s of sessions.slice(0, n)) {
    const when = new Date(s.mtime).toISOString().replace('T', ' ').slice(0, 16)
    console.log(`  ${when}  ${s.id}  ${s.file}  ${(s.bytes / 1024).toFixed(0)} KB`)
  }
  console.log('\n接一个 id 或 --latest 继续：node tools/tool-timeline.mjs --latest --tool code_run')
  process.exit(0)
}

const targets = has('latest')
  ? sessions.slice(0, Number(flag('n', 1)) || 1)
  : sessions.filter((s) => s.id === argv.find((a) => !a.startsWith('--') && a !== toolName))

if (targets.length === 0) {
  console.log(`没找到会话（看 --list）`)
  process.exit(1)
}

const when = (ev) => new Date(ev.time).toISOString().replace('T', ' ').slice(0, 19)

/** message.content 有两种形状：`{type:'text',text}` 与 `{type:'tool-result',content:[{type:'text',text}]}`。 */
const textOf = (message) => {
  const parts = []
  for (const c of Array.isArray(message?.content) ? message.content : []) {
    if (typeof c?.text === 'string') parts.push(c.text)
    for (const inner of Array.isArray(c?.content) ? c.content : []) if (typeof inner?.text === 'string') parts.push(inner.text)
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim()
}

/** 从入参里挑一个能一眼看出"这次在跑什么"的字段。 */
const hintOf = (argsJson) => {
  try {
    const a = JSON.parse(argsJson)
    const bits = [a.language, a.path !== undefined ? `path=${a.path}` : a.code !== undefined ? '内联源码' : undefined, Array.isArray(a.cases) ? `${a.cases.length} 条用例` : undefined]
    return bits.filter(Boolean).join(' · ')
  } catch {
    return ''
  }
}

let totalFails = 0
for (const s of targets) {
  const d = decodeSessionFile(s.abs)
  const pending = new Map()
  const rows = []
  for (const ev of d.lines) {
    const e = fields(ev)
    if (ev.type === 'tool/call' && e.name === toolName) pending.set(e.callId, { at: when(ev), hint: hintOf(e.arguments) })
    else if (ev.type === 'tool/result') {
      const cid = e.message?.source?.callId ?? e.callId
      const call = pending.get(cid)
      if (call === undefined) continue
      const text = textOf(e.message)
      const isErr = e.error !== undefined
      rows.push({
        ...call,
        err: isErr ? `${e.error.name}/${e.error.code}` : undefined,
        // 回执的"内容形态"决定它是哪种结果：编译失败是**正常的判定结果**，不是工具故障。
        kind: isErr ? 'error'
          : /编译：❌/.test(text) ? 'compile-fail（正常判定）'
            : /判定：✅|判定：❌|运行：退出码|编译：✅/.test(text) ? '正常回执'
              : text.length === 0 ? '空回执（值得看一眼）' : '其他',
        note: (isErr ? text : text).slice(0, 70),
      })
      pending.delete(cid)
    }
  }
  const bad = rows.filter((r) => r.kind === 'error')
  totalFails += bad.length
  console.log(`\n===== ${s.id}（${s.file}）=====`)
  console.log(`  ${d.frames} 帧 · ${d.lines.length} 行 · ${toolName} 调用 ${rows.length} 次 · 工具级错误 ${bad.length} 次\n`)
  for (const r of rows) {
    const mark = r.kind === 'error' ? '❌' : r.kind === '正常回执' ? '✅' : r.kind.startsWith('compile-fail') ? '⚠️' : '·'
    console.log(`  ${r.at}  ${mark} ${r.hint.padEnd(28)} ${r.err ?? r.kind}${r.err === undefined ? '' : `  ${r.note}`}`)
  }
  if (bad.length > 0) {
    const last = bad[bad.length - 1]
    const after = rows.filter((r) => r.at > last.at)
    const afterOk = after.filter((r) => r.kind !== 'error').length
    console.log(`\n  ★ 首次失败 ${bad[0].at} · 最后失败 ${last.at}`)
    console.log(`    最后失败之后还有 ${after.length} 次调用，其中非错误 ${afterOk} 次`)
    console.log(after.length > 0 && afterOk === after.length
      ? '    ⇒ 看起来已经好了：失败集中在较早的一段时间里，之后都正常（**别只看"有没有报错"**）'
      : after.length === 0
        ? '    ⇒ 最后失败之后没有任何调用——**无法判断是否修复**，去真跑一次'
        : '    ⇒ 之后仍有失败，还没好')
  } else if (rows.length > 0) {
    console.log(`\n  ★ 没有工具级错误`)
  } else {
    console.log(`\n  ★ 这个会话里没调用过 ${toolName}`)
  }
}
process.exit(totalFails === 0 ? 0 : 0) // 有历史失败是正常现象，不是本工具的失败——退出码始终 0