// check-plugin-api.mjs —— **API 清单**：每个插件文件必须导出这些东西。
//
// 为什么需要它（2026-09-28）：
//   三个插件源码文件的内容被一份旧快照盖回了 09-26 的状态（同目录下当天写的其它文件都在）。
//   当时 `doctor` 层 1 说的是「**7/7 可加载**」——**可加载 ≠ 完整**：缺了一个导出的模块照样能
//   被 `import` 成功，只是那个功能**静默消失**。而"静默消失"正是这套系统一直在消灭的东西。
//
//   这份清单把"每个文件应该长什么样"写成**可执行的事实**：少一个导出，`npm test` 立刻红，
//   并且直接告诉你"哪个文件少了什么"——这就是"≤1 条命令定位坏在哪一层"。
//
// 维护规则：**加了导出就加到清单里**（清单是契约，不是自动生成的镜像——自动生成就永远追不上现实，
// 也就永远抓不到"少了一个"）。测试会同时报告"清单里有但模块没有"（丢失）与
// "模块有但清单没有"（新增未登记），后者只是提示，不算失败。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const PKG = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

let pass = 0
let fail = 0
const check = (label, cond, extra) => {
  if (cond) { pass += 1; console.log('  ✅', label) }
  else { fail += 1; console.log('  ❌', label, extra === undefined ? '' : `→ ${extra}`) }
}

/** 每个插件文件的导出清单（契约）。key = 文件名，value = 必须存在的导出名。 */
const API = {
  'plan-core.js': [
    // 生命周期
    'name', 'apply',
    // 协议常量与路径
    'canonicalPath', 'readProbe', 'writeHealth',
    // 日期语义（学习日：凌晨 4 点前算前一天）
    'DAY_START_HOUR', 'DAY_RULE_HINT', 'formatDate', 'studyDate', 'weekStart', 'ageDays', 'isWithin',
    // 档案/任务解析
    'archiveStamp', 'basisStamp', 'genStamp', 'checkboxes', 'listItemsInSection', 'screenText', 'newestLogEntryDate',
    'parseBasis', 'renderBasis',
    // 科目发现与状态
    'discoverSubjects', 'analyzeSubject', 'survey',
    // 看板与守护
    'buildBoard', 'BOARD_MAX_BYTES', 'BOARD_HEAD_TIERS', 'BOARD_HEAD_MIN_BYTES', 'planDrift', 'planSubjectHeadings', 'replanVerdict',
    'validatePlan', 'validateNotice', 'validateTask',
    // ★ 跨科移交标记（2026-09-28：别科在自己档案里打 `@本科`，代码送到目标科目）
    'parseHandoffs',
    // ★ 档案卫生（2026-10-06「网安档案总是满」：把 persona 的"流水≤5 个学习日 / 每条一句话"
    //   算成数字，在被拒**之前**提醒；不硬拒）
    'archiveHygiene', 'FLOW_DAYS', 'FLOW_MEGA_BYTES',
    // ★ 计划卫生（2026-10-08「我的规划文档似乎也遇到了字数不够的问题」：卡住的**不是字节**
    //   ——实测 4199/8192 = 51%——而是**封顶格子的条数**：硬约束 5/5、漂移 6/6、预备 5/5、
    //   网安 MVE 3/3 全满。把"还剩几个格子"算出来报在**永不截断的尾部**，动笔前就知道。
    //   与 archiveHygiene 同族：都是把 persona 里"声明了但没人查"的规定变成数字。）
    'planHygiene',
    // ★ 课堂积累体量（2026-10-09「只写在文件里面能不能起到良好的规范作用」：该文件不进注入，
    //   它那 10 条约束里守护只能管 3 条（机械事实），但「超过约 60KB 就拆」量得出来却原来没人查。
    //   同族第三次：规定写在文件里、没有代码在查。）
    'classNotesHygiene', 'CLASS_NOTES_NAME', 'CLASS_NOTES_SPLIT_BYTES',
    // ★ 「陪伴」预设（2026-10-11 学员：*「它的定位不是科目，定位是陪伴」*）：
    //   记忆文件换名字 ⇒ **天然**不是科目（discoverSubjects 只认 学习档案.md）
    //   ⇒ 不进看板、不排 MVE、不下发任务、看板 +0 字节。代价是三条通路同时断，逐条补。
    //   `companionPlanItems` 是**唯一**从聊天侧外流到规划侧的读取路径（只有「要跟总规划说的」那一节）。
    'COMPANION_NOTE_NAME', 'COMPANION_SECTION_PLAN', 'COMPANION_PLAN_ITEMS_MAX', 'companionPlanItems',
    // ★ 看板预算协商（两次修，两个**相反**的失效方向——见 verify-companion-budget 的头注释）：
    //   2026-10-11：块无条件占**永不截断的尾部** ⇒ 每字节从头部预算扣 ⇒ 实测丢掉 4 条漂移事实；
    //     一条 2000 字的还把看板顶到 7720B。
    //   2026-10-12：改成"只吃余量"之后，现场余量只剩 104B 而头部已在最低档 ⇒ 块**根本不渲染**
    //     （通道静默失效）。学员的纠正把这条通道变成承重件，所以它现在**独立成块**：
    //     看板本体仍然 ≤4096 且逐字节不让，块用 COMPANION_BLOCK_MAX_BYTES 自己的预算。
    //   不变量：「学业本体逐字节不变」+「有内容就必须渲染」——由 test/verify-companion-budget.mjs 钉住。
    'COMPANION_ITEM_MAX_BYTES', 'COMPANION_BLOCK_MAX_BYTES',
  ],
  'companion-core.js': [
    'name', 'apply',
    // 协议常量与数值上限（file-guard 从这里取，不另抄一份）
    'ARCHIVE_NAME', 'TASK_NAME', 'PLAN_NAME', 'NOTICE_NAME', 'OUTLINE_NAME',
    'DEFAULT_MAX_LINES', 'DEFAULT_MAX_BYTES',
    // ★ 复习提纲：跨科只许追加 + 来源戳 + 两条来路的注入（2026-09-28）
    'hasSourceTag', 'foreignOutlineEntries', 'validateOutlineForeignWrite', 'renderForeignOutline',
    'collectHandoffs', 'pendingHandoffs', 'renderHandoffs',
    // 守护与判定
    'validateArchive', 'staleNotice', 'validateTaskWrite', 'taskBasisContext', 'reconstruct',
    // ★ 陪伴笔记：**另一套契约**（不要三字段、限额更小、仍然要日期戳）。
    //   必须在这里钉住——它由宿主 file-guard 一起执法，少了它那块就成了自由写入区。
    'COMPANION_NOTE_NAME', 'COMPANION_SECTION_PLAN', 'COMPANION_MAX_LINES', 'COMPANION_MAX_BYTES', 'validateCompanionNote',
    // ★ 自毁路径的守卫（2026-10-12 补的真缺陷）：认科目的唯一判据是文件名 `学习档案.md`，
    //   所以"陪伴不是科目"这条不变量**完全由文件名撑着**。而三层守护原来没有一层拦
    //   "陪伴在**自己**目录里建 学习档案.md"：file-guard 认 archive 但 `cwd === scopeDir`
    //   ⇒「本科自己写自己的档案」正好放行；预设内守护同理；persona 只写了"别改**别科**的文件"。
    //   症状是**静默变形**（陪伴变第七个科目、进看板、被点名要任务），不是报错。
    //   这两个导出是两个检查点（宿主平面 + 预设内）共用的判据与同一句拒绝理由。
    'looksLikeCompanionDir', 'companionArchiveRefusal',
    // ★ 课程路线（2026-10-17：学员说「教学深度不足，教学路线不清晰，教学内容不完整」）：
    //   学习档案只装状态、复习提纲只装已学知识点，没有"应该学什么/还差什么"的载体 ⇒
    //   第三份协议文件 + 每轮注入摘要 + 写守护（四节/六字段/状态按证据升级）。
    'ROUTE_NAME', 'DEFAULT_ROUTE_MAX_LINES', 'DEFAULT_ROUTE_MAX_BYTES',
    'parseRoute', 'validateRoute', 'renderRouteDigest', 'ROUTE_MISSING_HINT',
    // 学习日再导出（三处引用必须是同一个函数对象，verify-study-day ③ 钉着）
    'DAY_RULE_HINT', 'DAY_START_HOUR', 'formatDate', 'studyDate',
    // ★ 档案卫生的注入渲染（archiveHygiene 也从这里转发，doctor 与 check-migration 用它算现场）
    'archiveHygiene', 'renderHygiene',
  ],
  'file-guard.js': ['name', 'apply', 'inject', 'classify', 'looksLikeStudyRoot'],  'study-suite.js': ['name', 'apply'],
  'code-run.js': ['name', 'apply', 'inject', 'compileOkField'],
  'study-judge.js': ['name', 'apply'],
  'netsec-range.js': ['name', 'apply'],
}

console.log('插件 API 清单：每个文件的导出必须齐全（少了哪个就说明它被动过/被回退过）\n')
for (const [file, names] of Object.entries(API)) {
  let mod
  try {
    mod = await import(`file://${join(PKG, file)}`)
  } catch (e) {
    check(`${file} 能加载`, false, String(e.message).slice(0, 90))
    continue
  }
  const missing = names.filter((n) => mod[n] === undefined)
  check(`${file}：${names.length} 个导出齐全`, missing.length === 0, missing.length > 0 ? `少了 ${missing.join(' ')}　← 这个文件被改过或被回退了` : '')
  const extra = Object.keys(mod).filter((n) => !names.includes(n) && n !== 'name' && n !== 'inject' && n !== 'apply')
  if (extra.length > 0) console.log(`     ℹ️  清单未登记的新导出：${extra.join(' ')}（加了就写进 test/check-plugin-api.mjs 的清单）`)
}

// 插件入口的文件清单本身也要对得上（少一个文件 = 整套少一个部件）
console.log('\n包根必须有的入口文件')
for (const f of ['study-suite.js', 'plan-core.js', 'companion-core.js', 'file-guard.js', 'study-judge.js', 'code-run.js', 'netsec-range.js']) {
  let ok = true
  try { readFileSync(join(PKG, f), 'utf8') } catch { ok = false }
  check(`  ${f}`, ok, ok ? '' : '文件不存在')
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)