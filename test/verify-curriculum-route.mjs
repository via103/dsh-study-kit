// verify-curriculum-route.mjs —— 课程路线协议（2026-10-17 学员批评教学"没路线/不深/不完整"后的修复）
//
// 这一套钉住三件事：
//   ① 路线文件**能校验、能解析、能算覆盖**：结构（四节/六字段/日期戳）不是靠"请务必"，是写守护；
//   ② 投递真的发生：真实 pre-step 注入摘要、内容变化才重注入、缺文件有提示、陪伴目录不出现；
//   ③ 四份伴学 persona 都写明了同一份教学契约（路线/深度/覆盖/两种模式）——它们各自演进，最容易漂。
//
// 为什么必须有这套：`复习提纲.md` 只记"已经学到的知识点"，`学习档案.md` 只装状态（6KB），
// 两者都回答不了"这门课应该学什么、学到哪、还差什么"。没有第三份课程级文件时，模型只能
// 追着学员的问题跑——这正是学员原话「教学路线不清晰、教学内容不完整」的机制。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as plan from '../plan-core.js'
import * as core from '../companion-core.js'
import { profilePatchDeclarations, personaPrefixOf } from '../tools/presets.mjs'

let pass = 0, fail = 0
const check = (label, ok, extra) => {
  if (ok) { pass += 1; console.log('  ✅', label) }
  else { fail += 1; console.log('  ❌', label, extra === undefined ? '' : `→ ${extra}`) }
}
const today = plan.studyDate()
const root = mkdtempSync(join(tmpdir(), 'curriculum-route-'))
const subject = join(root, 'C')
mkdirSync(subject)

const ROUTE = `# 课程路线（C）

更新于: ${today}

> 用途：课程级路线（单元顺序 / 目标深度 / 状态与证据 / 下一课 / 覆盖清单）。

## 课程基准
- 教材＝某教材（测试夹具）
- 学校课程＝某课程；考核方式待记

## 单元进度
- C02 基本数据类型｜教材 第2章｜前置 —｜目标 L3｜状态 已过｜证据 ${today} 复习 6.5/10
- C03 基本算术运算｜教材 第3章｜前置 C02｜目标 L3｜状态 进行中｜证据 ${today} 复测仍错
- C05 选择控制结构｜教材 第5章｜前置 C02–C04｜目标 L3｜状态 未开始｜证据 —

## 下一课
- 主题：函数体系｜为什么现在：结构体作业要用｜目标 L3｜验收：独立写 Input/Find 过 3 组用例

## 覆盖清单
### C02 类型
- [x] 基本类型与 sizeof
- [x] 常量变量与初始化
- [ ] 类型转换
### C03 运算
- [x] 优先级与短路
- [ ] 位运算
- [ ] 复合赋值
`

const archive = (body = '无') => `# 学习档案\n\n更新于: ${today}\n\n## 学校当前进度\n第 2 章。\n\n## 已答主题与卡点\n${body}\n\n## 未消化薄弱点\n- 无。\n`
writeFileSync(join(subject, '学习档案.md'), archive(), 'utf8')

const mount = () => {
  const callbacks = new Map()
  let guardFn
  core.apply({
    on: (event, fn) => { callbacks.set(event, fn); return () => {} },
    get: (name) => name === 'tools' ? { guard: (fn) => { guardFn = fn; return () => {} } } : undefined,
  }, {})
  const agent = { id: `agent-${Math.random()}`, session: { header: { cwd: subject } } }
  return {
    agent,
    call: async () => {
      const res = await callbacks.get('agent/pre-step')({ agent, step: 1, signal: { aborted: false } }, async () => ({ kind: 'enter', messages: [] }))
      return res.messages.map((m) => m.content?.[0]?.text ?? '').join('\n')
    },
    guard: (executation) => guardFn(executation),
  }
}

console.log('\n① 规则函数：正控制（这份夹具就是给学员看的模板）')
check('合法路线通过校验', core.validateRoute(ROUTE) === undefined, core.validateRoute(ROUTE))
check('读取场景允许旧日期（stampFresh:false）', core.validateRoute(ROUTE.replace(today, '2026-01-01'), undefined, undefined, today, { stampFresh: false }) === undefined)
const parsed = core.parseRoute(ROUTE)
check('解析出日期戳', parsed.stamp === today, String(parsed.stamp))
check('解析出 3 个单元', parsed.units.length === 3, String(parsed.units.length))
check('解析出状态计数事实', parsed.units[1].status === '进行中' && parsed.units[1].depth === 3)
check('解析出「下一课」四字段', parsed.next !== undefined && parsed.next['目标'] === 'L3' && parsed.next['验收'].includes('Input'))
check('解析出覆盖统计 3/6', parsed.coverage.checked === 3 && parsed.coverage.total === 6, `${parsed.coverage.checked}/${parsed.coverage.total}`)
check('覆盖缺口按组带出', parsed.coverage.items.filter((i) => !i.checked).map((i) => i.group).includes('C03 运算'))

console.log('\n② 规则函数：拒绝负例（每条都是真实可能犯的写法）')
const rejects = [
  ['缺「## 单元进度」', ROUTE.replace('## 单元进度', '## 进度')],
  ['重复小节', ROUTE + '\n## 覆盖清单\n- [ ] 多余\n'],
  ['缺日期戳', ROUTE.replace(`更新于: ${today}\n`, '')],
  ['日期不是今天（写边界）', ROUTE.replace(`更新于: ${today}`, '更新于: 2026-01-01')],
  ['单元行少字段', ROUTE.replace('- C03 基本算术运算｜教材 第3章｜前置 C02｜目标 L3｜状态 进行中｜证据 ' + today + ' 复测仍错', '- C03 基本算术运算｜教材 第3章｜状态 进行中')],
  ['单元编号重复', ROUTE.replace('- C03 基本算术运算', '- C02 基本算术运算')],
  ['「已过」但没证据', ROUTE.replace(`状态 已过｜证据 ${today} 复习 6.5/10`, '状态 已过｜证据 —')],
  ['状态不在枚举里', ROUTE.replace('状态 进行中', '状态 学了一半')],
  ['目标深度越界 L9', ROUTE.replace('目标 L3｜状态 进行中', '目标 L9｜状态 进行中')],
  ['下一课缺字段', ROUTE.replace('- 主题：函数体系｜为什么现在：结构体作业要用｜目标 L3｜验收：独立写 Input/Find 过 3 组用例', '- 主题：函数体系｜为什么现在：结构体作业要用｜验收：独立写 Input/Find')],
  ['下一课目标深度坏', ROUTE.replace('目标 L3｜验收：独立写', '目标 深入｜验收：独立写')],
  ['覆盖清单为空', ROUTE.replace(/^- \[.\] .+$/gm, '')],
  ['基准没写教材', ROUTE.replace('- 教材＝某教材（测试夹具）', '- 用某本书')],
  ['超过行数上限', ROUTE + '\n' + Array.from({ length: 200 }, (_, i) => `- [ ] 多余 ${i}`).join('\n')],
  ['含控制字符', ROUTE.replace('更新于: ' + today, `更新于: ${today}\u0000`)],
]
for (const [label, bad] of rejects) {
  const why = core.validateRoute(bad)
  check(`拒绝：${label}`, typeof why === 'string' && why.length > 0, why)
}
check('非字符串直接拒绝', typeof core.validateRoute(undefined) === 'string')

console.log('\n③ 摘要：只放决策所需，且自报"可能陈旧"')
const digest = core.renderRouteDigest(parsed, { bytes: 1000, today, archiveStamp: today })
check('摘要点名课程路线与文件大小', digest.includes('课程路线') && digest.includes('1000 / 24576'))
check('摘要自报可能陈旧、以文件为准', digest.includes('可能陈旧') && digest.includes('以文件为准'))
check('摘要提醒「改它之前先 read」（注入 ≠ 读过）', digest.includes('先 read'))
check('摘要有进度计数', digest.includes('已过 1') && digest.includes('进行中 1') && digest.includes('未开始 1'))
check('摘要有覆盖统计与缺口', digest.includes('覆盖 3/6') && digest.includes('缺口'))
check('摘要有唯一「下一课」', digest.includes('下一课') && digest.includes('函数体系'))
const staleDigest = core.renderRouteDigest(core.parseRoute(ROUTE.replace(today, '2026-01-01')), { bytes: 1000, today, archiveStamp: today })
check('路线比档案旧 → 先补路线的提醒', staleDigest.includes('先补进路线'))
const oldDigest = core.renderRouteDigest(core.parseRoute(ROUTE.replace(today, '2026-01-01')), { bytes: 1000, today })
check('路线陈旧 ≥3 天 → 提醒核对进度', oldDigest.includes('天未更新'))

console.log('\n④ 真实 pre-step：摘要真的投递（文件在按需成本之外，每轮都在眼前）')
{
  writeFileSync(join(subject, core.ROUTE_NAME), ROUTE, 'utf8')
  const m = mount()
  const first = await m.call()
  check('首轮注入课程路线摘要', first.includes('课程路线·自动注入') && first.includes('函数体系'), first.slice(0, 120))
  check('首轮同时照旧注入学习档案', first.includes('伴学档案·自动注入'))
  const second = await m.call()
  check('内容未变 → 不重复注入（零成本）', second === '')
  writeFileSync(join(subject, core.ROUTE_NAME), ROUTE.replace('- [ ] 类型转换', '- [x] 类型转换'), 'utf8')
  const third = await m.call()
  check('路线一变 → 重新注入且覆盖数更新（3/6→4/6）', third.includes('覆盖 4/6'), third.slice(0, 160))
  writeFileSync(join(subject, core.ROUTE_NAME), ROUTE.replace('## 单元进度', '## 进度'), 'utf8')
  const broken = await m.call()
  check('写法不合法 → 摘要在，但先报格式提醒（不把坏文件当事实）', broken.includes('格式提醒') && broken.includes('单元进度'))
  rmSync(join(subject, core.ROUTE_NAME))
  const missing = await m.call()
  check('缺路线 → 注入缺失提示（学科工作区才提示）', missing.includes('课程路线·缺失') && missing.includes('对话摸底'))
  const m2 = mount() // 新 agent：缓存不复用
  const freshAgent = await m2.call()
  check('缺文件时不误报"路线是空的"', !freshAgent.includes('进度：已过 0') && freshAgent.includes('课程路线·缺失'))
  writeFileSync(join(subject, core.ROUTE_NAME), ROUTE, 'utf8')
}

console.log('\n⑤ 陪伴目录与非学科工作区：不该被这份协议打扰')
{
  const mind = join(root, '心灵')
  mkdirSync(mind)
  writeFileSync(join(mind, core.COMPANION_NOTE_NAME), `# 心灵笔记\n\n更新于: ${today}\n\n## 最近的状态\n还好。\n`, 'utf8')
  const callbacks = new Map(); let guardFn
  core.apply({ on: (e, fn) => { callbacks.set(e, fn); return () => {} }, get: (n) => n === 'tools' ? { guard: (fn) => { guardFn = fn; return () => {} } } : undefined }, { noteName: core.COMPANION_NOTE_NAME })
  const agent = { id: `mind-${Math.random()}`, session: { header: { cwd: mind } } }
  const res = await callbacks.get('agent/pre-step')({ agent, step: 1, signal: { aborted: false } }, async () => ({ kind: 'enter', messages: [] }))
  const text = res.messages.map((m) => m.content?.[0]?.text ?? '').join('\n')
  check('陪伴目录不注入课程路线', !text.includes('课程路线'))
  check('陪伴目录里写课程路线被拒（它不是科目）', String(guardFn({ name: 'write', arguments: { file_path: join(mind, core.ROUTE_NAME), content: ROUTE }, agent })).includes('陪伴目录'))
}
{
  const plain = join(root, '项目')
  mkdirSync(plain)
  const callbacks = new Map()
  core.apply({ on: (e, fn) => { callbacks.set(e, fn); return () => {} }, get: (n) => n === 'tools' ? { guard: () => () => {} } : undefined }, {})
  const agent = { id: `plain-${Math.random()}`, session: { header: { cwd: plain } } }
  const res = await callbacks.get('agent/pre-step')({ agent, step: 1, signal: { aborted: false } }, async () => ({ kind: 'enter', messages: [] }))
  check('非学科目录（无学习档案）不注入任何伴学内容', res.messages.length === 0)
}

console.log('\n⑥ 写守护：本科可写，但必须过结构校验；别科只读')
{
  const m = mount()
  const good = m.guard({ name: 'write', arguments: { file_path: join(subject, core.ROUTE_NAME), content: ROUTE }, agent: m.agent })
  check('合法写入放行', good === undefined, String(good))
  const bad = m.guard({ name: 'write', arguments: { file_path: join(subject, core.ROUTE_NAME), content: ROUTE.replace('## 下一课\n- 主题：函数体系｜为什么现在：结构体作业要用｜目标 L3｜验收：独立写 Input/Find 过 3 组用例\n', '## 下一课\n') }, agent: m.agent })
  check('非法写入被拒并说明原因', typeof bad === 'string' && bad.includes('下一课'), String(bad))
  const other = join(root, 'Python'); mkdirSync(other)
  const foreign = m.guard({ name: 'write', arguments: { file_path: join(other, core.ROUTE_NAME), content: ROUTE }, agent: m.agent })
  check('别科目录的路线只读', typeof foreign === 'string' && foreign.includes('别科只读'), String(foreign))
  writeFileSync(join(subject, core.ROUTE_NAME), ROUTE, 'utf8')
  const editBad = m.guard({
    name: 'edit',
    arguments: {
      file_path: join(subject, core.ROUTE_NAME),
      old_string: '- C05 选择控制结构｜教材 第5章｜前置 C02–C04｜目标 L3｜状态 未开始｜证据 —',
      new_string: '- C05 选择控制结构｜教材 第5章｜前置 C02–C04｜目标 L3｜状态 已过｜证据 —',
    },
    agent: m.agent,
  })
  check('edit 通道同样执法（改后内容重建再校验）', typeof editBad === 'string' && editBad.includes('已过'), String(editBad))
}

console.log('\n⑦ 现场与四份 persona：契约真的发到了学员会用的预设里')
{
  const routeFile = 'ST/C/课程路线.md'
  if (existsSync(routeFile)) {
    const raw = readFileSync(routeFile, 'utf8')
    const stamp = /更新于:\s*(\d{4}-\d{2}-\d{2})/.exec(raw)?.[1] ?? ''
    check('C 的课程路线存在且通过结构校验（以它自己的日期为今天）', core.validateRoute(raw, undefined, undefined, stamp) === undefined, core.validateRoute(raw, undefined, undefined, stamp))
    const p = core.parseRoute(raw)
    check('C 路线覆盖清单 ≥ 30 条知识点（完整性的基线）', p.coverage.total >= 30, String(p.coverage.total))
    check('C 路线「下一课」存在且目标深度合法', p.next !== undefined && /^L[1-4]$/.test(p.next['目标'] ?? ''))
    check('C 学习档案指向课程路线（不重复路线）', readFileSync('ST/C/学习档案.md', 'utf8').includes('课程路线.md'))
  } else {
    check('C 的课程路线已建档', false, '缺 ' + routeFile)
  }
  for (const profile of ['desktop', 'web']) {
    const decls = profilePatchDeclarations({ patch: `~/.dsh/profiles/${profile}/cordis.patch.yml` })
    for (const id of ['code-tutor', 'math-tutor', 'english-tutor', 'netsec-tutor']) {
      const p = personaPrefixOf(decls.find((d) => d.id === id)) ?? ''
      check(`${profile}/${id}: 写明课程路线协议`, p.includes('课程路线.md') && p.includes('教学契约'))
      check(`${profile}/${id}: 写明深浅阶梯与两种模式`, p.includes('L1') && p.includes('两种模式'))
      check(`${profile}/${id}: 写明覆盖审计`, p.includes('覆盖审计'))
    }
  }
}

rmSync(root, { recursive: true, force: true })
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exitCode = fail ? 1 : 0
