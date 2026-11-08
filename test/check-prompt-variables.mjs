// check-prompt-variables.mjs — 升级后必跑（也进 run-all）：预设文本引用的 {{变量}}，当前安装还认吗？
//
// ═══ 2026-10-17 的事故（这条检查就是为它写的）══════════════════════════════════
// 桌面端从 0.1.7-rc.1 升级到 0.2.1-rc.1 后，`dsh-agent-loop` 里 `cwd` 那行变量注册被删了：
//   · 0.1.7：`systemPrompt.variable('provider'|'model'|'cwd', …)` —— 三个
//   · 0.2.1：只剩 `provider`、`model`
// 而 7 个用户预设的 persona 开头都写着「由 {{model}} 驱动，工作目录 {{cwd}}」。
// 症状是**最坏的一种**：预设 YAML 合法、插件名全解析、preset 选择器里照常显示，
// 1134 条断言全绿——但**一开这些预设的会话就抛**
//   `unknown prompt variable "{{cwd}}" in section "deployment:persona-prefix"; registered variables: provider, model`
// 关键：这个报错在**装配**（每条消息）时抛出，不在加载时。所以"能解析"什么都没证明，
// 连 check-preset-yml（它问的是"persona 块能不能解析"）也看不见它。
//
// ═══ 这条检查问三件事，全部问**现在这个安装** ═════════════════════════════════
//   ① 它注册了哪些 prompt 变量 —— 扫源码（tools/prompt-render-probe.mjs），不写死清单；
//   ② 每个 profile 里每条预设 persona —— 用**安装自己的** renderPrompt 真渲染一遍；
//   ③ 预设配置里所有 {{变量}} 引用 —— 名字在注册表里、格式合法吗。
// 探针自带三个正控制（已注册变量能渲染 / 未注册变量被拒 / 非法名字被拒）——
// 防止"全绿"其实是因为没扫到东西（F16：断言结构上问不到问题）。
//
// 用法：
//   node test/check-prompt-variables.mjs
//   node test/check-prompt-variables.mjs --profiles <目录>   # 证伪用：指向一份坏 profile
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { detectInstall, describeInstall } from '../tools/dsh-install.mjs'
import { DSH_HOME, flattenRows, personaPrefixOf, profilePatchDeclarations, resolveRowName } from '../tools/presets.mjs'

const PKG = dirname(dirname(fileURLToPath(import.meta.url)))
let pass = 0
let fail = 0
const ok = (label, cond, extra) => {
  if (cond) { pass += 1; console.log('  ✅', label) }
  else { fail += 1; console.log('  ❌', label, extra === undefined ? '' : `→ ${extra}`) }
}
const lineOf = (error) => String(error?.message ?? error).split('\n')[0]

// ── ⓪ 决定扫哪些 profile ─────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const at = argv.indexOf('--profiles')
const profilesRoot = at >= 0 ? argv[at + 1] : join(DSH_HOME, 'profiles')
if (profilesRoot === undefined || !existsSync(profilesRoot)) {
  console.log(`❌ 找不到 profile 目录：${profilesRoot}`)
  process.exit(1)
}
const profiles = readdirSync(profilesRoot, { withFileTypes: true })
  .filter((e) => e.isDirectory() && existsSync(join(profilesRoot, e.name, 'cordis.patch.yml')))
  .map((e) => e.name)
  .sort()
console.log(`\n扫的 profile：${profiles.join('、') || '(无)'}  @ ${profilesRoot}`)

// ── ① 收集：预设声明 → persona 文本 + 所有 {{变量}} 引用 + 本地插件注册的变量 ──
const personas = []
const refs = []
const localVars = new Set()
const scanStrings = (value, path, sink) => {
  if (typeof value === 'string') { sink(value, path); return }
  if (Array.isArray(value)) { value.forEach((v, i) => scanStrings(v, `${path}[${i}]`, sink)); return }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) scanStrings(v, path === '' ? k : `${path}.${k}`, sink)
  }
}
let declCount = 0
for (const profile of profiles) {
  const patch = join(profilesRoot, profile, 'cordis.patch.yml')
  const dir = join(profilesRoot, profile)
  let decls
  try {
    decls = profilePatchDeclarations({ patch, dir })
  } catch (error) {
    fail += 1
    console.log(`  ❌ ${profile}: profile patch 解析失败 → ${lineOf(error)}`)
    continue
  }
  declCount += decls.length
  for (const d of decls) {
    const prefix = personaPrefixOf(d)
    if (typeof prefix === 'string') personas.push({ profile, preset: d.id, text: prefix })
    scanStrings(d.plugins, `${profile}/${d.id}`, (text, path) => {
      for (const m of text.matchAll(/\{\{([^{}]*)\}\}/g)) {
        refs.push({ profile, preset: d.id, path, raw: m[0], name: m[1] })
      }
    })
    // 预设行里若有本地插件文件（`name:` 是路径），它也可能注册变量——也扫进来，避免误报。
    for (const row of flattenRows(d.plugins)) {
      const res = resolveRowName(row.name, { baseDir: d.baseDir })
      if (!res.ok || res.kind !== 'file' || res.target === undefined) continue
      try {
        for (const m of readFileSync(res.target, 'utf8').matchAll(/systemPrompt\.variable\(\s*["']([a-z][a-z0-9_]*)["']/g)) localVars.add(m[1])
      } catch { /* 读不到就不算——安装扫描仍是主来源 */ }
    }
  }
}
console.log(`预设声明 ${declCount} 条 · persona ${personas.length} 条 · {{变量}} 引用 ${refs.length} 处${localVars.size > 0 ? ` · 本地插件注册 ${[...localVars].join('、')}` : ''}`)

// ── ② 让**安装自己**回答（它认哪些变量；这些 persona 渲染得出来吗）────────────
const install = detectInstall()
console.log(`\n问的是：${describeInstall(install)}`)
const probe = join(PKG, 'tools', 'prompt-render-probe.mjs')
const tmp = mkdtempSync(join(tmpdir(), 'dsh-prompt-probe-'))
let report
try {
  const payloadPath = join(tmp, 'payload.json')
  writeFileSync(payloadPath, JSON.stringify({ personas }), 'utf8')
  const stdout = execFileSync(install.launcher.bin, [probe, install.packagesDir, payloadPath], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...install.launcher.env },
    maxBuffer: 64 * 1024 * 1024,
    timeout: 180_000,
  })
  const line = stdout.split('\n').reverse().find((l) => l.trim().startsWith('{'))
  if (line === undefined) throw new Error(`探针没有输出 JSON；stdout 前 300 字：${stdout.slice(0, 300)}`)
  report = JSON.parse(line)
} catch (error) {
  fail += 1
  console.log(`  ❌ 探针没跑起来 → ${lineOf(error)}`)
  const stderr = String(error?.stderr ?? '').trim()
  if (stderr.length > 0) console.log(`     stderr: ${stderr.split('\n').slice(-4).join(' | ')}`)
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

// ── ③ 断言 ───────────────────────────────────────────────────────────────────
if (report !== undefined) {
  const vars = Array.isArray(report.variables) ? report.variables : []
  const allowed = new Set([...vars, ...localVars])

  console.log('')
  ok('探针跑通、报告完整', report.ok === true, (report.errors ?? []).join('; '))
  ok(
    vars.length > 0
      ? `安装注册的变量：${vars.join('、')}（来自 ${new Set((report.registrations ?? []).map((r) => r.pkg)).size} 个包）`
      : '安装注册的变量：(一个都没扫到——清单不可信，不能拿它判预设)',
    vars.length > 0,
    '扫不到变量时判"预设没问题"是假绿，所以这里直接红',
  )

  // 正控制：证明真插值真的在被调用
  ok('正控制①：已注册变量能渲染', report.controls?.registeredOk?.ok === true, report.controls?.registeredOk?.error)
  const ghost = report.controls?.ghost ?? 'probe_ghost_variable'
  ok(
    `正控制②：未注册变量 {{${ghost}}} 被拒`,
    report.controls?.unknownRejected?.ok === false && String(report.controls?.unknownRejected?.error).includes('unknown prompt variable'),
    report.controls?.unknownRejected?.ok === true ? '没有报错——插值没走真代码，后面的"通过"不可信' : report.controls?.unknownRejected?.error,
  )
  ok(
    '正控制③：非法变量名被拒（malformed）',
    report.controls?.malformedRejected?.ok === false && String(report.controls?.malformedRejected?.error).includes('malformed'),
    report.controls?.malformedRejected?.error,
  )

  // 引用检查：每条 {{变量}} 都要格式合法、且在注册表里
  const badRefs = refs.filter((r) => !/^[a-z][a-z0-9_]*$/.test(r.name) || !allowed.has(r.name))
  ok(
    `配置里 ${refs.length} 处 {{变量}} 引用全部是当前安装注册的`,
    badRefs.length === 0 && refs.length > 0,
    badRefs.length > 0
      ? badRefs.slice(0, 6).map((r) => `${r.profile}/${r.preset} ${r.raw}（${r.path}）`).join('；')
      : '一处都没扫到——这条检查没问到东西（F16）',
  )

  // persona 渲染：用安装自己的 renderPrompt 真渲染
  const badPersonas = (report.personas ?? []).filter((p) => !p.ok)
  ok(
    `${(report.personas ?? []).length} 条 persona 用安装自己的 renderPrompt 全部渲染成功`,
    badPersonas.length === 0 && (report.personas ?? []).length > 0,
    badPersonas.length > 0
      ? badPersonas.slice(0, 4).map((p) => `${p.profile}/${p.preset}: ${p.error}`).join('；')
      : '一条 persona 都没测到——profile 里没有预设声明？',
  )

  // 非空覆盖：persona 与引用都得真的来自 profile
  ok(
    `覆盖非空：${personas.length} 条 persona（${new Set(personas.map((p) => p.profile)).size} 个 profile）都被实际检查`,
    personas.length > 0 && refs.length > 0,
    '0 条 = 读错了文件或 profile 里没有预设',
  )
}

// ── 汇总 ─────────────────────────────────────────────────────────────────────
console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
