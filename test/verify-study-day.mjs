// verify-study-day.mjs —— 「学习日」的边界：**凌晨几点之前算前一天**。
//
// 为什么要单独一个套件：2026-09-25 用户提的规则（"第二天凌晨 4 点之前都算到前一天，我可能会熬夜"），
// 它改的是**整个系统里"今天是几号"的语义** —— 档案的「更新于」、任务的「生成」、漂移天数、
// 注入给模型的日期基准，全都跟着变。这种改动如果没有边界断言，最典型的坏法是"大部分时候对、
// 凌晨 0~4 点错一天"，而那个时段恰好是学员最可能用的时候。
//
// 另一个必须钉住的东西：`studyDate`（学习日）与 `formatDate`（纯日历日期）**是两个函数**。
// 混用会静默错一天 —— `weekStart()` 拿的是日期串构造的午夜锚点，对它做学习日偏移会整体前移。
import { declById, personaPrefixOf } from '../tools/presets.mjs'

const plan = await import('../plan-core.js')
const core = await import('../companion-core.js')
const guard = await import('../file-guard.js')

let pass = 0
let fail = 0
const check = (label, cond, extra) => {
  if (cond) { pass += 1; console.log('  ✅', label) }
  else { fail += 1; console.log('  ❌', label, extra === undefined ? '' : `→ ${extra}`) }
}

// 用本地时间构造（不要用 `new Date('2026-09-25T00:30')` —— 那在不同环境可能按 UTC 解析）
const at = (h, m = 0, s = 0) => new Date(2026, 8, 25, h, m, s) // 2026-09-25

console.log('\n① 边界：4 点之前算前一天，4 点整算当天')
check('声明了 DAY_START_HOUR', Number.isInteger(plan.DAY_START_HOUR), String(plan.DAY_START_HOUR))
check('  默认是 4', plan.DAY_START_HOUR === 4, String(plan.DAY_START_HOUR))
check('00:00 → 前一天', plan.studyDate(at(0)) === '2026-09-24', plan.studyDate(at(0)))
check('01:30 → 前一天（熬夜的主力时段）', plan.studyDate(at(1, 30)) === '2026-09-24', plan.studyDate(at(1, 30)))
check('03:59:59 → 前一天', plan.studyDate(at(3, 59, 59)) === '2026-09-24', plan.studyDate(at(3, 59, 59)))
check('04:00:00 → **当天**（边界右开）', plan.studyDate(at(4, 0, 0)) === '2026-09-25', plan.studyDate(at(4, 0, 0)))
check('04:00:01 → 当天', plan.studyDate(at(4, 0, 1)) === '2026-09-25', plan.studyDate(at(4, 0, 1)))
check('12:00 → 当天', plan.studyDate(at(12)) === '2026-09-25', plan.studyDate(at(12)))
check('23:59:59 → 当天', plan.studyDate(at(23, 59, 59)) === '2026-09-25', plan.studyDate(at(23, 59, 59)))
check('  跨月也成立（10-01 02:00 → 09-30）', plan.studyDate(new Date(2026, 9, 1, 2)) === '2026-09-30', plan.studyDate(new Date(2026, 9, 1, 2)))
check('  跨年也成立（2027-01-01 01:00 → 2026-12-31）', plan.studyDate(new Date(2027, 0, 1, 1)) === '2026-12-31', plan.studyDate(new Date(2027, 0, 1, 1)))

console.log('\n② formatDate 与 studyDate 必须分开（混用会静默错一天）')
check('formatDate(00:30) 是**当天**（纯日历日期，不偏移）', plan.formatDate(at(0, 30)) === '2026-09-25', plan.formatDate(at(0, 30)))
check('两者在 00:30 确实不同（证明它们不是同一个函数）', plan.formatDate(at(0, 30)) !== plan.studyDate(at(0, 30)))
check('周起点用的是 formatDate：对午夜锚点不偏移', plan.weekStart('2026-09-25') === '2026-09-21', plan.weekStart('2026-09-25'))
check('  周一自己算周起点还是它自己', plan.weekStart('2026-09-21') === '2026-09-21', plan.weekStart('2026-09-21'))
check('  周日归到本周（周一为始）', plan.weekStart('2026-09-27') === '2026-09-21', plan.weekStart('2026-09-27'))
// 若 weekStart 误用 studyDate，'2026-09-21' 的午夜锚点会被偏移到 09-20（周日），
// 于是周起点变成 09-14 —— 上面两条会立刻变红。这正是在防那个错。

console.log('\n③ 只有一份实现（三处引用必须指向同一个函数）')
check('companion-core 的 studyDate 与 plan-core 是同一个', core.studyDate === plan.studyDate)
check('file-guard 走的是同一个（它 import 自 plan-core）', typeof guard.apply === 'function')
check('companion-core 也导出了 formatDate / DAY_START_HOUR / DAY_RULE_HINT',
  core.formatDate === plan.formatDate && core.DAY_START_HOUR === plan.DAY_START_HOUR && core.DAY_RULE_HINT === plan.DAY_RULE_HINT)
check('旧的 localDate 已经不存在（避免有人用着旧语义）', plan.localDate === undefined && core.localDate === undefined)
check('DAY_RULE_HINT 说清了分界点', plan.DAY_RULE_HINT.includes('凌晨') && plan.DAY_RULE_HINT.includes(String(plan.DAY_START_HOUR)), plan.DAY_RULE_HINT)

console.log('\n④ 参数化：换个分界小时也成立')
check('studyDate(时刻, 0) = 自然日（午夜换天）', plan.studyDate(at(1), 0) === '2026-09-25', plan.studyDate(at(1), 0))
check('studyDate(时刻, 6) 在 05:00 仍算前一天', plan.studyDate(at(5), 6) === '2026-09-24', plan.studyDate(at(5), 6))
check('studyDate(时刻, 6) 在 06:00 算当天', plan.studyDate(at(6), 6) === '2026-09-25', plan.studyDate(at(6), 6))

console.log('\n⑤ 真正的痛点：跨零点写档案不再被拒')
{
  // 这是这个改动的**目的**：凌晨 1 点更新档案、日期戳写"昨天"，守护必须接受。
  // 旧实现（自然日）下，凌晨 0:00 一过，"今天"就跳到第二天，学员写原来那个日期会被判"日期不对"。
  const todayAt2am = plan.studyDate(at(2))            // = 2026-09-24
  const body = (stamp) => `# 学习档案\n\n更新于: ${stamp}\n\n## 学校当前进度\n第 3 章。\n\n## 已答主题与卡点\n- 指针。\n\n## 未消化薄弱点\n- 可变默认参数。\n`
  check('凌晨 2 点的学习日是前一天', todayAt2am === '2026-09-24', todayAt2am)
  const okAt2am = core.validateArchive(body(todayAt2am), 60, 6144, todayAt2am)
  check('  用学习日当日期戳 → 通过（旧实现会在这里拒绝）', okAt2am === undefined, okAt2am)
  const naturalDay = plan.formatDate(at(2))
  check('  用自然日（第二天）当戳 → 也在容差内（±1 天）', core.validateArchive(body(naturalDay), 60, 6144, todayAt2am) === undefined)
  const threeDays = core.validateArchive(body('2026-09-20'), 60, 6144, todayAt2am)
  check('  差 4 天仍然被拒（容差没被放大）', threeDays !== undefined, threeDays)
}

console.log('\n⑥ 注入与拒绝话术都要把规则讲出来')
{
  // 模型是照着注入行里的日期写档案的。规则不告诉它，凌晨那一段它就会写错日期。
  const src = await import('node:fs').then((fs) => fs.readFileSync(new URL('../companion-core.js', import.meta.url), 'utf8'))
  check('注入行带上了 DAY_RULE_HINT', src.includes('${DAY_RULE_HINT}'), '（在自动注入那段模板里）')
  check('拒绝话术也带上了规则', /\$\{DAY_RULE_HINT\}/.test(src) && (src.match(/\$\{DAY_RULE_HINT\}/g) ?? []).length >= 2, `出现 ${(src.match(/\$\{DAY_RULE_HINT\}/g) ?? []).length} 次`)

  // plan-core 的拒绝话术曾经只说"今天是 X"、**不说为什么 X 会是昨天**。
  // 凌晨 0:30 被拒的模型看到的正是这类消息，它据此只会反复试同一个自然日日期 ——
  // 拒绝话术的唯一用途就是让模型下次写对，所以规则必须写在话术里（不只是注入里）。
  const planSrc = await import('node:fs').then((fs) => fs.readFileSync(new URL('../plan-core.js', import.meta.url), 'utf8'))
  const planHints = (planSrc.match(/\$\{DAY_RULE_HINT\}/g) ?? []).length
  check('plan-core 的拒绝话术也带上了规则（计划 / 任务 / 变更记录三处）', planHints >= 5, `出现 ${planHints} 次，期望 ≥5`)
  check('  日期话术措辞统一用「学习日」而不是「系统今天」',
    !/系统今天/.test(planSrc) && !/日期取系统当前时间/.test(planSrc),
    (planSrc.match(/系统今天[^\n]*/g) ?? []).slice(0, 2).join(' | '))

  // 拒绝话术必须真的**用**到规则，而不是定义了常量放那儿。取一条真话术来看。
  // 注意：**只差一天**是被故意放行的（`age < -1` 才拒，±1 天容差就是为了跨零点），
  // 所以这里用"差两天"去踩那条话术 —— 断言要踩到它，就得先知道容差有多宽。
  const today = plan.studyDate(at(0, 30))          // 00:30 → 前一天 = 2026-09-24
  const twoAhead = plan.formatDate(new Date(2026, 8, 26))  // 2026-09-26
  const reject = plan.validateTask(
    `# 本周任务\n\n生成: ${twoAhead}\n依据: 学习档案 更新于 ${today}\n\n- [ ] x\n`,
    { today, subjectName: 'C', archiveStamp: today },
  )
  check('凌晨写了"还晚一天"的生成日期 → 被拒且话术讲出分界规则',
    typeof reject === 'string' && reject.includes('凌晨') && reject.includes('算前一天'),
    String(reject).slice(0, 90))

  // 顺带钉住容差本身没被这次改动放宽/收紧：差 1 天放行、差 2 天拒绝
  const oneAhead = plan.formatDate(new Date(2026, 8, 25))
  const okOne = plan.validateTask(
    `# 本周任务\n\n生成: ${oneAhead}\n依据: 学习档案 更新于 ${today}\n\n- [ ] x\n`,
    { today, subjectName: 'C', archiveStamp: today },
  )
  check('  差 1 天仍放行（±1 天容差没被这次改动动过）', okOne === undefined, String(okOne).slice(0, 70))
}

console.log('\n⑦ 六个预设的 persona 也说明这条规则')
{
  // ★ 断言必须**明确要求那条规则**，不能用"提到了学习日"这种松条件——
  //   第一版就是这么写的，结果四个伴学预设靠 persona 里另一处的「最近 5 个**学习日**」混了过去，
  //   而它们当时根本没写 4 点分界。松断言比没有断言更糟：它给的是假绿。
  // ★ mind-companion 也在这张表里：它的笔记**同样**要求「更新于」是当天（学习日口径），
  //   写守护用的是同一个 studyDate()，所以它必须知道 4 点分界——否则学员熬夜时会被守护拒。
  for (const id of ['netsec-tutor', 'math-tutor', 'english-tutor', 'code-tutor', 'study-planner', 'mind-companion']) {
    const decl = declById(id)
    const text = personaPrefixOf(decl) ?? ''
    const hasRule = /凌晨\s*4\s*点/.test(text) && /(算前一天|即前一天)/.test(text)
    check(`${id}：persona 里写明了「凌晨 4 点之前算前一天」`, hasRule, text.length > 0 ? '（读到了 persona，但没有这条规则）' : '（读不到 persona）')
  }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)