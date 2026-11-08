// snapshot.mjs —— 给这个**没有版本控制**的包做快照 / 比对。
//
// 为什么有它（2026-09-28，第二次数据损失）：
//   2026-09-25 我用 PowerShell 毁掉 `plan-core.js` 之后，在 LEARNINGS 里写过一条：
//   「给'源码'这类没有版本控制的东西**留一份兜底**；并且**知道你手上这层兜底是什么**」。
//   我写了，但**没做**。三天后 `plan-core.js` / `companion-core.js` / `file-guard.js`
//   三个文件的内容被一份保留时间戳的旧快照盖回 09-26 的状态（同目录下当天写的其它文件都在），
//   `npm test` 当场变红——而我能做的只有**手工重贴**当天两百多行改动。
//   这一条教训的形态是："把纪律写下来不等于执行了纪律"（与 F21 的『声明 ≠ 执行』同源）。
//
// 用法：
//   node tools/snapshot.mjs                    生成快照 → <工作区>\.backup\study-plugins-<时间戳>\
//   node tools/snapshot.mjs --list             列出已有快照
//   node tools/snapshot.mjs --diff <快照目录>   比对当前包 vs 快照：列出新增/删除/内容不同的文件
//   node tools/snapshot.mjs --diff latest      与最新快照比对
//
// `--diff` 是"代码还在不在"的**一条命令**答案：内容不同 = 被改过或被回退了。
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'

const PKG = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
// 快照放在**工作区**（与包不同盘/不同目录），这样"包被快照覆盖"不会连带毁掉兜底本身。
const BACKUP_ROOT = process.env.DSH_STUDY_BACKUP ?? './创建预设/.backup'
const KEEP = 10
const SKIP_DIRS = new Set(['node_modules', '.verify', '.health', '.git'])

const walk = (dir, out = []) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') && e.isDirectory()) continue
    if (SKIP_DIRS.has(e.name)) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(js|mjs|json|yml|yaml|md)$/.test(e.name)) out.push(p)
  }
  return out
}

const listSnapshots = () => {
  if (!existsSync(BACKUP_ROOT)) return []
  return readdirSync(BACKUP_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith('study-plugins-'))
    .map((e) => join(BACKUP_ROOT, e.name))
    // ⚠️ 按**修改时间**排，不按名字排：名字里可能混着不同来源（工具用 UTC、手工备份用本地时间），
    //    字符串排序会把 `…-133142`（UTC 13:31 = 本地 21:31）排到 `…-2130` 前面——
    //    于是 `--diff latest` 悄悄比对了**较旧**的那一份。第一版就是这么错的。
    .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs)
}

const args = process.argv.slice(2)

if (args[0] === '--list') {
  const snaps = listSnapshots()
  console.log(snaps.length === 0 ? `还没有快照（目录：${BACKUP_ROOT}）` : `已有 ${snaps.length} 个快照：`)
  for (const s of snaps.slice(-KEEP + 1)) console.log(`  ${basename(s)}  ${statSync(s).isDirectory() ? walk(s).length : 0} 个文件`)
  process.exit(0)
}

if (args[0] === '--diff') {
  let target = args[1]
  if (target === undefined) { console.log('用法：node tools/snapshot.mjs --diff <快照目录|latest>'); process.exit(1) }
  if (target === 'latest') {
    const snaps = listSnapshots()
    if (snaps.length === 0) { console.log('没有快照可比'); process.exit(1) }
    target = snaps.at(-1)
  }
  if (!existsSync(target)) { console.log(`快照不存在：${target}`); process.exit(1) }
  const now = new Map(walk(PKG).map((p) => [relative(PKG, p), p]))
  const then = new Map(walk(target).map((p) => [relative(target, p), p]))
  const changed = []
  const added = []
  const removed = []
  for (const [rel, p] of now) {
    if (!then.has(rel)) { added.push(rel); continue }
    if (readFileSync(p, 'utf8') !== readFileSync(then.get(rel), 'utf8')) changed.push(rel)
  }
  for (const rel of then.keys()) if (!now.has(rel)) removed.push(rel)
  console.log(`快照：${target}`)
  console.log(`文件数：当时 ${then.size} → 现在 ${now.size}`)
  const show = (label, list) => { if (list.length > 0) console.log(`  ${label} ${list.length} 个：${list.slice(0, 12).join(' · ')}${list.length > 12 ? ' …' : ''}`) }
  show('内容不同', changed)
  show('新增', added)
  show('已消失', removed)
  if (changed.length === 0 && added.length === 0 && removed.length === 0) console.log('  ✅ 与快照完全一致')
  process.exit(0)
}

// 默认：生成快照（用**本地时间**命名，跟人看到的日期一致）
const d = new Date()
const p2 = (n) => String(n).padStart(2, '0')
const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`
const dest = join(BACKUP_ROOT, `study-plugins-${stamp}`)
mkdirSync(dest, { recursive: true })
const files = walk(PKG)
for (const f of files) {
  const rel = relative(PKG, f)
  const out = join(dest, rel)
  mkdirSync(join(out, '..'), { recursive: true })
  copyFileSync(f, out)
}
const total = files.reduce((n, f) => n + statSync(f).size, 0)
console.log(`✅ 快照 ${files.length} 个文件 / ${Math.round(total / 1024)}KB → ${dest}`)

// 只保留最近 KEEP 个
const snaps = listSnapshots()
for (const old of snaps.slice(0, Math.max(0, snaps.length - KEEP))) {
  rmSync(old, { recursive: true, force: true })
  console.log(`  （清掉较旧的 ${basename(old)}）`)
}
console.log(`\n以后随时可以用这一条命令回答"我的改动还在不在"：\n  npm run snapshot -- --diff latest`)