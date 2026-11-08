// study-doctor.mjs — 学习系统的分层体检：出问题时**一条命令**告诉你坏在哪一层。
//
// 为什么需要它：2026-09-17 那次升级，症状是"预设打不开"，但**没有任何地方说得出为什么** ——
// 定位到"包改名了"花了十几步。凡是"要靠人一路猜"的东西，都不算可运维。
//
// 分层（自下而上，越靠下越基础）：
//   层 0 版本      当前 DSH 与这套系统声明的版本
//   层 1 插件文件   7 个 .js 存在、能被 import、导出数正常
//   层 2 预设       **组合后的声明行**里每个 name 都能解析（← check-plugin-names.mjs）
//                  + 报告"声明于哪一层"（相对路径的基准就是它）+ 会话使用面
//   层 3 组合树     web profile 能 compose，且宿主行在里面（← dsh --dump-config）
//   层 4 守护接线   三个守护注册没有、被调用过没有（← .health/*.json，插件自己写的痕迹）
//                  + 工具回执契约（← verify-tool-output.mjs --quick）
//   层 5 数据协议   各科档案 + 复习提纲合法且没超页（← check-migration.mjs）
//   层 6 注入       只能在会话内探（doctor 打印探针步骤，不替你做）
//
// ⚠️ 2026-09-22（0.1.7）：本层 **2** 的输入换过一次。以前读 `.agent-presets/<id>/agent.cordis.yml`
//    那个目录，而 0.1.7 起它已经没有任何代码读了——于是体检会**全绿而预设其实已失效**。
//    现在统一走 `tools/presets.mjs`（唯一来源）。教训见失效模式 F21：换机制时，
//    要重审的不是路径，是**检查的输入本身**。
//
// 用法：
//   node study-doctor.mjs              全跑
//   node study-doctor.mjs --fast       跳过层 3（要起 dsh 子进程，最慢）
// 它**只读**，不改任何文件；退出码 0 = 全绿。
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// 复用插件自己的读取探针（那里已经区分了"没有"和"读不到"）——规则只有一份。
const { readProbe, archiveHygiene, planHygiene, classNotesHygiene, archiveStamp } = await import(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'plan-core.js')).href)
// 预设声明的**唯一读取点**（0.1.7 起预设不再是目录，见 tools/presets.mjs 的头注）。
const { userPresets, presetDeclarations, LEGACY_DIR } = await import(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'tools', 'presets.mjs')).href)
// 会话日志的**唯一读取点**（文件名不写死版本号，见那里的头注）。
const { listSessionFiles, readSessionHeader } = await import(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'tools', 'decode-session.mjs')).href)

// **包目录自己**是一切相对路径的锚点：测试与清单都搬进包里了（见 package.json 的 scripts）。
// 这条以前写死的是工作区路径——插件搬家之后它就指错了地方，而 doctor 是"出问题了才跑"的东西，
// 指错地方最难发现。
const PKG = dirname(fileURLToPath(import.meta.url))
const PLUGINS = `${PKG.replaceAll('\\', '/')}/`
// ⚠️ 这是 **0.1.6 及以前** 的预设家目录。0.1.7 起**没有任何代码读它**——所以 doctor 不再拿它
//    判断"预设有几个"，只在迁移保真对照里用到（见 layer 2 的说明）。
const PRESETS = LEGACY_DIR
// ★ 2026-09-24（桌面端）：`DSH` 不能再写死 npm 那个路径——机器上同时有桌面端（0.1.7-rc.2，
//   包在 app.asar 里）与遗留的 npm 副本（0.1.7-rc.1），写死一个就是**问错安装**。
//   探测与"怎么跑它"都在 tools/dsh-install.mjs（一处收口）。见那里的头注。
const { detectInstall, describeInstall, runDsh } = await import(pathToFileURL(join(PKG, 'tools', 'dsh-install.mjs')).href)
const INSTALL = detectInstall()
const DSH = INSTALL.root
const ST = process.env.DSH_STUDY_ROOT ?? join(process.cwd(), 'ST')

/** 本系统声明的 dsh 版本范围——**从 package.json 读**，不在这里再抄一遍。 */
const ENGINES_DSH = (() => {
  try { return JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')).engines?.dsh } catch { return undefined }
})()

const fast = process.argv.includes('--fast')
const results = [] // { layer, label, status: 'ok'|'warn'|'bad'|'skip', detail }

const add = (layer, label, status, detail) => results.push({ layer, label, status, detail })

// ── 层 0 版本 ───────────────────────────────────────────────────────────────
// ⚠️ `engines.dsh` **没有任何内置机制会强制它**（2026-09-18 查过：dsh 的 JS 里没有一处读 engines，
//    `dsh-free-search` 那份 compatibility 表也是市场用的元数据）。所以**这里是唯一的执行点**——
//    doctor 不读它，就没人读了。这也是为什么它值得单列一层。
try {
  // 版本读数来自**探测出来的那个安装**；把它连同"我是谁"一起报出来——
  // 问错安装的答案是看不见的错，所以必须写在输出里。
  const v = INSTALL.version ?? '(读不到)'
  const range = ENGINES_DSH
  if (range === undefined) {
    add(0, '版本', 'warn', `dsh ${v}；但包里的 package.json 没写 engines.dsh，兼容性无从判断`)
  } else {
    const min = /(\d+\.\d+\.\d+)/.exec(range)?.[1]
    // ★ 2026-10-17 修：原来用 `v.startsWith(min)` 判「满足」，那等于要求主版本号前缀一致——
    //   只在 0.1.7 时代成立。升级到 0.2.1-rc.1 后，`engines.dsh = ">=0.1.7-alpha.1"` 明明
    //   语义上被满足，doctor 却报「对不上」；而前一天它还因为缓存装着旧版本号而**看不见升级**。
    //   两处一起修：按数值逐段比较（忽略 prerelease），并把版本号来源打在输出里。
    const parse = (s) => {
      const m = /^(\d+)\.(\d+)\.(\d+)/.exec(s ?? '')
      return m === null ? undefined : [Number(m[1]), Number(m[2]), Number(m[3])]
    }
    const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
    const a = parse(v)
    const b = parse(min)
    const same = a !== undefined && b !== undefined && cmp(a, b) >= 0
    add(0, '版本', same ? 'ok' : 'warn', `dsh ${v}（${describeInstall(INSTALL)}）；声明 engines.dsh = "${range}"${same ? '' : ' —— **对不上**（当前版本低于声明的最低版本），先按 §19 的升级差异清单逐条对一遍'}`)
  }
} catch (e) {
  add(0, '版本', 'bad', `读不到 dsh 版本：${e.message}`)
}

// ── 层 1 插件文件 ───────────────────────────────────────────────────────────
const PLUGIN_NAMES = ['plan-core', 'companion-core', 'file-guard', 'study-judge', 'code-run', 'netsec-range', 'study-suite']
{
  const parts = []
  let bad = 0
  for (const n of PLUGIN_NAMES) {
    const f = `${PLUGINS}${n}.js`
    if (!existsSync(f)) { parts.push(`${n} 缺失`); bad += 1; continue }
    try {
      const m = await import(pathToFileURL(f).href)
      parts.push(`${n} ${Object.keys(m).length}`)
    } catch (e) {
      parts.push(`${n} 加载失败(${e.message.slice(0, 40)})`)
      bad += 1
    }
  }
  add(1, '插件文件', bad === 0 ? 'ok' : 'bad', `${PLUGIN_NAMES.length - bad}/${PLUGIN_NAMES.length} 可加载 · ${parts.join(' · ')}`)
}

// ── 把已有的检查脚本当子层跑，收它们的 ❌ 行 ────────────────────────────────
function runScript(rel, args = []) {
  try {
    const out = execFileSync(process.execPath, [join(PKG, rel), ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { code: 0, out }
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}
const badLines = (out) => out.split('\n').filter((l) => l.includes('❌')).map((l) => l.trim()).slice(0, 4)

// ── 层 2 预设 ───────────────────────────────────────────────────────────────
{
  // ★★ 2026-10-09：**先问"我在检查哪一份"**，再检查那份的内容。
  //   这一层以前直接开始数声明、查名字，全程**不知道**自己读的是 `profiles/web`，
  //   而学员界面跑的是 `profiles/desktop` → 整整两周 9 项规则没投递，而这一层全绿。
  //   所以"对象"这一条必须排在任何内容检查**之前**：对象错了，后面全绿也没有意义。
  //   判据与 test/check-profile-live.mjs 同源（同一个探测模块），避免两处各有一套说法。
  try {
    const lp = await import(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'tools', 'live-profile.mjs')).href)
    const info = lp.detectProfile()
    // ★ 用**现查的进程表**，不用 `info.running`——缓存/环境变量分支下它是空的或未经核实的。
    //   （与 test/check-profile-live.mjs 同一条纪律：判据要落在独立证据上。）
    const running = [...new Set(lp.runningProfiles().map((r) => r.profile))]
    if (running.length > 0 && !running.includes(info.profile)) {
      add(2, 'profile 投递', 'bad',
        `工具链读的是 **${info.profile}**（依据 ${info.source}），而活着的进程用的是 **${running.join('、')}**` +
        ' ——我改的那份不是学员收到的那份（2026-10-09 事故的形状）')
    } else if (running.length > 0) {
      add(2, 'profile 投递', 'ok', `读的是 profiles/${info.profile}，与活着的进程一致（${running.join('、')}）`)
    } else {
      add(2, 'profile 投递', 'warn', `没有可问的进程，按 ${info.source} 取 profiles/${info.profile} ——**这条没验**`)
    }
  } catch (error) {
    add(2, 'profile 投递', 'bad', `profile 探测失败：${String(error?.message ?? error).split('\n')[0]}`)
  }
  // ② 内容层：别人有的规则，活着的这份不许缺（检测已发生的漏投）。
  const r2 = runScript('test/check-profile-live.mjs')
  if (r2.code !== 0) {
    add(2, '投递漏检', 'bad', `有规则只落在别的 profile 上：${badLines(r2.out).join(' / ')}`)
  }
  const r = runScript('test/check-plugin-names.mjs')
  // ★ 2026-09-22：这一层以前拿 `~/.dsh/.agent-presets` 的**目录个数**当"预设有几个"。
  //   0.1.7 删掉了那个目录的自动发现，于是它数的是一个没人读的目录——**数对了也是假绿**。
  //   现在数**组合后的声明行**（唯一来源），并把声明它的那一层一并报出来，因为"谁声明的"
  //   决定了相对路径的基准目录，是排查时第一个要问的问题。
  let decls = []
  try { decls = userPresets() } catch (error) {
    add(2, '预设声明', 'bad', `读不到组合后的预设声明：${String(error.message).split('\n')[0]}`)
  }
  if (decls.length > 0) {
    const layers = [...new Set(decls.map((d) => d.layer))]
    add(2, '预设', r.code === 0 ? 'ok' : 'bad', r.code === 0
      ? `${decls.length} 条用户预设声明（${decls.map((d) => d.id).join(' / ')}）的插件名全部可解析 · 声明于 ${layers.join(' + ')}`
      : `有预设 broken（无法挂载）：${badLines(r.out).join(' / ')}`)
  }

  // ★ **装得上 ≠ 有人在用。** 这一条是为 2026-09-18 那次误判留下的：当时读到"211 个会话里
  //   没有一个跑在伴学预设上"，就下了结论说 code_run / study_judge / 档案注入**从来没被挂载过**。
  //   **那个结论是错的**（2026-09-20 更正）：会话头的 `agentPreset` 记的是**创建时**的值，
  //   中途换过预设的会话不会更新它。把日志正文解开就能看到 code-tutor 的 persona 确实在跑。
  //   教训：拿"创建时快照"当"运行期事实"用，会造出一个查不到任何东西的假线索——
  //   而当时我信了它，去修了一个不存在的挂载问题。所以下面必须**交叉验证活进程**，不能只看它。
  //   （解会话日志请用 `tools/decode-session.mjs`，它按 zstd 魔数逐帧解，能读到正文与工具回执。）
  const studyPresets = ['netsec-tutor', 'math-tutor', 'english-tutor', 'code-tutor', 'study-planner', 'mind-companion']
  try {
    const store = join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh', 'sessions')
    // ★ 2026-09-23：这里以前写死 `session.v3.jsonl.zstd`。0.1.7-rc.1 把日志升到了 **v4**
    //   （实测已有 15 个 `session.v4.jsonl.zstd`），于是**最新的一批会话对这一层完全隐形**，
    //   而且不会报错——正是 F21 那一类"输入老了，检查还在跑"。文件名规则与读取实现
    //   统一交给 `tools/decode-session.mjs`（一处知道会话日志长什么样）。
    const found = listSessionFiles(store)
    const counts = new Map()
    for (const f of found) {
      const head = readSessionHeader(f.abs)
      if (head === undefined) continue
      counts.set(head.agentPreset, (counts.get(head.agentPreset) ?? 0) + 1)
    }
    const total = [...counts.values()].reduce((a, b) => a + b, 0)
    const used = studyPresets.filter((p) => counts.has(p))
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([p, n]) => `${p} ${n}`).join(' · ')
    // 交叉验证：会话头里的 `agentPreset` 记的是**创建时**那个。判断"有没有人在用"要看活进程。
    //
    // ★ 2026-09-22 放宽了判据。旧版要求 `calls > 0`，于是**刚重启完**必然误报"从来没被挂载过"——
    //   而 `companion-core` / `plan-core` **只存在于四个伴学预设里**，它们能在活进程里完成
    //   apply（拿到 tools 注册表）这件事本身，就已经证明有个伴学预设被挂上了。要求"还被调用过"
    //   是在等一个与命题无关的更强条件。假警报比漏报更伤信任，所以判据改成"活着 + apply 走完了"，
    //   调用次数只作为补充信息显示。
    const live = []
    try {
      const hdir = join(PKG, '.health')
      for (const f of readdirSync(hdir)) {
        const h = JSON.parse(readFileSync(join(hdir, f), 'utf8'))
        let alive = false
        try { process.kill(h.pid, 0); alive = true } catch { alive = false }
        if (!alive) continue
        if (h.plugin !== 'companion-core' && h.plugin !== 'plan-core') continue
        if (h.toolsAvailable !== true) continue
        live.push((h.calls ?? 0) > 0 ? `${h.plugin}(已调用 ${h.calls} 次)` : `${h.plugin}(刚挂上，还没被调用)`)
      }
    } catch { /* 没有痕迹就算了 */ }

    if (total === 0) {
      add(2, '预设使用面', 'skip', '读不到会话库，跳过（不是故障）')
    } else if (used.length > 0) {
      add(2, '预设使用面', 'ok', `${total} 个会话 · 创建时用过伴学预设：${used.join(' / ')}（全部：${top}）`)
    } else if (live.length > 0) {
      add(2, '预设使用面', 'ok', `${total} 个会话的**创建**预设里没有伴学预设（${top}），但当前进程里伴学插件已经挂上了：${live.join(' · ')} —— companion-core/plan-core 只存在于伴学预设，所以这是"有人在用"的直接证据；会话头那个读数只反映**创建时**，中途换过预设的会话不会更新它`)
    } else {
      add(2, '预设使用面', 'warn', `${total} 个会话里没有一个跑在伴学预设上（${top}），活进程里也看不到 companion-core / plan-core 的痕迹——**如果这是真的**，code_run / study_judge / 档案注入从来没被挂载过。去预设选择器选「编程伴学 / 网安伴学 / 英语伴学 / 数学伴学」，工作目录设成科目目录，开**新**会话`)
    }
  } catch (e) {
    add(2, '预设使用面', 'skip', `检查失败：${String(e.message).slice(0, 80)}`)
  }
}

// ── 层 3 组合树 ─────────────────────────────────────────────────────────────
// ★ 用**探测出来的安装**跑（`runDsh`），不是 PATH 上的 `dsh`——桌面端下 PATH 里的那个是
//   遗留的 npm 副本，组合出来的是**另一个版本**的宿主树（实测两边 `dsh-base`/`dsh-web-app`
//   的 patch 确实不同）。组合树的唯一合法来源是"正在跑的那个安装"。
if (fast) {
  add(3, '组合树', 'skip', '--fast 跳过')
} else {
  try {
    const out = runDsh(['--profile', 'web', '--dump-config'], { install: INSTALL })
    const hasGuard = out.includes('study-file-guard') || out.includes('file-guard')
    add(3, '组合树', hasGuard ? 'ok' : 'warn', hasGuard ? `dump-config 成功（${INSTALL.kind} ${INSTALL.version ?? '?'} 组合），宿主守护行在树里` : `dump-config 成功（${INSTALL.kind}），但树里没找到 study-file-guard 行`)
  } catch (e) {
    add(3, '组合树', 'bad', `${INSTALL.kind} 的 dsh --dump-config 失败：${String(e.message).split('\n')[0].slice(0, 90)}`)
  }
}

// ── 层 4 守护接线（读插件自己写的 .health/*.json） ──────────────────────────
{
  const dir = `${PLUGINS}.health`
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')) : []
  if (files.length === 0) {
    add(4, '守护接线', 'bad', '没有任何 .health/*.json —— 说明还没有一个守护写过启动痕迹（重启后复看）')
  } else {
    const alive = (pid) => {
      try { process.kill(pid, 0); return true } catch { return false }
    }
    for (const f of files.sort()) {
      let h
      try { h = JSON.parse(readFileSync(join(dir, f), 'utf8')) } catch { add(4, `守护接线 ${f}`, 'bad', 'JSON 读不出来'); continue }
      const who = `${h.plugin}（pid ${h.pid}）`
      if (!alive(h.pid)) add(4, `守护接线 ${h.plugin}`, 'warn', `痕迹来自**已经退出的进程**（pid ${h.pid}）——可能是探针或上一次运行，重启后复看`)
      else if (!h.toolsAvailable) add(4, `守护接线 ${h.plugin}`, 'bad', `${who} apply 时拿不到 tools → 守卫没注册`)
      else if (!h.guardRegistered) add(4, `守护接线 ${h.plugin}`, 'bad', `${who} 拿到 tools 但 guard() 没走完`)
      else if ((h.calls ?? 0) === 0) add(4, `守护接线 ${h.plugin}`, 'warn', `${who} 注册了但还没被调用过（做一次 write/edit 就会 > 0）`)
      else add(4, `守护接线 ${h.plugin}`, 'ok', `${who} 已注册且被调用过 ${h.calls} 次（最后 ${h.lastCallAt ?? '?'}）`)
    }
    // 宿主守护单独强调：它覆盖所有预设，缺了就是"纸面上的守护"
    const hostFile = join(dir, 'file-guard.json')
    if (!files.includes('file-guard.json')) add(4, '守护接线 file-guard', 'bad', '宿主平面的 file-guard 没有痕迹 → 跨预设这条防线等于没有')
    else if (!existsSync(hostFile)) add(4, '守护接线 file-guard', 'bad', '缺失')
  }

  // ★ 工具回执契约（2026-09-20 新增，直接为"听说 code-run 不能用"这一类报告服务）
  //   宿主会把工具返回值做一次 lossless JSON 快照；任一处 `undefined` 就让**整条回执**被丢掉，
  //   模型只看到一句 `value is not lossless JSON`。code_run 的 Python 分支当时就是
  //   `compileOk: ... ? true : undefined`，于是"C 能用、Python 永远报错"，而当时
  //   三个"全绿"的测试一个都看不见它。
  //   这里跑的是同一份契约检查的**快速档**（跳过要真编译 C 的那几条，约 1 秒），
  //   全量档在 `npm test` 里（含 C，约 20 秒）。两档用的是同一个脚本、同一个宿主校验器。
  const contract = runScript('test/verify-tool-output.mjs', ['--quick'])
  const n = [...contract.out.matchAll(/(\d+)\s*passed/g)].pop()?.[1] ?? '?'
  add(
    4,
    '工具回执契约',
    contract.code === 0 ? 'ok' : 'bad',
    contract.code === 0
      ? `${n} 条：每个工具的回执都能过宿主的 lossless JSON 快照（快速档，不含 C 编译那几条）`
      : `有工具的回执宿主收不下 —— 模型会看到 "value is not lossless JSON"：${badLines(contract.out).join(' / ')}`,
  )
}

// ── 层 5 数据协议 ───────────────────────────────────────────────────────────
{
  const r = runScript('test/check-migration.mjs')
  const subjects = existsSync(ST)
    ? readdirSync(ST, { withFileTypes: true }).filter((e) => e.isDirectory() && existsSync(join(ST, e.name, '学习档案.md')))
    : []
  add(5, '数据协议', r.code === 0 ? 'ok' : 'bad', r.code === 0 ? `${subjects.length} 科档案 + 提纲全部合法` : badLines(r.out).join(' / '))

  // 学习日规则：档案戳、任务「生成」日期、漂移天数、注入给模型的日期基准**全都**用它算。
  // 它是"今天是几号"的唯一定义，所以在体检里显式报出来——不然半夜看 doctor 会以为日期错了。
  {
    const { DAY_START_HOUR, DAY_RULE_HINT, studyDate } = await import(pathToFileURL(join(PKG, 'plan-core.js')).href)
    const now = new Date()
    const natural = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    const shifted = studyDate(now) !== natural
    add(5, '学习日', 'ok', `今天（学习日）是 ${studyDate(now)} ${DAY_RULE_HINT}${shifted ? `　← 现在自然日是 ${natural}，因为还没到凌晨 ${DAY_START_HOUR} 点，所以算前一天` : ''}`)
  }

  // 跨科知识点：**两条来路都报**，而且判据是"**提纲里到底有没有这一条**"（不是"档案更新过没有"）——
  // 旧判据有一条静默丢失：顺手更新了档案却没真收下，提醒就永久消失、东西也丢了（2026-09-28 修正）。
  //   ① 别科在自己档案里打了 `@本科` 标记（主路——发现方只碰自己的文件）
  //   ② 别科直接追加进了本科的 `复习提纲.md`（备选路）
  {
    const planMod = await import(pathToFileURL(join(PKG, 'plan-core.js')).href)
    const { OUTLINE_NAME, pendingHandoffs, foreignOutlineEntries } = await import(pathToFileURL(join(PKG, 'companion-core.js')).href)
    const states = planMod.survey(ST, planMod.studyDate())
    const pending = []
    let nHandoff = 0
    let nStale = 0
    let nAppend = 0
    for (const s of states) {
      let outline = ''
      try { outline = readFileSync(join(s.dir, OUTLINE_NAME), 'utf8') } catch { /* 没提纲就是没追加 */ }
      const r = pendingHandoffs(s.dir, { outlineText: outline, archiveStampValue: s.archiveStamp })
      nHandoff += r.pending.length
      nStale += r.stale
      if (r.pending.length > 0) {
        const srcs = [...new Set(r.pending.map((h) => h.source))].join('/')
        pending.push(`${s.name} 有 ${r.pending.length} 条移交没收下（来自 ${srcs}${r.stale > 0 ? `，其中 ${r.stale} 条它更新过档案但还没收` : ''}）；`)
      }
      const all = foreignOutlineEntries(outline)
      nAppend += all.length
    }
    const what = `移交没收下 ${nHandoff} 条（主路 @标记）· 提纲里别科追加 ${nAppend} 条`
    if (nHandoff === 0 && nAppend === 0) {
      add(5, '跨科知识点', 'ok', `没有跨科条目（${what}）。规则：发现方在自己档案里打 \`@<科目>\` 标记或追加进目标提纲；目标科下次开会话随注入自动收到，**收到并写进提纲后才算完**（断言在 verify-cross-subject）`)
    } else if (nHandoff === 0) {
      add(5, '跨科知识点', 'ok', `${what}，没有悬着的移交（提纲里的追加是出处记录，长期保留是正常的）`)
    } else {
      add(5, '跨科知识点', 'warn', `${what}。还没收下的：${pending.join('')}它们会在该科下一次开会话时**随注入自动到达**，并且**一直提醒到真的写进提纲**为止——去那一科说一句「按注入里的跨科条目办」即可`)
    }
  }

  // F11：**存在但读不到**比"超页"更隐蔽——旧实现会让科目从科目表与看板上凭空消失，
  // 更糟的是 looksLikeStudyRoot 会误判，整棵树不再受守护执法。所以这里独立探一遍，
  // 而且**不能用 existsSync 过滤**（它对拒绝读的文件本身就返回 false，等于把这个洞藏起来）。
  for (const e of existsSync(ST) ? readdirSync(ST, { withFileTypes: true }) : []) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue
    const probe = readProbe(join(ST, e.name, '学习档案.md'), '学习档案.md')
    if (!probe.ok && !probe.missing) {
      add(5, `可读性 ${e.name}`, 'bad', `档案存在但读不到（${probe.code}）——它会从看板与科目表里消失，守护也可能整棵树停止执法`)
    }
  }

  // 余量：**逼近上限比"已经超了"更值得提前说**——超了会被守护直接拒，逼近只是还没撞上。
  // 两道墙都要看（字节 6144 与行 60，谁先到由内容决定），取更满的那道报。
  for (const e of subjects) {
    const raw = readFileSync(join(ST, e.name, '学习档案.md'), 'utf8')
    const bytes = Buffer.byteLength(raw, 'utf8')
    const lines = raw.split('\n').length
    const bp = Math.round((100 * bytes) / 6144)
    const lp = Math.round((100 * lines) / 60)
    const worst = Math.max(bp, lp)
    const which = lp >= bp ? `行 ${lines}/60` : `字节 ${bytes}/6144`
    // 阈值定在 70/85 而不是 75/90：设计目标是稳态 40–55%，70% 已经是"在漂"，而 85% 还来得及
    // 从容整理（90% 时下一次写入就可能被拒——那时才报，等于把"预警"降级成"事故通知"）。
    if (worst >= 85) add(5, `余量 ${e.name}`, 'bad', `${which} = ${worst}% —— 去该科会话说「整理一下」把流水收敛到最近 5 个学习日（再写就可能被守护拒绝）`)
    else if (worst >= 70) add(5, `余量 ${e.name}`, 'warn', `${which} = ${worst}%，已经在漂；提前整理比撞墙便宜`)

    // 档案卫生（2026-10-06 学员问「网安档案总是满」）：把 persona 那两条**只有 persona 在说、
    // 没有代码在查**的规定（流水 ≤5 个学习日、每条一句话）算成数字报出来。
    // 与上面的"余量"是**互补**的两件事：余量说"快装不下了"，卫生说"装的是什么"——
    // 网安档案 99% 而只有 31 行，就是被长流水条吃掉的（平均 197 字节/行，英语只有 91）。
    const hy = archiveHygiene(raw)
    if (hy.flowItems > 0 && (hy.overWindow || hy.megaItems > 0)) {
      const bits = []
      if (hy.overWindow) bits.push(`流水覆盖 ${hy.days} 个学习日（规定 ≤${hy.dayWindow}）`)
      if (hy.megaItems > 0) bits.push(`${hy.megaItems} 条超 ${hy.megaThreshold} 字节（最长 ${hy.longestFlow}）`)
      add(5, `流水卫生 ${e.name}`, worst >= 85 ? 'bad' : 'warn',
        `${bits.join('；')}　·　「已答主题与卡点」占 ${hy.flowBytes} 字节（${hy.ratio}%）—— 该科会话每轮会被自动提醒先收拢再写；详情可搬进不进注入的文件（复习提纲.md / 题目记录.md）`)
    }
  }

  // 课程路线（2026-10-17 学员：「教学深度不足、教学路线不清晰、教学内容不完整」）：
  //   档案只装状态（6KB）、提纲只装已学；"应该学什么、学到哪、还差什么"没有载体 ⇒ 模型只能追着
  //   学员的问题跑。这里只报**机械事实**：有没有路线、结构合不合法、覆盖多少、路线是否比档案旧。
  //   `[x]` 是否诚实由 persona 负责（打勾要有证据）——这一层只保证"看得见"，不冒充教学验收。
  {
    const { ROUTE_NAME, parseRoute, validateRoute } = await import(pathToFileURL(join(PKG, 'companion-core.js')).href)
    for (const e of subjects) {
      const probe = readProbe(join(ST, e.name, ROUTE_NAME), ROUTE_NAME)
      if (!probe.ok) {
        if (probe.missing) add(5, `课程路线 ${e.name}`, 'warn', `还没有 ${ROUTE_NAME}：教学会退回「追着问题走」（学员 2026-10-17 的批评）。去该科会话说「按路线摸底建一份」`)
        else add(5, `课程路线 ${e.name}`, 'bad', `${ROUTE_NAME} 存在但读不到（${probe.code}）——注入会报读取异常，路线信息不可用`)
        continue
      }
      let archiveRaw = ''
      try { archiveRaw = readFileSync(join(ST, e.name, '学习档案.md'), 'utf8') } catch { /* subjects 已保证存在 */ }
      const routeStamp = /更新于:\s*(\d{4}-\d{2}-\d{2})/.exec(probe.text)?.[1]
      const why = validateRoute(probe.text, undefined, undefined, routeStamp ?? '2026-01-01', { stampFresh: false })
      if (why !== undefined) {
        add(5, `课程路线 ${e.name}`, 'bad', `${ROUTE_NAME} 结构不合法（写入守护会拒）：${why}`)
        continue
      }
      const p = parseRoute(probe.text)
      const pct = p.coverage.total > 0 ? Math.round((100 * p.coverage.checked) / p.coverage.total) : 0
      const gap = p.coverage.total - p.coverage.checked
      const passed = p.units.filter((u) => u.status === '已过').length
      const bits = [`${p.units.length} 单元（已过 ${passed}）`, `覆盖 ${p.coverage.checked}/${p.coverage.total}（${pct}%）`, `缺口 ${gap}`, `下一课：${p.next?.['主题'] ?? '缺'}`]
      const archStamp = archiveStamp(archiveRaw) ?? undefined
      const stale = routeStamp !== undefined && archStamp !== undefined && routeStamp < archStamp
      if (stale) add(5, `课程路线 ${e.name}`, 'warn', `路线（${routeStamp}）比档案（${archStamp}）旧，先补路线再继续教：${bits.join(' · ')}`)
      else add(5, `课程路线 ${e.name}`, 'ok', bits.join(' · '))
    }
  }

  // 单词复习站（2026-10-19）：只报机械事实——数据/HTML 是否同步、当前单元、待补语境。
  // 熟悉度在手机浏览器 localStorage，PC 端读不到；这里不猜。
  for (const e of subjects) {
    const dataPath = join(ST, e.name, '单词复习数据.json')
    const htmlPath = join(ST, e.name, '单词复习站.html')
    const hasData = existsSync(dataPath)
    const hasHtml = existsSync(htmlPath)
    if (!hasData && !hasHtml) continue
    const label = `单词复习站 ${e.name}`
    if (!hasData) {
      add(5, label, 'warn', 'HTML 存在但缺 单词复习数据.json：先补数据再构建')
      continue
    }
    let data
    try { data = JSON.parse(readFileSync(dataPath, 'utf8')) } catch (error) {
      add(5, label, 'bad', `单词复习数据.json 不是合法 JSON：${String(error?.message ?? error).split('\n')[0]}`)
      continue
    }
    if (data === null || !Array.isArray(data.units) || !Array.isArray(data.items)) {
      add(5, label, 'bad', '数据缺 units/items 数组')
      continue
    }
    const current = data.units.filter((u) => u && u.current === true)
    if (current.length !== 1) {
      add(5, label, 'bad', `current 单元必须恰好 1 个，现在 ${current.length}`)
      continue
    }
    const unit = current[0]
    const items = data.items.filter((i) => i && i.unitId === unit.id).length
    const cardOnly = data.items.filter((i) => i && i.testable === false && i.kind === 'phrase' && i.phrase && (!Array.isArray(i.phrase.blanks) || i.phrase.blanks.length === 0)).length
    const pending = data.items.filter((i) => i && i.testable === false && i.kind !== 'knowledge'
      && !(i.kind === 'phrase' && i.phrase && (!Array.isArray(i.phrase.blanks) || i.phrase.blanks.length === 0))).length
    const dataStat = statSync(dataPath)
    const htmlStat = hasHtml ? statSync(htmlPath) : null
    const bookPath = join(ST, e.name, '词汇情景本.md')
    const bookStat = existsSync(bookPath) ? statSync(bookPath) : null
    const bits = [`当前 ${unit.title || unit.id}（${items} 项）`, `${data.units.length} 单元 / ${data.items.length} 项`]
    if (cardOnly > 0) bits.push(`卡片型短语 ${cardOnly}`)
    if (pending > 0) bits.push(`待补语境 ${pending}`)
    if (!hasHtml) {
      add(5, label, 'warn', `${bits.join(' · ')}；HTML 未构建：跑 build-word-review.mjs`)
      continue
    }
    if (dataStat.mtimeMs > htmlStat.mtimeMs) {
      add(5, label, 'warn', `${bits.join(' · ')}；数据比 HTML 新，需重建`)
      continue
    }
    if (bookStat !== null && bookStat.mtimeMs > dataStat.mtimeMs) {
      add(5, label, 'warn', `${bits.join(' · ')}；书比数据新，先同步数据再构建`)
      continue
    }
    add(5, label, 'ok', `${bits.join(' · ')}；HTML 与数据同步`)
  }

  // 课堂积累（2026-10-09 学员问「关于英语有些规范，刚刚写的。只写在文件里面能不能起到良好的规范作用」）。
  //   该文件**不进注入**（按学期累积、设计上会一直长），所以它那 10 条约束里能由代码执行的极少——
  //   逐条判定后只有 3 条（文件名唯一 / 不按周新建 / 写者范围），其余 5 条是"一句话怎么说"，守护看不到。
  //   但**「超过约 60KB 就拆」是机械事实、完全量得出来**，原来却没有任何地方在查（F27 同族：只存储、没投递）。
  //   按 F26 的纪律：接近阈值就说，别等撞上。
  for (const e of subjects) {
    const ch = classNotesHygiene(join(ST, e.name))
    if (!ch.exists) continue
    if (ch.suspicious !== undefined && ch.suspicious.length > 0) {
      add(5, `课堂积累 ${e.name}`, 'warn',
        `出现同族文件 ${ch.suspicious.join('、')} —— 文件自己的规定是「一份，一直用；不按周新建」；拆分只允许切成 词汇情景本-<学期>.md 归档`)
    }
    if (ch.nearSplit) {
      add(5, `课堂积累 ${e.name}`, 'bad',
        `${ch.bytes}/${ch.splitAt} 字节 = ${ch.ratio}% —— 已到文件自己规定的拆分阈值（约 60KB）：把旧的切到 词汇情景本-<学期>.md（归档、不注入），规则段留在当前文件`)
    } else if (ch.ratio >= 60) {
      add(5, `课堂积累 ${e.name}`, 'warn', `${ch.bytes}/${ch.splitAt} 字节 = ${ch.ratio}%，接近拆分阈值`)
    }
  }

  // 计划卫生（2026-10-08 学员问「我的规划文档似乎也遇到了字数不够的问题」）：
  //   实测总规划 4199B / 8192B = **51%** —— 字节只用了一半，可它**写不下**。
  //   卡住它的是**封顶格子的条数**：硬约束 5/5、漂移 6/6、预备 5/5、网安 MVE 3/3。
  //   这跟"档案余量"是**互补**的两件事：余量说"字节快满了"，这里说"格子已经满了"——
  //   而后者**永远不可能从字节数看出来**（51% 看着很空）。
  try {
    const planRaw = readFileSync(join(ST, '总规划.md'), 'utf8')
    const ph = planHygiene(planRaw)
    if (ph.fullCount > 0) {
      const spec = [
        ...ph.blocks.filter((b) => b.full).map((b) => `${b.name} ${b.used}/${b.cap}`),
        ...ph.mve.filter((m) => m.full).map((m) => `MVE ${m.name} ${m.used}/${m.cap}`),
      ]
      add(5, '计划格子', 'warn',
        `已满：${spec.join('｜')}　·　字节只用 ${ph.bytes}/${ph.maxBytes}（${Math.round((100 * ph.bytes) / ph.maxBytes)}%）—— **要往里加一条，必须先删/并掉一条**；看板每轮会把这一行报给总规划。处置：已完成的旧条目 / 已并入本周的预备项 / 已消化完的漂移`)
    } else {
      add(5, '计划格子', 'ok', `各封顶区块都还有位（硬约束/漂移/预备/MVE），字节 ${ph.bytes}/${ph.maxBytes}`)
    }
    // 变更记录同一类：实测学员 2026-10-08 被拒过（1124 > 1024），而当时只有 7 条（条数上限还有余）。
    const noticeRaw = readFileSync(join(ST, '变更记录.md'), 'utf8')
    const nb = Buffer.byteLength(noticeRaw, 'utf8')
    const ni = noticeRaw.split('\n').filter((l) => /^\s*[-*+]\s+\S/.test(l)).length
    if (nb > 1024 * 0.85 || ni >= 10) {
      add(5, '变更记录体量', 'warn', `${nb}/1024 字节、${ni}/10 条 —— 快满了，加新条目前先删最早的（它是流水不是档案）`)
    }
  } catch { /* 没有总规划/变更记录就不报 */ }

  // 心灵陪伴（2026-10-11 新增的第六个预设）。
  //   它**不是科目**（没有 `学习档案.md`，所以 `subjects` 里没有它），所以上面所有按科目循环的
  //   检查都不会碰它——这正是设计意图。但"不被检查"不等于"不用检查"：它有自己的契约
  //   （40 行 / 4KB、必须带日期戳），而**没有任何按科目的循环会替它执行**。
  //   这一块是信息性的：报告它在不在、占多少、有没有话要给总规划、以及看板尾部到底渲染了什么。
  {
    const planMod = await import(pathToFileURL(join(PKG, 'plan-core.js')).href)
    const { COMPANION_NOTE_NAME, COMPANION_SECTION_PLAN, COMPANION_PLAN_ITEMS_MAX, companionPlanItems } = planMod
    // ⚠️ `validateCompanionNote` 与两个上限在 **companion-core**，不在 plan-core
    //   （plan-core 是依赖根，只有看板要用的那几个常量）。第一版从 plan-core 取，报的是
    //   `validateCompanionNote is not a function` —— 一个 import 写错源文件就长这样。
    const { COMPANION_MAX_LINES, COMPANION_MAX_BYTES, validateCompanionNote, pendingHandoffs } = await import(pathToFileURL(join(PKG, 'companion-core.js')).href)
    const dir = join(ST, '心灵')
    const probe = readProbe(join(dir, COMPANION_NOTE_NAME), COMPANION_NOTE_NAME)
    if (probe.missing) {
      // 缺失**不是故障**：学员可能根本没用过陪伴预设（它是 2026-10-11 才装的）。
      add(5, '心灵陪伴', 'skip', `还没有 ${COMPANION_NOTE_NAME}（陪伴预设没被用过，或还没跑 new-companion.mjs 建档）—— 这不是故障`)
    } else if (!probe.ok) {
      add(5, '心灵陪伴', 'bad', `笔记存在但读不到（${probe.code}）—— 陪伴会话拿不到记忆，且它不会从任何"按科目"的检查里露出来`)
    } else {
      const raw = probe.text
      const bytes = Buffer.byteLength(raw, 'utf8')
      const lines = raw.split('\n').length
      // 与学科档案分开算：它的上限是 40 行 / 4096 B（**比档案小**，因为它每轮都注入）。
      const bp = Math.round((100 * bytes) / COMPANION_MAX_BYTES)
      const lp = Math.round((100 * lines) / COMPANION_MAX_LINES)
      const worst = Math.max(bp, lp)
      const which = lp >= bp ? `行 ${lines}/${COMPANION_MAX_LINES}` : `字节 ${bytes}/${COMPANION_MAX_BYTES}`
      // 用**它自己的日期戳**当"今天"来验结构：陪伴笔记只在学员真的来聊天时才更新，
      // 拿系统日期当基准会让这条断言隔天就红（那是"学员没来聊天"，不是"笔记坏了"）。
      // 与 check-migration 里学科档案那条用的是同一个取舍。
      const stamp = /更新于:\s*(\d{4}-\d{2}-\d{2})/.exec(raw)?.[1] ?? ''
      const verdict = validateCompanionNote(raw, COMPANION_MAX_LINES, COMPANION_MAX_BYTES, stamp)
      /** 看板里「■ 心灵 …」那一块（到「本轮该动什么」之前）——用来把它的字节从总量里摘出来。 */
      const blockOfBoard = (b) => {
        const lines = b.split('\n')
        const i = lines.findIndex((l) => l.startsWith('■ 心灵'))
        if (i < 0) return ''
        let j = i
        while (j < lines.length && !lines[j].startsWith('■ 本轮该动什么')) j += 1
        return lines.slice(i, j).join('\n')
      }
      const items = companionPlanItems(raw)
      const pending = pendingHandoffs(dir, { outlineText: raw, noteName: COMPANION_NOTE_NAME })
      // ★ 2026-10-11：把**看板余量**报出来。这是修完那个真缺陷之后加的——那个缺陷的形状是
      //   「陪伴块占永不截断的尾部 ⇒ 吃掉头部预算 ⇒ 头部掉进字节硬截断 ⇒ 各科漂移与任务条目
      //   被整段切掉」，而**这一切在看板上没有任何提示**（硬截断的提示语只说"摘要被压短了"）。
      //   现在陪伴块只吃余量，所以这里量的是"现场还剩多少余量给它"——学员写了话却看不到时，
      //   一眼就知道是余量不够（而不是"代码坏了"）。它只在**真有话要说**时才可能成为问题，
      //   所以干净时只报一个数字、不报警。
      let budget = ''
      try {
        const today = planMod.studyDate()
        const subjects = planMod.survey(ST, today)
        const readOrUndef = (p) => { try { return readFileSync(p, 'utf8') } catch { return undefined } }
        const board = planMod.buildBoard(ST, {
          today, subjects,
          planRaw: readOrUndef(join(ST, '总规划.md')),
          noticeRaw: readOrUndef(join(ST, '变更记录.md')),
          noteRaw: raw,
        })
        const bytes = Buffer.byteLength(board, 'utf8')
        const cut = board.includes('已按上限截断')
        const shown = board.includes('■ 心灵')
        const pointed = board.includes('心灵有话说')
        // ★ 2026-10-12：陪伴块现在**独立成块**（自己的 COMPANION_BLOCK_MAX_BYTES 预算，拼在看板之后），
        //   所以这里报两个数：看板本体（仍受 4096 管）+ 陪伴块自己占了多少。
        //   旧输出只报一个总数、并把它与 4096 比——那个读法在新语义下会**误导**：
        //   总量 4104 > 4096 看着像越界，其实本体正好 3878、块 226。
        const bodyBytes = bytes - (shown ? Buffer.byteLength(blockOfBoard(board), 'utf8') : 0)
        budget = ` · 看板本体 ${bodyBytes}/${planMod.BOARD_MAX_BYTES}B${cut ? '（**已硬截断：末尾几科的漂移/任务丢了**）' : ''}` +
          (items.length === 0 ? ''
            : shown ? ` · 陪伴块 ${bytes - bodyBytes}/${planMod.COMPANION_BLOCK_MAX_BYTES}B（已渲染）`
              : pointed ? ' · 陪伴块**没渲染**，只给了指路'
                : ' · **有话但没渲染，且没有指路**')
        if (cut) {
          add(5, '心灵陪伴', 'warn', `${budget}　·　看板已顶到上限，末尾几科的事实被切掉了——先精简各科档案/计划，别让它靠"少写"来腾地方`)
        }
      } catch { /* 看板量不出来不影响下面那条信息性输出 */ }
      const detail = `笔记 ${which}（${worst}%）· 戳 ${stamp || '**缺**'} · 「${COMPANION_SECTION_PLAN}」${items.length} 条（看板渲染上限 ${COMPANION_PLAN_ITEMS_MAX}、单条 ${planMod.COMPANION_ITEM_MAX_BYTES}B、整块 ${planMod.COMPANION_BLOCK_MAX_BYTES}B）` +
        (pending.pending.length > 0 ? ` · 别科标给它的还有 ${pending.pending.length} 条没收下` : '') + budget
      if (verdict !== undefined) {
        add(5, '心灵陪伴', 'bad', `${detail}　·　结构不合法：${verdict}`)
      } else if (worst >= 85) {
        add(5, '心灵陪伴', 'warn', `${detail}　·　已到 ${worst}%：陪伴会话说「整理一下」，把过去的收拢掉（再写就可能被守护拒绝）`)
      } else {
        add(5, '心灵陪伴', 'ok', detail)
      }
    }
  }
}

// ── 输出 ────────────────────────────────────────────────────────────────────
const ICON = { ok: '✅', warn: '⚠️ ', bad: '❌', skip: '⏭️ ' }
console.log(`\nstudy-doctor  ${new Date().toLocaleString('zh-CN')}${fast ? '  (--fast)' : ''}\n`)
let last = -1
for (const r of results) {
  if (r.layer !== last) { console.log(`层 ${r.layer}`); last = r.layer }
  console.log(`  ${ICON[r.status]} ${r.label.padEnd(18)} ${r.detail}`)
}

// ── 失效模式清单：把「考虑得完不完善」变成可数的 ────────────────────────────
let fmLine
try {
  const modes = JSON.parse(readFileSync(join(PKG, 'failure-modes.json'), 'utf8')).modes
  const n = (s) => modes.filter((m) => m.status === s).length
  fmLine = `失效模式 ${modes.length} 条 · ✅ ${n('covered')} 有防护 · ⚠️ ${n('partial')} 部分 · ❌ ${n('open')} 没有`
  const open = modes.filter((m) => m.status === 'open')
  if (open.length > 0) fmLine += `\n         还没防护的：${open.map((m) => m.id).join('、')}（明细见 failure-modes.json）`
} catch {
  fmLine = '⚠️  失效模式清单读不出来：failure-modes.json'
}
console.log(`\n${fmLine}`)

const firstBad = results.find((r) => r.status === 'bad')
const warns = results.filter((r) => r.status === 'warn')
console.log('\n' + '─'.repeat(72))
if (firstBad === undefined) {
  console.log(`✅ 没有断掉的层${warns.length > 0 ? `（${warns.length} 条提醒，不是故障）` : ''}`)
} else {
  const FIX = {
    0: '升级过 DSH？包名可能变了 → 先跑层 2，再按 shipped standard 对齐预设的行',
    1: '插件文件被删/被改坏 → 从备份恢复，或用 git 看这几个文件',
    2: '有预设 broken → 看上面报出的插件名，多半是上游改名了（对照 dsh 的 shipped standard）',
    3: '组合树 compose 不了 → 看 profile 的 cordis.patch.yml',
    4: '守护没接上 → 检查这一行有没有 `export const inject = [\'tools\']`；改动后要**重启**才会重新 apply',
    5: '数据不合法 → 到该科会话里修，别从这里代改（守护会拦，而且本来就是它自己的文件）',
  }
  console.log(`❌ 第一个断掉的是 **层 ${firstBad.layer}**：${firstBad.detail}`)
  console.log(`   修法提示：${FIX[firstBad.layer] ?? '见设计文档'}`)
}

console.log('\n层 6 注入（只能会话内探，doctor 不替你做）：')
console.log('  在某个伴学会话里说「读一下你的学习档案」，看注入里那份档案是不是当前版本；')
console.log('  或在**别的目录**开的会话里试着改一下某科档案 —— 现在应该被宿主守护拦下。')
process.exit(firstBad === undefined ? 0 : 1)
