// selfcheck.mjs —— **一条命令的自检**，给定时任务用（也给人用）。
//
// 为什么需要它（2026-09-29）：
//   这套系统的检查全是**拉式**的：你得想起来跑 `npm test` / `doctor`，它们才会说话。
//   而 2026-09-28 实际发生的是：三个插件源码被一份旧快照盖回两天前的状态，**我毫无察觉**，
//   是学员问"执行得对不对"才查出来的。拉式检查救不了"我没去看"。
//   定时任务能把检查变成**推式**——但它需要一个值得被定时执行的**单一入口**，
//   而且要能自己区分两类完全不同的"红"：
//
//     ① **系统坏了**：源码被改/被回退、导出缺失、打包错、YAML 坏 → **必须有人去修**（exit 1）
//     ② **现场待办**：某科档案快满了、档案陈旧了、有跨科条目没收下 → **学员的事，不是故障**（exit 0）
//
//   把这两类混在一起报，是这套系统最容易被误解的地方（`doctor` 的收尾语就是
//   「这里绿 ≠ 现场健康」，反过来也成立：**现场红 ≠ 系统坏**）。
//   定时任务如果分不清这两类，它就会在"学员只是该整理档案了"的时候喊"系统故障"——
//   喊几次之后就被无视了，那它还不如没有。
//
// 用法：
//   node tools/selfcheck.mjs            人类可读的三段报告
//   node tools/selfcheck.mjs --quiet    只输出结论（定时任务用；绿色时一行）
// 退出码：0 = 系统健康（现场有红灯也算健康）；1 = 系统真的坏了
//
// ⚠️ 实现细节：**不用管道抓子进程输出**。Windows 沙箱下 `spawn` 带 pipe 会 EPERM
//    （"programs cannot open named pipes"），所以这里把子进程的 stdout/stderr 直接接到一个
//    **临时文件的 fd** 上，跑完再读文件——绕开管道，行为一致。
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PKG = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const quiet = process.argv.includes('--quiet')
const tmp = mkdtempSync(join(tmpdir(), 'selfcheck-'))

/** 跑一个脚本，返回 {code, out}。输出走临时文件而不是管道。 */
const run = (script, args = []) => {
  const log = join(tmp, `${script.replaceAll(/[\\/.]/g, '_')}.log`)
  const fd = openSync(log, 'w')
  const r = spawnSync(process.execPath, [join(PKG, script), ...args], { cwd: PKG, stdio: ['ignore', fd, fd] })
  closeSync(fd)
  let out = ''
  try { out = readFileSync(log, 'utf8') } catch { /* 没输出 */ }
  return { code: r.status ?? -1, out }
}

const tail = (out, n = 1) => out.trim().split('\n').filter((l) => l.trim().length > 0).slice(-n).join(' ｜ ')
const badLines = (out) => out.split('\n').filter((l) => l.includes('❌')).map((l) => l.trim()).slice(0, 4)

// ── 第一类：系统本身（必须永远绿）──────────────────────────────────────────────
const systemChecks = [
  ['插件 API 清单', 'test/check-plugin-api.mjs', []],       // 少一个导出 = 源码被动过
  ['源码与快照比对', 'tools/snapshot.mjs', ['--diff', 'latest']], // 内容变了 = 被改过/被回退
  ['打包不变量', 'test/check-package.mjs', []],              // BOM / 编码损坏 / JSON / 过期引用
]
const system = []
for (const [label, script, args] of systemChecks) {
  const r = run(script, args)
  system.push({ label, ...r, ok: r.code === 0 })
}

// ── 第二类：现场（红是待办，不是故障）─────────────────────────────────────────
const doctor = run('study-doctor.mjs')
const doctorBad = doctor.out.split('\n').filter((l) => /❌|⚠️/.test(l)).map((l) => l.replace(/^\s+/, '').trim())
const systemBroken = system.filter((s) => !s.ok)

if (quiet) {
  if (systemBroken.length > 0) {
    console.log(`❌ 系统坏了：${systemBroken.map((s) => s.label).join('、')}`)
    for (const s of systemBroken) console.log(`   ${s.label}: ${tail(s.out)}`)
    console.log(`   先跑 npm run snapshot -- --diff latest 看是哪些文件被动过`)
  } else {
    console.log(`✅ 系统健康（API 清单 / 快照比对 / 打包不变量 全绿）· 现场 ${doctorBad.length} 条待办`)
  }
  rmSync(tmp, { recursive: true, force: true })
  process.exit(systemBroken.length === 0 ? 0 : 1)
}

console.log(`\n自检  ${new Date().toLocaleString('zh-CN')}`)
console.log('\n① 系统本身（这三条必须永远绿；红了就是"有人动过源码"或"打包坏了"）')
for (const s of system) {
  console.log(`  ${s.ok ? '✅' : '❌'} ${s.label.padEnd(16)} ${tail(s.out, s.ok ? 1 : 2)}`)
  if (!s.ok) for (const l of badLines(s.out)) console.log(`       ${l}`)
}
console.log('\n② 现场（红/黄是**学员的待办**，不是故障）')
if (doctorBad.length === 0) console.log('  ✅ 无待办')
else for (const l of doctorBad.slice(0, 8)) console.log(`  ${l}`)
if (doctorBad.length > 8) console.log(`  …（另有 ${doctorBad.length - 8} 条，跑 npm run doctor 看全部）`)

console.log(`\n结论：${systemBroken.length === 0 ? '✅ 系统健康' : '❌ 系统有问题'}${doctorBad.length > 0 ? ` · 现场 ${doctorBad.length} 条待办（学员侧）` : ''}`)
if (systemBroken.length > 0) {
  console.log('下一步：npm run snapshot -- --diff latest  →  看哪些文件与快照不一致；')
  console.log('        如果确实是代码被回退，用快照里的版本比对后重贴（见 README「改含中文的文件」一节）')
}
rmSync(tmp, { recursive: true, force: true })
process.exit(systemBroken.length === 0 ? 0 : 1)