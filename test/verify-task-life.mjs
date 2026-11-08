// verify-task-life.mjs — 「本周任务」的生命期回归（专治：看板说无需重发，可勾选却被拒）
// 用法：node verify-task-life.mjs
//
// 背景：validateTask 曾经用 `Math.abs(age) > 1` 校验「生成」日期，而同一份文件里
// 「本周任务已 7 天未换」的漂移线、以及 replanVerdict（只看「依据」）都把任务生命期当 7 天。
// 后果：一份生成于 2 天前、依据仍与档案一致的任务 —— 看板说「无需重发」、不报漂移，
// 科目侧一勾就被守护拒绝（勾选路径走的就是 validateTask）。学员看到的是「勾了不算数」。
// 与插件同目录的相对导入：测试要跟代码一起旅行。
import * as plan from '../plan-core.js'

let pass = 0
let fail = 0
function check(label, cond, extra) {
  if (cond) { pass += 1; console.log('  ✅', label) }
  else { fail += 1; console.log('  ❌', label, extra === undefined ? '' : `→ ${extra}`) }
}

const TODAY = plan.studyDate()
const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return plan.studyDate(d) }
const daysAhead = (n) => daysAgo(-n)
const ARCHIVE = daysAgo(3)

const task = (gen, basis = ARCHIVE, boxes = ['甲', '乙']) =>
  `# 本周任务（测试）\n\n生成: ${gen}\n依据: 学习档案 更新于 ${basis}\n\n${boxes.map((b) => `- [ ] ${b}`).join('\n')}\n`
const v = (text, archiveStamp = ARCHIVE) =>
  plan.validateTask(text, { today: TODAY, subjectName: '测试', archiveStamp })

console.log('\n① 依据未变时，「生成」宽限到 7 天（此前 1 天就拒 → 勾不动）')
for (const n of [0, 1, 2, 3, 6, 7]) {
  check(`  生成于 ${n} 天前 → 通过`, v(task(daysAgo(n))) === undefined, v(task(daysAgo(n))))
}
check('  生成于 8 天前 → 拒绝（任务也有寿命）', typeof v(task(daysAgo(8))) === 'string', v(task(daysAgo(8))))

console.log('\n② 未来日期仍然一律拒（跨零点只宽限 1 天）')
check('  生成 = 明天 → 通过（宽限）', v(task(daysAhead(1))) === undefined, v(task(daysAhead(1))))
check('  生成 = 后天 → 拒绝', typeof v(task(daysAhead(2))) === 'string', v(task(daysAhead(2))))

console.log('\n③ 「依据」这条不变量不许被弱化（它才是该不该重发的判据）')
check('  依据与档案不一致 → 拒绝', typeof v(task(TODAY, daysAgo(5))) === 'string', v(task(TODAY, daysAgo(5))))
check('  缺依据行 → 拒绝', typeof v(`# 本周任务（测试）\n\n生成: ${TODAY}\n\n- [ ] 甲\n`) === 'string')
check('  档案缺日期戳（无档案）→ 依据必须写「无档案」口径才通过',
  typeof v(task(TODAY, ARCHIVE), undefined) === 'string' || v(task(TODAY, ARCHIVE), undefined) === undefined)

console.log('\n④ 条数上限与空任务不许退化')
check('  0 条 → 拒绝', typeof v(`# 本周任务（测试）\n\n生成: ${TODAY}\n依据: 学习档案 更新于 ${ARCHIVE}\n\n没有复选框\n`) === 'string')
check('  4 条 → 拒绝（每科 ≤3）', typeof v(task(TODAY, ARCHIVE, ['甲', '乙', '丙', '丁'])) === 'string')

console.log('\n⑤ 漂移线与守护用同一条寿命（7 天）')
{
  const drift = plan.analyzeSubject({
    name: '测试', dir: '.', archiveRaw: `# 学习档案\n\n更新于: ${TODAY}\n\n## 学校当前进度\n- x\n`,
    taskRaw: task(daysAgo(7), TODAY), today: TODAY,
  }).drift
  check('  7 天未换 → 报「本周任务已 7 天未换」', drift.some((d) => /本周任务已 7 天未换/.test(d)), JSON.stringify(drift))
  const drift6 = plan.analyzeSubject({
    name: '测试', dir: '.', archiveRaw: `# 学习档案\n\n更新于: ${TODAY}\n\n## 学校当前进度\n- x\n`,
    taskRaw: task(daysAgo(6), TODAY), today: TODAY,
  }).drift
  check('  6 天 → 不报（与宽限一致，仍在生命期内）', !drift6.some((d) => /未换/.test(d)), JSON.stringify(drift6))
}

console.log(fail === 0 ? `\n✅ 全部通过：${pass} passed, 0 failed` : `\n❌ ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
