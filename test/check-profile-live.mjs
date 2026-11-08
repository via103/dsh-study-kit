// check-profile-live.mjs — **「我改的那份，就是学员收到的那份吗」**。
//
// ═══ 为什么会有这个套件（2026-10-09）══════════════════════════════════════════
// 这是本项目最贵的一次静默失效，而且它骗过了**全部** 1000+ 条断言：
//
//   桌面端跑的是 `profiles/desktop`，而我一直在改 `profiles/web`。
//   2026-09-24 之后写进 web 那份 patch 的 9 项 persona 规则——
//   学习日（凌晨 4 点）、`@Python`、拿不准归属就别猜、来源标注、档案卫生、200 字节、
//   计划格子、课堂积累、词汇情景本——**学员一条都没收到**。
//
//   旧断言全都绿，因为它们问的是**我自己选的那个 profile**（`PROFILE` 写死 `'web'`）。
//   它们不是"问错了问题"，而是**问错了对象**——F16（断言结构上问不到问题）的变体：
//   断言再密，只要对象选错，全绿也只是"我改的那份自洽"。
//
// 所以这个套件的判据不是"预设声明对不对"，而是**两条关于投递的、与任何具体规则无关的事实**：
//
//   ① 工具链读的那份 == 学员界面正跑着的那份（**对象**对不对）
//   ② 别人有的规则，活着的那份里不许缺（**内容**有没有漏投）
//
// 两条都不依赖具体文案，所以不会因为将来改了措辞而误报；而当年那次事故，两条都会红。
//
// 用法：node test/check-profile-live.mjs
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  PROFILE, PROFILE_INFO, PROFILE_PATCH, DSH_HOME, allProfiles,
  deliveredDeclarations, personaPrefixOf,
} from '../tools/presets.mjs'
import { runningProfiles, describeProfile } from '../tools/live-profile.mjs'

let pass = 0
let fail = 0
const check = (label, cond, extra) => {
  if (cond) { pass += 1; console.log('  ✅', label) }
  else { fail += 1; console.log('  ❌', label, extra === undefined ? '' : `→ ${extra}`) }
}
const info = (label, detail) => console.log('  ·', label, detail === undefined ? '' : `→ ${detail}`)

// ★ 2026-11-07 可移植性：这套检查是**维护者侧**的（它问「我改的那份 == 学员收到的那份」），
//   别人的机器上可能根本没有 profile。没有就明确跳过并 exit 0 —— 让人看到"未运行"，
//   而不是一个指向他们从没创建过的路径的 Node 崩溃。
if (!existsSync(join(DSH_HOME, 'profiles'))) {
  console.log('⏭️  跳过：本机没有 DSH profile 目录（这是维护者侧的投递检查，插件运行不依赖它）')
  process.exit(0)
}

/** 该被投递的伴学预设（`standard` 那两个是实验预设，本来就没有伴学规则）。 */
// mind-companion 也在这张表里：它有 persona，而且**必须**在两份 profile 里一字不差地投递
// ——它是新建的，最容易只写进"我改的那份"（§39 的教训）。
const COMPANION_IDS = ['study-planner', 'fact-verify', 'netsec-tutor', 'math-tutor', 'english-tutor', 'code-tutor', 'mind-companion', 'competition-coach', 'model-tutor']

/**
 * 本次**真的查一遍进程表**，拿活着的 profile 名。
 * 为什么不让调用方直接用 `PROFILE_INFO.running`/`candidates`：
 * `candidates` 在 cache 分支里就是缓存的那个 profile 本身（拿它比 = 拿自己比自己）；
 * 而 `running` 虽然来自真实进程表，但它可能是 `detectProfile` 那次调用查的——
 * 这里再查一次的成本（~450ms）换的是"这一条断言有独立证据"，值。
 */
function info_running_profiles() {
  return [...new Set(runningProfiles().map((r) => r.profile))]
}

/**
 * 一份 persona 里"值得当成规则"的行——短行（标题、空行、记号）不算，
 * 否则换个措辞、加个空行都会误报。
 */
export function ruleLines(text) {
  return String(text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length >= 12 && !l.startsWith('#') && !l.startsWith('```'))
}

/**
 * ★ ② 的核心判定，**抽成纯函数**就是为了能让 ⑤ 反向自证它真的会红。
 * 返回"别人有、活着的那份没有"的行（每条带上是谁独有的）。
 */
export function missingRules(liveText, others) {
  const live = new Set(ruleLines(liveText))
  const out = []
  for (const { profile, text } of others) {
    for (const line of ruleLines(text)) {
      if (!live.has(line)) out.push({ from: profile, line })
    }
  }
  return out
}

// ── ① 对象对不对：工具链读的那份，是不是学员界面正跑着的那份 ──────────────────
console.log('\n① 工具链问的是哪个 profile')
console.log(`  读的是：${describeProfile(PROFILE_INFO)}`)
check(
  'PROFILE 不是写死的字符串，而是探测出来的',
  typeof PROFILE_INFO.source === 'string' && PROFILE_INFO.source !== '',
  PROFILE_INFO.source,
)
// ★ 判据用**真实的进程表**（`info.running`），**不能**用 `info.candidates`。
//   两个坑都在这里踩过：
//   ① 第一版写 `source === 'running'` 当分支条件，于是 `DSH_STUDY_PROFILE=web`
//      一设就走进"跳过进程级比对"分支 → **守卫自己被一个环境变量绕过去、然后全绿**。
//   ② 加了快速缓存之后，`candidates` 在 cache 分支里就是缓存的那个 profile 本身
//      → 拿它比等于**拿自己比自己**，又变成空断言。
//   `running` 是本次调用**真的查了进程表**得到的（哪怕 profile 来自缓存），所以它才是独立证据。
const liveProfiles = info_running_profiles()
if (liveProfiles.length > 0) {
  check(
    '  工具链读的 profile ∈ 活着的进程用的 profile',
    liveProfiles.includes(PROFILE),
    `工具链=${PROFILE}（依据 ${PROFILE_INFO.source}）｜进程里=${liveProfiles.join('、')}` +
      (PROFILE_INFO.source === 'env' ? ' ← 环境变量把它钉到了**没人在读**的那份' : '') +
      (PROFILE_INFO.source === 'cache' ? ' ← 结论来自缓存，但这一条是**另查了一遍进程表**得出的' : ''),
  )
} else {
  // 没有进程可问（桌面端没开）时不能假装验过——但也不能静默放过。
  info('跳过进程级比对', '现在没有可问的进程——这一条**没验**')
  const cached = PROFILE_INFO.source === 'stale-cache' ? PROFILE_INFO.profile : undefined
  check(
    '  连过期缓存也没有说"活的是别的 profile"',
    cached === undefined || cached === PROFILE,
    cached === undefined ? undefined : `上次探测到活着的是 ${cached}`,
  )
}
const onDisk = allProfiles()
check('  活着的 patch 真的在磁盘上', existsSync(PROFILE_PATCH), PROFILE_PATCH)
info('磁盘上的 profile', onDisk.join('、'))
if (onDisk.length > 1) {
  // 多 profile 本身不是错，但它正是"改了一份、跑的是另一份"的温床，所以要说出来。
  info('注意', `有 ${onDisk.length} 个 profile，改预设时只有「${PROFILE}」这份会到达学员`)
}

// ── ② 内容有没有漏投：别人有的规则，活着的那份不许缺 ────────────────────────
console.log('\n② 别的 profile 里有、学员这份里没有的规则（漏投检测）')
// ★ 2026-11-05：**用「实际投递的那一组」而不是「profile patch 里的那一组」**。
//   0.2.2 起「总规划」只声明在 @local/dsh-study 的组合包 patch 里，profile 里没有这一行；
//   只读 profile patch 会把它当成"不存在"，于是 personaPrefixOf(undefined) 直接抛
//   TypeError，整个套件崩掉——而 doctor 只看到 exit 非 0，报成"有规则只落在别的 profile 上"。
//   deliveredDeclarations = 组合包 ∪ profile（profile 覆盖组合包）。
const liveDecls = new Map(deliveredDeclarations().map((d) => [d.id, d]))
let leakTotal = 0
for (const id of COMPANION_IDS) {
  const liveDecl = liveDecls.get(id)
  if (liveDecl === undefined) { info(id, '活着的 profile 里没有这个预设——跳过'); continue }
  const liveText = personaPrefixOf(liveDecl) ?? ''
  const others = []
  for (const profile of onDisk) {
    if (profile === PROFILE) continue
    const patch = join(DSH_HOME, 'profiles', profile, 'cordis.patch.yml')
    let decl
    try { decl = deliveredDeclarations({ patch, dir: join(DSH_HOME, 'profiles', profile) }).find((d) => d.id === id) }
    catch { continue }
    if (decl === undefined) continue
    others.push({ profile, text: personaPrefixOf(decl) ?? '' })
  }
  const missing = missingRules(liveText, others)
  leakTotal += missing.length
  check(
    `  ${id}（${others.length} 个别的 profile 比过）`,
    missing.length === 0,
    missing.length === 0 ? undefined : `${missing.length} 行只在 ${[...new Set(missing.map((m) => m.from))].join('、')} 里：\n      ` +
      missing.slice(0, 4).map((m) => `[${m.from}] ${m.line.slice(0, 90)}…`).join('\n      '),
  )
}
check('  没有任何规则只落在别的 profile 上', leakTotal === 0, `共 ${leakTotal} 行`)

// ── ③ 投递金丝雀：几条"曾经丢过"的具体规则，必须在活着的那份里 ──────────────
//    ② 是通用的，③ 是把当年丢掉的 9 项里最稳定的几条钉死。措辞变了就该改这里——
//    这正是我们要的：改措辞是**有意识**的动作，而"悄悄没投递"不是。
console.log('\n③ 投递金丝雀（曾经丢过的规则，必须在学员这份里）')
const CANARIES = [
  // 学习日（凌晨 4 点）：**伴学预设**都要遵守，因为它决定档案戳与任务日期的基准。
  // ★ 不含 `fact-verify`——它是消费研究助手（购物核实），有自己的时间语义（检索时间 / 核实日期），
  //   不参与档案与计划，所以**从来没有**学习日这条规则。第一版把它写进来，红了；
  //   查证两份 profile 都写着 `len 7799 / 含学习日 false / 含检索时间 true`，
  //   才发现是**金丝雀写宽了**，不是投递缺了。金丝雀必须钉"确实该有的"，多一条就是假红。
  { ids: ['study-planner', 'netsec-tutor', 'math-tutor', 'english-tutor', 'code-tutor', 'mind-companion'], phrase: '学习日', why: '凌晨 4 点前的日期归属' },
  { ids: ['netsec-tutor', 'math-tutor', 'english-tutor', 'code-tutor'], phrase: '档案卫生', why: '档案体量的守护口径' },
  { ids: ['netsec-tutor', 'math-tutor', 'english-tutor', 'code-tutor', 'mind-companion'], phrase: '拿不准归属就别猜', why: '跨科知识点的归属纪律' },
  { ids: ['english-tutor'], phrase: '课堂积累', why: '《词汇情景本》必须去读的地方' },
  { ids: ['english-tutor'], phrase: '词汇情景本', why: '课堂积累文件的名字' },
  { ids: ['code-tutor'], phrase: '@Python', why: 'Python 通道的代号' },
  // 2026-10-28：学员投诉数学预设「说了不要提示非要提示」——四个带提示阶梯的预设
  // 现在都必须有「学员明确拒绝提示时直接给答案，且压过教学契约/回答形态」的硬句。
  { ids: ['netsec-tutor', 'math-tutor', 'english-tutor', 'code-tutor'], phrase: '学员明确说「不要提示', why: '学员拒绝提示时直接给答案' },
  // 2026-10-28 学员第二次投诉：预设「不太喜欢记录」——四个教学预设都必须有
  // 「记录（默认动作）」节：什么该记、记到哪、什么时候记、用的时候先读。
  { ids: ['netsec-tutor', 'math-tutor', 'english-tutor', 'code-tutor'], phrase: '记录（默认动作', why: '值得长期留的内容要落盘' },
  // ★ mind-companion 的三条**结构性**金丝雀：不是措辞，是"它必须与学业预设不同"的地方。
  //   前两条是"陪伴不是科目"的正面表述与它的记忆文件名；第三条是**隐私边界**——
  //   只有「要跟总规划说的」那一节会外流，这条一旦被改掉，隐私就从"结构性"退回"靠自觉"。
  { ids: ['mind-companion'], phrase: '陪伴，不是科目', why: '它不是科目的自我定位' },
  { ids: ['mind-companion'], phrase: '心灵笔记.md', why: '它的记忆文件名（不是 学习档案.md）' },
  { ids: ['mind-companion'], phrase: '要跟总规划说的', why: '唯一会外流给总规划的那一节' },
  // 2026-10-29 新增 Model 方向伴学：与教学预设同一套纪律（学习日 / 档案卫生 / 归属不猜 / 拒绝提示 / 默认记录）。
  { ids: ['model-tutor'], phrase: '学习日', why: '凌晨 4 点的日期归属' },
  { ids: ['model-tutor'], phrase: '档案卫生', why: '档案体量的守护口径' },
  { ids: ['model-tutor'], phrase: '拿不准归属就别猜', why: '跨科知识点的归属纪律' },
  { ids: ['model-tutor'], phrase: '学员明确说「不要提示', why: '学员拒绝提示时直接给答案' },
  { ids: ['model-tutor'], phrase: '记录（默认动作', why: '值得长期留的内容要落盘' },
  // 2026-10-29 学员投诉「预设听不懂话」：C 会话被配成网安伴学，且两次纠偏被无视。
  // 五个教学类预设都必须有「先复述 → 换结构不换参数 → 一题一考点 → 指令高于流程」。
  { ids: ['netsec-tutor', 'math-tutor', 'english-tutor', 'code-tutor', 'model-tutor'], phrase: '纠偏（学员说', why: '被否定时先复述、换结构而不是只换参数' },
  // 2026-11-04 Python 归属：学校课＋语言归编程伴学；部门 T0–T9 的 Python 交付物归 Model 伴学，两边不重复开课。
  { ids: ['code-tutor'], phrase: 'Python 边界', why: 'Python 归属与不重复系统讲' },
  { ids: ['model-tutor'], phrase: '与编程伴学的 Python 分工', why: '部门任务不转成语法课' },
  // 2026-10-30 用户反馈「总规划记性差」：口头事实（考试/截止/课表）必须当轮落盘，
  // 排期前先读 总规划.md / 周日程表.md；会话上下文会被压缩成摘要，不能当记忆。
  { ids: ['study-planner'], phrase: '记忆（文件是唯一记忆', why: '口头事实当轮落盘，压缩摘要不可靠' },
  { ids: ['study-planner'], phrase: '不许猜', why: '没记到就问日期，不许推测' },
  // 2026-11-07 学员要求：首轮建档引导**只能出现在第一次对话**，之后任何轮次都不许再出现。
  // 判定必须落在文件（没有 `建档:` 行才引导），不能靠"记忆里是不是第一次"。
  { ids: ['study-planner'], phrase: '首次建档（只在第一次', why: '建档引导只做一次' },
  { ids: ['study-planner'], phrase: '建档只有一次', why: '已建档后不得再引导、不得重问六项' },
  // 2026-11-07 学员定义的精简判据：容量触顶时按**信息量**取舍，不按新旧。
  // 「删掉迟早还会再说一遍的，留下只说过一次、丢了就没了」，前提是这条本身有用。
  { ids: ['netsec-tutor', 'math-tutor', 'english-tutor', 'code-tutor', 'model-tutor'], phrase: '只说过一次', why: '整理档案时留低频高信息，不按日期删' },
  { ids: ['study-planner'], phrase: '超了不是删最早的', why: '变更记录按信息量淘汰，不是 FIFO' },
  { ids: ['mind-companion'], phrase: '12356', why: '安全兜底：危机时给的热线' },
]
for (const c of CANARIES) {
  for (const id of c.ids) {
    const decl = liveDecls.get(id)
    const text = personaPrefixOf(decl) ?? ''
    check(
      `  ${id} 含「${c.phrase}」（${c.why}）`,
      text.includes(c.phrase),
      decl === undefined ? '这条预设在该 profile 的投递里根本不存在（组合包和 profile patch 都没有）' : undefined,
    )
  }
}

// ── ④ 结构：每一份 persona 都真的存在、非空、没被编码事故打坏 ────────────────
console.log('\n④ 活着的 profile 里每份 persona 的结构')
for (const id of COMPANION_IDS) {
  const decl = liveDecls.get(id)
  if (decl === undefined) continue
  const text = personaPrefixOf(decl) ?? ''
  check(`  ${id} 有 persona 且非空`, text.length > 200, `${text.length} 字符`)
  // PowerShell 那次把 plan-core.js 打成 594 个 U+FFFD；persona 也会被打坏，而且打坏后
  // 语法上依然"是一段文本"，只有逐字看才发现。
  check(`  ${id} 没有 U+FFFD（编码事故痕迹）`, !text.includes('\uFFFD'))
}

// ── ⑤ 反向自证：证明 ② 不是空断言 ────────────────────────────────────────────
//    把"当年那份分裂"的形状喂进判定函数：web 多出一条学习日规则、desktop 没有。
//    如果 missingRules 对这种输入都不报，那 ② 绿只是因为**它不会红**。
console.log('\n⑤ 反向自证：判定函数对"当年那次分裂"会红吗')
{
  const webLike = '1. `生成` 取系统当天（**「当天」= 学习日：以凌晨 4 点为界，4 点之前算前一天**）；\n其他规则。'
  const desktopLike = '1. `生成` 取系统当天（允许差 1 天，作为跨零点宽限）；\n其他规则。'
  const caught = missingRules(desktopLike, [{ profile: 'web', text: webLike }])
  check('  漏投的那一行会被抓出来', caught.length === 1, JSON.stringify(caught.map((c) => c.from)))
  check('  抓出来的确实点名了是哪个 profile 独有的', caught[0]?.from === 'web', String(caught[0]?.from))
  // 反向：两份一样时必须**不**报（否则这条断言只是"永远报红"）
  check('  两份一致时不误报', missingRules(webLike, [{ profile: 'web', text: webLike }]).length === 0)
  info('自证方式', '把 2026-09-24 那次分裂的真实形状（web 有学习日、desktop 是旧版）喂进 missingRules')
}

console.log(`\n${fail === 0 ? '✅' : '❌'} profile 投递：${pass} 条通过 / ${fail} 条失败`)
if (fail > 0) {
  console.log('\n修法：把缺的规则补进 **活着的** 那份 patch：')
  console.log(`  ${PROFILE_PATCH}`)
  console.log('  或跑 .verify/port-personas-to-desktop.mjs --apply 从另一份移植（先干跑看自检）。')
}
process.exit(fail === 0 ? 0 : 1)
