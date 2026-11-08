// verify-companion-budget.mjs — 「心灵的话」块：**看板本体一个字节都不许让给它，但它自己必须真的能显示**。
//
// ═══ 两次修改，两个不同的失效方向 ═══════════════════════════════════════════════
//
// 【2026-10-11】块**无条件占尾部** ⇒ 挤掉学业事实。
//   看板尾部永不截断，而这一块原来无条件 push 进尾部 ⇒ 每字节都从头部预算里扣 ⇒
//   头部降档降到最低还不够时掉进 `cutoffBytes` 的**字节硬截断**。实测把 2 条各 120 字的
//   「要跟总规划说的」写进尾部：看板 4096B（正好顶满）· 头部 2397 → **1745** ·
//   **丢掉 4 条代码算出来的漂移事实**（英语「任务下发后该科零回执」、Python 三条）。
//   单条还没有长度上限：一条 2000 字的把看板顶到 **7720 字节**。
//   修法：头部先按"不含这一块"的预算渲染，这一块只吃剩下的余量。
//
// 【2026-10-12】改成"只吃余量"之后 ⇒ **通道静默失效**（学员纠正暴露出来的）。
//   学员说：*「如果我说的一些话可能影响到我的规划…就应该有相应的变化，所以这个可能还需要
//   预设自己来判断，不是那种说什么就写什么」* —— 这条通道是"判断能变成动作"的**唯一**路径。
//   但实测（`.verify/measure-judgment-fit.mjs`）：现场看板 3878/4096、头部**已在最低档**、
//   余量只剩 **104 B**，而一条判断至少要 ~180 B ⇒ 块**根本不渲染**，只留一句指路。
//   而头部**降无可降**（再压就是硬截断，正是上面那个后果）⇒ 两头都挤不出来。
//   修法：这一块改成**自己的预算**（`COMPANION_BLOCK_MAX_BYTES`，从看板的 4096 里独立出来），
//   头部照旧按不含它的预算渲染。
//
// ═══ 于是本套件钉住的不变量 ═══════════════════════════════════════════════════
//   ① **看板本体（摘掉陪伴块之后）与不含它时逐字节相同** —— 学业信息一个字节都不让
//   ② 陪伴块存在时，各科**漂移行与任务条目一条都不少**
//   ③ ★ **只要「要跟总规划说的」那一节有内容，块就渲染** —— 不再看余量脸色
//      （旧语义下"余量够不够"是**档位表的偶然**，同一个功能今天能用明天不能用）
//   ④ 块自己有上限（≤ COMPANION_BLOCK_MAX_BYTES），所以整条注入 ≤ 4096 + 512
//
// ⚠️ 写这套件时踩的坑（记下来，因为形状会重复）：
//   · 夹具档案用"今天"的戳 ⇒ `archiveAge = 0` ⇒ **不产生漂移**（阈值 DEFAULT_STALE_DAYS=2），
//     于是"每科都有漂移"这条前提红了，而代码是对的。夹具必须 `ageDays >= 2`。
//   · 余量不是"档案越大越小"——档位表是**离散**的，`long` 一变档位就跳，余量跟着跳
//     （实测 56B ~ 745B 之间跳）。所以阶梯测试要按**实测到的档位形状**挑夹具，不能靠直觉。
//   · 断言"某条漂移原文在不在看板里"会被**省略号**骗（降档后单条被截断）——
//     要数 `⚠️ 漂移` / `☐` / `☑` 的**条数**，或者直接比头部字节。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as plan from '../plan-core.js'

let pass = 0
let fail = 0
const check = (label, cond, extra) => {
  if (cond) { pass += 1; console.log('  ✅', label) }
  else { fail += 1; console.log('  ❌', label, extra === undefined ? '' : `→ ${extra}`) }
}

const B = (t) => Buffer.byteLength(t, 'utf8')
const TODAY = plan.studyDate()
const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return plan.studyDate(d) }
const fixtures = []
const fixture = (name) => {
  const root = mkdtempSync(join(tmpdir(), `cb-${name}-`))
  fixtures.push(root)
  return root
}

/**
 * 造一个学习根。形状决定看板头部大小（从而决定余量）。
 * @param {number} n 科目数
 * @param {{items?:number, long?:number, tasks?:number, ageDays?:number}} o
 *   items/long = 档案三节各几条、每条多长；tasks = 每科几条任务；
 *   ageDays 必须 ≥ 2 才会产生"档案陈旧"漂移（否则夹具是"刚更新过"，不产生漂移）。
 */
function studyRoot(name, n, { items = 2, long = 0, tasks = 0, ageDays = 3 } = {}) {
  const root = fixture(name)
  const stamp = ageDays === 0 ? TODAY : daysAgo(ageDays)
  for (let i = 1; i <= n; i += 1) {
    const nm = `科目${i}`
    const dir = join(root, nm)
    mkdirSync(dir, { recursive: true })
    const filler = '条目内容很长的摘要'.repeat(long)
    const sec = (tag) => Array.from({ length: items }, (_, k) => `- ${nm} ${tag}${k + 1} ${filler}`).join('\n')
    writeFileSync(join(dir, '学习档案.md'), `# 学习档案\n\n更新于: ${stamp}\n\n## 学校当前进度\n${sec('进度')}\n\n## 已答主题与卡点\n${sec('卡点')}\n\n## 未消化薄弱点\n${sec('薄弱')}\n`, 'utf8')
    if (tasks > 0) {
      writeFileSync(join(dir, '本周任务.md'), `# 本周任务（${nm}）\n\n生成: ${stamp}\n依据: 学习档案 更新于 ${stamp}\n\n${Array.from({ length: tasks }, (_, k) => `- [ ] ${nm}任务条目${k + 1}`).join('\n')}\n`, 'utf8')
    }
  }
  return root
}

/** 一条「要跟总规划说的」笔记（另外三节带哨兵，用来同时确认它们不外流）。 */
const note = (items, { stamp = TODAY } = {}) =>
  `# 心灵笔记\n\n更新于: ${stamp}\n\n## 最近的状态\n- 哨兵-状态-不外流\n\n## 要跟学科说的\n- @数学：哨兵-学科-不外流\n\n## ${plan.COMPANION_SECTION_PLAN}\n${items.map((t) => `- ${t}`).join('\n')}\n\n## 收下的移交\n- （源:数学 ${stamp}）哨兵-移交-不外流\n`

/** 头/尾分界（与 buildBoard 的拼接方式一致）。 */
const split = (board) => {
  const i = board.indexOf('\n■ 计划自身')
  return i < 0 ? { head: board, tail: '' } : { head: board.slice(0, i), tail: board.slice(i + 1) }
}
/** 不含陪伴块时的余量（= 陪伴块能用的上限）。 */
const roomOf = (board) => {
  const { head, tail } = split(board)
  return 4096 - B(head) - 1 - B(tail)
}
/** 看板里那一块（从 `■ 心灵` 到「本轮该动什么」）。 */
const blockOf = (board) => {
  const lines = board.split('\n')
  const i = lines.findIndex((l) => l.startsWith('■ 心灵'))
  if (i < 0) return ''
  let j = i
  while (j < lines.length && !lines[j].startsWith('■ 本轮该动什么')) j += 1
  return lines.slice(i, j).join('\n').trimEnd()
}
/** 某科区块里某类标记的条数（抗省略号）。 */
const countIn = (board, name, mark) => {
  const start = board.indexOf(`\n■ ${name}`)
  if (start < 0) return 0
  const rest = board.slice(start + 1)
  const next = rest.indexOf('\n■ ')
  const block = next < 0 ? rest : rest.slice(0, next)
  return block.split('\n').filter((l) => l.trimStart().startsWith(mark)).length
}
/** buildBoard 在"块放不下"时补的那句指路（用来量它自己占多少字节）。 */
const NOTICE = `  ⚠️ 心灵有话说，但连最简形式都超过 ${plan.COMPANION_BLOCK_MAX_BYTES} 字节：去 ${plan.COMPANION_NOTE_NAME} 的「${plan.COMPANION_SECTION_PLAN}」看`
const NOTICE_BYTES = B(NOTICE) + 1

/**
 * 看板本体 = 整条注入**减去**陪伴块。
 * 为什么需要它：2026-10-12 起陪伴块有自己的预算、拼在看板之后，所以"总量 ≤4096"
 * 这条旧断言不再成立（现在是 ≤4096 + 块上限）。要看的是**看板本体**有没有被撑大。
 */
const boardOnly = (board) => {
  const { head, tail } = split(board)
  const i = tail.indexOf('■ 心灵')
  if (i < 0) return board
  // 块在 tail 里，从它前面那个空行开始到「本轮该动什么」之前
  const before = tail.slice(0, i)
  const rest = tail.slice(i)
  const j = rest.indexOf('■ 本轮该动什么')
  const blockPart = j < 0 ? rest : rest.slice(0, j)
  const keep = j < 0 ? '' : rest.slice(j)
  return `${head}\n${before}${keep}`
}

// ── ① 头部不变性 ─────────────────────────────────────────────────────────────
console.log('\n① 加不加陪伴块，头部**逐字节相同**（本次修的核心不变量）')
{
  const root = studyRoot('invariance', 4, { items: 3, long: 60, tasks: 3 })
  const subjects = plan.survey(root, TODAY)
  const base = plan.buildBoard(root, { today: TODAY, subjects, planRaw: undefined })
  const baseHead = split(base).head
  const baseBoard = B(base)
  check('  （前提）这个夹具的余量本来就很小（正是 2026-10-12 那个失效形状）', roomOf(base) < 512, `余量 ${roomOf(base)}B`)

  const sizes = [
    ['一条短的（20 字）', note(['这周别按满量排，我最近有点累。'])],
    ['两条典型（各 30 字）', note(['这周别按满量排，我最近有点累。', '周末想留半天给自己，别排任务。'])],
    ['两条写满（各 120 字）', note(['这'.repeat(120), '字'.repeat(120)])],
    ['一条 2000 字（超过整块预算）', note(['字'.repeat(2000)])],
    ['一条 20000 字（远超看板上限）', note(['字'.repeat(20000)])],
    ['两条各 20000 字', note(['字'.repeat(20000), '甲'.repeat(20000)])],
  ]
  for (const [label, raw] of sizes) {
    const board = plan.buildBoard(root, { today: TODAY, subjects, planRaw: undefined, noteRaw: raw })
    check(`  ${label}：头部与不含它时逐字节相同`, split(board).head === baseHead,
      `${B(baseHead)} → ${B(split(board).head)}`)
    // ★ 核心：学业本体**一个字节都不多**（陪伴块整块被摘掉之后应当与基线完全相同）
    check(`  ${label}：看板本体与不含它时逐字节相同`, boardOnly(board) === base, `${baseBoard} → ${B(boardOnly(board))}`)
    // 块自己有上限 ⇒ 整条注入 ≤ 4096 + 512
    check(`  ${label}：总量 ≤ 4096 + 块上限`, B(board) <= 4096 + plan.COMPANION_BLOCK_MAX_BYTES, `${B(board)}`)
  }

  // 正控制：**尾部**必须真的变了，否则上面那几条可能只是"什么都没渲染"。
  const withNote = plan.buildBoard(root, { today: TODAY, subjects, planRaw: undefined, noteRaw: note(['这周别按满量排，我最近有点累。']) })
  check('  （正控制）尾部确实变长了 ⇒ 那一块真的渲染了', B(split(withNote).tail) > B(split(base).tail),
    `尾部 ${B(split(base).tail)} → ${B(split(withNote).tail)}`)
  check('  （正控制）且那一条的正文真的出现在看板里', withNote.includes('这周别按满量排'))
  // ★★ 本次修的核心（2026-10-12）：**余量不足也必须渲染**——旧语义下这里只会得到一句指路。
  check('  ★ 余量不够时**仍然渲染正文**（旧的"只吃余量"在这里是静默失效）',
    withNote.includes('这周别按满量排') && !withNote.includes('心灵有话说'),
    `余量 ${roomOf(base)}B`)
  // 隐私：另外三节的哨兵一个都不许外流（同一份笔记里）
  for (const s of ['哨兵-状态-不外流', '哨兵-学科-不外流', '哨兵-移交-不外流']) {
    check(`  隐私：${s} 不在看板里`, !withNote.includes(s))
  }
}

// ── ② 事实保全 ───────────────────────────────────────────────────────────────
console.log('\n② 陪伴块存在时，各科**漂移行与任务条目一条都不少**')
{
  const root = studyRoot('facts', 5, { items: 3, long: 40, tasks: 4 })
  const subjects = plan.survey(root, TODAY)
  check('  （前提）每科都有漂移行（夹具 ageDays=3 ⇒ 档案陈旧）', subjects.every((s) => s.drift.length > 0),
    JSON.stringify(subjects.map((s) => s.drift.length)))
  check('  （前提）每科都有任务条目', subjects.every((s) => s.task.open.length > 0),
    JSON.stringify(subjects.map((s) => s.task.open.length)))

  const base = plan.buildBoard(root, { today: TODAY, subjects, planRaw: undefined })
  const big = plan.buildBoard(root, { today: TODAY, subjects, planRaw: undefined, noteRaw: note(['字'.repeat(2000), '甲'.repeat(2000)]) })
  const driftLost = subjects.filter((s) => countIn(big, s.name, '⚠️ 漂移') < countIn(base, s.name, '⚠️ 漂移')).map((s) => s.name)
  const taskLost = subjects.filter((s) => countIn(big, s.name, '☐') < countIn(base, s.name, '☐')).map((s) => s.name)
  check('  2000 字 ×2 的陪伴块：漂移行一条都没少', driftLost.length === 0, driftLost.join(','))
  check('  2000 字 ×2 的陪伴块：任务条目一条都没少', taskLost.length === 0, taskLost.join(','))
  check('  且没有掉进硬截断', !big.includes('已按上限截断'), big.split('\n').find((l) => l.includes('截断')))
  // 反向：真掉进硬截断时（9 科 + 长档案），提示必须**如实**说末尾被切
  const many = studyRoot('hardcut', 9, { items: 3, long: 60, tasks: 3 })
  const mSubjects = plan.survey(many, TODAY)
  const cut = plan.buildBoard(many, { today: TODAY, subjects: mSubjects, planRaw: undefined })
  check('  （前提）9 科长档案确实触发了硬截断（否则下面两条没在测东西）', cut.includes('已按上限截断'),
    cut.split('\n').find((l) => l.includes('截断')))
  // ⚠️ 这里**不能**去断言 `headTierNotice` 那句「漂移行与任务条目未丢」被改写：
  //    它在 candidate 的**最后一行**，而 cutoffBytes 切的是**尾部** ⇒ 它总是第一个被切掉，
  //    "改它"是死代码。真正到达模型的是 CUTOFF_NOTICE 自己，所以断言它说了实话。
  check('  硬截断时**不许**谎称「漂移行与任务条目未丢」', !cut.includes('漂移行与任务条目未丢'),
    cut.split('\n').find((l) => l.includes('超预算')))
  check('  且如实说明末尾几科连同漂移/任务被切掉', cut.includes('末尾几科被整段切掉') && cut.includes('漂移与任务条目'),
    cut.split('\n').find((l) => l.includes('截断')))
  check('  截断路径下仍然 ≤ 4096（换的说法必须把自述字节算进预算）', B(cut) <= 4096, `${B(cut)}`)
}

// ── ③ 总量上限 ───────────────────────────────────────────────────────────────
console.log('\n③ 看板本体 ≤ 4096，陪伴块 ≤ 自己的上限（两块各有各的预算，谁都不许越界）')
{
  for (const [label, n, o] of [['3 科', 3, { items: 3, long: 40, tasks: 3 }], ['6 科', 6, { items: 3, long: 40, tasks: 3 }], ['9 科（连最低档都装不下）', 9, { items: 3, long: 60, tasks: 3 }]]) {
    const root = studyRoot(`cap-${n}`, n, o)
    const subjects = plan.survey(root, TODAY)
    let worstBody = 0
    let worstBlock = 0
    let worstLabel = ''
    for (const [wl, raw] of [['无笔记', undefined], ['一条短', note(['短。'])], ['一条 500 字', note(['中'.repeat(500)])], ['一条 3000 字', note(['长'.repeat(3000)])], ['两条各 40000 字', note(['超'.repeat(40000), '长'.repeat(40000)])]]) {
      const board = plan.buildBoard(root, { today: TODAY, subjects, planRaw: undefined, noteRaw: raw })
      const body = B(boardOnly(board))
      const block = B(board) - body
      if (body > worstBody) { worstBody = body; worstLabel = wl }
      if (block > worstBlock) worstBlock = block
    }
    check(`  ${label}：看板本体最大 ${worstBody}B ≤ 4096（最坏输入：${worstLabel}）`, worstBody <= 4096, `${worstBody}`)
    check(`  ${label}：陪伴块最大 ${worstBlock}B ≤ ${plan.COMPANION_BLOCK_MAX_BYTES}`, worstBlock <= plan.COMPANION_BLOCK_MAX_BYTES, `${worstBlock}`)
  }
}

// ── ④ 降级阶梯 ───────────────────────────────────────────────────────────────
console.log('\n④ 降级阶梯：现在由**自己的上限**决定（不再看看板余量的脸色）')
{
  const raw = note(['第一条要说的话，稍微长一点以便观察截断。', '第二条要说的话，也稍微长一点。'])
  // 这些形状的余量是**实测**出来的，覆盖"看板很空 / 看板很满"两种极端。
  // ★ 2026-10-12 起，**余量不再是变量**：这些形状应当给出**同样**的块字节数。
  const shapes = [
    ['4 科 × 2 条', 4, { items: 2, long: 60, tasks: 3 }],
    ['3 科 × 3 条', 3, { items: 3, long: 60, tasks: 3 }],
    ['5 科 × 2 条', 5, { items: 2, long: 60, tasks: 3 }],
    ['6 科 × 2 条', 6, { items: 2, long: 60, tasks: 3 }],
    ['4 科 × 3 条', 4, { items: 3, long: 60, tasks: 3 }],
    ['3 科 × 2 条', 3, { items: 2, long: 60, tasks: 3 }],
    ['5 科 × 3 条', 5, { items: 3, long: 60, tasks: 3 }],
  ]
  const rows = []
  for (const [label, n, o] of shapes) {
    const root = studyRoot(`ladder-${n}-${o.items}`, n, o)
    const subjects = plan.survey(root, TODAY)
    const base = plan.buildBoard(root, { today: TODAY, subjects, planRaw: undefined })
    const board = plan.buildBoard(root, { today: TODAY, subjects, planRaw: undefined, noteRaw: raw })
    const block = blockOf(board)
    rows.push({
      label,
      room: roomOf(base),
      bytes: B(block),
      items: (block.match(/^ {2}· /gm) ?? []).length,
      hasHead: block.includes('■ 心灵'),
      notice: board.includes('心灵有话说'),
      boardBytes: B(board),
      headSame: split(board).head === split(base).head,
    })
  }
  for (const r of rows) {
    console.log(`     ${r.label.padEnd(12)} 余量 ${String(r.room).padStart(4)}B · 块 ${String(r.bytes).padStart(4)}B · 条目 ${r.items} · ${r.hasHead ? '有标题' : '整块未渲染'}${r.notice ? ' + 指路' : ''}`)
  }
  check('  每一档：头部与不含它时逐字节相同', rows.every((r) => r.headSame), rows.filter((r) => !r.headSame).map((r) => r.label).join(','))
  check(`  每一档：块字节 ≤ 自己的上限 ${plan.COMPANION_BLOCK_MAX_BYTES}`, rows.every((r) => r.bytes <= plan.COMPANION_BLOCK_MAX_BYTES), rows.map((r) => r.bytes).join(' '))
  // ★ 核心：**不管看板余量多少，块都一样**（旧语义下这里会随档位跳变、甚至整块消失）
  check('  ★ 每一档：块字节完全相同（不再随余量跳变）', new Set(rows.map((r) => r.bytes)).size === 1,
    rows.map((r) => `${r.label}:${r.bytes}`).join(' '))
  check('  ★ 每一档：都渲染出来了（没有"余量不足"的档）', rows.every((r) => r.hasHead && !r.notice),
    rows.filter((r) => !r.hasHead || r.notice).map((r) => r.label).join(','))
  check('  每一档：两条都完整渲染（512B 的预算够两条各 150B）', rows.every((r) => r.items === 2), rows.map((r) => r.items).join(' '))
  // 余量最小的一档也必须渲染 —— 这正是 2026-10-12 修掉的那个静默失效
  const sorted = [...rows].sort((a, b) => a.room - b.room)
  const worst = sorted[0]
  check(`  ★ 余量最小的一档（${worst.label}，${worst.room}B）照样完整渲染`, worst.items === 2 && !worst.notice,
    `条目 ${worst.items}，指路 ${worst.notice}`)
}

// ── ⑤ 零成本 ─────────────────────────────────────────────────────────────────
console.log('\n⑤ 零成本：没有要说的内容时，看板一个字节都不多')
{
  const root = studyRoot('zero', 4, { items: 3, long: 40, tasks: 3 })
  const subjects = plan.survey(root, TODAY)
  const base = plan.buildBoard(root, { today: TODAY, subjects, planRaw: undefined })
  const empties = [
    ['不传 noteRaw', undefined],
    ['空骨架（那一节只有占位说明）', `# 心灵笔记\n\n更新于: ${TODAY}\n\n## ${plan.COMPANION_SECTION_PLAN}\n\n（只有这一节会被总规划看到。）\n`],
    ['笔记为空串', ''],
    ['没有「要跟总规划说的」那一节', `# 心灵笔记\n\n更新于: ${TODAY}\n\n## 最近的状态\n- 只有这个。\n`],
    ['那一节只有整行括号的占位行', `# 心灵笔记\n\n更新于: ${TODAY}\n\n## ${plan.COMPANION_SECTION_PLAN}\n- （这里写点什么）\n`],
  ]
  for (const [label, raw] of empties) {
    const board = plan.buildBoard(root, { today: TODAY, subjects, planRaw: undefined, noteRaw: raw })
    check(`  ${label} → 一个字节都不多`, B(board) === B(base), `${B(base)} → ${B(board)}`)
  }
  check('  （正控制）同样形状、那一节真有内容 → 看板确实变长',
    B(plan.buildBoard(root, { today: TODAY, subjects, planRaw: undefined, noteRaw: note(['真有一条。']) })) > B(base))
}

for (const root of fixtures) { try { rmSync(root, { recursive: true, force: true }) } catch {} }
console.log(fail === 0 ? `\n✅ 全部通过：${pass} passed, 0 failed` : `\n❌ ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
