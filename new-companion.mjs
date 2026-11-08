// new-companion.mjs — 建「陪伴」预设的记忆文件：一条命令，一处改动。
//
// 与 `new-subject.mjs` 是**姊妹脚本**，但生成的是**另一套契约**（学员 2026-10-11 的纠正：
// 「它的定位不是科目，定位是陪伴，是日常，是聊天」）：
//
//   科目：ST\<科目>\学习档案.md      60 行 / 6144 B，必填 进度 / 卡点 / 薄弱
//   陪伴：ST\心灵\心灵笔记.md        40 行 / 4096 B，**不要**那三字段
//
// 「不是科目」是**结构性**的、不是靠约定：认科目的唯一判据就是 `学习档案.md` 这个名字
// （`discoverSubjects`），所以换名字之后它自动不进看板、不排 MVE、不被逼下发任务、看板 +0 字节。
// 实测见 `.verify/probe-companion-corrected.mjs`。
//
// 用法：
//   node new-companion.mjs                    建 ST\心灵\心灵笔记.md
//   node new-companion.mjs 树洞              换个目录名
//   node new-companion.mjs --root D:/别的/ST
//
// 它**拒绝覆盖**已存在的目录。**先验后写**（用守护用的同一个校验器），验不过一个字节都不落盘。
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// ★ 2026-10-24 可移植性：与 new-subject.mjs 同一套取法，套件发给别的学生时不能只认维护者路径。
const PLUGINS = dirname(fileURLToPath(import.meta.url)) + '/'
function defaultRoot() {
  if (process.env.DSH_STUDY_ROOT) return process.env.DSH_STUDY_ROOT
  const cwd = process.cwd()
  if (existsSync(join(cwd, '总规划.md')) || existsSync(join(cwd, '大学学习总纲.md'))) return cwd
  return join(cwd, 'ST')
}
const core = await import(pathToFileURL(PLUGINS + 'companion-core.js').href)

const argv = process.argv.slice(2)
const name = argv.find((a) => !a.startsWith('--')) ?? '心灵'
const rootArg = argv.indexOf('--root')
const ROOT = rootArg >= 0 ? argv[rootArg + 1] : defaultRoot()

const problems = []
if (name.trim() !== name || name.length === 0) problems.push('名字首尾不能有空白')
if (/[\\/:*?"<>|]/.test(name)) problems.push('名字不能含路径分隔符或 Windows 非法字符')
if (name.includes('｜')) problems.push('名字不能含「｜」')
if (name.startsWith('.')) problems.push('名字不能以 . 开头')
if (problems.length > 0) {
  console.error(`❌ 目录名「${name}」不行：`)
  for (const p of problems) console.error(`   · ${p}`)
  process.exit(2)
}

const dir = join(ROOT, name)
const note = join(dir, core.COMPANION_NOTE_NAME)
if (existsSync(dir)) {
  console.error(`❌ ${dir} 已经存在——本脚本**从不覆盖**任何东西。\n   要重建就先自己把目录移走。`)
  process.exit(1)
}
if (!existsSync(ROOT)) {
  console.error(`❌ 学习根不存在：${ROOT}（用 --root 指定）`)
  process.exit(1)
}

// ── 生成骨架 ────────────────────────────────────────────────────────────────
// 四节职责明确：规划节进入自动看板，学科出信节内 @标记定向投递。
// 此为自动注入隔离，非文件 ACL；共享工作区的工具可能读取整份笔记。
const today = core.studyDate()
// ⚠️ 各节的说明**不写成列表项**：`companionPlanItems` 抽的是列表项，写成 `- （说明…）`
//    会让一条空笔记也在总规划看板上占一行（实测踩过）。说明用缩进的斜体，读起来一样清楚。
const noteText = `# ${name}笔记

更新于: ${today}

## 最近的状态
  *最近在想什么、什么在耗神、什么让你高兴——几条就好，不写流水账；过去的滚动掉。*

## 要跟学科说的
  *仅放已授权的教学方式需要，如 \`- @数学：讲解请一次一步\`；此节标记定向投递，任务量交总规划。*

## ${core.COMPANION_SECTION_PLAN}
  *自动看板只渲染此节：放已授权的安排影响，写必要结论，不抄私事经过；无依据不编比例。*
  *按同一事项的实际结果核对，同日办完、未采纳已说明、撤回或失效均可结束；待确认先留。*

## 收下的移交
  *别科来信收下后保留该条必要正文、行尾来源戳，如 \`（源:数学 ${today}）\`；同日不同条分别收件，不代表已办成。*

  *共享文件不是私人保险箱；不愿落盘的细节不写，授权只覆盖约定对象、范围和期限。*
`

// ── **先验后写**：用守护用的同一个校验器，验不过就一个字节都不写 ─────────────
const why = core.validateCompanionNote(noteText, core.COMPANION_MAX_LINES, core.COMPANION_MAX_BYTES, today)
if (why !== undefined) {
  console.error(`❌ 生成的骨架没通过守护校验，已中止（这是本脚本自己的 bug）：${why}`)
  process.exit(1)
}

try {
  mkdirSync(dir)
  writeFileSync(note, noteText)
} catch (e) {
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* 清理失败就算了 */ }
  console.error(`❌ 写不进去：${e?.code ?? e?.message}`)
  console.error(`   ${dir}`)
  console.error('   已回滚（不会留下建了一半的目录）——本脚本要么完整，要么什么都没有。')
  process.exit(1)
}

const bytes = Buffer.byteLength(noteText, 'utf8')
console.log(`✅ 建好陪伴记忆「${name}」`)
console.log(`   ${note}  （${bytes} B / ${core.COMPANION_MAX_BYTES}，${noteText.split('\n').length} 行 / ${core.COMPANION_MAX_LINES}）`)
console.log(`
接下来（就一步）：
   在预设选择器里选「心灵陪伴」，把会话工作目录设成 ${dir}

它是**陪伴**、不是科目：不进总规划看板、不排 MVE、不下发 本周任务.md。
与外面的两条通道（都由代码做，你只需要打标记）：
   · 给学科：在「要跟学科说的」写 \`- @数学：…\` → 数学下一次开会话就收到【跨科移交】
   · 给规划：在「${core.COMPANION_SECTION_PLAN}」写一条 → 总规划看板尾部会显示（仅规划节自动显示；共享文件不是读取隔离）
别科标给它的（\`- @${name}：…\`）会自动出现在它的注入里；收下后在「收下的移交」留该条必要正文与行尾来源戳（同来源同日分条收件），只销收信提醒、不代表已经解决。`)
