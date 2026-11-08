// check-plugin-names.mjs — 升级后必跑：每个预设里 `name:` 指向的插件现在还解析得到吗？
//
// 为什么需要它：预设是"一行一个插件"的清单，行里的包名属于**部署版本**。DSH 升级时
// 包可能被改名或合并（0.1.5 的 `dsh-workflow-worker-thread` 在 0.1.6 里叫 `dsh-workflow-ptc`），
// 而预设登记处会把"名字解析不到"的预设判为 **broken**，直接拒绝挂载。
// 表现是"预设还在选择器里，但一开会话就起不来"——没有任何语法错误，YAML 也完全合法。
//
// ═══ 2026-09-22 重写（0.1.7）═══════════════════════════════════════════════════
// 上一版读的是 `$DSH_HOME/.agent-presets/<id>/agent.cordis.yml`。0.1.7 **删掉了**那个目录的
// 自动发现，所以上一版在升级后依然打出 8/8 ✅——**它检查的是一个已经没人读的机制**。
// 这是"断言结构上问不到问题"（F16）的又一次复发，而且这次骗过的正是为升级准备的那张网。
//
// 现在改读**组合后的声明行**（`tools/presets.mjs`，唯一来源），并顺手做两件上一版做不到的事：
//   ① 按 0.1.7 的新规则解析相对路径（基准是**声明它的那一层**的目录，不是预设目录）；
//   ② 与旧目录逐行**对照**，证明迁移没丢东西（按解析后的绝对目标比，绕过路径改写）。
//
// 用法：node test/check-plugin-names.mjs
import { describeInstall, DESKTOP, detectInstall, NPM_DSH, visible } from '../tools/dsh-install.mjs'
import { resolveRowName, flattenRows, pluginNamesOf, userPresets, presetDeclarations, legacyRowsOf, legacyDirOf } from '../tools/presets.mjs'

let fail = 0
const ok = (label, cond, extra) => {
  if (cond) console.log('  ✅', label)
  else { fail += 1; console.log('  ❌', label, extra === undefined ? '' : `→ ${extra}`) }
}

/** 期望存在的用户预设 —— 迁移漏掉一个就会在这里露出来。 */
const EXPECTED = ['anchored-standard', 'router-standard', 'study-planner', 'fact-verify', 'netsec-tutor', 'math-tutor', 'english-tutor', 'code-tutor', 'mind-companion', 'competition-coach']

// ── ⓪ 先声明"我问的是哪个安装"，并把它钉成断言 ──────────────────────────────
// 2026-09-24（桌面端）：机器上同时有桌面端（包在 app.asar 里）与遗留的 npm 副本，而包名解析
// **必须**问正在跑的那个。问错的答案是看不见的错——所以"谁在回答"不能只印一行，要有断言。
const INSTALL = detectInstall()
console.log(`问的安装：${describeInstall(INSTALL)}`)
const desktopPresent = visible(DESKTOP.exe) && visible(DESKTOP.asar)
ok('检测到了一个可用的 DSH 安装（版本读得到）', INSTALL.version !== undefined, `version=${INSTALL.version}`)
if (desktopPresent) {
  ok('桌面端在场时**没有**退回 npm 副本（问错安装 = 假绿）', INSTALL.kind === 'desktop', `实际用了 ${INSTALL.kind}：${INSTALL.root}`)
  ok('  且拿得到它的包清单（asar 只能靠 Electron 读）', INSTALL.packages.length > 0, `${INSTALL.packages.length} 个包`)
} else {
  console.log(`  （未发现桌面端，用 ${INSTALL.kind} 是正确行为）`)
}
if (INSTALL.kind === 'desktop' && visible(NPM_DSH) && INSTALL.version !== undefined) {
  const npmVersion = (() => { try { return JSON.parse(readFileSync(join(NPM_DSH, 'package.json'), 'utf8')).version } catch { return undefined } })()
  if (npmVersion !== undefined && npmVersion !== INSTALL.version) {
    console.log(`  ⚠️  两个安装版本不同：桌面端 ${INSTALL.version} vs npm 副本 ${npmVersion}`)
    console.log('      这就是"问错安装会给出错答案"的现场——正在跑的是桌面端，所以必须问它')
  }
}
console.log('')

const decls = presetDeclarations()
// ★ 2026-11-07：用户预设 = 非 shipped 的声明，**包含随组合包分发的那些**。
//   「总规划」现在只声明在 `@local/dsh-study` 的 bundle patch 里（profile 里没有这一行），
//   只读 profile patch 的旧写法会把它判成"缺少 study-planner"——而选择器里明明有。
//   `userPresets()` 走的是 `presetDeclarations()`，后者已经把 bundle 声明并进来了，
//   所以这里不需要另开一条路（deliveredDeclarations 会把内置预设的转贴副本也带进来，
//   于是"standard 没有显示名"这类假红会冒出来——那是 shipped，不是用户预设）。
const mine = userPresets()
const shipped = decls.filter((d) => d.shipped)

console.log(`预设声明 ${decls.length} 条（shipped ${shipped.length} · 用户 ${mine.length}）`)
console.log(`来源：${decls[0]?.layer ?? '?'}\n`)

// ── ① 用户预设一个都不能少 ──────────────────────────────────────────────────
const ids = mine.map((d) => d.id)
const missing = EXPECTED.filter((id) => !ids.includes(id))
ok(`10 个用户预设都在声明里（${ids.length} 条）`, missing.length === 0, `缺少 ${missing.join('、')}`)
const noName = mine.filter((d) => typeof d.name !== 'string' || d.name.length === 0)
ok('每个用户预设都有显示名（没有的话选择器里是一串 id）', noName.length === 0, noName.map((d) => d.id).join('、'))
const noOrder = mine.filter((d) => typeof d.order !== 'number')
ok('每个用户预设都有 order（没有的话排序随机）', noOrder.length === 0, noOrder.map((d) => d.id).join('、'))

// ── ② 每个 name 都解析得到（F2 本体）──────────────────────────────────────
const broken = []
console.log('')
for (const d of [...mine, ...shipped]) {
  const rows = flattenRows(d.plugins)
  const names = pluginNamesOf(d)
  const bad = []
  for (const n of names) {
    const res = resolveRowName(n, { baseDir: d.baseDir })
    if (!res.ok) bad.push(`${n} — ${res.detail}`)
  }
  const tag = d.shipped ? 'shipped' : '用户  '
  if (bad.length === 0) console.log(`■ ${tag} ${d.id.padEnd(20)} ✅ ${names.length} 个 name 全部可解析（${rows.length} 行）`)
  else {
    broken.push(d.id)
    console.log(`■ ${tag} ${d.id.padEnd(20)} ❌ ${bad.length} 个解析不到 → 该预设会被判 broken、无法挂载`)
    for (const b of bad) console.log(`     · ${b}`)
  }
}
ok(`全部 ${decls.length} 条预设声明的插件名都可解析`, broken.length === 0, broken.join(', '))

// ── ③ 迁移保真：与旧目录逐行对照 ───────────────────────────────────────────
// 0.1.7 之后旧目录**不再被读取**，所以这里不是"检查旧机制"，而是"证明搬迁没丢东西"。
// 比对用**解析后的目标**而不是名字字面：迁移按文档改写过路径
// （`./x.mjs` -> `../../.agent-presets/<id>/x.mjs`，`C:/…/.dsh/<p>` -> `../../<p>`），
// 拿字面比会满屏假差异。
console.log('\n迁移保真（旧目录 → 声明行）')
const identity = (name, baseDir) => {
  const res = resolveRowName(name, { baseDir })
  if (res.kind === 'file') return `file:${(res.target ?? name).toLowerCase()}`
  if (res.kind === 'builtin') return `builtin:${name}`
  return `pkg:${res.target ?? name}`
}
let comparedCount = 0
let driftCount = 0
for (const d of mine) {
  const legacy = legacyRowsOf(d.id)
  if (legacy === undefined) { console.log(`  ⏭️  ${d.id}：没有旧目录（本就是这个格式写的），跳过对照`); continue }
  comparedCount += 1
  const before = new Set(flattenRows(legacy).map((r) => identity(r.name, legacyDirOf(d.id))))
  const after = new Set(flattenRows(d.plugins).map((r) => identity(r.name, d.baseDir)))
  const lost = [...before].filter((x) => !after.has(x))
  const added = [...after].filter((x) => !before.has(x))
  if (lost.length === 0 && added.length === 0) console.log(`  ✅ ${d.id}：${before.size} 行逐一对应，无增无减`)
  else {
    driftCount += 1
    console.log(`  ⚠️  ${d.id}：旧 ${before.size} 行 / 新 ${after.size} 行`)
    for (const l of lost.slice(0, 6)) console.log(`       少了：${l}`)
    for (const a of added.slice(0, 6)) console.log(`       多了：${a}`)
  }
}
ok(`对照了 ${comparedCount} 个预设有旧目录可比的预设`, comparedCount > 0, '一个都没比上——旧目录是不是被删了？')
console.log(`  （${driftCount} 个存在差异；差异不一定是错——迁移时可以有意增删行，但值得逐条看一眼）`)

process.exit(fail === 0 ? 0 : 1)