// new-subject.mjs — 加一个科目：一条命令，一处改动。
//
// 为什么需要它：「加一个科目」以前要动 5 处（建目录、写档案骨架、记住三字段、记住日期戳、
// 记住两道上限），而且任何一处错了都要等到会话里被守护拒绝才发现。
// 现在：**它先生成、再用真正的校验器验一遍、验过了才落盘**——生成物不可能被守护拒绝。
//
// 科目是什么：`ST` 下的**直接子目录**，且里面有 `学习档案.md`。规划器靠这条自动发现科目；
// 预设不按科目分（四个伴学预设按"学科门类"分），所以加一个科目**不需要动任何预设**。
//
// 用法：
//   node new-subject.mjs 数学                 建 ST\数学\学习档案.md
//   node new-subject.mjs 离散数学 --outline    同时建一个空的复习提纲骨架
//   node new-subject.mjs 化学 --root D:/别的/ST
//
// 它**拒绝覆盖**已存在的目录。只读校验，写之前不碰任何东西。
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// ★ 2026-10-24 可移植性：套件要发给别的学生，脚本不能只认维护者机器。
//   PLUGINS 按脚本自己的位置取；学习根优先 DSH_STUDY_ROOT，其次当前目录（若看起来是学习根），
//   最后才是维护者机器沿用的旧默认值。
const PLUGINS = dirname(fileURLToPath(import.meta.url)) + '/'
function defaultRoot() {
  if (process.env.DSH_STUDY_ROOT) return process.env.DSH_STUDY_ROOT
  const cwd = process.cwd()
  if (existsSync(join(cwd, '总规划.md')) || existsSync(join(cwd, '大学学习总纲.md'))) return cwd
  return join(cwd, 'ST')
}
const core = await import(pathToFileURL(PLUGINS + 'companion-core.js').href)

const argv = process.argv.slice(2)
const name = argv.find((a) => !a.startsWith('--'))
const outline = argv.includes('--outline')
const rootArg = argv.indexOf('--root')
const ROOT = rootArg >= 0 ? argv[rootArg + 1] : defaultRoot()

if (name === undefined) {
  console.error('用法：node new-subject.mjs <科目名> [--outline] [--root <学习根>]')
  process.exit(2)
}

// ── 名字校验：这些不是洁癖，每一条都对应一个真实的坏法 ──────────────────────
const problems = []
if (name.trim() !== name || name.length === 0) problems.push('名字首尾不能有空白')
if (/[\\/:*?"<>|]/.test(name)) problems.push('名字不能含路径分隔符或 Windows 非法字符')
if (name.includes('｜')) problems.push('名字不能含「｜」——看板用全角竖线分隔字段，含它的科目名会让漂移永远消不掉（verify-planner ④h）')
if (name.startsWith('.')) problems.push('名字不能以 . 开头——规划器会跳过隐藏目录，那样它就不是一个科目')
// ⚠️ 这里**故意没有"全大写就拒绝"这条**：第一版加了 `name === name.toUpperCase()`，
//    结果把 `C` 这种完全正常的科目名（而且本来就有一科叫这个）也拒了。
//    "名字看着像文件"不是失效模式——目录和文件不在同一个命名空间里，不会冲突。
if (problems.length > 0) {
  console.error(`❌ 科目名「${name}」不行：`)
  for (const p of problems) console.error(`   · ${p}`)
  process.exit(2)
}

const dir = join(ROOT, name)
const archive = join(dir, core.ARCHIVE_NAME)
if (existsSync(dir)) {
  console.error(`❌ ${dir} 已经存在——本脚本**从不覆盖**任何东西。\n   要重建就先自己把目录移走；要给它补提纲，直接用文件工具写 ${join(dir, '复习提纲.md')}。`)
  process.exit(1)
}
if (!existsSync(ROOT)) {
  console.error(`❌ 学习根不存在：${ROOT}（用 --root 指定）`)
  process.exit(1)
}

// ── 生成骨架 ────────────────────────────────────────────────────────────────
const today = core.studyDate()
const archiveText = `# 学习档案

更新于: ${today}

## 学校当前进度
- 待摸底：本学期「${name}」课的进度、教材、周次与考核方式尚未告知
- 首次会话用一两句对话式摸底补全（「课上到哪了？最近在学什么？」），不搞正式问卷

## 已答主题与卡点
- （尚无答疑记录）

## 未消化薄弱点
- （待摸底后填写；须具体到知识点，不写「不熟」这种没法教的话）
`

const outlineText = `# 复习提纲（${name}）

我学过的一切知识点，一行一条、新的在上。\`复\` = 复习次数，\`上\` = 上次复习日期（没复习过写 \`—\`）。

- （还没有知识点：第一次答疑后，把"学到了什么"写成一行加在这里）
`

// ── **先验后写**：用守护用的同一个校验器，验不过就一个字节都不写 ─────────────
const why = core.validateArchive(archiveText, core.DEFAULT_MAX_LINES, core.DEFAULT_MAX_BYTES, today)
if (why !== undefined) {
  console.error(`❌ 生成的骨架没通过守护校验，已中止（这是本脚本自己的 bug）：${why}`)
  process.exit(1)
}

// ── 落盘：**要么完整，要么什么都没有** ──────────────────────────────────────
// 磁盘满 / 只读 / 杀软占用 / 权限不足——这些都不该留下"半个科目"（目录建好了、档案没写成）。
try {
  mkdirSync(dir)
  writeFileSync(archive, archiveText)
  if (outline) writeFileSync(join(dir, '复习提纲.md'), outlineText)
} catch (e) {
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* 清理失败就算了，下面会说清楚 */ }
  console.error(`❌ 写不进去：${e?.code ?? e?.message}`)
  console.error(`   ${dir}`)
  console.error('   常见原因：目录只读 / 磁盘满 / 杀软或另一个进程占用 / 权限不足。')
  console.error('   已回滚（不会留下建了一半的科目）——本脚本要么完整，要么什么都没有。')
  process.exit(1)
}

const bytes = Buffer.byteLength(archiveText, 'utf8')
console.log(`✅ 建好科目「${name}」`)
console.log(`   ${archive}  （${bytes} B / ${core.DEFAULT_MAX_BYTES}，${archiveText.split('\n').length} 行 / ${core.DEFAULT_MAX_LINES}）`)
if (outline) console.log(`   ${join(dir, '复习提纲.md')}  （空骨架，不受守护、不进注入）`)
console.log(`
接下来（就一步）：
   在预设选择器里选一个**伴学预设**，把会话工作目录设成 ${dir}
   —— 科目目录 = 会话工作目录，这样档案/提纲才会落在对的地方，注入也才认得它。

只有"全新的学科门类"才需要动预设（复制一个伴学预设 + 改 persona + 改 preset.yml）；
**加一个科目不需要碰任何预设**——规划器靠"ST 下含学习档案.md 的子目录"自动发现它。`)
