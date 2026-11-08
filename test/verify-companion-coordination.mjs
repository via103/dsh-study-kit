// 陪伴协调回归：驱动真实 pre-step，夹具不碰学员数据；同日条目不互相吞掉。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as plan from '../plan-core.js'
import * as core from '../companion-core.js'
import { profilePatchDeclarations, deliveredDeclarations, personaPrefixOf } from '../tools/presets.mjs'
let pass = 0, fail = 0
const check = (label, ok) => { if (ok) { pass++; console.log('✅', label) } else { fail++; console.log('❌', label) } }
const root = mkdtempSync(join(tmpdir(), 'companion-coordination-'))
const mind = join(root, '心灵'), math = join(root, '数学')
mkdirSync(mind); mkdirSync(math)
const today = plan.studyDate()
const archive = (body) => `# 学习档案\n更新于: ${today}\n## 学校当前进度\n第1章\n## 已答主题与卡点\n${body}\n## 未消化薄弱点\n无\n`
const note = (out = '', state = '', teaching = '', inbox = '') => `# 心灵笔记\n更新于: ${today}\n## 最近的状态\n${state}\n## 要跟学科说的\n${teaching}\n## 要跟总规划说的\n${out}\n## 收下的移交\n${inbox}\n`
const notePath = join(mind, plan.COMPANION_NOTE_NAME)
const save = (text) => writeFileSync(notePath, text, 'utf8')
const mount = (mod, config, cwd) => {
  const callbacks = new Map()
  mod.apply({ on: (event, fn) => { callbacks.set(event, fn); return () => {} }, get: (name) => name === 'tools' ? { guard: () => () => {} } : undefined }, config)
  const agent = { id: `${cwd}-${Math.random()}`, session: { header: { cwd } } }
  return async () => (await callbacks.get('agent/pre-step')({ agent, step: 1, signal: { aborted: false } }, async () => ({ kind: 'enter', messages: [] }))).messages.map((m) => m.content[0].text).join('\n')
}
try {
  writeFileSync(join(math, '学习档案.md'), archive('- 无'))
  save(note())
  const runPlanner = mount(plan, { root, companionDir: '心灵' }, root)
  check('首次真实看板进入', (await runPlanner()).includes('全科看板'))
  check('未变化去重', (await runPlanner()) === '')
  save(note('- 本周只有三晚，请统筹任务量'))
  check('仅新增待办，下一轮重新注入', (await runPlanner()).includes('本周只有三晚'))
  check('重复内容不重复注入', (await runPlanner()) === '')
  save(note('- 本周只有两晚，请统筹任务量'))
  check('同日同长度改条，下一轮重新注入', (await runPlanner()).includes('本周只有两晚'))
  save(note())
  const removed = await runPlanner()
  check('仅删待办，也重新注入当前看板', removed.includes('全科看板') && !removed.includes('待规划处理'))
  save(note('', '私人状态换了一个说法'))
  check('私人状态不改变规划注入（避免隐私变化触发通道）', (await runPlanner()) === '')

  save(note('- @数学：规划节不应投递', '- @数学：私人哨兵', '- @数学：讲解请一次一步', '- @数学：收件节不应投递'))
  const outbound = core.collectHandoffs(math)
  check('只投递学科出信节的合法标记', outbound.length === 1 && outbound[0].text === '讲解请一次一步')
  check('私有节/规划节/收件节标记全部不进入学科注入', !JSON.stringify(outbound).includes('哨兵') && !JSON.stringify(outbound).includes('不应投递'))
  const receipt = `- 讲解请一次一步（源:心灵 ${today}）\n`
  check('学科收下陪伴的一条后该条停止提醒', core.pendingHandoffs(math, { outlineText: receipt }).pending.length === 0)
  save(note('', '', '- @数学：讲解请一次一步\n- @数学：答完请先问我哪里没懂'))
  const sameDay = core.pendingHandoffs(math, { outlineText: receipt })
  check('同来源同日的第二条仍提醒', sameDay.pending.length === 1 && sameDay.pending[0].text === '答完请先问我哪里没懂')
  check('只是“收到”不能吞掉具体请求', core.pendingHandoffs(math, { outlineText: `- 收到（源:心灵 ${today}）` }).pending.length === 2)
  check('学科在自己档案留同条收据也可销账，不强迫写提纲', core.pendingHandoffs(math, { companionReceiptText: archive(receipt) }).pending.length === 1)
  const teachingNotice = core.renderHandoffs(sameDay.pending)
  check('来自陪伴的真实渲染是教学协调，不是讲课/复习知识点', teachingNotice.includes('【跨科移交·陪伴协调】') && !teachingNotice.includes('照常复习') && teachingNotice.includes('自己的 学习档案.md'))
  writeFileSync(join(math, '学习档案.md'), archive(receipt))
  const tutorInjected = await mount(core, {}, math)()
  check('真实学科 pre-step 使用档案收据只留下同日第二条', !tutorInjected.includes('  - @数学：讲解请一次一步') && tutorInjected.includes('答完请先问我哪里没懂'))
  check('学科注入带「写前先读」边界（注入 ≠ 读过；2026-10-18 数学会话反复撞 FS_NOT_OBSERVED）', tutorInjected.includes('写前先读') && tutorInjected.includes('注入 ≠ 读过'))
  save(note('', '', '- @数学：仅正文有效\n```md\n- @数学：代码块哨兵\n```\n## 其他\n- @数学：其他节哨兵'))
  const fenced = core.collectHandoffs(math)
  check('代码示例和后续其他节不当出信', fenced.length === 1 && fenced[0].text === '仅正文有效')

  writeFileSync(join(math, '学习档案.md'), archive('- @心灵：数学挫败感需要陪聊\n- @心灵：今天练习后很开心'))
  const incomingReceipt = note('', '', '', `- 数学挫败感需要陪聊（源:数学 ${today}）`)
  const pending = core.pendingHandoffs(mind, { outlineText: incomingReceipt })
  check('陪伴收件同日第二条不被第一条来源戳吞掉', pending.pending.length === 1 && pending.pending[0].text === '今天练习后很开心')
  const rendered = core.renderHandoffs(pending.pending, { ledgerName: plan.COMPANION_NOTE_NAME })
  check('陪伴收信不要求讲课/复习', !rendered.includes('讲一遍') && !rendered.includes('照常复习'))
  check('收信提醒明确区分收下与完成', rendered.includes('不代表问题已经解决'))
  const legacy = core.renderHandoffs(pending.pending)
  check('正控制：传统学科知识点仍保留教学/复习流程', legacy.includes('讲一遍') && legacy.includes('照常复习'))
  save(note())
  const liveNote = await mount(core, { noteName: plan.COMPANION_NOTE_NAME }, mind)()
  check('真实陪伴注入不再承诺其余各节不外传', !liveNote.includes('其余各节不外传') && liveNote.includes('不是文件访问隔离'))
  check('真实陪伴注入说明定向学科通道', liveNote.includes('要跟学科说的') && liveNote.includes('@目标科目'))
  check('陪伴注入也带「写前先读」边界（笔记同样受宿主观察策略）', liveNote.includes('写前先读'))
  save(incomingReceipt)
  writeFileSync(join(root, '变更记录.md'), `# 变更记录\n生成: ${today}\n- ${today} 全局：本周时间影响已处理\n`)
  const receiptedInjection = await mount(core, { noteName: plan.COMPANION_NOTE_NAME }, mind)()
  check('陪伴已有收件戳也不触发跨科知识点复习模板', !receiptedInjection.includes('【跨科知识点·别科追加】') && !receiptedInjection.includes('复习/出题时'))
  check('陪伴公开记录注入是核对而非学科任务/档案回执', receiptedInjection.includes('可核对对应事项') && !receiptedInjection.includes('有困难照常写进 学习档案.md'))

  const oldStamp = new Date(Date.parse(`${today}T12:00:00Z`) - 3 * 86400000).toISOString().slice(0, 10)
  save(note().replace(`更新于: ${today}`, `更新于: ${oldStamp}`))
  const oldNoteInjection = await mount(core, { noteName: plan.COMPANION_NOTE_NAME }, mind)()
  check('隔三天回来聊天，不再被陈旧模板催建学业档案', !oldNoteInjection.includes('先更新 学习档案.md 再收尾'))
  check('正控制：传统学科陈旧提醒仍存在', core.staleNotice(archive('- 无').replace(today, oldStamp), today).includes('先更新 学习档案.md 再收尾'))

  // 行为规范只能验证投递文本，不能把字符串断言冒称为模型行为验收。
  if (!process.argv.includes('--mechanics-only')) {
    for (const profile of ['desktop', 'web']) {
      // ★ 2026-11-05：用「实际投递的那一组」= 组合包 ∪ profile patch。
      //   `总规划` 现在只声明在 @local/dsh-study 的组合包 patch 里（desktop 没有 override），
      //   只读 profile patch 会拿到 undefined → persona 空串 → 三条断言假红。
      const decls = deliveredDeclarations({ patch: `~/.dsh/profiles/${profile}/cordis.patch.yml`, dir: `~/.dsh/profiles/${profile}` })
      const persona = (id) => personaPrefixOf(decls.find((d) => d.id === id)) ?? ''
      const p = persona('mind-companion'), pp = persona('study-planner')
      check(`${profile}: 陪伴主职及普通倾诉不盘问`, p.includes('陪伴是主职') && p.includes('普通倾诉不盘问'))
      check(`${profile}: 明确委托不重复确认、敏感推断先确认`, p.includes('明确委托就办理') && p.includes('重大调整先确认'))
      check(`${profile}: 单一统筹出口、无依据不编比例`, p.includes('一个问题一个统筹出口') && p.includes('没有依据不编百分比'))
      check(`${profile}: 同日、部分/未采纳、撤回与暂缓都可核对`, ['同日办理也有效', '部分采纳', '未采纳也是处理结果', '撤回、失效', '复核时点'].every((s) => p.includes(s)))
      check(`${profile}: 隐私不冒充 ACL`, p.includes('不是文件访问隔离') && !p.includes('其余各节不外传'))
      check(`${profile}: 规划处理而非机械执行；任务量统筹`, pp.includes('待处理') && pp.includes('具体任务量由你统筹') && !pp.includes('这轮真的按 60% 排'))
      check(`${profile}: 规划同日及未采纳结果不冒充改动`, pp.includes('同日处理也有效') && pp.includes('不编造改动'))
      check(`${profile}: 截断残句不能直接执行或读私人笔记补齐`, pp.includes('省略号') && pp.includes('不能按残句执行'))
      for (const id of ['math-tutor', 'netsec-tutor', 'english-tutor', 'code-tutor']) check(`${profile}/${id}: 教学协调不转抄私事、不改任务`, persona(id).includes('来自心灵的教学协调不是知识点移交') && persona(id).includes('不能据此自行改'))
    }
    const scaffoldSource = readFileSync(new URL('../new-companion.mjs', import.meta.url), 'utf8')
    check('新笔记骨架不声称唯一外流通道', !scaffoldSource.includes('只有这一节外流') && !scaffoldSource.includes('只有第 ③ 节会外流'))
  }
} finally { rmSync(root, { recursive: true, force: true }) }
console.log(`结果：${pass} 通过 / ${fail} 失败`)
process.exitCode = fail ? 1 : 0
