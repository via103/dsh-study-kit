// run-all.mjs — 一条命令跑完所有回归与自查。
//
// 为什么需要它：断言散在 15 个脚本里（6 个业务套件 + 8 个自查 + 1 个预设解析），
// 改完插件要手动 for 一遍文件名——那就是「测试与代码不同源」的具体样子（failure-modes 里的 G4）。
// 现在：**`npm test`**（在包目录里）或 `node <包>/run-all.mjs`（任意位置）。
//
// 另有一个**不进这里**的脚本：`test/falsify-contract.mjs`。它会临时把历史上真实的坏形状
// 注入 code-run.js、确认契约测试会因此变红、再还原。它证明的是"那条断言不是空的"，
// 属于发布前/怀疑断言失效时手动跑的一次检验，不适合塞进每次回归（它会改文件）。
//
// 为什么它和插件在同一个目录：**测试要跟代码一起旅行**。分离的那段时间里，改完插件忘了跑、
// 或者跑了旧位置的副本，都是真实发生过的。
//
// 分成两组，因为它们的**失败含义不同**：
//   业务套件  我们自己的逻辑对不对（改了插件就必须全绿）
//   自查      部署现场对不对（升级、预设、数据、接线）——它们各自也能单独跑
//
// 用法：
//   node run-all.mjs            跑全部
//   node run-all.mjs --fast     跳过最慢的（code-run 要真编译 C，10~30 秒）
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const WS = dirname(fileURLToPath(import.meta.url))
const fast = process.argv.includes('--fast')

const SUITES = [
  ['test/verify-hardening.mjs', '约束加固'],
  ['test/verify-planner.mjs', '总规划看板与流转'],
  ['test/verify-guard-v2.mjs', '预设内守护'],
  ['test/verify-file-guard.mjs', '宿主守护'],
  ['test/verify-board-fit.mjs', '看板头部预算（漂移与任务条目不丢）'],
  // ★ 2026-10-11：上面那一套钉的是"头部内部怎么降档"，而这一条钉的是**头部与陪伴块的边界**。
  //   实测到的真缺陷：陪伴块原来无条件 push 进**永不截断的尾部** ⇒ 每字节都从头部预算里扣，
  //   把 2 条各 120 字的「要跟总规划说的」写进去会**丢掉 4 条代码算出来的漂移事实**；
  //   而一条 2000 字的（笔记自己允许 4096 字节）把看板顶到 **7720B**，超过它自己的上限。
  // ★ 2026-10-12：改成"只吃余量"之后暴露了**另一个方向的失效**——现场余量只剩 104B
  //   而头部已在最低档、降无可降 ⇒ 块根本不渲染（通道静默失效）。
  //   学员的纠正把这条通道变成了承重件，所以它现在**独立成块**（自己的 512B 预算）。
  //   本套件钉三条：学业本体逐字节不变 / 漂移与任务一条不少 / **有内容就必须渲染**。
  ['test/verify-companion-budget.mjs', '看板预算：陪伴块独立成块（学业本体逐字节不变）'],
  ['test/verify-task-life.mjs', '本周任务的生命期（勾选不再被假拒）'],
  ['test/verify-code-tutor.mjs', '编程伴学 + 预设结构不变量'],
  // ★ 2026-10-17：学员批评「教学深度不足/路线不清晰/内容不完整」——根因是没有课程级载体：
  //   学习档案只装状态、复习提纲只装已学知识点，谁也不知道"应该学什么、学到哪、还差什么"。
  //   这套钉住课程路线协议：结构校验 + 摘要真的注入 + 写守护 + 四份 persona 投递一致。
  ['test/verify-curriculum-route.mjs', '课程路线（教学契约投递 + 写守护 + persona）'],
  // 心灵陪伴（2026-10-11 新增的第六个预设）：**它不是科目**这件事完全由文件名决定
  // （记忆文件叫 `心灵笔记.md` 而不是 `学习档案.md`），代价是注入 / 去路 / 账本三条通路
  // **同时断掉**且全都是静默的。这一套件给每条通路都配了同形状的正控制与归零对照，
  // 并**反向自证**"放一个 学习档案.md 进去它就立刻变成科目"——证明那几条不是空断言。
  ['test/verify-mind-preset.mjs', '心灵陪伴（不是科目 + 双向通气 + 规划单节渲染）'],
  ['test/verify-companion-coordination.mjs', '陪伴协调（同日同步 + 出信边界 + 分条收件 + 两端职责）'],
  ['test/verify-code-run.mjs', '真编译真运行（慢）'],
  // 「今天是几号」的语义（凌晨 4 点前算前一天）：它影响档案戳、任务生成日期、漂移天数与注入基准，
  // 而最典型的坏法是"大部分时候对、凌晨 0~4 点错一天"——那个时段恰好是学员最可能用的时候。
  ['test/verify-study-day.mjs', '学习日边界（凌晨 4 点前算前一天）'],
  // 跨科知识点：别科会话学到的本科知识点，只许追加进**它所属科目**的复习提纲，且目标科目
  // 会从注入里直接看到（不需要总规划中转、不需要 ack 协议）。
  ['test/verify-cross-subject.mjs', '跨科知识点（归属 + 只许追加 + 注入可见）'],
  // 课堂积累文件的体量：该文件**不进注入**（按学期累积、设计上会一直长），所以它的规则
  // 只能靠"有人去读 + 有人去量"。这里量的是**机械事实**（60KB 拆分阈值 / 一份一直用），
  // 而那正是守护管得了、原来却没人查的那部分。
  ['test/verify-classnotes-hygiene.mjs', '课堂积累体量（60KB 拆分阈值 + 一份一直用）'],
  // 单词复习站（2026-10-24 v5.10）：学员要的是"卡片是主路径、统一熟悉度、一轮覆盖全词、
  // 多主题长阅读、六板块＋词库、固定卡片视口/右侧滑块/手势、稳定 key/进度格式、无大小上限"。
  // 这一套钉住数据模型/构建器/运行时引擎/单文件 HTML/persona/注入/改站包装器，避免规范只写在文件里。
  ['test/verify-word-review.mjs', '英语单词复习站 v5.18（笔记分类预览/word-phrase 硬边界/拼写与遗忘）'],

  ['test/verify-correction-rules.mjs', '预设纠偏（身份自检 / 否定后换结构）'],
]
const CHECKS = [
  // ★★ 放第一条之前：2026-10-09，本项目最贵的一次静默失效——桌面端跑 `profiles/desktop`，
  //   而工具链写死 `profiles/web`，于是 9 项 persona 规则**学员一条都没收到**，
  //   而 1000+ 条断言全绿（它们问的就是我自己选的那份 profile）。
  //   这条检查的判据与任何具体规则无关：**读的那份 == 活的那份** + **别人有的规则不许缺**。
  //   它自己也被证伪过（.verify/falsify-profile-live.mjs 造一份多一行的临时 profile → 必红）。
  ['test/check-profile-live.mjs', 'profile 投递（读的那份 == 学员收到的那份）'],
  // ★ 放这里：2026-09-28 三个插件源码被一份旧快照盖回了两天前的状态，而 doctor 层 1 当时说的是
  //   「7/7 可加载」——**可加载 ≠ 完整**，少一个导出照样 import 成功、功能静默消失。
  //   这条清单把"每个文件应该导出什么"写成可执行的事实：少一个就红，并直接点名少了哪个。
  ['test/check-plugin-api.mjs', '插件 API 清单（源码被回退会立刻红）'],
  ['test/check-plugin-names.mjs', '预设插件名可解析（升级体检）'],
  // ★ 2026-10-17 升级（0.1.7-rc.1 → 0.2.1-rc.1）的真实事故：`dsh-agent-loop` 删掉了 `cwd`
  //   这个 prompt 变量，而 7 个用户预设的 persona 开头都写着「工作目录 {{cwd}}」。
  //   预设 YAML 合法、插件名全解析、上面那条升级体检全绿，但**一开这些预设的会话就抛**
  //   `unknown prompt variable "{{cwd}}" in section "deployment:persona-prefix"`——
  //   报错发生在**装配**（每条消息）时，不在加载时，所以"能解析"什么都没证明。
  //   这条检查问的是**当前安装注册了哪些变量**（扫源码，不写死清单），并用安装自己的
  //   renderPrompt 把每条 persona 真渲染一遍；探针自带三个正控制，防止"全绿"是空断言。
  ['test/check-prompt-variables.mjs', '预设 prompt 变量（升级后仍注册 + persona 真渲染）'],
  ['test/check-migration.mjs', '数据协议现场'],
  ['test/verify-remount.mjs', '换预设时的 mount/unmount 不变量'],
  ['test/probe-guard-logic.mjs', '守卫判定逻辑（脱离运行时）'],
  ['test/probe-metamount.mjs', '套件入口的前提：ctx.plugin(命名空间) 认不认'],
  ['test/verify-suite.mjs', '套件入口 study-suite 的契约与集成'],
  ['test/check-package.mjs', '打包不变量：bundle patch / 链接 / engines / 包内一致性'],
  ['test/check-preset-yml.mjs', '预设 YAML 与 persona 块能不能解析'],
  ['test/probe-code-run.mjs', 'code_run 真能挂上并真跑（C 走 python 宿主 + Python）'],
  // ★ 宿主契约：工具回执必须是宿主的 lossless JSON。放最后是因为它要跑真编译。
  //   2026-09-18~20 的「code_run 的 Python 通道不能用」就是这条契约被违反，
  //   而当时三个"全绿"的测试全都看不见它——所以这一行不是可选项。
  ['test/verify-tool-output.mjs', '宿主契约：每个工具回执都必须是 lossless JSON'],
]

const run = (rel) => {
  try {
    const out = execFileSync(process.execPath, [join(WS, rel)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { code: 0, out }
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}
const passCount = (out) => {
  const m = [...out.matchAll(/(\d+)\s*(?:passed|通过)|通过\s*(\d+)/g)].pop()
  return m ? Number(m[1] ?? m[2]) : 0
}
const summaryOf = (out) => {
  const m = [...out.matchAll(/(\d+)\s*(?:passed|通过)|通过\s*(\d+)/g)].pop()
  const f = [...out.matchAll(/(\d+)\s*failed/g)].pop()
  return m === undefined ? '' : `${m[1] ?? m[2]} 条${f ? ` / ${f[1]} 失败` : ' / 0 失败'}`
}

let total = 0
let broken = 0
const line = (label, rel, r) => {
  total += passCount(r.out)
  if (r.code !== 0) broken += 1
  console.log(`  ${r.code === 0 ? '✅' : '❌'} ${label.padEnd(30)} ${summaryOf(r.out) || `exit ${r.code}`}`)
  if (r.code !== 0) {
    for (const l of r.out.split('\n').filter((x) => x.includes('❌')).slice(0, 4)) console.log(`       ${l.trim()}`)
  }
}

console.log(`\nrun-all  ${new Date().toLocaleString('zh-CN')}${fast ? '  (--fast)' : ''}\n`)
console.log('业务套件')
for (const [rel, label] of SUITES) {
  // 表里存的是相对路径（`test/…`），这里必须按后缀比——用全等比会让 --fast 永远不跳过。
  if (fast && rel.endsWith('verify-code-run.mjs')) { console.log(`  ⏭️  ${label.padEnd(30)} --fast 跳过`); continue }
  line(label, rel, run(rel))
}

console.log('\n自查')
for (const [rel, label] of CHECKS) line(label, rel, run(rel))

console.log('\n' + '─'.repeat(72))
if (broken === 0) {
  console.log(`✅ 全绿：${total} 条断言通过`)
  console.log('   注意：这里绿 ≠ 现场健康。「余量快满了」「守护没接线」这类"没坏但不健康"的事，')
  console.log('   由 node study-doctor.mjs 按层报出来 —— 两者的检查范围不同，别只看一边。')
} else {
  console.log(`❌ ${broken} 个脚本失败（其余合计 ${total} 条通过）`)
  console.log('   下一步：node study-doctor.mjs —— 它按层告诉你坏在哪，比逐个脚本看快得多')
}
process.exit(broken === 0 ? 0 : 1)

