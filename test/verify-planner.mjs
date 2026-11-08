// verify-planner.mjs — 「总规划」预设（plan-core + companion-core 任务通道）的回归测试
// 用法：node verify-planner.mjs
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { declById, personaPrefixOf } from '../tools/presets.mjs'

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
const daysAgo = (n) => {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return plan.studyDate(d)
}

// ── 测试夹具：一棵 ST 形状的目录树 ───────────────────────────────────────────
const ROOT = mkdtempSync(join(tmpdir(), 'plan-fixture-'))
const archiveOf = (stamp, tag) =>
  `# 学习档案\n\n更新于: ${stamp}\n\n## 学校当前进度\n- ${tag} 进度要点一\n- ${tag} 进度要点二\n\n## 已答主题与卡点\n- ${tag} 卡点一\n\n## 未消化薄弱点\n- ${tag} 薄弱一\n- ${tag} 薄弱二\n`

mkdirSync(join(ROOT, '英语'))
mkdirSync(join(ROOT, '网安'))
mkdirSync(join(ROOT, '数学')) // 无档案：不算科目
mkdirSync(join(ROOT, '.git')) // 隐藏目录：忽略
writeFileSync(join(ROOT, '英语', '学习档案.md'), archiveOf(TODAY, '英语'))
writeFileSync(join(ROOT, '网安', '学习档案.md'), archiveOf(daysAgo(3), '网安'))
writeFileSync(join(ROOT, '.git', '学习档案.md'), archiveOf(TODAY, 'git'))

// 网安：任务下发于昨天、依据 3 天前的档案 → 期望「零回执」漂移
writeFileSync(
  join(ROOT, '网安', '本周任务.md'),
  `# 本周任务（网安）\n\n生成: ${daysAgo(1)}\n依据: 学习档案 更新于 ${daysAgo(3)}\n\n- [ ] 网安任务甲\n- [x] 网安任务乙\n`,
)
// 英语：任务下发于昨天、依据今天的档案 → 期望「有回执」，无零回执
writeFileSync(
  join(ROOT, '英语', '本周任务.md'),
  `# 本周任务（英语）\n\n生成: ${daysAgo(1)}\n依据: 学习档案 更新于 ${TODAY}\n\n- [ ] 英语任务甲\n`,
)

const subjects = plan.survey(ROOT, TODAY)

// ── ① 科目发现与档案解析 ─────────────────────────────────────────────────────
console.log('\n① 科目发现 / 档案解析')
check('只发现带档案的子目录（2 个）', subjects.length === 2, subjects.map((s) => s.name).join(','))
check('  忽略隐藏目录', !subjects.some((s) => s.name === '.git'))
check('  忽略无档案目录', !subjects.some((s) => s.name === '数学'))
check('  科目按名称排序稳定（拼音序：网安 < 英语）', subjects.map((s) => s.name).join(',') === '网安,英语', subjects.map((s) => s.name).join(','))
const eng = subjects.find((s) => s.name === '英语')
check('档案日期戳解析正确', eng.archiveStamp === TODAY, eng.archiveStamp)
check('三字段摘要都抽到了', eng.progress.length === 2 && eng.pain.length === 1 && eng.weak.length === 2, JSON.stringify(eng.progress))
check('excerpt 去掉了列表符', eng.progress[0] === '英语 进度要点一', eng.progress[0])

// ── ② 漂移检测（代码层） ────────────────────────────────────────────────────
console.log('\n② 漂移检测：陈旧 / 零回执 / 回执确认')
const sec = subjects.find((s) => s.name === '网安')
check('网安档案陈旧 3 天被抓到', sec.drift.some((d) => /档案已 3 天未更新/.test(d)), JSON.stringify(sec.drift))
check('  零回执被抓到（任务晚于档案）', sec.drift.some((d) => /零回执/.test(d)), JSON.stringify(sec.drift))
check('  无 receiptDate', sec.receiptDate === undefined)
check('英语有回执，不报零回执', !eng.drift.some((d) => /零回执/.test(d)), JSON.stringify(eng.drift))
check('  回执日期 = 档案日期', eng.receiptDate === TODAY, eng.receiptDate)
const fresh = plan.analyzeSubject({ name: 'x', dir: ROOT, archiveRaw: archiveOf(TODAY, 'x'), taskRaw: undefined, today: TODAY })
check('当天档案不报陈旧', fresh.drift.length === 0, JSON.stringify(fresh.drift))
const noStamp = plan.analyzeSubject({ name: 'x', dir: ROOT, archiveRaw: '# 学习档案\n\n## 学校当前进度\n- a\n', taskRaw: undefined, today: TODAY })
check('缺日期戳被抓到', noStamp.drift.some((d) => /缺少「更新于/.test(d)), JSON.stringify(noStamp.drift))
check('ageDays 方向正确（正数=落后）', plan.ageDays(daysAgo(3), TODAY) === 3 && plan.ageDays(TODAY, TODAY) === 0)

// ── ③ 看板 ─────────────────────────────────────────────────────────────────
console.log('\n③ 全科看板合成')
const board = plan.buildBoard(ROOT, { today: TODAY, subjects, planRaw: undefined })
check('看板含系统当前日期', board.includes(`系统当前日期：${TODAY}`))
check('看板含两个科目', board.includes('■ 英语') && board.includes('■ 网安'))
check('看板含漂移警报行', board.includes('⚠️ 漂移'))
check('看板含 MVE 完成度', board.includes('已完成 1 / 未完成 1'), board.split('\n').find((l) => l.includes('本周任务')))
check('看板标出计划尚未创建', board.includes('尚未创建'))
check('看板末尾给出可照抄的基准行', board.includes(`数据基准: ${subjects.map((s) => `${s.name}=${s.archiveStamp}`).join('｜')}`))
const emptyBoard = plan.buildBoard(ROOT, { today: TODAY, subjects: [], planRaw: undefined })
check('空目录时看板大声报警', emptyBoard.includes('未发现任何科目'), emptyBoard.slice(0, 120))

// ── ③b 「卡点」取段末：它是日志，不是优先级列表 ─────────────────────────────
// 旧实现用 pick（取段首）。网安档案的「已答主题与卡点」是按时间追加的，段首是最老的
// 09-04 两条，于是 09-15/09-16 的条目永远送不到计划模型眼前。
console.log('\n③b 卡点摘要取段末（治「看板永远显示最老的卡点」）')
const logArchive = `# 学习档案\n\n更新于: ${TODAY}\n\n## 学校当前进度\n- 总述在前\n- 近况在后\n\n## 已答主题与卡点\n- 09-04 最老的卡点\n- 09-08 中间的卡点\n- 09-12 较新的卡点\n- 09-16 最新的卡点\n\n## 未消化薄弱点\n- 薄弱一\n`
const logSubj = plan.analyzeSubject({ name: 'x', dir: ROOT, archiveRaw: logArchive, taskRaw: undefined, today: TODAY })
check('卡点仍只取 2 条', logSubj.pain.length === 2, JSON.stringify(logSubj.pain))
check('  取的是最新两条（且保持时间先后）', logSubj.pain.join('|') === '09-12 较新的卡点|09-16 最新的卡点', JSON.stringify(logSubj.pain))
check('  最老的一条不再被当卡点', !logSubj.pain.some((p) => p.includes('最老的')), JSON.stringify(logSubj.pain))
check('进度仍取段首（优先级列表语义未变）', logSubj.progress.join('|') === '总述在前|近况在后', JSON.stringify(logSubj.progress))
check('  单条卡点仍能取到（取尾不吞短段）', plan.analyzeSubject({ name: 'x', dir: ROOT, archiveRaw: archiveOf(TODAY, 'x'), taskRaw: undefined, today: TODAY }).pain.length === 1)
const logBoard = plan.buildBoard(ROOT, { today: TODAY, subjects: [logSubj], planRaw: undefined })
check('看板里出现了最新卡点', logBoard.includes('09-16 最新的卡点'), logBoard.split('\n').find((l) => l.includes('卡点 ›')))
check('  看板里没有最老的卡点', !logBoard.includes('09-04 最老的卡点'))

// ── ④ 总规划.md 写入守护 ────────────────────────────────────────────────────
console.log('\n④ 总规划.md 写入守护')
const basis = subjects.map((s) => `${s.name}=${s.archiveStamp}`).join('｜')
const goodPlan = `# 总规划（周看板）

生成: ${TODAY}
本次修订: 首次制定
数据基准: ${basis}

## 一、本周硬约束
- 今晚英语入学考试

## 二、每科 MVE（每科 ≤3 条）
### 英语
- [ ] 考前暖耳 15 分钟
### 网安
- [ ] 补交上次未完成的 sqli 练习

## 三、漂移与风险
- 网安档案已 3 天未更新

## 四、下周预备
- 英语启动 1-1-1 长期线
`
check('合法计划通过', plan.validatePlan(goodPlan, { today: TODAY, subjects }) === undefined, plan.validatePlan(goodPlan, { today: TODAY, subjects }))

const noGen = goodPlan.replace(`生成: ${TODAY}\n`, '')
check('缺「生成」被拒', /必须含一行「生成/.test(plan.validatePlan(noGen, { today: TODAY, subjects }) ?? ''))
const wrongDate = goodPlan.replace(`生成: ${TODAY}`, '生成: 2020-01-01')
check('「生成」日期不对被拒', /先核对当前日期/.test(plan.validatePlan(wrongDate, { today: TODAY, subjects }) ?? ''))

const badBasis = goodPlan.replace(basis, basis.replace(/=.*?(?=｜|$)/, '=no-such-date'))
const badBasisMsg = plan.validatePlan(badBasis, { today: TODAY, subjects })
check('基准与磁盘不符被拒', /数据基准与磁盘现状不符/.test(badBasisMsg ?? ''), badBasisMsg)
check('  拒绝信息里带上正确基准行（可直接照抄）', (badBasisMsg ?? '').includes(`数据基准: ${basis}`))
const missingBasis = goodPlan.replace(/数据基准: .*\n/, '')
check('缺基准行被拒', /必须含一行数据基准/.test(plan.validatePlan(missingBasis, { today: TODAY, subjects }) ?? ''))
const basisNoSubject = goodPlan.replace(basis, basis.split('｜')[0])
check('漏掉一个科目的基准被拒', /数据基准与磁盘现状不符/.test(plan.validatePlan(basisNoSubject, { today: TODAY, subjects }) ?? ''))

for (const marker of ['硬约束', 'MVE', '漂移', '下周预备']) {
  const msg = plan.validatePlan(goodPlan.replace(marker, 'XX'), { today: TODAY, subjects }) ?? ''
  check(`缺「${marker}」二级标题被拒`, msg.includes(`缺少「## ${marker}」`), msg)
}
check('  正文里出现关键词但没标题 → 也拒（旧实现只看子串）', /缺少「## /.test(plan.validatePlan(goodPlan.replace(/^## .*$/gm, ''), { today: TODAY, subjects }) ?? ''))

const fourMve = goodPlan.replace(
  '### 英语\n- [ ] 考前暖耳 15 分钟',
  '### 英语\n- [ ] a\n- [ ] b\n- [ ] c\n- [ ] d',
)
const fourMsg = plan.validatePlan(fourMve, { today: TODAY, subjects })
check('每科 4 条 MVE 被拒', /超过每科 3 条上限/.test(fourMsg ?? ''), fourMsg)
check('  拒绝信息点名是哪一科', (fourMsg ?? '').includes('英语'))
const skipSubject = goodPlan.replace('### 网安\n- [ ] 补交上次未完成的 sqli 练习\n', '')
check('漏掉一个科目的小节被拒', /MVE 缺少这些科目的小节：网安/.test(plan.validatePlan(skipSubject, { today: TODAY, subjects }) ?? ''))
const noSub = goodPlan.replace('## 二、每科 MVE（每科 ≤3 条）\n### 英语\n- [ ] 考前暖耳 15 分钟\n### 网安\n- [ ] 补交上次未完成的 sqli 练习', '## 二、每科 MVE\n- [ ] 只有一条总任务')
check('MVE 未按科目分小节被拒', /必须按科目分小节/.test(plan.validatePlan(noSub, { today: TODAY, subjects }) ?? ''))
check('MVE 全部为空 → 放行（不再逼模型编一条）', plan.validatePlan(goodPlan.replace(/- \[ \] .*\n/g, ''), { today: TODAY, subjects }) === undefined)
check('无科目时拒绝写计划', /未发现任何科目/.test(plan.validatePlan(goodPlan, { today: TODAY, subjects: [] }) ?? ''))
check('超行数上限被拒', /超过 120 行上限/.test(plan.validatePlan(`${goodPlan}${'\n'.repeat(200)}`, { today: TODAY, subjects }) ?? ''))
check('3 条已完成计入每科 3 条上限 → 放行', plan.validatePlan(goodPlan.replace('- [ ] 考前暖耳 15 分钟', '- [x] a\n- [x] b\n- [x] c'), { today: TODAY, subjects }) === undefined)
check('  4 条已完成同样超限被拒', /超过每科 3 条上限/.test(plan.validatePlan(goodPlan.replace('- [ ] 考前暖耳 15 分钟', '- [x] a\n- [x] b\n- [x] c\n- [x] d'), { today: TODAY, subjects }) ?? ''))
check('  有序列表 1. [ ] 也计入上限', /超过每科 3 条上限/.test(plan.validatePlan(goodPlan.replace('- [ ] 考前暖耳 15 分钟', '1. [ ] a\n2. [ ] b\n3. [ ] c\n4. [ ] d'), { today: TODAY, subjects }) ?? ''))
check('  复选框写到「漂移与风险」里被拒', /不在 MVE 区块里/.test(plan.validatePlan(goodPlan.replace('## 三、漂移与风险\n', '## 三、漂移与风险\n- [ ] 偷渡的复选框\n'), { today: TODAY, subjects }) ?? ''))
check('  小节标题带修饰（### 英语哦哦哦）不再蒙混通过', plan.validatePlan(goodPlan.replace('### 英语', '### 英语哦哦哦'), { today: TODAY, subjects }) !== undefined)
check('  给没有档案的科目排 MVE 被拒', /不属于本工作区/.test(plan.validatePlan(goodPlan.replace('### 网安', '### 美术\n- [ ] x\n### 网安'), { today: TODAY, subjects }) ?? ''))
check('含 NUL 的计划被拒', /控制字符/.test(plan.validatePlan(`${goodPlan}\u0000`, { today: TODAY, subjects }) ?? ''))

// ── ④d 反过度调整：修订理由 / 反冗余 / 该不该动笔 ──────────────────────────
console.log('\n④d 反过度调整（治「过于积极改规划」）')
{
  const noRev = goodPlan.replace(`本次修订: 首次制定\n`, '')
  check('缺「本次修订」被拒', /必须含一行「本次修订/.test(plan.validatePlan(noRev, { today: TODAY, subjects }) ?? ''))
  check('修订理由不在枚举里被拒', /不是合法理由/.test(plan.validatePlan(goodPlan.replace('首次制定', '随便改改'), { today: TODAY, subjects }) ?? ''))
  check('磁盘已有计划时再写「首次制定」被拒', /已经有总规划了/.test(plan.validatePlan(goodPlan, { today: TODAY, subjects, existing: goodPlan }) ?? ''))
  check('  改写「基准刷新」放行', plan.validatePlan(goodPlan.replace('首次制定', '基准刷新'), { today: TODAY, subjects, existing: goodPlan }) === undefined)
  check('  首次制定 + 磁盘无计划 → 放行', plan.validatePlan(goodPlan, { today: TODAY, subjects, existing: undefined }) === undefined)

  const dup = goodPlan.replace('### 网安\n- [ ] 补交上次未完成的 sqli 练习', '### 网安\n- [ ] 考前暖耳 15 分钟')
  check('重复条目被拒（同一件事只写一条）', /重复条目/.test(plan.validatePlan(dup, { today: TODAY, subjects }) ?? ''))

  const fatNext = goodPlan.replace('## 四、下周预备\n- 英语启动 1-1-1 长期线\n', `## 四、下周预备\n${'- 预备项\n'.repeat(6)}`)
  check('「下周预备」超 5 条被拒', /超过 5 条上限/.test(plan.validatePlan(fatNext, { today: TODAY, subjects }) ?? ''))

  // 代码判定的「该不该动笔」，默认必须是不动
  const vSameDay = plan.replanVerdict({ today: TODAY, subjects, planRaw: goodPlan })
  check('今天刚写的计划 → planAction=none（默认不动）', vSameDay.planAction === 'none', JSON.stringify(vSameDay.reasons))
  const boardFresh = plan.buildBoard(ROOT, { today: TODAY, subjects, planRaw: goodPlan, planName: '总规划.md' })
  check('  看板明说「一个字都不要改」', boardFresh.includes('一个字都不要改'))
  check('  看板不再有无条件的漂移催促', !boardFresh.includes('都要在下一次计划里有明确交代。'))

  const staleBasis = plan.validatePlan.bind(null)
  void staleBasis
  const shifted = subjects.map((s) => (s.name === '英语' ? { ...s, archiveStamp: daysAgo(1) } : s))
  const vBasis = plan.replanVerdict({ today: TODAY, subjects: shifted, planRaw: goodPlan })
  check('只过期了基准 → planAction=refresh（只改两行）', vBasis.planAction === 'refresh', JSON.stringify(vBasis.reasons))

  const lastWeek = goodPlan.replace(`生成: ${TODAY}`, `生成: ${daysAgo(9)}`)
  const vWeek = plan.replanVerdict({ today: TODAY, subjects, planRaw: lastWeek })
  check('跨周 → planAction=rewrite', vWeek.planAction === 'rewrite' && /跨周/.test(vWeek.reasons.join('')), JSON.stringify(vWeek.reasons))
  const vNone = plan.replanVerdict({ today: TODAY, subjects, planRaw: undefined })
  check('尚无计划 → rewrite', vNone.planAction === 'rewrite')
  check('weekStart 以周一为始', plan.weekStart('2026-09-13') === '2026-09-07', plan.weekStart('2026-09-13'))
}

// ── ④e 变更记录（流水）+ 其余增长区块封顶 ──────────────────────────────────
console.log('\n④e 变更记录（事件流水）+ 各区块封顶')
{
  const entry = (d, kind, text) => `- ${d} ${kind}：${text}`
  const goodNotice = `# 变更记录\n\n生成: ${TODAY}\n\n${entry(TODAY, '计划', '跨周重排，英语换 MVE')}\n${entry(TODAY, '全局', '本周三考试，各科减量')}\n`
  check('合法记录通过', plan.validateNotice(goodNotice, { today: TODAY }) === undefined, plan.validateNotice(goodNotice, { today: TODAY }))
  check('缺「生成」被拒', /必须含一行「生成/.test(plan.validateNotice(goodNotice.replace(`生成: ${TODAY}\n`, ''), { today: TODAY }) ?? ''))
  check('一条都没有被拒', /至少要有一条/.test(plan.validateNotice(`# 变更记录\n\n生成: ${TODAY}\n`, { today: TODAY }) ?? ''))
  check('条目缺日期/格式不对被拒', /要写成「- YYYY-MM-DD 类型：一句话」/.test(plan.validateNotice(`# 变更记录\n\n生成: ${TODAY}\n\n- 改了计划\n`, { today: TODAY }) ?? ''))
  check('记录里放复选框被拒', /不要放任务复选框/.test(plan.validateNotice(`${goodNotice}- [ ] 英语做 1 套卷\n`, { today: TODAY }) ?? ''))
  check('超 10 条被拒', /超过 10 条上限/.test(plan.validateNotice(`# 变更记录\n\n生成: ${TODAY}\n\n${`${entry(TODAY, '计划', 'x')}\n`.repeat(11)}`, { today: TODAY }) ?? ''))
  check('超 1024 字节被拒', /1024 字节上限/.test(plan.validateNotice(`${goodNotice}\n${'x'.repeat(1200)}\n`, { today: TODAY }) ?? ''))

  const fatConstraint = goodPlan.replace('## 一、本周硬约束\n- 今晚英语入学考试', `## 一、本周硬约束\n${'- 约束\n'.repeat(6)}`)
  check('「本周硬约束」超 5 条被拒', /超过 5 条上限/.test(plan.validatePlan(fatConstraint, { today: TODAY, subjects }) ?? ''))
  const fatRisk = goodPlan.replace('## 三、漂移与风险\n- 网安档案已 3 天未更新', `## 三、漂移与风险\n${'- 风险\n'.repeat(7)}`)
  check('「漂移与风险」超 6 条被拒', /超过 6 条上限/.test(plan.validatePlan(fatRisk, { today: TODAY, subjects }) ?? ''))

  const withNotice = plan.buildBoard(ROOT, { today: TODAY, subjects, planRaw: goodPlan, noticeRaw: goodNotice, planName: '总规划.md' })
  check('看板报出记录状态', withNotice.includes('变更记录：最新一条'), withNotice.split('\n').find((l) => l.includes('变更记录')))
  check('  最新一条日期解析正确', plan.newestLogEntryDate(goodNotice) === TODAY, plan.newestLogEntryDate(goodNotice))

  // 读侧一致性检查：改过计划却没记一条 —— 检测放在读侧，比指望写入时不忘更可靠
  const missing = plan.buildBoard(ROOT, { today: TODAY, subjects, planRaw: goodPlan, planName: '总规划.md' })
  check('计划在但记录全无 → 看板报「变更记录缺失」', missing.includes('变更记录缺失'))
  const behind = plan.buildBoard(ROOT, {
    today: TODAY,
    subjects,
    planRaw: goodPlan,
    noticeRaw: `# 变更记录\n\n生成: ${TODAY}\n\n${entry(daysAgo(3), '计划', '旧改动')}\n`,
    planName: '总规划.md',
  })
  check('计划比记录新 → 看板报「变更记录没跟上」', behind.includes('变更记录没跟上'), behind.split('\n').find((l) => l.includes('没跟上')))
  const inSync = plan.buildBoard(ROOT, {
    today: TODAY,
    subjects,
    planRaw: goodPlan,
    noticeRaw: `# 变更记录\n\n生成: ${TODAY}\n\n${entry(TODAY, '计划', '刚改的')}\n`,
    planName: '总规划.md',
  })
  check('记录跟上了 → 不报警', !inSync.includes('没跟上') && !inSync.includes('缺失'))
}

// ★★ 2026-10-08 学员问「我的规划文档似乎也遇到了字数不够的问题」。
//    实测：总规划 4199B / 8192B = **51%**，字节预算用了一半 —— 可它**写不下**。
//    因为卡住它的是**封顶格子的条数**：硬约束 5/5、漂移 6/6、预备 5/5、网安 MVE 3/3，四个全满。
//    而"满了"这件事，`validatePlan` 只在**你写了第 N+1 条之后**才说 —— 动笔之前、看板上、
//    注入里**没有任何地方说**。于是每补一件事都要"试一次、被拒、删一条、再试一次"。
//    跟档案那边（archiveHygiene）**同一个形状**：规定写在 persona 里、没有代码在查。
console.log('\n④i 计划卫生：封顶格子满了要**在动笔前**说（治「规划总是写不下」）')
{
  const mk = (constraints, risks, next, mve) =>
    [
      '# 总规划（周看板）', '',
      `生成: ${TODAY}`, '本次修订: 基准刷新',
      `数据基准: ${subjects.map((s) => `${s.name}=${s.archiveStamp}`).join('｜')}`, '',
      '## 一、本周硬约束',
      ...Array.from({ length: constraints }, (_, i) => `- 硬约束第 ${i + 1} 条`), '',
      '## 二、每科 MVE（每科 ≤3 条）', '### 英语',
      ...Array.from({ length: mve }, (_, i) => `- [ ] MVE 第 ${i + 1} 条`),
      ...subjects.filter((s) => s.name !== '英语').map((s) => `### ${s.name}\n本周无 MVE`), '',
      '## 三、漂移与风险',
      ...Array.from({ length: risks }, (_, i) => `- 风险第 ${i + 1} 条`), '',
      '## 四、下周预备',
      ...Array.from({ length: next }, (_, i) => `- 预备第 ${i + 1} 条`), '',
    ].join('\n')

  // ① 纯函数：算出的占用必须与真值一致
  const h = plan.planHygiene(mk(5, 6, 5, 3))
  check('planHygiene 数出硬约束 5/5、漂移 6/6、预备 5/5', 
    h.blocks.map((b) => `${b.name}${b.used}/${b.cap}`).join() === '硬约束5/5,漂移6/6,预备5/5',
    h.blocks.map((b) => `${b.name}${b.used}/${b.cap}`).join())
  check('  数出 MVE 英语 3/3', h.mve.filter((m) => m.name === '英语').map((m) => `${m.used}/${m.cap}`).join() === '3/3', JSON.stringify(h.mve))
  check('  这些格子（硬约束/漂移/预备 + MVE 英语）全为真，其余科目不算满',
    h.blocks.every((b) => b.full) && h.mve.filter((m) => m.name === '英语').every((m) => m.full) && h.mve.filter((m) => m.name !== '英语').every((m) => !m.full),
    JSON.stringify(h.mve))
  check('  报告里同时给出字节占用（证明"不是字节不够"）', h.bytes > 0 && h.maxBytes === 8192 && h.bytes < h.maxBytes, `${h.bytes}/${h.maxBytes}`)

  // ② 关键：n == cap（正好满）时 validatePlan **不报**，但 planHygiene 必须报
  const exactlyFull = mk(5, 6, 5, 3)
  check('正好满时 validatePlan 放行（这就是"没有地方说"的根源）',
    plan.validatePlan(exactlyFull, { today: TODAY, subjects, existing: exactlyFull }) === undefined)
  const v = plan.verdictOf === undefined ? undefined : undefined
  // ③ 看板：满了必须报，且说清"要加就得先删"、并把字节数一起给出
  const fullBoard = plan.buildBoard(ROOT, { today: TODAY, subjects, planRaw: exactlyFull, planName: '总规划.md' })
  check('看板报出「格子满了」', fullBoard.includes('格子满了'), fullBoard.split('\n').find((l) => l.includes('格子')))
  check('  点出是哪几个格子（硬约束/漂移/预备/MVE）',
    ['硬约束', '漂移', '预备', 'MVE 英语'].every((k) => fullBoard.split('\n').find((l) => l.includes('格子满了'))?.includes(k) === true))
  check('  说清「要加一条就得先删/并一条」', fullBoard.includes('要加一条就得先删'))
  check('  同时给出字节数（让"不是字节不够"可核对）', /不是字节不够：\d+\/8192/.test(fullBoard))
  check('  这几行在尾部（永不截断，所以一定看得到）',
    fullBoard.indexOf('格子满了') > fullBoard.indexOf('■ 计划自身'))
  check('  可照抄的基准行仍在最后', fullBoard.trimEnd().endsWith(`数据基准: ${subjects.map((s) => `${s.name}=${s.archiveStamp}`).join('｜')}`))

  // ④ 干净时**零噪音**（同 renderHygiene 的纪律：只在真有问题时说话）
  const roomy = mk(2, 2, 2, 1)
  const roomyBoard = plan.buildBoard(ROOT, { today: TODAY, subjects, planRaw: roomy, planName: '总规划.md' })
  check('没满时**不出现**这句（零噪音，否则天天喊狼来了）', !roomyBoard.includes('格子满了'), roomyBoard.split('\n').find((l) => l.includes('格子')) ?? '(无)')
  check('  但字节占用仍然报（它是有用信息，不是警告）', /变更记录|生成 \d{4}-\d{2}-\d{2}/.test(roomyBoard))

  // ⑤ 边界：4/5 不算满（差一格时不能说"满了"，否则模型会白删一条）
  const almost = mk(4, 5, 4, 2)
  const almostBoard = plan.buildBoard(ROOT, { today: TODAY, subjects, planRaw: almost, planName: '总规划.md' })
  check('差一格（4/5）**不算满** —— 不能喊狼来了让模型白删一条', !almostBoard.includes('格子满了'))

  // ⑥ 没有计划时不许报格子（否则是凭空捏造的警告）
  const noPlan = plan.buildBoard(ROOT, { today: TODAY, subjects, planRaw: undefined, planName: '总规划.md' })
  check('还没有计划时不报格子', !noPlan.includes('格子满了'))

  // ⑦ 变更记录：带上体量，快满时提前说（学员 2026-10-08 实测被拒：1124 > 1024）
  //    夹具要**真的过阈值**：第一版用 7 条 ×90 = 827B = 81%，低于 85% 的警戒线，
  //    于是那条断言红的 —— **是夹具不够大，不是代码不警告**（先读完整失败信息再改代码）。
  const mkEntry = (d, kind, text) => `- ${d} ${kind}：${text}`
  const fatNotice = `# 变更记录\n\n生成: ${TODAY}\n\n${`${mkEntry(TODAY, '全局', 'x'.repeat(100))}\n`.repeat(8)}`
  const noticeBoard = plan.buildBoard(ROOT, { today: TODAY, subjects, planRaw: roomy, noticeRaw: fatNotice, planName: '总规划.md' })
  check('  夹具确实超了警戒线（前置）', Buffer.byteLength(fatNotice, 'utf8') > 1024 * 0.85 && Buffer.byteLength(fatNotice, 'utf8') < 1024,
    `${Buffer.byteLength(fatNotice, 'utf8')}B`)
  check('  变更记录体积被报出来（例如 878/1024 字节）', /\d+\/1024 字节/.test(noticeBoard), noticeBoard.split('\n').find((l) => l.includes('变更记录：')))
  check('  快满时提前警告「先删最早的」', noticeBoard.includes('快满了'), noticeBoard.split('\n').find((l) => l.includes('快满')))
  check('  还很空时不警告',
    !plan.buildBoard(ROOT, { today: TODAY, subjects, planRaw: roomy, noticeRaw: `# 变更记录\n\n生成: ${TODAY}\n\n${mkEntry(TODAY, '计划', '刚改的')}\n`, planName: '总规划.md' }).includes('快满了'))
}

// 闭环：看板给出的基准行直接照抄即可通过 —— 模型照做就必然合法
console.log('\n④b 闭环：照抄看板基准行即可通过')
const copied = goodPlan.replace(/数据基准: .*/, board.split('\n').find((l) => l.startsWith('数据基准: ')))
check('照抄看板基准行 → 通过', plan.validatePlan(copied, { today: TODAY, subjects }) === undefined, plan.validatePlan(copied, { today: TODAY, subjects }))
check('科目档案变更后旧计划立刻失效', plan.validatePlan(copied, { today: TODAY, subjects: subjects.map((s) => (s.name === '英语' ? { ...s, archiveStamp: daysAgo(1) } : s)) }) !== undefined)

// ── ⑤ 本周任务.md 写入守护 ─────────────────────────────────────────────────
console.log('\n⑤ 本周任务.md 写入守护')
const engStamp = eng.archiveStamp
const goodTask = `# 本周任务（英语）\n\n生成: ${TODAY}\n依据: 学习档案 更新于 ${engStamp}\n\n- [ ] 考前暖耳 15 分钟\n`
const taskOpts = { today: TODAY, subjectName: '英语', archiveStamp: engStamp }
check('合法任务通过', plan.validateTask(goodTask, taskOpts) === undefined, plan.validateTask(goodTask, taskOpts))
check('缺「依据」被拒', /必须含一行「依据/.test(plan.validateTask(`# 本周任务\n\n生成: ${TODAY}\n\n- [ ] a\n`, taskOpts) ?? ''))
const staleTask = `# 本周任务\n\n生成: ${TODAY}\n依据: 学习档案 更新于 ${daysAgo(9)}\n\n- [ ] a\n`
check('依据日期与档案不符被拒', /基准对不上/.test(plan.validateTask(staleTask, taskOpts) ?? ''), plan.validateTask(staleTask, taskOpts))
check('4 条任务被拒', /超过每科 3 条上限/.test(plan.validateTask(`# 本周任务\n\n生成: ${TODAY}\n依据: 学习档案 更新于 ${engStamp}\n\n- [ ] a\n- [ ] b\n- [ ] c\n- [ ] d\n`, taskOpts) ?? ''))
check('0 条任务被拒', /至少要有一条/.test(plan.validateTask(`# 本周任务\n\n生成: ${TODAY}\n依据: 学习档案 更新于 ${engStamp}\n`, taskOpts) ?? ''))
check('超 2048 字节被拒', /超过 2048 字节上限/.test(plan.validateTask(`${goodTask}\n${'x'.repeat(3000)}`, taskOpts) ?? ''))
// 「生成」日期错有两种，理由不同：未来日期是抄错日历，过于陈旧是任务过期。
// （旧断言只查前一种文案，而 2020 年那种走的是后一种分支——2026-09-21 随 TASK_MAX_AGE_DAYS 一并改。）
check('日期不对被拒（未来日期）', /先核对当前日期/.test(plan.validateTask(goodTask.replace(`生成: ${TODAY}`, `生成: ${plan.studyDate(new Date(Date.now() + 3 * 86400000))}`), taskOpts) ?? ''))
check('日期不对被拒（超出任务生命期）', /超过任务生命期/.test(plan.validateTask(goodTask.replace(TODAY, '2020-01-01'), taskOpts) ?? ''))

// ── ⑥ 守护接线（apply 里真的挂上了吗） ──────────────────────────────────────
console.log('\n⑥ 守护接线：写错文件真的会被拦')
{
  const guards = []
  plan.apply({ on: () => {}, get: (n) => (n === 'tools' ? { guard: (f) => guards.push(f) } : undefined) }, { root: ROOT })
  check('plan-core 挂了一个 guard', guards.length === 1)
  const call = (name, file_path, extra) => guards[0]({ name, arguments: { file_path, ...extra } })
  check('  写合法总规划 → 放行', call('write', join(ROOT, '总规划.md'), { content: goodPlan }) === undefined)
  check('  写非法总规划 → 拦下', /数据基准/.test(call('write', join(ROOT, '总规划.md'), { content: missingBasis }) ?? ''))
  check('  写合法本周任务 → 放行', call('write', join(ROOT, '英语', '本周任务.md'), { content: goodTask }) === undefined)
  check('  写依据过期的本周任务 → 拦下', /基准对不上/.test(call('write', join(ROOT, '英语', '本周任务.md'), { content: staleTask }) ?? ''))
  check('  把本周任务写进非科目目录 → 拦下', /不是一个科目/.test(call('write', join(ROOT, '数学', '本周任务.md'), { content: goodTask }) ?? ''))
  check('  无关文件不插手', call('write', join(ROOT, '随手笔记.md'), { content: 'x' }) === undefined)
  check('  读工具不插手', call('read', join(ROOT, '总规划.md'), {}) === undefined)
}

// ── ⑦ companion-core：任务下发只读、只许勾选 ────────────────────────────────
console.log('\n⑦ companion-core：本周任务只读（只许勾选）')
check('write 整篇重写被拒', /只读文件/.test(core.validateTaskWrite('write', { content: 'x' }) ?? ''))
check('edit 勾选 [ ]→[x] 放行', core.validateTaskWrite('edit', { old_string: '- [ ] 英语任务甲', new_string: '- [x] 英语任务甲' }) === undefined)
check('edit 取消勾选 [x]→[ ] 放行', core.validateTaskWrite('edit', { old_string: '- [X] 英语任务甲', new_string: '- [ ] 英语任务甲' }) === undefined)
check('edit 改任务文字被拒', /不得修改任务文字/.test(core.validateTaskWrite('edit', { old_string: '- [ ] 英语任务甲', new_string: '- [ ] 英语任务甲（改成别的）' }) ?? ''))
check('edit 顺手勾选又改字被拒', /不得修改任务文字/.test(core.validateTaskWrite('edit', { old_string: '- [ ] 甲', new_string: '- [x] 乙' }) ?? ''))
check('edit 删条目被拒', /不得修改任务文字/.test(core.validateTaskWrite('edit', { old_string: '- [ ] 甲\n', new_string: '' }) ?? ''))
check('edit 参数不全 → 放行给 edit 自己报错', core.validateTaskWrite('edit', {}) === undefined)

console.log('\n⑦b companion-core：任务注入')
{
  const guards = []
  const handlers = {}
  const ctx = { on: (ev, fn) => { handlers[ev] = fn }, get: (n) => (n === 'tools' ? { guard: (f) => guards.push(f) } : undefined) }
  core.apply(ctx, {})
  const cwd = join(ROOT, '网安')
  const decision = { kind: 'proceed', messages: [] }
  const out = await handlers['agent/pre-step'](
    { agent: { id: 'test-agent', session: { header: { cwd } } }, step: 1, signal: { aborted: false } },
    async () => decision,
  )
  const texts = out.messages.map((m) => m.content[0].text).join('\n---\n')
  check('档案注入仍在（回归）', texts.includes('【伴学档案·自动注入】') && texts.includes('网安 进度要点一'))
  check('本周任务被注入', texts.includes('【本周任务·总规划下发】') && texts.includes('网安任务甲'))
  check('注入块写明只读与回执走档案', texts.includes('只读') && texts.includes('学习档案.md'))
  const step2 = await handlers['agent/pre-step'](
    { agent: { id: 'test-agent', session: { header: { cwd } } }, step: 2, signal: { aborted: false } },
    async () => decision,
  )
  check('step 2 不重复注入', step2.messages.length === 0)
  check('guard 里已接入任务文件校验', /只读文件/.test(guards[0]({ name: 'write', arguments: { file_path: join(cwd, '本周任务.md'), content: 'x' } }) ?? ''))
  check('  档案写入守护未被破坏（回归）', core.validateArchive(archiveOf(TODAY, 'x') + 'x'.repeat(9000), 60, 4096) !== undefined)
}

// ── ④c persona 模板回归：persona 里给模型看的模板，必须真的能被守护接受 ──────
// （这是整套设计最该防的失败模式：模型照 persona 做却被守护拒 —— 之前一条断言都没有）
console.log('\n④c persona 模板 ↔ 守护 闭环')
{
  // 0.1.7：预设声明在组合树里（不再有 agent.cordis.yml）。persona 文本由 YAML 解析器给出，
  // 它**已经**去掉了块标量的缩进——所以不能再像读原文那样补一次 `^ {6}` 剥离，否则模板
  // 会被多切掉一层，`validatePlan` 的报错会指向一个根本不存在的格式问题。
  const decl = declById('study-planner')
  const yml = personaPrefixOf(decl) ?? ''
  check('读到了 study-planner 的 persona', yml.length > 500, `${yml.length} 字符`)
  const blocks = [...yml.matchAll(/```\n([\s\S]*?)```/g)].map((m) => m[1])
  const planTpl = blocks.find((b) => b.includes('数据基准'))
  const taskTpl = blocks.find((b) => b.includes('依据: 学习档案 更新于'))
  check('从 persona 里抠出两个模板', planTpl !== undefined && taskTpl !== undefined, `blocks=${blocks.length}`)
  let n = 0
  const filled = planTpl
    .replace(/数据基准:.*/, plan.renderBasis(subjects))
    .replace(/生成: YYYY-MM-DD/, `生成: ${TODAY}`)
    .replace(/^- \[ \] …$/gm, () => `- [ ] 占位任务${(n += 1)}`)
  const v1 = plan.validatePlan(filled, { today: TODAY, subjects })
  check('  计划模板逐字填完 → 通过', v1 === undefined, v1)
  const engStampNow = subjects.find((s) => s.name === '英语').archiveStamp
  const tFilled = taskTpl
    .replace(/生成: YYYY-MM-DD/, `生成: ${TODAY}`)
    .replace(/依据: 学习档案 更新于 YYYY-MM-DD/, `依据: 学习档案 更新于 ${engStampNow}`)
    .replace(/^- \[ \] …$/gm, '- [ ] 占位任务')
  const v2 = plan.validateTask(tFilled, { today: TODAY, subjectName: '英语', archiveStamp: engStampNow })
  check('  任务模板逐字填完 → 通过', v2 === undefined, v2)

  // ★ 2026-10-08：persona 必须**解释「格子满了」该怎么办**，否则看板报了警告、
  //   模型却不知道那是"要加就得先删"。光有代码警告、没有处置说明 = 只报错不给路。
  check('persona 写明"先看格子再动笔"', /先看.{0,4}格子.{0,4}再动笔/.test(yml), yml.includes('格子') ? '(有格子字样但措辞不同)' : '(完全没提格子)')
  check('  写明"格子满了要先删/并一条"', /先删掉或并掉一条|要加一条就得先删/.test(yml))
  check('  写明"它跟字节数无关"（否则会被"还能写很多字"骗）', /跟字节数无关|不是字节不够/.test(yml))
  check('  写明处置顺序（先定拿掉哪条，再写新的）', /先定拿掉哪条|先定拿掉/.test(yml))
  // 反面：不许留下模板字面量残渣（第一版写成了 `≤{5{'}'}`，U+FFFD 检查抓不到这种）
  check('  没有模板字面量残渣（如 {5{\'\'}}）', !/\{\d+\{/.test(yml), (/\{\d+\{/.exec(yml) ?? [''])[0])
}

// ── ④f 科目变更：看板指令与写守护必须给出**同一个**结论 ──────────────────────
// 真实数据复现过的死锁：新增 ST\C / ST\Python 后，计划里只有网安/英语两个 MVE 小节 →
// 裁决停在 `refresh`，看板于是写「其余内容原样保留，不要重写」；可 `validatePlan` 又要求
// 每个科目都有自己的「### 科目名」小节。**模型照看板做必被拒，想补齐小节又违反看板。**
// 这一组钉住那个死锁：裁决、看板文字、写守护三者必须一致。
console.log('\n④f 科目变更 ↔ 写入守护 闭环（治「照看板做必被拒」）')
{
  const root = mkdtempSync(join(tmpdir(), 'plan-newsubj-'))
  for (const name of ['网安', '英语']) {
    mkdirSync(join(root, name))
    writeFileSync(join(root, name, '学习档案.md'), archiveOf(TODAY, name))
  }
  // 修订理由必须与「磁盘上已有没有计划」相符——这是第二道闸（同一天不能谎称「首次制定」）。
  const mkPlan = (names, revision = '首次制定') =>
    `# 总规划（周看板）\n\n生成: ${TODAY}\n本次修订: ${revision}\n数据基准: ${names.map((n) => `${n}=${TODAY}`).join('｜')}\n\n` +
    `## 一、本周硬约束\n- 约束一\n\n## 二、每科 MVE（每科 ≤3 条）\n` +
    names.map((n) => `### ${n}\n- [ ] ${n}本周任务一\n`).join('\n') +
    `\n## 三、漂移与风险\n- 风险一\n\n## 四、下周预备\n- 预备一\n`

  const twoSubjPlan = mkPlan(['网安', '英语'])
  const twoSubjects = plan.survey(root, TODAY)
  check('夹具前提：两科计划是合法的', plan.validatePlan(twoSubjPlan, { today: TODAY, subjects: twoSubjects }) === undefined, plan.validatePlan(twoSubjPlan, { today: TODAY, subjects: twoSubjects }))

  // 新增第三科
  mkdirSync(join(root, 'C'))
  writeFileSync(join(root, 'C', '学习档案.md'), archiveOf(TODAY, 'C'))
  const threeSubjects = plan.survey(root, TODAY)
  check('新增 C 后被自动发现', threeSubjects.map((s) => s.name).includes('C'))

  const v = plan.replanVerdict({ today: TODAY, subjects: threeSubjects, planRaw: twoSubjPlan })
  const board = plan.buildBoard(root, { today: TODAY, subjects: threeSubjects, planRaw: twoSubjPlan })
  const reasonLine = board.split('\n').find((l) => l.includes('需要重排')) ?? ''
  check('裁决升级为 rewrite（不再是 refresh）', v.planAction === 'rewrite', v.planAction)
  check('  理由点明「科目变更」', v.reasons.join('；').includes('科目变更'), v.reasons.join('；'))
  check('  理由点名缺少 C', v.reasons.join('；').includes('缺少 C'))
  check('  仍保留原有的基准过期理由', v.reasons.join('；').includes('数据基准过期'))
  // 理由只讲事实：动作是 rewrite 时，不能夹带「只刷新基准行 / 不要重写」这类相反指令
  check('  理由里不带相反的动作指令', !/只刷新基准行|不要重写|一个字都不要改/.test(v.reasons.join('；')), v.reasons.join('；'))

  // 模型读到的文字：这一条是整组的重点——它必须与守护同向
  check('看板说「需要重排」', reasonLine.length > 0)
  check('  渲染出来的「原因」里也没有相反指令', !/只刷新基准行|不要重写|一个字都不要改/.test(reasonLine), reasonLine)
  check('看板**不再**说「不要重写」', !board.includes('其余内容原样保留，不要重写'))
  check('  也不再出现「一个字都不要改」', !board.includes('一个字都不要改'))

  // 守护侧：只刷新基准仍然被拒 —— 这是对的，因为看板已要求重排（不再互相矛盾）。
  // 这里刻意用旧口径的「基准刷新」：它正是当初看板 refresh 分支指示模型做的那件事。
  const refreshed = twoSubjPlan
    .replace(/^数据基准:.*$/m, plan.renderBasis(threeSubjects))
    .replace(/^本次修订:.*$/m, '本次修订: 基准刷新')
  const rejected = plan.validatePlan(refreshed, { today: TODAY, subjects: threeSubjects, existing: twoSubjPlan })
  check('只刷新基准仍被守护拒绝（补齐 C 才能过）', typeof rejected === 'string' && rejected.includes('缺少这些科目的小节：C'), rejected)

  // 闭环：按看板重排、补齐 C 的小节后必须能通过
  const fixed = mkPlan(['网安', '英语', 'C'], '科目变更')
  const fixedWhy = plan.validatePlan(fixed, { today: TODAY, subjects: threeSubjects, existing: twoSubjPlan })
  check('补齐 C 小节后 → 通过（闭环成立）', fixedWhy === undefined, fixedWhy)

  // 反过度调整不能被这次修复破坏：科目齐了、基准对了，就还是「不要动」
  const vNone = plan.replanVerdict({ today: TODAY, subjects: threeSubjects, planRaw: fixed })
  check('科目齐 + 基准对 → 仍回到 none（没把反冗余治坏）', vNone.planAction === 'none', `${vNone.planAction}：${vNone.reasons.join('；')}`)
  const boardNone = plan.buildBoard(root, { today: TODAY, subjects: threeSubjects, planRaw: fixed })
  check('  看板仍说「一个字都不要改」', boardNone.includes('一个字都不要改'))

  // 反向：科目被删掉后，计划里的小节成了多余 → 同样必须重排
  const onlyOne = plan.survey(mkdtempSync(join(tmpdir(), 'plan-onlyone-')), TODAY)
  check('空目录 → 0 科目（前置）', onlyOne.length === 0)
  const vExtra = plan.replanVerdict({ today: TODAY, subjects: twoSubjects.filter((s) => s.name === '网安'), planRaw: twoSubjPlan })
  check('科目减少 → rewrite', vExtra.planAction === 'rewrite', vExtra.planAction)
  check('  理由点明「多出 英语」', vExtra.reasons.join('；').includes('多出 英语'), vExtra.reasons.join('；'))

  // planSubjectHeadings：只认 MVE 区里的小节，且与 validatePlan 同口径
  const withStray = twoSubjPlan.replace('## 三、漂移与风险', '## 三、漂移与风险\n### 不该算科目\n- 它在 MVE 区之外\n')
  check('planSubjectHeadings：只扫 MVE 区', JSON.stringify(plan.planSubjectHeadings(withStray)) === JSON.stringify(['网安', '英语']), JSON.stringify(plan.planSubjectHeadings(withStray)))
  check('planSubjectHeadings：容忍标题尾部冒号', JSON.stringify(plan.planSubjectHeadings(twoSubjPlan.replace('### 网安', '### 网安：'))) === JSON.stringify(['网安', '英语']))
  check('planSubjectHeadings：无 MVE 节 → 空数组', JSON.stringify(plan.planSubjectHeadings('# 随便\n\n### 甲\n')) === '[]')
  check('planSubjectHeadings：非字符串 → 空数组', JSON.stringify(plan.planSubjectHeadings(undefined)) === '[]')

  rmSync(root, { recursive: true, force: true })
}

console.log('\n④g 任务时效：看板与勾选守护必须用同一个事实（依据）')
// 审计发现的第二处「两条路径各算各的」：
//   勾选守护 / validateTask 比的是 **依据**；而看板的"需重发"曾经比的是 **生成日期**。
// 漏掉的正是「当天先下发任务、之后档案又更新」——两个日期相等，看板以为一切正常，
// 可任务已经挂在旧档案版本上、连勾选都会被拒，而看板又不要求重发 → 又是一处死锁。
{
  const root = mkdtempSync(join(tmpdir(), 'plan-basis-'))
  mkdirSync(join(root, '英语'))
  writeFileSync(join(root, '英语', '学习档案.md'), archiveOf(TODAY, '英语'))
  // 任务：今天生成、依据也是今天 → 与档案一致，不该重发，勾选也该放行
  const freshTask = `# 本周任务\n\n生成: ${TODAY}\n依据: 学习档案 更新于 ${TODAY}\n\n- [ ] 任务甲\n`
  writeFileSync(join(root, '英语', '本周任务.md'), freshTask)
  const sFresh = plan.survey(root, TODAY)
  const vFresh = plan.replanVerdict({ today: TODAY, subjects: sFresh, planRaw: undefined })
  check('依据吻合 → 不要求重发', !vFresh.taskWork.some((t) => t.includes('英语')), JSON.stringify(vFresh.taskWork))
  check('  看板也不把它列成待办任务', !plan.buildBoard(root, { today: TODAY, subjects: sFresh, planRaw: undefined }).includes('英语（依据'))

  // 关键回归：生成日期是今天、依据却是旧的（档案后来更新过）→ 必须要求重发
  writeFileSync(join(root, '英语', '本周任务.md'), `# 本周任务\n\n生成: ${TODAY}\n依据: 学习档案 更新于 ${daysAgo(3)}\n\n- [ ] 任务甲\n`)
  const sStale = plan.survey(root, TODAY)
  check('survey 暴露了 task.basis', sStale[0].task.basis === daysAgo(3), JSON.stringify(sStale[0].task))
  const vStale = plan.replanVerdict({ today: TODAY, subjects: sStale, planRaw: undefined })
  check('生成=今天但依据过期 → 仍然要求重发（旧实现会漏掉这一种）', vStale.taskWork.some((t) => t.includes('需按新依据重发')), JSON.stringify(vStale.taskWork))
  check('  理由里写明两边的值', vStale.taskWork.some((t) => t.includes(daysAgo(3)) && t.includes(TODAY)), JSON.stringify(vStale.taskWork))

  // 闭环：看板说要重发，勾选也确实被拒 —— 两侧同向
  const { validateTaskWrite } = core
  const staleErr = validateTaskWrite('edit', { old_string: '- [ ] 任务甲', new_string: '- [x] 任务甲' }, { basis: daysAgo(3), archiveStamp: TODAY })
  check('同一状态下勾选被拒（看板与守护同向）', typeof staleErr === 'string' && staleErr.includes('旧依据已经作废'), staleErr)
  check('  而依据吻合时勾选放行', validateTaskWrite('edit', { old_string: '- [ ] 任务甲', new_string: '- [x] 任务甲' }, { basis: TODAY, archiveStamp: TODAY }) === undefined)
  check('  拿不到依据时不误伤（回落到纯勾选判定）', validateTaskWrite('edit', { old_string: '- [ ] 任务甲', new_string: '- [x] 任务甲' }, {}) === undefined)

  rmSync(root, { recursive: true, force: true })
}

console.log('\n④h 科目名含分隔符：看板必须提示改名（否则漂移永远消不掉）')
{
  const root = mkdtempSync(join(tmpdir(), 'plan-badname-'))
  mkdirSync(join(root, '数学｜一'))
  writeFileSync(join(root, '数学｜一', '学习档案.md'), archiveOf(TODAY, '数学'))
  const subs = plan.survey(root, TODAY)
  const basisLine = plan.renderBasis(subs)
  check('基准行确实含分隔符（前置）', basisLine.includes('数学｜一='))
  check('  parseBasis 读不回这个名字（这就是病灶）', plan.parseBasis(basisLine).get('数学｜一') === undefined)
  const board = plan.buildBoard(root, { today: TODAY, subjects: subs, planRaw: undefined })
  check('看板提示「写不进数据基准行」', board.includes('写不进数据基准行') && board.includes('数学｜一'))
  check('  并给出可执行的处置（改目录名）', board.includes('改成不含'))
  rmSync(root, { recursive: true, force: true })
}

rmSync(ROOT, { recursive: true, force: true })
console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
