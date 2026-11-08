// prompt-render-probe.mjs — **由正在跑的那个安装自己执行**的探针：
//   ① 它现在注册了哪些 system prompt 变量？（扫源码，不写死清单）
//   ② 现有 profile 里的预设 persona，用它**自己那份** renderPrompt 渲染得出来吗？
//
// 为什么必须问安装自己（2026-10-17 的真实事故）：
//   桌面端 0.1.7-rc.1 → 0.2.1-rc.1 升级后，`dsh-agent-loop` 里的 `cwd` 变量注册被删了
//   （0.1.7 注册 provider/model/cwd 三个，0.2.1 只剩 provider/model）。而 7 个用户预设的
//   persona 开头都写着「由 {{model}} 驱动，工作目录 {{cwd}}」。症状是：
//     YAML 合法、插件名全解析、1134 条断言全绿，但**一开这些预设的会话就抛**
//     `unknown prompt variable "{{cwd}}" in section "deployment:persona-prefix"`。
//   报错发生在**装配**时（每条消息），不在加载时——所以"能解析"什么都没证明。
//
// 变与不变：
//   · 变量清单**不写死**：每次扫安装里 `@deepseek-ai/*` 的 `lib/`（+`dist/`），找
//     `systemPrompt.variable('x', …)`。升级后多认/少认变量，这里跟着变。
//   · 渲染用安装里**那份真的** `dsh-system-prompt` 的 `renderPrompt()`，不是重写的近似实现。
//   · 三个正控制保证结论不是空的：① 已注册变量必须渲染成功；② 必然未注册的名字必须抛
//     unknown；③ 非法名字必须抛 malformed。②③ 若都不抛，说明根本没走真插值，"全绿"是假的。
//
// 由 test/check-prompt-variables.mjs 调用（也可手工跑）：
//   ELECTRON_RUN_AS_NODE=1 "D:/DSH/DeepSeek Harness.exe" \
//     tools/prompt-render-probe.mjs <packagesDir> <payloadJsonPath>
//   npm 安装：node tools/prompt-render-probe.mjs <packagesDir> <payloadJsonPath>
// 输出：stdout 最后一行是 JSON（宿主只解析那一行），诊断走 stderr。
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [packagesDir, payloadPath] = process.argv.slice(2)
const out = { ok: false, packagesDir, variables: [], registrations: [], personas: [], controls: {}, errors: [] }
const log = (...a) => console.error(...a)

try {
  if (packagesDir === undefined || payloadPath === undefined) {
    throw new Error('用法：prompt-render-probe.mjs <packagesDir> <payloadJsonPath>')
  }
  const payload = JSON.parse(readFileSync(payloadPath, 'utf8'))

  // ── ① 当前安装注册了哪些变量 ────────────────────────────────────────────────
  // DSH 的插件都编译到 lib/（未来若有 dist 也一并看）。跳过 node_modules 与 .bak。
  const REG = /systemPrompt\.variable\(\s*["']([a-z][a-z0-9_]*)["']/g
  const walk = (dir, pkg) => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name.endsWith('.bak')) continue
      const p = join(dir, e.name)
      if (e.isDirectory()) { walk(p, pkg); continue }
      if (!/\.(js|mjs|cjs)$/.test(e.name)) continue
      let text
      try {
        if (statSync(p).size > 4 * 1024 * 1024) continue
        text = readFileSync(p, 'utf8')
      } catch { continue }
      let m
      REG.lastIndex = 0
      while ((m = REG.exec(text)) !== null) {
        out.registrations.push({ pkg, file: p, line: text.slice(0, m.index).split('\n').length, name: m[1] })
      }
    }
  }
  for (const e of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('.') || e.name.endsWith('.bak')) continue
    walk(join(packagesDir, e.name, 'lib'), e.name)
    walk(join(packagesDir, e.name, 'dist'), e.name)
  }
  out.variables = [...new Set(out.registrations.map((r) => r.name))].sort()
  log(`注册变量 ${out.variables.length} 个：${out.variables.join(', ') || '(无)'}（来自 ${new Set(out.registrations.map((r) => r.pkg)).size} 个包）`)

  // ── ② 用安装里那份真的 renderPrompt 渲染 ────────────────────────────────────
  const sp = await import(pathToFileURL(join(packagesDir, 'dsh-system-prompt', 'lib', 'index.js')).href)
  out.renderPromptType = typeof sp.renderPrompt
  if (typeof sp.renderPrompt !== 'function') {
    throw new Error('安装里的 dsh-system-prompt 没有导出 renderPrompt——不能验证，而这本身就是一次升级后的接口变化')
  }

  const sample = Object.fromEntries(out.variables.map((v) => [v, `${v}-value`]))
  const render = (text) => {
    try {
      const rendered = sp.renderPrompt({ sections: [{ name: 'deployment:persona-prefix', text }], variables: sample })
      return { ok: true, rendered }
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) }
    }
  }

  // 正控制①：只引用一个已注册变量 → 必须渲染成功（否则说明探针或接口坏了）
  const only = out.variables[0]
  out.controls.registeredOk = only === undefined
    ? { ok: false, error: '一个注册变量都没扫到' }
    : render(`由 {{${only}}} 驱动。`)
  // 正控制②：一个必然未注册的名字 → 必须抛 unknown（否则说明没走真插值）
  let ghost = 'probe_ghost_variable'
  while (out.variables.includes(ghost)) ghost += '_x'
  out.controls.ghost = ghost
  out.controls.unknownRejected = render(`工作目录 {{${ghost}}}。`)
  // 正控制③：名字不合法（含空格）→ 必须抛 malformed
  out.controls.malformedRejected = render('{{bad name}}')

  // 被测对象：每个预设的 persona 文本（由调用方从**现在的** profile patch 里取出来）
  for (const p of payload.personas ?? []) {
    const r = render(p.text)
    out.personas.push({ profile: p.profile, preset: p.preset, ok: r.ok, error: r.error, rendered: r.ok ? r.rendered : undefined })
  }
  out.ok = true
} catch (error) {
  out.errors.push(String(error?.message ?? error))
}
process.stdout.write(`${JSON.stringify(out)}\n`)
