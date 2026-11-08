// verify-board-fit.mjs — 看板头部预算的回归测试（专治「最后一科的漂移行与任务条目被切掉」）
// 用法：node verify-board-fit.mjs
//
// 背景：旧实现把各科区块拼成一整块，然后按固定常量 BOARD_TAIL_RESERVE = 1536 截断头部。
// 后果：2 科就超预算（真实 ST 头部 2868B > 2560B），而截断是**一刀切尾部**——
// 切掉的正好是最后一科（英语）的 ⚠️ 漂移行与全部任务条目；看板还反过来让**唯一无权改档案**的
// 总规划去「压缩各科档案」。现在：① 先算尾部实际字节，再把余额给头部；② 头部按档位渲染，
// 先压长散文，⚠️ 漂移行与任务条目最后才动、且不整条丢。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// 与插件同目录的相对导入：测试要跟代码一起旅行（旧版按绝对路径 import 插件，插件一搬家就变成跑旧代码）。
import * as plan from '../plan-core.js'

let pass = 0
let fail = 0
function check(label, cond, extra) {
  if (cond) { pass += 1; console.log('  ✅', label) }
  else { fail += 1; console.log('  ❌', label, extra === undefined ? '' : `→ ${extra}`) }
}

const TODAY = plan.studyDate()
const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return plan.studyDate(d) }
const B = (t) => Buffer.byteLength(t, 'utf8')
const read = (p) => { try { return readFileSync(p, 'utf8') } catch { return undefined } }
/** 某科区块在不在：从 `■ 名称` 到下一个小节标题。 */
const blockOf = (board, name) => {
  const start = board.indexOf(`\n■ ${name}`)
  if (start < 0) return ''
  const rest = board.slice(start + 1)
  const next = rest.indexOf('\n■ ')
  return next < 0 ? rest : rest.slice(0, next)
}
const itemsOf = (section, mark) => section.split('\n').filter((l) => l.trimStart().startsWith(mark)).length

const fixtures = []
function fixture(name) {
  const root = mkdtempSync(join(tmpdir(), `board-${name}-`))
  fixtures.push(root)
  return root
}
const archiveOf = (stamp, name, { items = 2, long = 0 } = {}) => {
  const filler = '条目内容很长的摘要'.repeat(long)
  const line = (tag) => `- ${tag}${filler}`
  return `# 学习档案\n\n更新于: ${stamp}\n\n## 学校当前进度\n${Array.from({ length: items }, (_, i) => line(`${name} 进度${i + 1} `)).join('\n')}\n\n## 已答主题与卡点\n${Array.from({ length: items }, (_, i) => line(`${name} 卡点${i + 1} `)).join('\n')}\n\n## 未消化薄弱点\n${Array.from({ length: items }, (_, i) => line(`${name} 薄弱${i + 1} `)).join('\n')}\n`
}
const taskOf = (stamp, name, n) =>
  `# 本周任务（${name}）\n\n生成: ${stamp}\n依据: 学习档案 更新于 ${stamp}\n\n${Array.from({ length: n }, (_, i) => `- [ ] ${name}任务条目${i + 1}`).join('\n')}\n`

console.log('\n① 真实 ST 数据：曾经被切掉的英语区块，现在必须完整')
{
  const ROOT = 'ST'
  const subjects = existsSync(ROOT) ? plan.survey(ROOT, TODAY) : []
  if (subjects.length === 0) {
    console.log('  ⏭️  跳过：本机没有真实学习根目录（该节只在开发机上有效，不算失败）')
  } else {
    const board = plan.buildBoard(ROOT, {
      today: TODAY, subjects,
      planRaw: read(join(ROOT, '总规划.md')), noticeRaw: read(join(ROOT, '变更记录.md')), planName: '总规划.md',
    })
    const eng = subjects.find((s) => s.name === '英语')
    const block = blockOf(board, '英语')
    check('  英语区块在', block.length > 0)
    check('  英语的 ⚠️ 漂移行没有被切掉',
      eng.drift.length === 0 || block.includes('⚠️ 漂移'),
      `档案 ${eng.archiveStamp} 漂移 ${JSON.stringify(eng.drift)}`)
    check('  英语的每条任务条目都在',
      eng.task.open.length + eng.task.done.length === itemsOf(block, '☐') + itemsOf(block, '☑'),
      `看板 ${itemsOf(block, '☐') + itemsOf(block, '☑')} 条 / 实际 ${eng.task.open.length + eng.task.done.length} 条`)
    // 真实数据的档案大小会变：只要装得下，就一个字都不该压；装不下也只许「压摘要」。
    // 所以这里断言的是**不变量**（无硬截断 + 压缩时必须自述漂移/任务未丢），
    // 而不是「真实数据永远不触发降档」——那是把随档案增长的量写成了断言（曾在 4 科时假红）。
    check('  没有硬截断（内容只可能被压摘要，不会被切尾）', !board.includes('已按上限截断'),
      board.split('\n').find((l) => l.includes('超预算') || l.includes('截断')))
    check('  若提示了压缩，提示里必须写明漂移与任务未丢',
      !board.includes('头部超预算') || board.includes('漂移行与任务条目未丢'),
      board.split('\n').find((l) => l.includes('超预算')))
    check('  总字节 ≤ 4096', B(board) <= 4096, `${B(board)}`)
    check('  尾部（可照抄基准行）仍在末尾', board.trimEnd().endsWith(`数据基准: ${subjects.map((s) => `${s.name}=${s.archiveStamp}`).join('｜')}`))
  }
}

console.log('\n② 头部比旧预算(2560B)大、但装得下尾部余额 → 一个字节都不该压')
{
  const ROOT = fixture('fit')
  const names = ['甲科', '乙科']
  for (const n of names) {
    mkdirSync(join(ROOT, n), { recursive: true })
    writeFileSync(join(ROOT, n, '学习档案.md'), archiveOf(daysAgo(1), n, { items: 3, long: 5 }))
    writeFileSync(join(ROOT, n, '本周任务.md'), taskOf(daysAgo(1), n, 3))
  }
  const subjects = plan.survey(ROOT, TODAY)
  const board = plan.buildBoard(ROOT, { today: TODAY, subjects, planRaw: undefined })
  const head = board.slice(0, board.indexOf('\n■ 计划自身'))
  check('  头部 > 旧预算 2560B（说明旧实现必然切）', B(head) > 2560, `${B(head)}`)
  check('  头部 ≤ 尾部余额（新的动态预算）', B(head) + 1 + B(board.slice(board.indexOf('\n■ 计划自身') + 1)) <= 4096 + 1)
  check('  无降档提示、无截断标记', !board.includes('头部超预算') && !board.includes('已按上限截断'))
  for (const n of names) {
    const block = blockOf(board, n)
    const s = subjects.find((x) => x.name === n)
    check(`  ${n}：漂移行在`, s.drift.length === 0 || block.includes('⚠️ 漂移'))
    check(`  ${n}：${s.task.open.length} 条任务条目一条不少`, itemsOf(block, '☐') + itemsOf(block, '☑') === s.task.open.length + s.task.done.length)
  }
}

console.log('\n③ 真超预算 → 只压长散文，⚠️ 漂移行与任务条目一条都不许丢')
{
  const ROOT = fixture('overflow')
  const names = ['甲科', '乙科']
  for (const n of names) {
    mkdirSync(join(ROOT, n), { recursive: true })
    writeFileSync(join(ROOT, n, '学习档案.md'), archiveOf(daysAgo(2), n, { items: 3, long: 40 }))
    writeFileSync(join(ROOT, n, '本周任务.md'), taskOf(daysAgo(2), n, 3))
  }
  const subjects = plan.survey(ROOT, TODAY)
  const board = plan.buildBoard(ROOT, { today: TODAY, subjects, planRaw: undefined })
  check('  出现降档提示（且不再叫模型去改档案）', board.includes('头部超预算') && board.includes('总规划只读档案'), board.split('\n').find((l) => l.includes('超预算')))
  check('  没有再甩「请先压缩各科档案」', !board.includes('请先压缩各科档案'))
  // ★ 断言必须是**真契约**上限，不是「上限 + 120」。旧实现 cutoffBytes 先切到上限、
  //   再追加 118B 提示语 → 看板真实 4214B；而这里写成 4096+120 就**恰好把 bug 放过去了**。
  //   松到"刚好容得下这个 bug"的断言，比没有断言更糟：它给假绿。
  check('  总字节 ≤ 4096（真上限，不许再留 cutoff 提示语的余量）', B(board) <= 4096, `${B(board)}`)
  check('  基准行仍在', board.split('\n').some((l) => l.startsWith('数据基准: ')))
  for (const n of names) {
    const block = blockOf(board, n)
    const s = subjects.find((x) => x.name === n)
    check(`  ${n}：区块在`, block.length > 0)
    check(`  ${n}：⚠️ 漂移行没被丢`, s.drift.length === 0 || block.includes('⚠️ 漂移'), JSON.stringify(s.drift))
    check(`  ${n}：${s.task.open.length} 条任务条目一条不少`, itemsOf(block, '☐') + itemsOf(block, '☑') === s.task.open.length + s.task.done.length)
  }
}

console.log('\n④ 科目多到极致（6 科长档案）：只留核心行，基准行与每科漂移仍在')
{
  const ROOT = fixture('many')
  const names = Array.from({ length: 6 }, (_, i) => `科目${i + 1}`)
  for (const n of names) {
    mkdirSync(join(ROOT, n), { recursive: true })
    writeFileSync(join(ROOT, n, '学习档案.md'), archiveOf(daysAgo(3), n, { items: 3, long: 60 }))
  }
  const subjects = plan.survey(ROOT, TODAY)
  const board = plan.buildBoard(ROOT, { today: TODAY, subjects, planRaw: undefined })
  check('  基准行仍在', board.split('\n').some((l) => l.startsWith('数据基准: ')))
  check('  总字节 ≤ 4096（真上限）', B(board) <= 4096, `${B(board)}`)
  const missing = names.filter((n) => blockOf(board, n).length === 0)
  check('  每个科目区块都还在（不再整科消失）', missing.length === 0, missing.join(','))
  const noDrift = names.filter((n) => !blockOf(board, n).includes('⚠️ 漂移'))
  check('  每科的陈旧漂移都还在', noDrift.length === 0, noDrift.join(','))
}

console.log('\n⑥ 两个"函数自己破坏自己的契约"的算错（2026-10-06 现场 4214B 的根因）')
{
  // ── (a) cutoffBytes 必须把自己那行提示语的字节**算进预算**
  //     现场看板 4214B = 4096 + 118，而 118 正好是提示语长度 → 铁证。
  const ROOT = fixture('cutoff')
  const names = Array.from({ length: 9 }, (_, i) => `科目${i + 1}`)  // 多到连最低档都装不下
  for (const n of names) {
    mkdirSync(join(ROOT, n), { recursive: true })
    writeFileSync(join(ROOT, n, '学习档案.md'), archiveOf(daysAgo(3), n, { items: 3, long: 60 }))
    writeFileSync(join(ROOT, n, '本周任务.md'), taskOf(daysAgo(3), n, 3))
  }
  const board = plan.buildBoard(ROOT, { today: TODAY, subjects: plan.survey(ROOT, TODAY), planRaw: undefined })
  check('  9 科目：确实触发了硬截断（否则这条断言没在测东西）', board.includes('已按上限截断'))
  check('  硬截断后**仍然** ≤ 4096（提示语也要占预算）', B(board) <= 4096, `${B(board)}`)

  // ── (b) 头部下限不许把预算**抬到**上限之上
  //     旧式 `Math.max(上限 - 尾部 - 1, 下限)` 在尾部很长时会把预算抬到超出真实余额，
  //     于是"装得下"是假的。这里用一个尾部极长的现场（大计划 + 长变更记录）逼近它。
  const ROOT2 = fixture('floor')
  for (const n of ['甲科', '乙科', '丙科']) {
    mkdirSync(join(ROOT2, n), { recursive: true })
    writeFileSync(join(ROOT2, n, '学习档案.md'), archiveOf(daysAgo(1), n, { items: 3, long: 30 }))
  }
  const fatPlan = ['# 总规划', '', `生成: ${TODAY}`, '', '## 本周目标', ...Array.from({ length: 40 }, (_, i) => `- 目标条目 ${i + 1} ${'内'.repeat(20)}`)].join('\n')
  const board2 = plan.buildBoard(ROOT2, { today: TODAY, subjects: plan.survey(ROOT2, TODAY), planRaw: fatPlan })
  check('  尾部极长时：总字节仍 ≤ 4096（预算不许被下限抬过头）', B(board2) <= 4096, `${B(board2)}`)
  check('  尾部极长时：可照抄基准行仍在（尾部永不截断）', board2.split('\n').some((l) => l.startsWith('数据基准: ')))

  // ── (c) 档位表必须**单调递减**，否则"逐档降"会中途反弹，永远收敛不到最低档
  const tiers = plan.BOARD_HEAD_TIERS
  let mono = true
  let why = ''
  for (let i = 1; i < tiers.length; i += 1) {
    const a = tiers[i - 1]; const b = tiers[i]
    if (b.fields.length > a.fields.length) { mono = false; why = `第 ${i + 1} 档 fields 变多` }
    // item 只在**两档都还渲染散文摘要**时才有意义：fields 为空的那几档根本不渲染
    // 「进度/卡点/薄弱」，item 是死配置（写 0 表示"不截断"但没有任何行可截）。
    const itemLive = a.fields.length > 0 && b.fields.length > 0
    for (const k of ['item', 'task', 'drift']) {
      if (k === 'item' && !itemLive) continue
      // 0 表示"不截断"（最松），非 0 比 0 严 → 0 → 非0 是变严，允许；非0 → 0 是变松，不允许
      if (a[k] !== 0 && b[k] === 0) { mono = false; why = `第 ${i + 1} 档 ${k} 从 ${a[k]} 变回 0（不截断）` }
      else if (a[k] !== 0 && b[k] !== 0 && b[k] > a[k]) { mono = false; why = `第 ${i + 1} 档 ${k} 从 ${a[k]} 变大到 ${b[k]}` }
    }
  }
  check('  降档表单调递减（只会越来越紧）', mono, why)
  check('  最低档不含任何散文摘要（最后一步只能压摘要，不能压事实）', tiers.at(-1).fields.length === 0)
  check('  最低档仍给任务与漂移留了字节（事实永不整条丢）', tiers.at(-1).task > 0 && tiers.at(-1).drift > 0)
  check('  不渲染摘要的档位，item 是死配置（不许被误当成"更松"）',
    tiers.filter((t) => t.fields.length === 0).every((t) => t.item === 0))
}

console.log('\n⑤ 短看板不许冒出假标记 / 无科目仍然大声报警')
{
  const ROOT = fixture('short')
  mkdirSync(join(ROOT, '甲科'), { recursive: true })
  writeFileSync(join(ROOT, '甲科', '学习档案.md'), archiveOf(TODAY, '甲科'))
  const board = plan.buildBoard(ROOT, { today: TODAY, subjects: plan.survey(ROOT, TODAY), planRaw: undefined })
  check('  短看板无任何截断/降档标记', !board.includes('已按上限截断') && !board.includes('头部超预算'))
  const empty = plan.buildBoard(fixture('empty'), { today: TODAY, subjects: [], planRaw: undefined })
  check('  无科目时报警', empty.includes('未发现任何科目'))
  check('  无科目时不渲染可照抄基准行（避免自相矛盾）', !empty.includes('数据基准: '))
}

for (const root of fixtures) { try { rmSync(root, { recursive: true, force: true }) } catch {} }
console.log(fail === 0 ? `\n✅ 全部通过：${pass} passed, 0 failed` : `\n❌ ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
