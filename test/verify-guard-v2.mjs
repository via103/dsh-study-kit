// verify-guard-v2.mjs — 守护接线层的对抗回归（红队 12 条反例里「真绕过」的那几条）
// 用法：node verify-guard-v2.mjs
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const PLUGINS = '<study-plugins>/'
const plan = await import(pathToFileURL(PLUGINS + 'plan-core.js').href)
const core = await import(pathToFileURL(PLUGINS + 'companion-core.js').href)

let pass = 0
let fail = 0
function check(label, cond, extra) {
  if (cond) { pass += 1; console.log('  ✅', label) }
  else { fail += 1; console.log('  ❌', label, extra === undefined ? '' : `→ ${extra}`) }
}

const TODAY = plan.studyDate()
const ROOT = mkdtempSync(join(tmpdir(), 'guard-v2-'))
const ST = join(ROOT, 'ST')
const ENG = join(ST, '英语')
mkdirSync(ENG, { recursive: true })
const archive = (stamp) =>
  `# 学习档案\n\n更新于: ${stamp}\n\n## 学校当前进度\n- 进度正常\n\n## 已答主题与卡点\n- 卡点：无\n\n## 未消化薄弱点\n- 薄弱：无\n`
writeFileSync(join(ENG, '学习档案.md'), archive(TODAY))

const badTask = `# 本周任务（英语）\n\n生成: 1999-01-01\n依据: 学习档案 更新于 1999-01-01\n\n- [ ] 1\n- [ ] 2\n- [ ] 3\n- [ ] 4\n`

// ── 接线：三个 guard，分别代表「总规划会话」「科目会话」 ──────────────────────
const planGuard = (() => {
  const g = []
  plan.apply({ on: () => {}, get: (n) => (n === 'tools' ? { guard: (f) => g.push(f) } : undefined) }, { root: ST })
  return g[0]
})()
const compGuard = (() => {
  const g = []
  core.apply({ on: () => {}, get: (n) => (n === 'tools' ? { guard: (f) => g.push(f) } : undefined) }, {})
  return g[0]
})()
const planner = (name, file, args) => planGuard({ name, arguments: { file_path: file, ...args }, agent: { session: { header: { cwd: ST } } } })
const tutor = (name, file, args) => compGuard({ name, arguments: { file_path: file, ...args }, agent: { session: { header: { cwd: ENG } } } })
const blocked = (v) => typeof v === 'string' && v.length > 0

// ── ① 大小写别名：Windows 上 .MD 与 .md 是同一个文件 ─────────────────────────
console.log('\n① 文件名大小写别名（曾让 4/4 守护全部失效）')
check('planner 写 总规划.md → 校验生效', blocked(planner('write', join(ST, '总规划.md'), { content: 'x' })))
check('planner 写 总规划.MD → 同样被拦（别名）', blocked(planner('write', join(ST, '总规划.MD'), { content: 'x' })))
check('planner 写 英语/本周任务.MD → 同样被拦', blocked(planner('write', join(ENG, '本周任务.MD'), { content: badTask })))
check('tutor 写 学习档案.MD → 同样被拦', blocked(tutor('write', join(ENG, '学习档案.MD'), { content: '随便' })))
check('tutor 写 本周任务.MD → 同样被拦', blocked(tutor('write', join(ENG, '本周任务.MD'), { content: 'x' })))

// ── ② 路径写法变体：不能让校验被跳过 ────────────────────────────────────────
console.log('\n② 路径写法变体（曾让任务校验整段跳过）')
check('正斜杠路径 → 被拦', blocked(planner('write', `${ST.replaceAll('\\', '/')}/英语/本周任务.md`, { content: badTask })))
check('小写盘符/路径 → 被拦', blocked(planner('write', join(ST, '英语', '本周任务.md').toLowerCase(), { content: badTask })))
check('`\\\\?\\` 长路径前缀 → 被拦', blocked(planner('write', `\\\\?\\${join(ST, '英语', '本周任务.md')}`, { content: badTask })))
check('规范路径仍被拦（对照）', blocked(planner('write', join(ST, '英语', '本周任务.md'), { content: badTask })))
check('`..` 越界（root 之外）→ 不归本插件管，放行', planner('write', '..\\英语\\本周任务.md', { content: badTask }) === undefined)
check('root 的兄弟目录 ST2 → 不再被误判成 root 内', planner('write', join(ROOT, 'ST2', '英语', '本周任务.md'), { content: badTask }) === undefined)

// ── ③ edit 重建：必须与真实 edit 同语义，且重建不了就拒绝 ────────────────────
console.log('\n③ edit 重建语义（曾 fail-open 且与真实 edit 不同）')
const crlfFile = join(ENG, '学习档案.md')
writeFileSync(crlfFile, archive(TODAY).replaceAll('\n', '\r\n'))
const oldLf = `更新于: ${TODAY}\n\n## 学校当前进度\n- 进度正常\n## 已答主题与卡点\n- 卡点：无\n## 未消化薄弱点\n- 薄弱：无`
const v1 = tutor('edit', crlfFile, { old_string: oldLf, new_string: `更新于: 2001-01-01\n\n（三字段全没了）` })
check('CRLF 文件 + LF 的 old_string → 重建成功并被拦', blocked(v1), v1)
writeFileSync(crlfFile, archive(TODAY))
check('old_string 找不到 → 拒绝（不再放行）', /无法重建改后内容/.test(tutor('edit', crlfFile, { old_string: '不存在的行', new_string: 'x' }) ?? ''))
const v2 = tutor('edit', crlfFile, { old_string: `更新于: ${TODAY}`, new_string: '$&' })
check('new_string 含 `$&` → 校验的是字面内容而非展开结果', blocked(v2), v2)
const taskPath = join(ENG, '本周任务.md')
writeFileSync(taskPath, `# 本周任务\n\n生成: ${TODAY}\n依据: 学习档案 更新于 ${TODAY}\n\n- [ ] a\n- [ ] b\n`)
check('纯勾选 edit → 放行', tutor('edit', taskPath, { old_string: '- [ ] a', new_string: '- [x] a' }) === undefined)
check('改任务文字 → 拒绝', blocked(tutor('edit', taskPath, { old_string: '- [ ] a', new_string: '- [ ] a（改了）' })))

// ── ④ 平面不变量：现在两半都在代码里 ────────────────────────────────────────
console.log('\n④ 平面不变量（之前只有一半被代码化）')
check('总规划改各科档案 → 拒绝', /只读不改/.test(planner('write', join(ENG, '学习档案.md'), { content: archive(TODAY) }) ?? ''))
check('  总规划写别处同名档案 → 不归它管', planner('write', join(ROOT, 'x', '学习档案.md'), { content: 'x' }) === undefined)
check('科目会话改总规划.md → 拒绝', /由「总规划」预设维护/.test(tutor('write', join(ENG, '总规划.md'), { content: 'x' }) ?? ''))

// ── ⑤ 只执法本工作区同级文件（不再过度拦截） ─────────────────────────────────
console.log('\n⑤ 执法范围（之前会拦别的项目的同名文件）')
check('tutor 写子目录里的 学习档案.md → 不归它管', tutor('write', join(ENG, 'sub', '学习档案.md'), { content: 'x' }) === undefined)
check('tutor 写别处项目的 学习档案.md → 不归它管', tutor('write', join(ROOT, 'other', '学习档案.md'), { content: 'x' }) === undefined)

// ── ⑥ 看板截断：基准行是模型唯一的出路，永远不许切掉 ────────────────────────
console.log('\n⑥ 看板超长截断（曾经按码元切、把基准行切掉）')
{
  const big = join(ROOT, 'BIG')
  const long = (t, n) => `${t}${'条目内容'.repeat(30)}${n}`
  for (let i = 1; i <= 6; i += 1) {
    const name = `科目${i}`
    mkdirSync(join(big, name), { recursive: true })
    writeFileSync(
      join(big, name, '学习档案.md'),
      `# 学习档案\n\n更新于: ${TODAY}\n\n## 学校当前进度\n- ${long(name, 1)}\n- ${long(name, 2)}\n\n## 已答主题与卡点\n- ${long(name, 3)}\n- ${long(name, 4)}\n\n## 未消化薄弱点\n- ${long(name, 5)}\n- ${long(name, 6)}\n- ${long(name, 7)}\n`,
    )
  }
  const subs = plan.survey(big, TODAY)
  const board = plan.buildBoard(big, { today: TODAY, subjects: subs, planRaw: undefined })
  check('  6 科长档案：基准行仍在', board.split('\n').some((l) => l.startsWith('数据基准: ')))
  check('  字节数不超过上限（含截断标记）', Buffer.byteLength(board, 'utf8') <= 4096 + 120, `${Buffer.byteLength(board, 'utf8')}`)
  check('  短看板不会再冒出假的「已截断」标记', !plan.buildBoard(ST, { today: TODAY, subjects: plan.survey(ST, TODAY), planRaw: undefined }).includes('已按上限截断'))
}

// ── ⑦ 基准行：科目名含 `=` / 空格不再形成死循环 ─────────────────────────────
console.log('\n⑦ 数据基准解析（曾经科目名含 `=` 就永远写不进去）')
check('parseBasis(A=B=日期) → 名字 A=B', [...plan.parseBasis('数据基准: A=B=2026-09-13')].map(([k, v]) => `${k}|${v}`).join(',') === 'A=B|2026-09-13')
check('parseBasis(名字含空格) → 正常', [...plan.parseBasis('数据基准: 英语 听力=2026-09-13｜网安=2026-09-12')].length === 2)
check('parseBasis 缺档案值 → 无档案', plan.parseBasis('数据基准: 数学=无档案').get('数学') === '无档案')
{
  const eqRoot = join(ROOT, 'EQ')
  mkdirSync(join(eqRoot, 'A=B'), { recursive: true })
  writeFileSync(join(eqRoot, 'A=B', '学习档案.md'), archive(TODAY))
  const subs = plan.survey(eqRoot, TODAY)
  const doc = `# 总规划\n\n生成: ${TODAY}\n本次修订: 首次制定\n${plan.renderBasis(subs)}\n\n## 一、本周硬约束\n- x\n\n## 二、每科 MVE\n### A=B\n- [ ] y\n\n## 三、漂移与风险\n- z\n\n## 四、下周预备\n- w\n`
  check('  照抄看板基准行 → 通过（不再死循环）', plan.validatePlan(doc, { today: TODAY, subjects: subs }) === undefined, plan.validatePlan(doc, { today: TODAY, subjects: subs }))
}

// ── ⑧ 档案准入 ─────────────────────────────────────────────────────────────
console.log('\n⑧ 档案/任务正文准入')
check('含 NUL 的档案 → 拒绝', /控制字符/.test(core.validateArchive(`# 学习档案\n\n更新于: ${TODAY}\n\n## 学校当前进度\n- a\u0000b\n`, 60, 6144) ?? ''))
check('档案日期戳必须自成一行', core.validateArchive(`${archive(TODAY)}\n- 历史：修订于 2026-08-01，更新于 2026-01-01 那版\n`.replace('\n- 历史', '\n- 历史'), 60, 6144) === undefined)
check('  正文里的「更新于 X」（非独立行）不再被当成日期戳', plan.archiveStamp(`# 学习档案\n\n- 历史：更新于 2026-01-01 那版\n`) === undefined)
check('  companion 与 plan 对同一份档案得出同一基准', plan.archiveStamp(archive(TODAY)) === TODAY && core.validateArchive(archive(TODAY), 60, 6144) === undefined)
check('档案默认字节上限已放宽到 6144', core.validateArchive(archive(TODAY) + 'x'.repeat(5000), 60, undefined) === undefined)

// ── ⑨ 变更记录的归属与注入 ──────────────────────────────────────────────────
console.log('\n⑨ 变更记录（流水）：只有总规划能写、必须放在学习根、读者不能清空')
{
  const notice = `# 变更记录\n\n生成: ${TODAY}\n\n- ${TODAY} 全局：本周三考试，各科减量\n`
  check('planner 写根目录记录 → 校验生效', blocked(planner('write', join(ST, '变更记录.md'), { content: 'x' })))
  check('  planner 把记录写进科目目录 → 拦下', /只能写在学习根目录/.test(planner('write', join(ENG, '变更记录.md'), { content: notice }) ?? ''))
  check('  planner 写合法根目录记录 → 放行', planner('write', join(ST, '变更记录.md'), { content: notice }) === undefined)
  check('tutor 写本科目录里的记录 → 拦下', /只读/.test(tutor('write', join(ENG, '变更记录.md'), { content: notice }) ?? ''))
  check('tutor 写父目录（学习根）的记录 → 也拦下（它在 cwd 之外，最易漏）', /只读/.test(tutor('write', join(ST, '变更记录.md'), { content: notice }) ?? ''))
  check('  tutor 清空它（write 空内容）→ 同样拦下', /只读/.test(tutor('write', join(ST, '变更记录.md'), { content: '' }) ?? ''))
  check('tutor 写别处项目的同名文件 → 不归它管', tutor('write', join(ROOT, 'other', '变更记录.md'), { content: 'x' }) === undefined)

  writeFileSync(join(ST, '变更记录.md'), notice)
  const guards = []
  const handlers = {}
  core.apply({ on: (ev, fn) => { handlers[ev] = fn }, get: (n) => (n === 'tools' ? { guard: (f) => guards.push(f) } : undefined) }, {})
  const out = await handlers['agent/pre-step'](
    { agent: { id: 'notice-agent', session: { header: { cwd: ENG } } }, step: 1, signal: { aborted: false } },
    async () => ({ kind: 'proceed', messages: [] }),
  )
  const texts = out.messages.map((m) => m.content[0].text).join('\n---\n')
  check('记录被注入到科目会话', texts.includes('【变更记录·总规划维护】') && texts.includes('各科减量'))
  check('  注入块说明「你的任务以本周任务为准」', texts.includes('你的任务以上面的 本周任务.md 为准'))
  check('  注入块明说不要清空', texts.includes('不要清空'))
  const again = await handlers['agent/pre-step'](
    { agent: { id: 'notice-agent', session: { header: { cwd: ENG } } }, step: 1, signal: { aborted: false } },
    async () => ({ kind: 'proceed', messages: [] }),
  )
  check('  同一会话第二次读 → 去重，不再重复注入（不需要靠清空来止扰）', again.messages.length === 0)
}

console.log('\n⑩ 预设内守护也要拦「旧依据的勾选」（不能只有宿主守护做到）')
// 两个平面共用同一份 validateTaskWrite / taskBasisContext；这里验证预设内那条路真的把上下文传了进去。
{
  writeFileSync(join(ENG, '本周任务.md'), `# 本周任务\n\n生成: ${TODAY}\n依据: 学习档案 更新于 2020-01-01\n\n- [ ] 旧任务\n`)
  const stale = tutor('edit', join(ENG, '本周任务.md'), { old_string: '- [ ] 旧任务', new_string: '- [x] 旧任务' })
  check('旧依据 → 勾选被预设内守护拦下', blocked(stale), stale)
  check('  理由来自同一份实现（含「旧依据已经作废」）', String(stale).includes('旧依据已经作废'))
  writeFileSync(join(ENG, '本周任务.md'), `# 本周任务\n\n生成: ${TODAY}\n依据: 学习档案 更新于 ${TODAY}\n\n- [ ] 新任务\n`)
  check('依据吻合 → 放行', tutor('edit', join(ENG, '本周任务.md'), { old_string: '- [ ] 新任务', new_string: '- [x] 新任务' }) === undefined)
}

console.log('\n⑪ 复习清单已合并进复习提纲（2026-09-17）')
{
  // 第三个协议文件删掉后，这三个导出必须真的消失——留着就是"文档说删了、代码还在"。
  check('纯函数三件套已移除', core.validateReviewList === undefined && core.parseReviewList === undefined && core.MAX_REVIEW_ITEMS === undefined)
  // 提纲是学员自己的笔记：**预设内守护也不碰它**——它没有代码契约，也就没有可执行的规则。
  check('复习提纲.md → 预设内守护不管', tutor('write', join(ENG, '复习提纲.md'), { content: '一段随便的笔记' }) === undefined)
  check('  合法的知识点行也照常放行', tutor('write', join(ENG, '复习提纲.md'), { content: '- 09-16 数组名退化｜复 2｜上 09-20\n' }) === undefined)
}

rmSync(ROOT, { recursive: true, force: true })
console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
