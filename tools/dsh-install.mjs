// dsh-install.mjs — **「我问的是哪个 DSH」的唯一答案处**。
//
// ═══ 为什么需要它（2026-09-24，桌面端）════════════════════════════════════════
// 前两次升级，我的检查都读着"已经不生效的东西"（F21：预设目录、v3 日志文件名）。
// 这一次是同一个教训的第三种形态，而且更隐蔽：
//
//   **机器上同时存在两个 dsh 安装，而我的工具写死了其中一个。**
//     · 桌面端：`D:\DSH\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh` —— **正在跑的就是它**（0.1.7-rc.2）
//     · npm 全局：`%APPDATA%\npm\node_modules\@deepseek-ai\dsh`            —— 遗留副本（0.1.7-rc.1）
//
// 于是 `--dump-config` 组合的是 npm 那份 rc.1 的宿主树，包名也是按 rc.1 解析的。今天两者
// 恰好得出同样的结论（四个 shipped 预设文件字节相同），但那是**运气**，不是保证——
// `dsh-base` / `dsh-web-app` 的 patch 在两边**确实不同**。
//
// 桌面端的包在 `app.asar` 里，普通 node 与 shell **读不到**（`Test-Path` 返回 False）。
// 唯一的读法是让**桌面端自己的 Electron** 以 `ELECTRON_RUN_AS_NODE=1` 充当 node——
// Electron 自带 asar 的 fs 补丁，那个模式下依然生效（`tools/asar-probe.mjs` 就是干这个的）。
//
// 纪律：**优先用正在跑的那个安装**，其次才是能读到的那个；并且把"我问的是谁"打进输出，
// 让错的答案看得见（看不见的错答案就是下一个假绿）。
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
// ★ 与 presets.mjs 同一条纪律：profile 也**不许写死**。见 tools/live-profile.mjs 头注。
import { detectProfile } from './live-profile.mjs'

export const PKG = dirname(dirname(fileURLToPath(import.meta.url)))
export const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')

/** 桌面端安装位（Electron 应用 + 打包进 asar 的 dsh 树）。 */
export const DESKTOP = {
  exe: process.env.DSH_DESKTOP_EXE ?? 'D:/DSH/DeepSeek Harness.exe',
  asar: process.env.DSH_DESKTOP_ASAR ?? 'D:/DSH/resources/app.asar',
}
/** asar 内 dsh 树的路径（**只有 Electron 读得到**）。 */
export const DESKTOP_DSH_IN_ASAR = `${DESKTOP.asar}/dsh/node_modules/@deepseek-ai/dsh`
/**
 * asar 内**包清单**所在的那一层。
 * 桌面端 `<asar>/dsh` 是个 wrapper（`@deepseek-ai/dsh-desktop-runtime`），284 个包 hoist 在
 * 它的 `node_modules/@deepseek-ai` 下；真正的 CLI 包是它的子目录 `dsh`。**两者不是同一层**，
 * 混起来会得到"0 个包"，而那会让所有名字解析都误判为失败。
 */
export const DESKTOP_PACKAGES_IN_ASAR = `${DESKTOP.asar}/dsh/node_modules/@deepseek-ai`
/** npm 全局安装位（遗留副本；CLI 场景下它才是"正在跑的那个"）。 */
export const NPM_DSH = process.env.DSH_NPM_INSTALL
  ?? join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'npm', 'node_modules', '@deepseek-ai', 'dsh')
/** 探测结果的缓存（跑一次 Electron 要一秒多，而 doctor 与多个测试都要问）。 */
const CACHE = join(PKG, '.verify', 'dsh-install.json')

/** 这个路径**从普通 node**看得见吗——asar 里的路径看不见。 */
export const visible = (p) => { try { return existsSync(p) } catch { return false } }

/**
 * 一次安装的**新鲜度指纹**：桌面端看 `app.asar` 的 mtime，其它安装看根 `package.json`。
 *
 * ★ 2026-10-17 修：原来缓存判据是 `visible(cached.root) || cached.kind === 'desktop'`，
 *   而桌面端路径永远 visible ⇒ **桌面端缓存永不过期**。于是 0.1.7-rc.1 升级到 0.2.1-rc.1
 *   之后，缓存里还写着 `version: 0.1.7-rc.2`，"问的是哪个安装"这句输出在**撒谎**，
 *   升级前后的差异全都看不见。这又是一个 F16/F21 同族：**检查读的是旧快照**。
 *   现在按安装文件的 mtime 判新鲜；没有 stamp 的旧缓存一律作废（宁可多探一次）。
 */
function stampOf(kind, root) {
  try {
    if (kind === 'desktop') return statSync(DESKTOP.asar).mtimeMs
    if (root !== undefined) return statSync(join(root, 'package.json')).mtimeMs
    if (visible(NPM_DSH)) return statSync(join(NPM_DSH, 'package.json')).mtimeMs
  } catch { /* 读不到就不设新鲜标记 */ }
  return undefined
}

/**
 * 用桌面端的 Electron 探一次 asar 里的树。
 * 返回探针的 JSON，或 `{ok:false, error}`。**只在桌面端存在时才可调用**。
 */
export function probeDesktop() {
  if (!visible(DESKTOP.exe)) return { ok: false, error: `找不到桌面端可执行文件：${DESKTOP.exe}` }
  if (!visible(DESKTOP.asar)) return { ok: false, error: `找不到 app.asar：${DESKTOP.asar}` }
  try {
    const out = execFileSync(DESKTOP.exe, [join(PKG, 'tools', 'asar-probe.mjs'), DESKTOP_DSH_IN_ASAR, DESKTOP_PACKAGES_IN_ASAR], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      maxBuffer: 32 * 1024 * 1024,
      timeout: 120_000,
    })
    const line = out.split('\n').find((l) => l.trim().startsWith('{'))
    return line === undefined ? { ok: false, error: '探针没有输出 JSON' } : JSON.parse(line)
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error).split('\n')[0] }
  }
}

/**
 * 决定"问哪个安装"。顺序即优先级：
 *   1. `DSH_INSTALL` 环境变量（显式指定，最高优先）
 *   2. **桌面端**——如果它在，那正在跑的通常就是它
 *   3. npm 全局——CLI 场景的运行时，也是桌面端不存在时的兜底
 *
 * @returns {{kind, root, version, launcher, readable, packages, note}}
 *   `launcher` 是跑该安装 `lib/bin.js` 的方式：`{bin, args0, env}`。
 */
export function detectInstall({ fresh = false } = {}) {
  if (!fresh && visible(CACHE)) {
    try {
      const cached = JSON.parse(readFileSync(CACHE, 'utf8'))
      // 缓存里的**证据**：安装件的 mtime 没变才复用（旧缓存没有 stamp ⇒ 作废重探，
      // 否则升级后版本号会一直停在旧值——2026-10-17 那次的现场）。
      const stamp = cached.stamp
      if (stamp !== undefined && stamp === stampOf(cached.kind, cached.root)) return cached
    } catch { /* 缓存坏了就当没有 */ }
  }

  const explicit = process.env.DSH_INSTALL
  if (explicit !== undefined && explicit.length > 0) {
    return finish({ kind: 'explicit', root: explicit, note: '由 DSH_INSTALL 指定' })
  }

  if (visible(DESKTOP.exe) && visible(DESKTOP.asar)) {
    const probe = probeDesktop()
    if (probe.ok === true) {
      return finish({
        kind: 'desktop',
        root: DESKTOP_DSH_IN_ASAR,
        version: probe.version,
        packages: probe.packages,
        packagesDir: DESKTOP_PACKAGES_IN_ASAR,
        // asar 里的东西普通 node 读不到：跑 bin 要用**它自己的 Electron**。
        // 直接把 `lib/bin.js` 当脚本入口交给它即可——**不需要 shim**：
        // Electron 在 RUN_AS_NODE 模式下把 argv[1] 当脚本、其余参数原样透传（实测），
        // 与 node 的语义一致。而 bin.js 只在"自己是入口"时才跑 CLI（它导出的是 runCli），
        // 所以用 shim 去 import 它反而什么都不会发生。
        launcher: { bin: DESKTOP.exe, env: { ELECTRON_RUN_AS_NODE: '1' } },
        readable: false,
        note: '桌面端（包在 app.asar 内，普通 node 读不到；用 Electron 当 node 跑）',
      })
    }
    // 桌面端在但探不通：不静默降级，把原因带上。
    const npm = finish({ kind: 'npm', root: NPM_DSH, note: `桌面端探测失败（${probe.error}），退回 npm 安装` })
    return npm
  }

  return finish({ kind: 'npm', root: NPM_DSH, note: '未发现桌面端，用 npm 全局安装' })
}

function finish(partial) {
  const root = partial.root
  let version = partial.version
  let packages = partial.packages
  const readable = partial.readable ?? visible(join(root, 'package.json'))
  // `@deepseek-ai` 那一层的目录：npm 是 `<dsh>/node_modules/@deepseek-ai`；
  // 桌面端是 wrapper 的那一层（见 DESKTOP_PACKAGES_IN_ASAR），**两处不一样**。
  const packagesDir = partial.packagesDir ?? join(root, 'node_modules/@deepseek-ai')
  if (readable) {
    try { version = version ?? JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version } catch { /* 保持 undefined */ }
    if (packages === undefined) {
      try { packages = readdirSync(packagesDir).filter((n) => !n.includes('.bak')) } catch { packages = [] }
    }
  }
  const result = {
    kind: partial.kind,
    root,
    version,
    packages: packages ?? [],
    packagesDir,
    readable,
    launcher: partial.launcher ?? { bin: process.execPath, env: {} },
    note: partial.note,
    // 新鲜度指纹：安装件变过（如升级）⇒ 下次 detectInstall 不复用这条缓存。
    stamp: stampOf(partial.kind, root),
  }
  try {
    mkdirSync(dirname(CACHE), { recursive: true })
    writeFileSync(CACHE, JSON.stringify(result, null, 2), 'utf8')
  } catch { /* 缓存写不进去不影响使用 */ }
  return result
}

/** 一行人类可读的"我问的是谁"——**每次输出都要带上它**。 */
export function describeInstall(install = detectInstall()) {
  return `${install.kind} ${install.version ?? '?'} @ ${install.root}（${install.note}${install.readable ? '' : '；文件不可直接读'}）`
}

/**
 * 用**正确的方式**跑这个安装的 `dsh` CLI。
 *
 * npm 安装：`node <root>/lib/bin.js …`；桌面端：`ELECTRON_RUN_AS_NODE=1 <Electron exe> <asar 内 bin.js> …`。
 * 两者都符合 node 的 `argv[1] = 脚本` 约定，所以 bin.js 里的"我是入口吗"判断会通过。
 */
export function runDsh(args, { install = detectInstall(), timeoutMs = 180_000 } = {}) {
  const binPath = join(install.root, 'lib/bin.js')
  return execFileSync(install.launcher.bin, [binPath, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...install.launcher.env },
    maxBuffer: 64 * 1024 * 1024,
    timeout: timeoutMs,
  })
}

/** profile 的 node_modules —— 第三方 bundle（@local/…、@dsh-external/…）装在这里，是**真目录**。 */
export function profileNodeModules(profile = detectProfile().profile) {
  return join(DSH_HOME, 'profiles', profile, 'node_modules')
}

/**
 * 该跑着的安装里有没有这个包。
 *
 * 不用 `require.resolve`：桌面端的包在 asar 里，普通 node 的 resolver **看不见**——
 * 那正是这次故障的形状（"解析不到"与"我读不到"是两件事，这里按目录清单判）。
 *   · `@deepseek-ai/*`  → 看安装的 `@deepseek-ai` 目录清单（由探针/readdir 得到）
 *   · 其它（@local/… 等）→ 看 **profile** 的 node_modules（plugin_manager 装在那儿）
 */
export function hasPackage(name, install = detectInstall()) {
  if (name.startsWith('@deepseek-ai/')) return install.packages.includes(name.slice('@deepseek-ai/'.length))
  const pkgDir = name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name.split('/')[0]
  return visible(join(profileNodeModules(), pkgDir))
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const install = detectInstall({ fresh: process.argv.includes('--fresh') })
  const other = install.kind === 'desktop' ? NPM_DSH : DESKTOP_DSH_IN_ASAR
  console.log(`\n问的是：${describeInstall(install)}`)
  console.log(`  包数：${install.packages.length}`)
  console.log(`  可直读：${install.readable}`)
  console.log(`  启动器：${install.launcher.bin}`)
  console.log(`  另一个安装位：${other}`)
  console.log(`    ${visible(other) ? '（从普通 node 看得见）' : '（看不见——asar 里，或不存在）'}`)
  console.log(`\nprofile node_modules：${profileNodeModules()} ${visible(profileNodeModules()) ? '（在）' : '（不在）'}`)
}