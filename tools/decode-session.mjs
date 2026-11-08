// decode-session.mjs — 把会话日志（`session.v3.jsonl.zstd`）解成人能读的事件流。
//
// 为什么需要它：整套伴学插件的"证据链"最终落在这里——工具到底被调用了几次、回执是什么、
// 模型当时看到了什么。没有这个工具时，只能靠模型自己的复述去猜（之前就是这么误判了两回）。
//
// 关键坑（踩过一次，记在这里）：`session.v3.jsonl.zstd` 里是**多个 zstd 帧首尾相接**，
// `zstdDecompressSync` 只解**第一帧**，于是日志看起来"被截断、没有工具结果"。必须自己扫
// 魔数 `28 B5 2F FD` 把每一帧切出来分别解。
//
// 用法：
//   node tools/decode-session.mjs --list [N]            最近的 N 个会话（默认 10）
//   node tools/decode-session.mjs --grep code_run [N]   最近 N 个会话里提到 code_run 的事件
//   node tools/decode-session.mjs <sessionId> [--grep X]

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'

const SESSIONS_ROOT = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'sessions')
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 扫出所有帧并逐一解压；任何一帧解不开就跳过它，不让它带走整个会话。 */
export function decodeSessionFile(abs) {
  const raw = readFileSync(abs)
  const starts = []
  for (let i = 0; i + 4 <= raw.length; i += 1) {
    if (raw[i] === MAGIC[0] && raw[i + 1] === MAGIC[1] && raw[i + 2] === MAGIC[2] && raw[i + 3] === MAGIC[3]) starts.push(i)
  }
  if (starts.length === 0) return { frames: 0, badFrames: 0, lines: [], text: '' }
  const parts = []
  let badFrames = 0
  for (let f = 0; f < starts.length; f += 1) {
    const end = f + 1 < starts.length ? starts[f + 1] : raw.length
    try {
      parts.push(zstdDecompressSync(raw.subarray(starts[f], end)))
    } catch {
      badFrames += 1
    }
  }
  const text = Buffer.concat(parts).toString('utf8')
  const lines = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (t.length === 0) continue
    try {
      lines.push(JSON.parse(t))
    } catch {
      lines.push({ __unparsed: t.slice(0, 200) })
    }
  }
  return { frames: starts.length, badFrames, lines, text }
}

/** 收集所有会话文件，按修改时间倒序。 */
export function listSessions() {
  return listSessionFiles(SESSIONS_ROOT)
}

/**
 * 会话日志的文件名形如 `session.jsonl.zstd`（v0~v2）、`session.v3.jsonl.zstd`、`session.v4.jsonl.zstd`……
 *
 * ★ **别把版本号写死**。2026-09-23（0.1.7-rc.1）实测：日志已升到 **v4**，`session.v4.jsonl.zstd`
 *   出现了 15 个，而本文件与 `study-doctor.mjs` 当时都硬编码着 `session.v3.…`——结果新会话
 *   对它们**完全隐形**（doctor 少算十几个会话、解码器一个新会话都找不到），而且**不会报错**。
 *   这与 F21 同类：输入老了，检查还在跑，绿着，但看的是旧东西。
 *
 * 容器格式本身没跟着变：仍是 zstd 多帧 + JSONL，事件仍是 `{type, seq, time, data}`。
 * 所以真正需要版本无关的**只有文件名**。
 */
export const SESSION_FILE_RE = /^session(?:\.v\d+)?\.jsonl\.zstd$/

/** **一处**知道会话日志住在哪、叫什么。 */
export function listSessionFiles(root = SESSIONS_ROOT) {
  const out = []
  let groups
  try {
    groups = readdirSync(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const g of groups) {
    if (!g.isDirectory()) continue
    const gdir = join(root, g.name)
    let sessions
    try {
      sessions = readdirSync(gdir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const s of sessions) {
      if (!s.isDirectory()) continue
      let files
      try {
        files = readdirSync(join(gdir, s.name))
      } catch {
        continue
      }
      // 一个会话目录正常只有一个日志文件；真有多个就按版本号取最新的那个。
      const log = files
        .filter((f) => SESSION_FILE_RE.test(f))
        .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
        .pop()
      if (log === undefined) continue
      const abs = join(gdir, s.name, log)
      let st
      try {
        st = statSync(abs)
      } catch {
        continue
      }
      out.push({ id: s.name, group: g.name, abs, file: log, mtime: st.mtimeMs, bytes: st.size })
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime)
}

/**
 * 只读一个会话的**头**（第一帧的第一行），跳过其余帧。
 *
 * 头里有 cwd / createdAt / `agentPreset`（**创建时**的值，中途换过预设的会话不会更新它）。
 * 只解第一帧是刻意的：一个日志可以几 MB、几百帧，而"数一数谁用了什么预设"只接头。
 */
export function readSessionHeader(abs) {
  const raw = readFileSync(abs)
  const end = raw.indexOf(MAGIC, 4) // 第二帧的起点 = 第一帧的终点
  try {
    const text = zstdDecompressSync(end > 0 ? raw.subarray(0, end) : raw).toString('utf8')
    return JSON.parse(text.split('\n')[0])
  } catch {
    return undefined
  }
}

/**
 * 从一条日志行里取出 `{type, data}`。
 *
 * **坑**：持久化的事件是**包了一层**的 —— `{type, seq, time, data:{turn, step, name, …}}`，
 * 而不是事件类型声明里的扁平形状。第一版按扁平形状读，于是每个 `tool/call` 的
 * `name` 都读出 `undefined`，看着像"日志里没有工具名"。取 data 时保留顶层兜底，
 * 免得将来某一类事件不包这层就整个读不出来。
 */
export function fields(ev) {
  const d = ev?.data
  return d !== null && typeof d === 'object' && !Array.isArray(d) ? { ...ev, ...d } : { ...ev }
}

/** 一条事件压成一行可读文本；认不出的类型返回 undefined（由调用方决定要不要显示）。 */
export function summarize(ev) {
  const t = ev?.type
  if (t === undefined) return undefined
  const e = fields(ev)
  const flat = (m) => {
    const content = Array.isArray(m?.content) ? m.content : []
    return content
      .map((c) => (typeof c === 'string' ? c : c?.text ?? (c?.type === 'tool-result' ? '' : `[${c?.type ?? '?'}]`)))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
  }
  if (t === 'tool/call') return `[tool/call] ${e.name} ${String(e.arguments ?? '').replace(/\s+/g, ' ').slice(0, 400)}`
  if (t === 'tool/result') {
    const err = e.error === undefined ? '' : ` ⚠️ERROR=${JSON.stringify(e.error)}`
    return `[tool/result]${err} ${flat(e.message).slice(0, 800)}`
  }
  if (t === 'assistant/message') return `[assistant] ${flat(e.message).slice(0, 700)}`
  if (t === 'user/message') return `[user] ${flat(e.message).slice(0, 300)}`
  // 这条才是"这个会话实际跑在哪个预设上"的权威记录（会话头的 agentPreset 是**创建时**的默认值）。
  if (t === 'agent-preset/selected') return `[★预设] ${JSON.stringify(e).slice(0, 300)}`
  if (t === 'model/selection') return `[模型] ${JSON.stringify(e).slice(0, 200)}`
  if (t === 'system/message') return `[system] ${flat(e.message).slice(0, 200)}`
  return undefined
}

// ── CLI ─────────────────────────────────────────────────────────────────────
/**
 * ★ 只有**本文件被当作入口运行**时才跑 CLI。
 *
 * 这里踩过一次：原来的判断是 `argv.length > 0 || 文件名以 decode-session.mjs 结尾`——
 * 于是**任何**带参数的脚本 import 本模块（比如 tools/tool-timeline.mjs 传 --tool code_run）
 * 都会触发这里的 CLI，把不相干的会话列表打到别人的输出里，而且退出码还会 `process.exit()`
 * 把调用方一起带走。判断入口必须用 `import.meta.url`，不能用"有没有参数"。
 */
const isEntry = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href

if (isEntry) {
  const argv = process.argv.slice(2)
  const grepIdx = argv.indexOf('--grep')
  const needle = grepIdx >= 0 ? argv[grepIdx + 1] : undefined
  const listMode = argv.includes('--list')
  const positional = argv.filter((a, i) => !a.startsWith('--') && i !== grepIdx + 1)
  const n = Number(positional.find((p) => /^\d+$/.test(p)) ?? 10)
  const idArg = positional.find((p) => /^session-/.test(p))

  const all = listSessions()
  const targets = idArg !== undefined ? all.filter((s) => s.id === idArg) : all.slice(0, n)
  if (targets.length === 0) {
    console.log('(没有找到会话)')
    process.exit(0)
  }
  for (const s of targets) {
    const d = decodeSessionFile(s.abs)
    const header = d.lines.find((l) => l.type === 'session/header' || l.header !== undefined) ?? d.lines[0]
    const when = new Date(s.mtime).toISOString().replace('T', ' ').slice(0, 19)
    console.log(`\n===== ${s.id} =====`)
    console.log(`  文件 ${s.bytes} B · ${d.frames} 帧（坏帧 ${d.badFrames}） · ${d.lines.length} 行 · 改动 ${when}`)
    console.log(`  目录 ${s.group}`)
    if (header !== undefined) console.log(`  头部 ${JSON.stringify(header).slice(0, 400)}`)
    if (listMode) continue
    let hits = 0
    for (const ev of d.lines) {
      const line = summarize(ev)
      if (line === undefined) continue
      if (needle !== undefined && !line.includes(needle)) continue
      hits += 1
      console.log(`  ${line}`)
    }
    if (needle !== undefined) console.log(`  —— 命中 ${hits} 条`)
  }
}