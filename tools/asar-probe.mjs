// asar-probe.mjs —— 这个文件**不由 node 运行**，而要交给桌面端的 Electron 运行：
//
//   $env:ELECTRON_RUN_AS_NODE='1'
//   & 'D:\DSH\DeepSeek Harness.exe' <本文件> <asar 里的 dsh 目录>
//
// 为什么：桌面端把整棵 dsh 打包进 `resources/app.asar`，**普通 node 与 shell 都读不进去**
// （`Test-Path 'D:\DSH\resources\app.asar\dsh'` 返回 False）。但 Electron 自己带着 asar 的 fs 补丁，
// 用 `ELECTRON_RUN_AS_NODE=1` 把它当 node 用时，那层补丁仍在——于是我们能读到桌面端**真正在跑**
// 的那棵树。这是"问对安装"的唯一路子（见 tools/dsh-install.mjs 的头注）。
//
// 输出：一行 JSON 到 stdout（宿主只解析这一行），诊断走 stderr。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const root = process.argv[2]
const packagesDir = process.argv[3] ?? join(root, 'node_modules/@deepseek-ai')
const out = { ok: false, root }
try {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  out.name = pkg.name
  out.version = pkg.version
  out.bin = pkg.bin
  out.hasLibBin = existsSync(join(root, 'lib/bin.js'))
  // ★ 包清单要看**hoist 的那一层**，不是 dsh 包自己的 node_modules。
  //   桌面端：`<asar>/dsh` 是 `@deepseek-ai/dsh-desktop-runtime`（一个 wrapper），
  //   284 个包 hoist 在 `<asar>/dsh/node_modules/@deepseek-ai`；而真正的 CLI 包在
  //   `<asar>/dsh/node_modules/@deepseek-ai/dsh`。两者的 node_modules 不是同一个，
  //   第一版只看了后者，于是"包数 0"——而 0 个包会让所有名字解析都判失败。
  out.packagesDir = packagesDir
  out.packages = existsSync(packagesDir) ? readdirSync(packagesDir).filter((n) => !n.includes('.bak')) : []
  out.packageCount = out.packages.length
  // 版本对照用：shipped 预设文件的指纹（桌面端与 npm 副本可能不同版本）
  out.presetFiles = {}
  const presets = join(packagesDir, 'dsh-web-app/presets')
  if (existsSync(presets)) {
    for (const f of readdirSync(presets)) out.presetFiles[f] = statSync(join(presets, f)).size
  }
  out.ok = true
} catch (error) {
  out.error = String(error?.message ?? error)
}
process.stdout.write(`${JSON.stringify(out)}\n`)