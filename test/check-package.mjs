// check-package.mjs — 打包之后的不变量：这个包是不是真的"一个包"、装上了、链接对不对、版本声明能不能被满足。
//
// 为什么单独一个脚本：打包把"文件放在哪"变成了一种**约定**（包 = 插件 + 工具 + 测试；宿主行由
// bundle 的 patch 提供；profile 里是链接不是拷贝）。约定没有断言就会漂——而漂了之后的表现是
// "看起来都在，但改的不是同一份代码"。
//
// 用法：node test/check-package.mjs
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// ★ 2026-09-24：`DSH` 改从**探测出来的安装**取（桌面端 vs 遗留 npm 副本，见 tools/dsh-install.mjs）。
//   写死 npm 路径时，这条"当前 dsh 满足 engines 吗"问的是**另一个版本**。
const { detectInstall, describeInstall } = await import('../tools/dsh-install.mjs')
const INSTALL = detectInstall()
const DSH = INSTALL.root
// ★★ 2026-10-09：`PROFILE` 原来是**写死的字符串** `.../profiles/web`。而桌面端跑的是 `desktop`——
//   于是这个套件里所有"装到 profile 了吗 / 是不是链接"的断言，问的都是**没人读的那一份**，
//   一路全绿。改成问活着的那个（tools/live-profile.mjs）。
const { detectProfile, describeProfile } = await import('../tools/live-profile.mjs')
const PROFILE_INFO = detectProfile()
const PROFILE = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', PROFILE_INFO.profile)
console.log(`\n（读的是 ${describeProfile(PROFILE_INFO)}）`)

let pass = 0
let fail = 0
const check = (label, cond, extra) => {
  if (cond) { pass += 1; console.log('  ✅', label) }
  else { fail += 1; console.log('  ❌', label, extra === undefined ? '' : `→ ${extra}`) }
}

const pkg = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8'))

// ── ① 它自报是 bundle，而且 patch 指的是一份真文件 ───────────────────────────
console.log('\n① package.json 与 bundle patch')
check('有 name / version', typeof pkg.name === 'string' && typeof pkg.version === 'string', `${pkg.name}@${pkg.version}`)
const patchRel = pkg.dsh?.bundle?.patch
check('声明了 dsh.bundle.patch', typeof patchRel === 'string', patchRel)
const patchPath = patchRel === undefined ? undefined : join(PKG, patchRel)
check('  那个文件真的在', patchPath !== undefined && existsSync(patchPath), patchPath)

const patchText = patchPath !== undefined && existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : ''
// ★ 2026-10-24：bundle patch 现在同时声明「总规划」预设。预设声明的包装行
//   （@deepseek-ai/dsh-agent-preset）不是包的依赖，它 config.plugins 里的行是 preset 自己的
//   插件表（由 DSH 在 preset 作用域里解析，可能是 cordis:group 这类伪名）——都不能拿
//   profile 的 createRequire 去 resolve。所以只取**顶层 bundle 行**的名字：解析 YAML，
//   跳过 preset 声明包装行与 cordis:* 伪名，但继续展开原生 group 的 config 列表。
const { yaml } = await import('../tools/presets.mjs')
const patchDoc = yaml.load(patchText.replace(/!!js\s?/g, ''))
const rowNames = []
const isPresetDeclRow = (row) => typeof row.id === 'string' && row.id.startsWith('preset-')
const collectRowNames = (rows) => {
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row === null || typeof row !== 'object') continue
    if (typeof row.name === 'string' && !isPresetDeclRow(row) && !row.name.startsWith('cordis:')) rowNames.push(row.name)
    if (Array.isArray(row.insert)) collectRowNames(row.insert)
    if (Array.isArray(row.config)) collectRowNames(row.config) // 原生 group 的子行写在 config 列表里
  }
}
collectRowNames(patchDoc)
check('  patch 里至少有一行并给了 name', rowNames.length > 0, JSON.stringify(rowNames))

// bundle 现在也声明预设：preset 的学习插件行必须是本包里的真实文件——路径写错时
// 组合树照样能 dump，只有装配到 preset 作用域才炸，所以在这里立个岗。
const collectPresetRows = (rows) => {
  const out = []
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row === null || typeof row !== 'object') continue
    if (isPresetDeclRow(row)) out.push(row)
    if (Array.isArray(row.insert)) out.push(...collectPresetRows(row.insert))
  }
  return out
}
for (const row of collectPresetRows(patchDoc)) {
  const suite = (row.config?.plugins ?? []).find((r) => typeof r?.name === 'string' && r.name.startsWith('@local/dsh-study/'))
  const rel = suite === undefined ? undefined : suite.name.slice('@local/dsh-study/'.length)
  check(
    `  预设 ${row.id} 的学习插件行指向本包真实文件`,
    rel !== undefined && existsSync(join(PKG, rel)),
    suite?.name ?? '(没有 @local/dsh-study/... 行)',
  )
}

// ── ② 那些 name 从 profile 能不能解析（这一步 --dump-config 不做） ────────────
console.log('\n② patch 里的包名从 profile 可解析')
{
  const r = createRequire(join(PROFILE, 'cordis.yml'))
  for (const n of rowNames) {
    let ok = true
    let where
    try { where = r.resolve(n) } catch (e) { ok = false; where = e.code }
    check(`  ${n}`, ok, where)
  }
}

// ── ③ 装进来的是**链接**，不是拷贝 ───────────────────────────────────────────
// 这是"一份事实一个家"落到安装层的形状：如果哪天变成拷贝，改包里的文件不会影响运行的那份，
// 而两种状态的**表现完全一样**——所以必须有断言盯着。
console.log('\n③ profile 里是链接（一份物理拷贝）')
{
  const installed = join(PROFILE, 'node_modules', pkg.name)
  check('已安装到 profile', existsSync(installed), installed)
  if (existsSync(installed)) {
    const st = lstatSync(installed)
    check('  它是 SymbolicLink', st.isSymbolicLink(), st.isSymbolicLink() ? '' : '是真实目录 = 拷贝')
    if (st.isSymbolicLink()) {
      // 必须用 realpathSync：`path.resolve` 是**纯词法**的，不会跟随符号链接。
      // （第一版我用了 resolve，那条断言会永远"通过"，因为它比较的是链接路径自己。）
      const real = realpathSync(installed)
      check('  指回本包目录', real.toLowerCase() === realpathSync(PKG).toLowerCase(), `${real} vs ${realpathSync(PKG)}`)
    }
  }
}

// ── ④ engines.dsh：声明要能被人（doctor）看懂，也要真的被当前版本满足 ─────────
console.log('\n④ engines.dsh')
{
  const range = pkg.engines?.dsh
  check('声明了 engines.dsh', typeof range === 'string', String(range))
  const installedDsh = INSTALL.version ?? '(读不到)'
  const min = /(\d+\.\d+\.\d+)/.exec(range ?? '')?.[1]
  // ★ 2026-10-17 修：原来用 `installedDsh.startsWith(min)` 做「宽松比对」，那等于要求
  //   主版本号前缀一致——只在 0.1.7 时代成立。升级到 0.2.1-rc.1 后，`>=0.1.7-alpha.1`
  //   明明**语义上**被满足，前缀比较却红。改为按数值逐段比较（忽略 prerelease）：
  //   这才是"装上的版本 >= 声明的最低版本"。
  const ver = (v) => {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v ?? '')
    return m === null ? undefined : [Number(m[1]), Number(m[2]), Number(m[3])]
  }
  const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
  const installedParsed = ver(installedDsh)
  const minParsed = ver(min)
  check(
    `  当前 dsh ${installedDsh} 满足它（数值比较，忽略 prerelease）`,
    installedParsed !== undefined && minParsed !== undefined && cmp(installedParsed, minParsed) >= 0,
    `range="${range}" min=${min} · 问的是 ${describeInstall(INSTALL)}`,
  )
}

// ── ⑤ 包内一致性：JSON 都能解析、没有 BOM、没有过期的路径引用 ────────────────
// BOM 那一条是给一个真实的坑立的岗：PowerShell 的 `Set-Content -Encoding UTF8` **会写 BOM**，
// 而 Node 容忍 .mjs 的 BOM、**JSON 不能**——所以它只在其中一个文件上炸，最容易看漏（§27.5）。
console.log('\n⑤ 包内一致性')
{
  const files = []
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.(mjs|js|json|yml|md)$/.test(e.name)) files.push(p)
    }
  }
  walk(PKG)

  const withBom = files.filter((f) => {
    const b = readFileSync(f)
    return b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf
  })
  check(`没有任何文件带 BOM（查了 ${files.length} 个）`, withBom.length === 0, withBom.map((f) => f.replace(PKG, '')).join(', '))

  const badJson = []
  for (const f of files.filter((x) => x.endsWith('.json'))) {
    try { JSON.parse(readFileSync(f, 'utf8')) } catch { badJson.push(f.replace(PKG, '')) }
  }
  check('所有 .json 都能解析', badJson.length === 0, badJson.join(', '))

  // failure-modes.json 必须**由序列化器落盘**（`JSON.stringify(obj, null, 2) + '\n'`）。
  // 2026-09-28：这个文件因为「手写、值里带未转义的直引号」坏掉过**四次**。手写 JSON 就是不该做的事——
  // 断言"规范序列化"等于断言"它没被手写过"，而那正是四次事故的共同前提。
  // 改它请用 `npm run fm -- add '<json>'`（自动转义），或改完跑 `npm run fm -- fix` 归正。
  {
    const rawFm = readFileSync(join(PKG, 'failure-modes.json'), 'utf8')
    let canon = false
    try { canon = `${JSON.stringify(JSON.parse(rawFm), null, 2)}\n` === rawFm } catch { canon = false }
    check('failure-modes.json 是规范序列化（= 没被手写改过）', canon, '跑 `npm run fm -- fix` 归正；以后用 `npm run fm -- add` 写入')
  }

  // ── 编码损坏（2026-09-25 立的岗）──────────────────────────────────────────────
  // 事故：我用 PowerShell 的 `Get-Content -Raw` + `Set-Content -Encoding utf8` 去改 `plan-core.js`，
  // 而 PS 5.1 按 **ANSI(cp936)** 解读无 BOM 的 UTF-8 文件 —— 中文整片变乱码，还吃掉 ~130 个换行，
  // 1279 行缩成 1131 行。找它花了一整轮（最后靠**会话日志重放**才恢复）。
  // 这两条断言能在一秒内指出它。
  //
  // ⚠️ 签名表必须写成 `\uXXXX` 转义、**不能直接写那几个汉字**——否则本文件自己就含这些字符，
  //    会被自己命中（写这条时第一版就是这么挂的；同一个坑在下面的"过期引用"那条已经记过一次）。
  //    码点是从那次事故的损坏文件里实测出来的最高频分布，不是猜的。
  const MOJI_SIGNS = [
    '\uFFFD',                                              // 解码失败的确定痕迹
    String.fromCharCode(0x951F, 0x65A4, 0x62F7),           // 经典三连
    ...['\u951B', '\u9239', '\u6D93', '\u9286', '\u6D60', '\u9352', '\u9359', '\u93C8', '\u7D1D', '\u6B91', '\u9428'],
  ]
  const mojibake = []
  for (const f of files) {
    const text = readFileSync(f, 'utf8')
    if (text.includes('\uFFFD')) {
      const line = text.split('\n').findIndex((l) => l.includes('\uFFFD')) + 1
      const n = text.split('\uFFFD').length - 1
      mojibake.push(`${f.replace(PKG, '')}（U+FFFD × ${n}，首处 L${line}）`)
      continue
    }
    // 没有 U+FFFD 也可能是"静默"损坏：整段被 GBK 解成合法但错误的汉字。用签名密度判。
    const hitChars = MOJI_SIGNS.slice(1).filter((t) => text.includes(t))
    const density = MOJI_SIGNS.slice(1).reduce((acc, t) => acc + text.split(t).length - 1, 0)
    if (hitChars.length >= 3 || density >= 8) {
      mojibake.push(`${f.replace(PKG, '')}（乱码签名 ${hitChars.length} 种 / ${density} 次）`)
    }
  }
  check(`没有文件被编码损坏（查了 ${files.length} 个）`, mojibake.length === 0, mojibake.slice(0, 5).join(' · '))

  // 过期引用：测试搬家前在旧目录下，搬完还写着旧路径的注释/文档会误导人。
  // ⚠️ 这条针**必须在运行时拼出来**：写成字面量的话，本文件自己就会命中自己——
  //    第一版就是这么挂的（"检查旧路径的文件"本身含有那个旧路径）。
  const staleNeedle = ['.verify', 'code'].join('/') + '/'
  const stale = []
  for (const f of files) {
    const t = readFileSync(f, 'utf8')
    if (t.includes(staleNeedle)) stale.push(f.replace(PKG, ''))
  }
  check('没有指向旧位置的过期引用', stale.length === 0, stale.join(', '))

  // 测试与代码同源：测试必须在包里，而不是留在工作区
  const testDir = join(PKG, 'test')
  check('test/ 目录在包里且非空', existsSync(testDir) && statSync(testDir).isDirectory() && readdirSync(testDir).length >= 10, String(existsSync(testDir) && readdirSync(testDir).length))
  for (const must of ['run-all.mjs', 'study-doctor.mjs', 'new-subject.mjs', 'failure-modes.json']) {
    check(`  ${must} 在包根`, existsSync(join(PKG, must)))
  }
}

// ── ⑥ 可移植性：套件要能装到别人的机器上 ────────────────────────────────────
// 2026-10-24：bundle 带「总规划」后，学生第一步就是跑 new-subject / new-companion 建科目。
// 这两个脚本曾写死作者本机的插件目录与学习根——
// 在别人的机器上表现为"学习根不存在"，只有真正换一台机器才会发现。用临时目录 + 环境变量
// 真跑一遍，才能证明它们按自己的位置和 DSH_STUDY_ROOT 走。
console.log('\n⑥ 可移植性（自定义学习根，不依赖维护者路径）')
{
  const tmpRoot = mkdtempSync(join(tmpdir(), 'study-kit-'))
  try {
    const run = (script, args, target) => {
      const r = spawnSync(process.execPath, [join(PKG, script), ...args], {
        cwd: tmpRoot,
        env: { ...process.env, DSH_STUDY_ROOT: tmpRoot },
        encoding: 'utf8',
      })
      check(`  ${script} 在自定义 DSH_STUDY_ROOT 下可用`, r.status === 0 && existsSync(target), (r.stderr || r.stdout || '').split('\n').filter(Boolean)[0] ?? `status=${r.status}`)
    }
    run('new-subject.mjs', ['可移植测试'], join(tmpRoot, '可移植测试', '学习档案.md'))
    run('new-companion.mjs', ['树洞'], join(tmpRoot, '树洞', '心灵笔记.md'))
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true })
  }
}

console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
