// presets.mjs — **预设声明的唯一读取点**。
//
// ═══ 为什么会有这个文件（2026-09-22，DSH 0.1.6 → 0.1.7）═══════════════════════
// 0.1.7 **删掉了** `$DSH_HOME/.agent-presets/<id>/` 的目录自动发现。那套机制下预设是
// 两个文件（`preset.yml` 给选择器看名字/描述、`agent.cordis.yml` 给 loader 看插件行），
// 现在**没有任何代码读它们了**：预设变成 `@deepseek-ai/dsh-agent-preset` 的**行内声明**，
// 由某个 bundle 或 profile 的 patch 插入，字段是 `config: {id, name, description, order, plugins}`。
//
// 这次升级暴露的问题比"包改名"深一层：**我的检查网当时正读着那个没人读的目录，于是
// 8/8 全绿地告诉我"预设都好着"**——而它检查的是已经失效的机制。这正是 F16 那一类
// （断言结构上问不到问题）的又一次复发，所以这里不是"改个路径"，而是把
// **"预设声明住在哪里"这件事收成一份**，所有消费方都从这里读。
//
// 另一处只有 0.1.7 才有的知识：行内声明之后，**相对路径的基准目录变了**。
//   · 目录时代：`./x.mjs` 相对**预设目录**解析
//   · 行内之后：相对**声明它的那个 patch 文件所在目录**解析
// 用户那 8 个预设声明在**学员界面正在跑的那个 profile** 的 `cordis.patch.yml` 里，所以
// `./x.mjs` 指的是该 profile 目录下的 `x.mjs`，而 `../../.agent-presets/<id>/x.mjs` 才指回
// 旧的预设目录。（★ 2026-10-09 更正：这里原来写死 `profiles/web/`——见下面 `PROFILE` 处。）
// `--dump-config` 的输出里每个顶层条目上方都有一行 `# == <bundle>, patched by <层>`，
// 那就是"谁声明的"的权威记录——本模块靠它算出每行正确的基准目录，而不是猜。
//
// 用法：
//   node tools/presets.mjs                 打印所有预设声明与插件行解析结果
//   node tools/presets.mjs --json          机器可读
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { detectInstall, hasPackage, NPM_DSH, runDsh } from './dsh-install.mjs'
import { detectProfile, describeProfile } from './live-profile.mjs'

export const PKG = dirname(dirname(fileURLToPath(import.meta.url)))
export const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
// ★★ 2026-10-09 修正：这里原来是 `process.env.DSH_STUDY_PROFILE ?? 'web'` ——**写死 web**。
//   而桌面端跑的是 `profiles/desktop`。后果不是"报错"，而是**静默投递到没人读的那份**：
//   2026-09-24 之后写进 web 那份 patch 的 9 项 persona 规则（学习日、@Python、拿不准归属就别猜、
//   来源标注、档案卫生、200 字节、计划格子、课堂积累、词汇情景本）**学员一条都没收到**，
//   而工具链、doctor、测试**一路全绿**——因为它们检查的正是我自己选的那个 profile。
//
//   这与 F16（断言结构上问不到问题）/F21（读着失效的机制）/F28（v3 日志文件名）同源，是同一
//   教训的第四种形态：**对"我问的是哪个对象"做了静默假设，而假设错了。**
//
//   修法沿用 `tools/dsh-install.mjs` 的思路——**优先问正在跑的那个**（进程命令行是运行时事实，
//   不是配置里的意图），并把"依据"记下来打进输出（`PROFILE_INFO.source`），让错的答案看得见。
export const PROFILE_INFO = detectProfile()
export const PROFILE = PROFILE_INFO.profile
export const PROFILE_DIR = join(DSH_HOME, 'profiles', PROFILE)
export const PROFILE_PATCH = join(PROFILE_DIR, 'cordis.patch.yml')
/** 磁盘上所有 profile 的名字（用来发现"改了一份、跑的是另一份"这种分叉）。 */
export function allProfiles() {
  const root = join(DSH_HOME, 'profiles')
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(root, e.name, 'cordis.patch.yml')))
    .map((e) => e.name)
    .sort()
}
/** 0.1.6 及以前的家；0.1.7 起**无人读取**，只作为迁移对照与"本地插件文件还在不在"的参照。 */
export const LEGACY_DIR = join(DSH_HOME, '.agent-presets')
export const CACHE = join(PKG, '.verify', `composed-${PROFILE}.yml`)

// ★ 2026-09-24（桌面端）：`DSH_INSTALL` 从"写死的 npm 路径"改成**探测出来的那个安装**。
//   机器上同时有桌面端（0.1.7-rc.2，包在 app.asar 里）与遗留的 npm 副本（0.1.7-rc.1），
//   写死一个就等于**问错安装**。见 tools/dsh-install.mjs 的头注。
const INSTALL = detectInstall()
export const DSH_INSTALL = INSTALL.root
export const DSH_INSTALL_INFO = INSTALL

// js-yaml 从**能直读的那个**安装里取：桌面端的 js-yaml 在 asar 里，普通 node 的
// require.resolve 拿不到它。js-yaml 是纯 JS、与 dsh 版本无关，所以退化到 npm 副本是安全的
// （这是在"用一个不完美的来源"，所以写明白理由）。
const requireFromDsh = createRequire(join(INSTALL.readable ? DSH_INSTALL : NPM_DSH, 'package.json'))
export const yaml = requireFromDsh('js-yaml')

/**
 * 0.1.7 起 shipped 预设是 web-app 的 `presets/<id>.patch.yml`。
 * 它在安装的 `node_modules/@deepseek-ai` 那一层——桌面端就是 asar 里（**普通 node 读不到**），
 * 所以这个常量只给"能直读"的安装用；需要内容时请走 `runDsh`/探针，别拿它去 readFile。
 */
export const SHIPPED_PRESET_DIR = join(INSTALL.readable ? DSH_INSTALL : NPM_DSH, 'node_modules/@deepseek-ai/dsh-web-app/presets')

// ── 组合树 ──────────────────────────────────────────────────────────────────

/** 缓存是否还新鲜：比 profile patch 与**正在问的那个安装**的 package.json 都新就复用。 */
function cacheFresh(profile = PROFILE) {
  const cache = join(PKG, '.verify', `composed-${profile}.yml`)
  if (!existsSync(cache)) return false
  const stampFile = join(PKG, '.verify', 'composed-install.json')
  let stamp
  try { stamp = JSON.parse(readFileSync(stampFile, 'utf8')) } catch { return false }
  if (stamp.kind !== INSTALL.kind) return false // 换了安装 → 组合树必然不同，缓存作废
  // ★ 2026-11-05（0.2.1-rc.5 → 0.2.2-rc.1）：**同一个安装也会升级**。
  //   以前只比 `kind`，桌面端的 asar 又读不到 package.json，于是升级后缓存照样算“新鲜”，
  //   工具链一直读着上个版本的 shipped 预设——`verify-code-tutor` 的“每一行逐字未改”
  //   就是这么红的（拿 0.2.1 的 standard 去比 0.2.2 迁移后的预设）。
  //   版本号记在 stamp 里，比一次字符串的成本≈0，必须比。
  if (stamp.version !== INSTALL.version) return false
  if (stamp.root !== INSTALL.root) return false
  const t = statSync(cache).mtimeMs
  const sources = [join(DSH_HOME, 'profiles', profile, 'cordis.patch.yml')]
  if (INSTALL.readable) sources.push(join(DSH_INSTALL, 'package.json'))
  return sources.every((s) => !existsSync(s) || statSync(s).mtimeMs <= t)
}

/**
 * 组合后的 profile 树（`dsh --profile <p> --dump-config` 的原文），由**正在跑的那个安装**组合。
 * 缓存到 `.verify/`，因为 doctor 与多个测试都要读它；缓存里记着"这是哪个安装的组合结果"。
 *
 * ★ 不是每个 profile 都能 dump：桌面端那种由 Electron 独占的 profile 会被直接拒绝
 *   （`error: profile "desktop" is managed exclusively by the Electron application`）。
 *   所以这里允许指定 `profile`，让调用方在必要时借一个能 dump 的 profile 去问安装。
 */
export function composedRaw({ fresh = false, profile = PROFILE } = {}) {
  const cache = join(PKG, '.verify', `composed-${profile}.yml`)
  if (!fresh && cacheFresh(profile)) return readFileSync(cache, 'utf8')
  // 用探测出来的 launcher 跑（桌面端 = 它自己的 Electron + asar 内的 bin.js），**不经 shell**。
  const out = runDsh(['--profile', profile, '--dump-config'], { install: INSTALL })
  mkdirSync(dirname(cache), { recursive: true })
  writeFileSync(cache, out, 'utf8')
  writeFileSync(join(PKG, '.verify', 'composed-install.json'), JSON.stringify({ kind: INSTALL.kind, root: INSTALL.root, version: INSTALL.version }), 'utf8')
  return out
}

/** 每条顶层条目属于哪一层——由 `# == … patched by X` 标记还原。 */
function provenanceOf(raw) {
  const marks = []
  const lines = raw.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^#\s*==\s*(.+)$/.exec(lines[i])
    if (m === null) continue
    // 形如 `@deepseek-ai/dsh-base, patched by <层>`；没有 patched by 时层就是它自己。
    const patched = /patched by (.+)$/.exec(m[1])
    marks.push({ line: i, layer: (patched === null ? m[1] : patched[1]).trim() })
  }
  return { marks, lines }
}

/**
 * `patched by <层>` 的层名换成一个绝对目录——**相对路径行的基准目录**。
 * 绝对路径层（profile 的 patch 文件）取它的 dirname；包名层（bundle）取其安装目录。
 *
 * bundle 目录直接用**探测出来的** `packagesDir` 拼，不用 `require.resolve`——
 * 桌面端的包在 asar 里，普通 node 的 resolver 解析不到（那正是这次故障的形状）。
 */
export function baseDirOfLayer(layer) {
  if (layer === undefined || layer.length === 0) return undefined
  if (isAbsolute(layer) || /^[A-Za-z]:[\\/]/.test(layer)) return dirname(layer)
  const short = layer.startsWith('@') ? layer.split('/').slice(1, 2).join('/') : layer.split('/')[0]
  // packagesDir 缺失时不要硬拼（`join(undefined, x)` 会抛）——缓存里可能是旧形状的记录。
  const viaInstall = INSTALL.packagesDir === undefined ? undefined : join(INSTALL.packagesDir, short)
  if (viaInstall !== undefined && existsSync(viaInstall)) return viaInstall
  try {
    return dirname(requireFromDsh.resolve(`${layer.startsWith('@') ? layer.split('/').slice(0, 2).join('/') : short}/package.json`))
  } catch {
    return undefined
  }
}

/**
 * 所有预设声明。
 *
 * ★★ 2026-10-09 重构：**用户那 8 个预设改成直接从 profile 的 patch 读**，不再依赖
 *   `--dump-config`。原因是桌面端的 profile **拒绝被 dump**：
 *       `error: profile "desktop" is managed exclusively by the Electron application`
 *   而桌面端正是学员界面在跑的那份。原来唯一的读取路径（组合树）在活着的 profile 上
 *   **根本走不通**——所以"改了一份、跑的是另一份"能潜伏这么久，不只是默认值写错，
 *   还因为**工具链压根没有一条能问对对象的路**。
 *
 *   组合树仍然读，但只用来拿 shipped 预设（那些在安装的 asar 里，patch 里没有）；
 *   拿不到就少几条 shipped，**用户自己的预设一条都不会因此丢失**。
 *
 * @returns {Array<{rowId, id, name, description, order, plugins, layer, layerIsUser, baseDir, shipped, source}>}
 */
export function presetDeclarations({ fresh = false } = {}) {
  const fromPatch = profilePatchDeclarations()
  const seen = new Set(fromPatch.map((d) => d.id))
  // ★ 2026-10-24：预设也可以由 bundle patch 声明（学习套件把「总规划」装在包里，
  //   新学生装完套件就有它）。profile 的覆盖行优先级最高，其次是 bundle，最后才是
  //   shipped；shipped 里已有的 id 不再从 bundle 里补，避免把 standard 这类内置预设
  //   误报成"用户自己声明的"。
  //
  // ★ 2026-11-07：顺序反过来算——bundle 先、shipped 后，但**只认非内置包**的 bundle。
  //   组合树 dump 里也能看到已装 bundle 声明的那条（它本来就在活配置里），如果先算
  //   shipped，`总规划` 会被贴上 shipped 标签、再从 bundle 归因里被剔掉：报表写成"内置"，
  //   而 check-plugin-names 的"10 条用户预设"于是报"缺少 study-planner"——一次假红，
  //   真因是归因顺序。
  //   反过来也要防另一个极端：`dsh.profile.bundles` 里同时装着会**转贴内置预设**的包
  //   （本机是 `billion-context`，它的 bundle patch 原样带一份 standard/ptc/minimal/cordis），
  //   把这些也当用户预设，就会冒出"standard 没有显示名 / 没有 order"的第二类假红。
  //   区分不靠包名（`@local/*` 与第三方转贴都在 profile node_modules 里，路径分不出来），
  //   靠**作者痕迹**：自己写的预设一定有数字 `order`（选择器要排序），转贴的内置副本没有。
  const fromBundles = bundlePatchDeclarations().filter(
    (d) => !seen.has(d.id) && Number.isFinite(d.order),
  )
  const bundleIds = new Set(fromBundles.map((d) => d.id))
  let shipped = []
  let composedError
  try {
    shipped = composedPresetDeclarations({ fresh }).filter(
      (d) => d.shipped && !seen.has(d.id) && !bundleIds.has(d.id),
    )
  } catch (error) {
    composedError = String(error?.message ?? error).split('\n')[0]
  }
  const all = [...fromPatch, ...fromBundles, ...shipped].sort((a, b) => (a.order ?? 999) - (b.order ?? 999))
  Object.defineProperty(all, 'composedError', { value: composedError, enumerable: false })
  return all
}

/**
 * **只读 profile 自己的 `cordis.patch.yml`**，把里面的预设声明解析出来。
 * 这条路不碰 `--dump-config`，所以在桌面端（profile 被 Electron 独占）也走得通。
 *
 * 条目形态与组合树一致：`{ id: "preset-<x>", config: { id, name, description, order, plugins } }`，
 * 也可能嵌在 `insert: [...]` 或 group 的 `config: [...]` 里。
 */
function declarationsFromDoc(doc, { layer, baseDir, source }) {
  const out = []
  const walk = (rows) => {
    for (const row of Array.isArray(rows) ? rows : []) {
      if (row === null || typeof row !== 'object') continue
      if (typeof row.id === 'string' && row.id.startsWith('preset-')) {
        const cfg = row.config ?? {}
        out.push({
          rowId: row.id,
          id: cfg.id ?? row.id.replace(/^preset-/, ''),
          name: cfg.name,
          description: cfg.description,
          order: cfg.order,
          plugins: Array.isArray(cfg.plugins) ? cfg.plugins : [],
          layer,
          layerIsUser: true,
          baseDir,
          shipped: false,
          source,
        })
      }
      if (Array.isArray(row.insert)) walk(row.insert)
      if (Array.isArray(row.config)) walk(row.config)
      if (Array.isArray(row.plugins)) walk(row.plugins)
    }
  }
  walk(doc)
  return out
}

export function profilePatchDeclarations({ patch = PROFILE_PATCH, dir = PROFILE_DIR } = {}) {
  if (!existsSync(patch)) return []
  let doc
  try {
    // `!!js <表达式>` 是 DSH 的自定义标签：js-yaml 不认它，剥掉标签保留表达式文本即可
    // （我们只读声明结构，不求值——求值要宿主环境）。
    doc = yaml.load(readFileSync(patch, 'utf8').replace(/!!js\s?/g, ''))
  } catch (error) {
    throw new Error(`profile patch 解析失败（${patch}）：${String(error?.message ?? error).split('\n')[0]}`)
  }
  return declarationsFromDoc(doc, { layer: patch, baseDir: dir, source: 'profile-patch' })
}

/**
 * **组合包 patch 里的预设声明**——这条是给「学习套件装一次就有总规划」用的。
 *
 * 套件把 study-planner 声明在 `study-plugins/cordis.patch.yml`；新学生装完套件后
 * profile 的 patch 里**没有**这一行。如果工具链只读 profile patch，doctor /
 * check-preset-yml 会把"选择器里有、工具却看不到"当成零预设——同一类
 * "检查网读着没人读的东西"的复发（见文件头注释）。
 *
 * 只读 profile `node_modules` 里真实可读的组合包；Electron 安装里的 shipped 组合包
 * 读不到就跳过（那些由 composedPresetDeclarations 负责）。
 */
export function bundlePatchDeclarations({ dir = PROFILE_DIR } = {}) {
  const pkgPath = join(dir, 'package.json')
  if (!existsSync(pkgPath)) return []
  let pkg
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  } catch {
    return []
  }
  const bundles = pkg?.dsh?.profile?.bundles
  if (!Array.isArray(bundles)) return []
  const out = []
  for (const name of bundles) {
    if (typeof name !== 'string') continue
    const bundleDir = join(dir, 'node_modules', name)
    const manifestPath = join(bundleDir, 'package.json')
    if (!existsSync(manifestPath)) continue
    let manifest
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    } catch {
      continue
    }
    const patch = manifest?.dsh?.bundle?.patch
    const rels = Array.isArray(patch) ? patch : typeof patch === 'string' ? [patch] : []
    for (const rel of rels) {
      if (typeof rel !== 'string') continue
      const patchPath = resolve(bundleDir, rel)
      if (!existsSync(patchPath)) continue
      let doc
      try {
        doc = yaml.load(readFileSync(patchPath, 'utf8').replace(/!!js\s?/g, ''))
      } catch {
        continue
      }
      out.push(...declarationsFromDoc(doc, { layer: patchPath, baseDir: dirname(patchPath), source: `bundle(${name})` }))
    }
  }
  return out
}

/**
 * **学员实际收到的那一组预设声明** = profile patch ∪ 该 profile 已装的组合包 patch。
 *
 * 为什么需要它（2026-11-05 的事故）：0.2.2 起「总规划」只声明在 `@local/dsh-study` 的
 * bundle patch 里，profile patch 里**没有这一行**。任何"只读 profile patch、再按 id 取
 * persona"的检查都会拿到 `undefined`，轻则当成缺预设，重则直接 TypeError 崩掉整个套件
 * （check-profile-live 就是这么崩的，而 doctor 只看到 exit 非 0、报出"有规则只落在别的
 * profile 上"这种误导性结论）。
 *
 * 合并顺序：组合包先、profile 后 —— 同一个 id 两处都声明时，**profile 的那份是生效的**
 * （DSH 的覆盖语义），所以让 profile 后写覆盖掉。
 */
export function deliveredDeclarations({ patch = PROFILE_PATCH, dir = PROFILE_DIR } = {}) {
  const byId = new Map()
  for (const d of bundlePatchDeclarations({ dir })) byId.set(d.id, d)
  for (const d of profilePatchDeclarations({ patch, dir })) byId.set(d.id, d)
  return [...byId.values()]
}

/**
 * 组合树里的预设声明（主要价值是 shipped 那些）。dump 不了时**借一个能 dump 的 profile 再问一次**。
 *
 * 为什么借是正当的：**shipped 预设来自安装，与 profile 无关**——`standard` 之类的行由
 * `dsh-web-app` 的 shipped patch 提供，两个 profile 组合出来的那一层是同一份。
 * 而桌面端的 profile 会**拒绝** dump，于是"活着的 profile"恰恰是唯一问不到安装的那个。
 * 借来的结果会打上 `source: 'composed(<profile>)'`，让"这条是借来的"看得见。
 */
function composedPresetDeclarations({ fresh = false } = {}) {
  const tried = []
  let firstError
  for (const profile of [PROFILE, ...allProfiles().filter((p) => p !== PROFILE)]) {
    try {
      const decls = presetDeclsFromDump(composedRaw({ fresh, profile }), profile)
      tried.push(`${profile}:${decls.length}`)
      // **shipped 预设来自安装，与 profile 无关**：任何一个能 dump 且组合进了 shipped 的
      // profile 都能给出完整的那一份。所以第一次拿到非空结果就够了，不必把每个 profile 都跑一遍
      // （每次 dump 要一两秒，doctor 与几十个测试都要问）。
      // ★ 别只试"第一个别的 profile"：`headless` 的组合里**没有** shipped 预设，
      //   按字母序它恰好排在最前——只试一个的话会"成功但为空"，比报错更难发现。
      if (decls.length > 0) return decls
    } catch (error) {
      if (firstError === undefined) firstError = error
      tried.push(`${profile}:拒绝（${String(error?.message ?? error).split('\n')[0].slice(0, 60)}）`)
    }
  }
  if (firstError !== undefined) throw firstError
  return []
}

/** 从一份 `--dump-config` 原文里抠出预设声明。 */
function presetDeclsFromDump(raw, profile) {
  const { marks } = provenanceOf(raw)
  const doc = yaml.load(raw.replace(/!!js\s?/g, ''))
  const decls = []
  const layerAt = (line) => {
    let best
    for (const m of marks) if (m.line <= line) best = m.layer
    return best
  }
  // 顶层条目的行号：YAML 解析后不再有行号，所以用"重建出的顺序"对齐是不稳的。
  // 改为按**条目内容**回头在原文里定位 `id:` 行——顶层条目数很少（~200），够用且不依赖 YAML 行号。
  let cursor = 0
  for (const entry of Array.isArray(doc) ? doc : []) {
    const rows = Array.isArray(entry?.insert) ? entry.insert : entry?.id === undefined ? [] : [entry]
    for (const row of rows) {
      if (typeof row?.id !== 'string' || !row.id.startsWith('preset-')) continue
      // 在原文里找 `- id: <rowId>`（顶层或 insert 内），用来取这一条上方的来源标记
      const needle = new RegExp(`^\\s*-\\s*id:\\s*["']?${row.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']?\\s*$`)
      let found = -1
      const lines = raw.split('\n')
      for (let i = cursor; i < lines.length; i += 1) {
        if (needle.test(lines[i])) { found = i; cursor = i; break }
      }
      const layer = found >= 0 ? layerAt(found) : undefined
      const cfg = row.config ?? {}
      decls.push({
        rowId: row.id,
        id: cfg.id ?? row.id.replace(/^preset-/, ''),
        name: cfg.name,
        description: cfg.description,
        order: cfg.order,
        plugins: Array.isArray(cfg.plugins) ? cfg.plugins : [],
        layer,
        layerIsUser: layer !== undefined && (isAbsolute(layer) || /^[A-Za-z]:[\\/]/.test(layer)),
        baseDir: baseDirOfLayer(layer),
        shipped: !(layer !== undefined && (isAbsolute(layer) || /^[A-Za-z]:[\\/]/.test(layer))),
        // 记下这条是从**哪份组合树**读来的。"借来的"必须看得见——shipped 与 profile 无关，
        // 但用户预设是**跟 profile 走的**，借错就会读到别人的声明（见调用处的过滤）。
        source: profile === PROFILE ? 'composed' : `composed(${profile})`,
      })
    }
  }
  return decls.sort((a, b) => (a.order ?? 999) - (b.order ?? 999))
}

/** 用户自己声明的那些（排除 shipped）。 */
export function userPresets(options) {
  return presetDeclarations(options).filter((d) => !d.shipped)
}

// ── 插件行 ──────────────────────────────────────────────────────────────────

/**
 * 把 `plugins` 递归摊平成一串行。group 行（`cordis:group` / 带 `group: true`）会被展开，
 * 因为它们的子行才是真正挂载的东西——只看第一层会把 group 里的插件整个漏掉。
 * @returns {Array<{id, name, disabled, depth}>}
 */
export function flattenRows(rows, depth = 0, out = []) {
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row === null || typeof row !== 'object') continue
    if (typeof row.name === 'string') out.push({ id: row.id, name: row.name, disabled: row.disabled === true, depth })
    if (Array.isArray(row.config)) flattenRows(row.config, depth + 1, out)      // cordis:group 的子行写在 config 列表里
    else if (Array.isArray(row.plugins)) flattenRows(row.plugins, depth + 1, out)
  }
  return out
}

/** 一个预设里出现的全部 name（去重）——升级体检要的就是这一串。 */
export function pluginNamesOf(decl) {
  return [...new Set(flattenRows(decl.plugins).map((r) => r.name))].filter((n) => n !== '@deepseek-ai/dsh-agent-preset')
}

/** 按 id 取一条声明（`code-tutor` 这样的预设 id，不是 `preset-code-tutor` 这个行 id）。 */
export function declById(id, options) {
  return presetDeclarations(options).find((d) => d.id === id)
}

/**
 * 在声明里按 `id` 找一条**插件行**（含 group 内部），返回原始行（带 config）。
 * 给"这条预设的 study 行点名了哪些 parts""persona 的 prefix 写了什么"这类断言用。
 */
export function findPluginRow(decl, rowId) {
  const find = (rows) => {
    for (const r of Array.isArray(rows) ? rows : []) {
      if (r === null || typeof r !== 'object') continue
      if (r.id === rowId) return r
      const nested = Array.isArray(r.config) ? r.config : Array.isArray(r.plugins) ? r.plugins : null
      if (nested !== null) { const hit = find(nested); if (hit !== undefined) return hit }
    }
    return undefined
  }
  return find(decl?.plugins)
}

/** 取 persona 行的 prefix 文本（persona 断言用）。 */
export function personaPrefixOf(decl) {
  // 传 undefined 时返回 undefined 而不是崩：调用方（check-profile-live）要能自己决定
  // "这条预设不存在"是跳过还是失败。2026-11-05 那次 TypeError 就是从这儿抛的。
  if (decl === undefined || decl === null) return undefined
  const row = flattenRows(decl.plugins).find((r) => r.name === '@deepseek-ai/dsh-persona')
  if (row === undefined) return undefined
  // flattenRows 只带出 name，prefix 要回原结构取
  const find = (rows) => {
    for (const r of Array.isArray(rows) ? rows : []) {
      if (r?.name === '@deepseek-ai/dsh-persona') return r.config?.prefix
      const nested = Array.isArray(r?.config) ? r.config : Array.isArray(r?.plugins) ? r.plugins : null
      if (nested !== null) { const hit = find(nested); if (hit !== undefined) return hit }
    }
    return undefined
  }
  return find(decl.plugins)
}

// ── 名字解析（升级体检的核心）──────────────────────────────────────────────
const isPathLike = (n) => n.startsWith('./') || n.startsWith('../') || n.startsWith('/') || /^[A-Za-z]:[\\/]/.test(n)

/**
 * 一行 `name:` 到底指向什么、现在还存不存在。
 *
 * 三种形态，规则各不相同：
 *   · `cordis:*`        —— 内置，永远算解析得到
 *   · 包名              —— 按**已安装的 harness** 解析（bundle 预检用的就是它）
 *   · 路径              —— **相对路径按声明它的那一层的目录解析**（0.1.7 的关键变化），
 *                          绝对路径直接看文件在不在。裸 Windows 绝对路径要按 URL 看。
 */
export function resolveRowName(name, { baseDir } = {}) {
  if (typeof name !== 'string' || name.length === 0) return { kind: 'invalid', ok: false, detail: '空名字' }
  if (name.startsWith('cordis:')) return { kind: 'builtin', ok: true }
  if (isPathLike(name)) {
    const abs = isAbsolute(name) || /^[A-Za-z]:[\\/]/.test(name)
      ? resolve(name)
      : baseDir === undefined ? undefined : resolve(baseDir, name)
    if (abs === undefined) return { kind: 'file', ok: false, detail: `相对路径但不知道基准目录：${name}` }
    return { kind: 'file', ok: existsSync(abs), target: abs, detail: existsSync(abs) ? undefined : `本地文件不存在：${abs}` }
  }
  const pkg = name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name.split('/')[0]
  // ★ 不用 `require.resolve`：桌面端的包在 asar 里，普通 node 的 resolver **看不见**它们，
  //   于是"解析不到"会把所有行都判成失败——而它其实只是"我读不到"。
  //   改为按**探测出来的包清单**判（`@deepseek-ai/*`）或看 profile 的真目录（第三方 bundle）。
  if (hasPackage(pkg, INSTALL)) return { kind: 'package', ok: true, target: pkg }
  return {
    kind: 'package',
    ok: false,
    target: pkg,
    detail: `安装里没有这个包 ${pkg}（清单来自 ${INSTALL.kind} 的 ${INSTALL.packages.length} 个包；第三方 bundle 看 profile 的 node_modules）`,
  }
}

// ── 旧目录（0.1.7 起无人读取；只作迁移对照）─────────────────────────────────
export function legacyDirOf(id) {
  return join(LEGACY_DIR, id)
}
export function legacyRowsOf(id) {
  const f = join(legacyDirOf(id), 'agent.cordis.yml')
  if (!existsSync(f)) return undefined
  try {
    return yaml.load(readFileSync(f, 'utf8').replace(/!!js\s?/g, ''))
  } catch {
    return undefined
  }
}
export function legacyMetaOf(id) {
  const f = join(legacyDirOf(id), 'preset.yml')
  if (!existsSync(f)) return undefined
  try {
    return yaml.load(readFileSync(f, 'utf8'))
  } catch {
    return undefined
  }
}

// ── CLI ─────────────────────────────────────────────────────────────────────
if (process.argv[1] !== undefined && process.argv[1].endsWith('presets.mjs')) {
  const decls = presetDeclarations({ fresh: process.argv.includes('--fresh') })
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(decls.map((d) => ({ ...d, names: pluginNamesOf(d) })), null, 2))
  } else {
    // ★ 先把"我问的是哪个 profile、凭什么这么认为"打出来。过去这里没打，
    //   于是"改了一份、跑的是另一份"整整两周没人看见。
    console.log(`\n读的是：${describeProfile(PROFILE_INFO)}`)
    console.log(`  patch：${PROFILE_PATCH}`)
    const others = allProfiles().filter((p) => p !== PROFILE)
    if (others.length > 0) console.log(`  别的 profile：${others.join('、')}（不读它们——但它们可能才是活的那个）`)
    console.log(`\n预设声明 ${decls.length} 条（shipped ${decls.filter((d) => d.shipped).length} · 用户 ${decls.filter((d) => !d.shipped).length}）`)
    for (const d of decls) {
      const rows = flattenRows(d.plugins)
      const bad = []
      for (const r of rows) {
        const res = resolveRowName(r.name, { baseDir: d.baseDir })
        if (!res.ok) bad.push(`${r.name} — ${res.detail}`)
      }
      const tag = d.shipped ? 'shipped' : '用户  '
      console.log(`\n■ ${tag} ${d.id.padEnd(20)} ${d.name ?? '(无 name)'}  order=${d.order ?? '-'}`)
      console.log(`   行 ${rows.length} 条 · 层 ${d.layer ?? '?'} · 基准 ${d.baseDir ?? '?'}`)
      if (bad.length === 0) console.log('   ✅ 所有插件名都可解析')
      else for (const b of bad) console.log(`   ❌ ${b}`)
    }
  }
}