// plan-core — 总规划底座插件（DSH Cordis，宿主侧，纯 ESM，无外部依赖）
//
// 面向「总规划」预设：以学习根目录（默认取会话工作区，例如 ...\ST）为范围，
// 统筹其下的科目子目录（子目录里有 `学习档案.md` 的算一个科目）。
//
// 与三个伴学预设的通信完全走文件，方向严格分离、写者不重叠（无需锁）：
//   各科 → 总规划：各科自己的 `学习档案.md`（由该科写，companion-core 守护）
//   总规划 → 各科：根目录 `总规划.md`（周看板）+ 各科目录 `本周任务.md`（下发）
//
// 三个贡献：
// 1) 全科看板自动注入（agent/pre-step，内容变化才注入）：每轮开头把各科档案的
//    关键状态、本周任务的 MVE 完成度、以及计划自身的漂移合成一份注入。
//    模型不必「记得去读各科档案」——不读也已经看到了。
// 2) 漂移检测落在代码层：档案陈旧天数、任务下发后该科是否有回执、计划的数据基准
//    与实际磁盘是否一致、MVE 未完成条数，全部由代码算出。模型只能读结论，编不了。
// 3) 写入守护：`总规划.md` / `本周任务.md` 的结构校验。`数据基准:` 行就是乐观
//    并发控制——写入时的基准必须与磁盘现状逐科相符，否则拒绝，倒逼先重新读档。
//
// 只消费宿主服务（tools 可选），不发布服务，无需 isolate realm。
// 挂载：预设 agent.cordis.yml 加一行 name 指向本文件绝对路径。
// 可选 config：{ root?, planName?, taskName?, archiveName?, maxPlanLines?, maxPlanBytes?, maxTaskBytes?, staleDays? }

import { mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

export const name = 'plan-core'

/**
 * 启动痕迹：把「守护到底接上没接上」写成**一条可读的文件**，`study-doctor.mjs` 的层 4 读它。
 *
 * 为什么放在 plan-core：**它是依赖根**——companion-core 与 file-guard 都 import 它，
 * 反过来 import 会成环。诊断文件绝不能反过来弄坏插件，所以任何异常都吞掉。
 */
export function writeHealth(plugin, state) {
  try {
    const dir = join(dirname(fileURLToPath(import.meta.url)), '.health')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `${plugin}.json`)
    // **不要覆盖一个"还活着的别的进程"写下的痕迹。**
    // 测试脚本与探针会用假 ctx 调 apply()。直接覆盖就会把宿主进程的真实状态擦成
    // "某个已经退出的 pid"——2026-09-18 实测：跑一次六个套件，doctor 的层 4 全变灰。
    try {
      const prev = JSON.parse(readFileSync(file, 'utf8'))
      if (prev?.pid !== undefined && prev.pid !== process.pid && isAlive(prev.pid)) return
    } catch {
      /* 没有旧文件、或旧文件读坏了：照写 */
    }
    writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`)
  } catch {
    /* 写不进去就算了 */
  }
}

/** 进程还活着吗。`kill(pid, 0)` 只做存在性检查，不真的发信号。 */
function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** plan-core 自己那一条（file-guard / companion-core 各写各的，同一个 schema）。 */
const HEALTH = {
  plugin: 'plan-core',
  pid: process.pid,
  startedAt: undefined,
  toolsAvailable: false,
  guardRegistered: false,
  calls: 0,
  lastCallAt: undefined,
}

const ARCHIVE_NAME = '学习档案.md'
const TASK_NAME = '本周任务.md'
const PLAN_NAME = '总规划.md'
/**
 * 变更记录（放在学习根目录，与 `总规划.md` 同级，**只有总规划能写**）。
 *
 * 为什么是「记录每一次改动」而不是「本周通告」：模型没有连续的时间感，它只在被调用时存在，
 * 按「周」维护的内容没人会去更新——旧版本的通告写完之后不会自己过期，会一直被注入。
 * 改成事件流水：每次改计划/下发任务/全局变化就追加一条；条目自带日期，读者自己判断新旧。
 *
 * 为什么**不许读完清空**：
 *   1. 清空 = 读者变成写者。三个科目会话里谁先读到就清了，另外两个永远看不到——广播变成先到先得，
 *      而且直接破坏「一文件一写者」这条整套系统赖以成立的性质。
 *   2. 「别重复打扰」已经由注入去重缓存解决了：同一会话读过一次，内容不变就不会再注入。
 *
 * 它仍然很克制，因为流水天然会变噪音：只记**改动**，不复制任何任务条目。
 */
const NOTICE_NAME = '变更记录.md'
const DEFAULT_MAX_PLAN_LINES = 120
const DEFAULT_MAX_PLAN_BYTES = 8192
const DEFAULT_MAX_TASK_BYTES = 2048
/** 一份任务的生命期（天）：与「本周任务已 N 天未换」的漂移线、跨周重排对齐——同一条事实只写一处。 */
const TASK_MAX_AGE_DAYS = 7
const DEFAULT_MAX_NOTICE_BYTES = 1024
const DEFAULT_STALE_DAYS = 2
const MAX_MVE_PER_SUBJECT = 3
/** 「下周预备」条目上限：不封顶的话每次重写都往里堆，是规划冗余的直接来源。 */
const MAX_NEXT_ITEMS = 5
/** 「本周硬约束」「漂移与风险」同样会增长，一并封顶（上限要盖住所有会增长的区块）。 */
const MAX_CONSTRAINT_ITEMS = 5
const MAX_RISK_ITEMS = 6
/** 变更记录条目上限；更早的由写入者自己删（记录是流水，不是档案）。 */
const MAX_NOTICE_ITEMS = 10
/** 记录条目形如 `- 2026-09-15 计划：跨周重排`，取日期用于读侧一致性检查。 */
const LOG_ENTRY_RE = /^\s*[-*+]\s*(\d{4}-\d{2}-\d{2})\b/
/** 记录条目里最近一条的日期，用于读侧检查「计划改过但记录没跟上」。 */
const LOG_ENTRY_DATE_RE = /^\s*[-*+]\s*(\d{4}-\d{2}-\d{2})/
/** 重写计划必须报备的修订理由（第一项只在磁盘上还没有计划时允许）。 */
const REVISION_KINDS = ['首次制定', '基准刷新', '跨周重排', '学员要求', '漂移处置', '科目变更']
const REVISION_RE = /^\s*(?:[-*]\s*)?本次修订[:：]\s*(.+?)\s*$/m
// 看板的字节上限是**契约数字**：降档逻辑围着它转，测试与体检也要用它，所以导出。
export const BOARD_MAX_BYTES = 4096
/**
 * 头部下限 —— **仅作参考，已不再参与预算计算**（2026-10-06）。
 * 尾部（计划自身 + 可照抄基准行）永不截断，所以预算是"先算尾部实际大小、再把剩下的给头部"。
 * 旧实现扣一个固定常量 BOARD_TAIL_RESERVE = 1536，尾部真实只用 1040B，头部就白丢 496B。
 * 后来又改成 `Math.max(真实余额, 本下限)`，于是尾部一长就把预算抬到真实余额之上 → 看板超上限。
 * 教训：**"兜底下限"和"强制上限"不能同时成立时，上限赢**——撒谎的"装得下"比承认装不下更坏。
 */
export const BOARD_HEAD_MIN_BYTES = 1024
/**
 * 头部压缩档位：从「档案原文」逐级降到「只留核心行」。
 * 旧实现把头部整块拼好再**一刀切尾部**——2 科就切掉最后一科的 ⚠️ 漂移行与全部任务条目，
 * 而那恰恰是代码算出来的事实、模型唯一能据以行动的东西。
 * 现在按优先级渲染：先压缩长散文（进度 / 卡点 / 薄弱——这三样只有该科自己能精简），
 * 任务条目与漂移行最后才动，且永不整条丢弃。
 * item / task / drift 是**按字节的单条上限**，0 = 不截断。
 */
const BOARD_PROSE_FIELDS = [['进度', 'progress'], ['卡点', 'pain'], ['薄弱', 'weak']]
/**
 * 档位排序是**单调递减**的（`verify-board-fit` ⑥ 钉着这一点）：item/task/drift 只许变小、
 * fields 只许变少。前 8 档是为「摘要太长」设计的；后 3 档是**实测补出来的**——2026-10-06 现场
 * 5 科（9 条任务 + 8 条漂移）即使降到「完全不要散文摘要」也还要 2856B，而尾部（永不截断的
 * 计划自身段）占 1357B，头部动态预算只剩 2738B → 最低档也装不下，直接掉进 `cutoffBytes`
 * 把最后一科的任务条**切在半句上**。有了这三档，正常规模的现场再也不需要硬截断。
 */
export const BOARD_HEAD_TIERS = [
  { fields: ['进度', '卡点', '薄弱'], item: 0, task: 0, drift: 0 },
  { fields: ['进度', '卡点', '薄弱'], item: 110, task: 0, drift: 0 },
  { fields: ['进度', '卡点', '薄弱'], item: 80, task: 200, drift: 240 },
  { fields: ['进度', '卡点', '薄弱'], item: 60, task: 160, drift: 200 },
  { fields: ['卡点', '薄弱'], item: 60, task: 160, drift: 200 },
  { fields: ['卡点', '薄弱'], item: 48, task: 130, drift: 160 },
  { fields: ['卡点'], item: 48, task: 130, drift: 160 },
  { fields: [], item: 0, task: 110, drift: 140 },
  { fields: [], item: 0, task: 88, drift: 110 },
  { fields: [], item: 0, task: 64, drift: 88 },
  { fields: [], item: 0, task: 40, drift: 64 },
]

/** 手工构造 snapshot 用户消息（等价 createUserMessage，避免对宿主内部包的脆弱导入）。 */
function snapshotMessage(text) {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text })]),
    source: {
      kind: `plugin:${name}`,
      plugin: name,
      form: 'snapshot',
      sections: Object.freeze([Object.freeze({ name, text })]),
    },
  })
}

// ── 日期与时间戳 ────────────────────────────────────────────────────────────

/**
 * **学习日的分界小时**：凌晨 N 点之前算**前一天**。默认 4。
 *
 * 为什么需要它（用户 2026-09-25 提的）：学员会熬夜，凌晨 1 点还在写代码时，
 * 「今天是几号」按自然日算会突然跳到第二天——于是档案的「更新于」、任务的「生成」、
 * 漂移天数会在同一个学习段里前后不一致，跨零点的会话甚至会因为日期戳"不匹配"被守护拒掉。
 * **学习日的边界应该由学习行为决定，不该由午夜决定。**
 *
 * 单一家：这里定义一次，`companion-core` 与 `file-guard` 都从这里取（三处各写一份必然漂移）。
 * 需要改（比如改成 5 点）只改这一个数——或用环境变量 `DSH_STUDY_DAY_START` 覆盖，
 * 它作用在**整个进程**上，所以两个插件不可能对"今天"得出不同答案。
 */
export const DAY_START_HOUR = (() => {
  const raw = Number(process.env.DSH_STUDY_DAY_START)
  return Number.isInteger(raw) && raw >= 0 && raw <= 23 ? raw : 4
})()

/**
 * 学习日规则的**人话版本**——所有面向模型/学员的日期提示都拼这一句，
 * 免得"凌晨 4 点前算前一天"这个规则在五个地方各写一种说法。
 */
export const DAY_RULE_HINT = DAY_START_HOUR === 0
  ? '（自然日，午夜换天）'
  : `（学习日以凌晨 ${DAY_START_HOUR} 点为界：在此之前算前一天——熬夜也算同一个学习日）`

/**
 * 把一个 Date 格式化成**它自己的本地日历日期**（YYYY-MM-DD），**不做学习日偏移**。
 *
 * ⚠️ 与 `studyDate` 的区别是本文件最容易出错的一处：
 *   · `formatDate(d)` —— 「这个具体日期是几号」（d 常常是从日期串构造的午夜锚点）
 *   · `studyDate(now)` —— 「现在属于哪个学习日」（只看当前时刻）
 * 混用会静默错一天：`weekStart()` 用的是 `new Date('2026-09-24T00:00:00')`，
 * 对它做 4 小时偏移会得到 09-23，于是"周一"整体前移一天。
 */
export function formatDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * 现在属于哪个**学习日**（YYYY-MM-DD）——系统里所有"今天是几号"都用它。
 * 规则：把时刻往前挪 `dayStartHour` 小时，再取日历日期。
 */
export function studyDate(now = new Date(), dayStartHour = DAY_START_HOUR) {
  return formatDate(new Date(now.getTime() - dayStartHour * 3600000))
}

/** today 相对 stamp 的天数差（正数 = stamp 落后 today 多少天）。 */
export function ageDays(stamp, today) {
  if (typeof stamp !== 'string') return undefined
  const days = Math.round((Date.parse(`${today}T00:00:00`) - Date.parse(`${stamp}T00:00:00`)) / 86400000)
  return Number.isFinite(days) ? days : undefined
}

// 日期戳必须**自成一行**（可带列表符）。否则正文里一句「修订于 2026-08-01，更新于 2026-01-01 那版」
// 会被当成真日期戳，两个插件还会对同一份档案得出不同基准。行内出现（任务依据行）用 INLINE_STAMP_RE。
const ARCHIVE_STAMP_RE = /^\s*(?:[-*]\s*)?更新于\s*[:：]?\s*(\d{4})-(\d{2})-(\d{2})/m
const INLINE_STAMP_RE = /更新于\s*[:：]?\s*(\d{4})-(\d{2})-(\d{2})/
const GEN_STAMP_RE = /^\s*(?:[-*]\s*)?生成[:：]\s*(\d{4})-(\d{2})-(\d{2})\s*$/m
const BASIS_RE = /^\s*(?:[-*]\s*)?数据基准[:：]\s*(.+)$/m
const STAMP_VALUE_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/
const NO_ARCHIVE_RE = /^(无档案|无|none)$/i
/** 基准行/小节标题里不允许出现的分隔符——出现在科目名里就无法表示（改名即可）。 */
const BASIS_SEP_RE = /[｜|]/
/** 复选框行：`- [ ]`、`* [x]`、`1. [ ]`、`2) [x]` 都算。 */
const CHECKBOX_RE = /^\s*(?:[-*+]|\d+[.)])\s*\[( |x|X)\]\s*(.+?)\s*$/
/** 控制字符准入：允许换行/回车/制表，其余（含 NUL）一律拒绝——它们会把文件变成工具读不了的二进制。 */
// eslint-disable-next-line no-control-regex
const BAD_CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/

/** 路径归一：大小写、正斜杠、`\\?\` 前缀、`..`、8.3 短名在 Windows 上都指向同一个文件。 */
export function canonicalPath(input) {
  let current = resolve(input)
  const tail = []
  for (;;) {
    try {
      return join(realpathSync.native(current), ...tail.slice().reverse())
    } catch {
      const parent = dirname(current)
      if (parent === current) return resolve(input) // 走到卷根仍不存在：原样返回
      tail.push(basename(current))
      current = parent
    }
  }
}

/**
 * target 是否**真的**在 root 之内（路径意义上的包含，而不是字符串前缀）。
 * 字符串 `startsWith` 会把 `…\ST` 与 `…\ST2` 判成包含关系，也会放过 `\\?\`、正斜杠与小写变体。
 */
export function isWithin(root, target) {
  const rel = relative(canonicalPath(root), canonicalPath(target))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/** 档案正文里的「更新于: YYYY-MM-DD」。 */
export function archiveStamp(content) {
  if (typeof content !== 'string') return undefined
  const m = ARCHIVE_STAMP_RE.exec(content)
  return m === null ? undefined : `${m[1]}-${m[2]}-${m[3]}`
}

/** persona 规定的流水窗口：只留最近 5 个学习日。 */
export const FLOW_DAYS = 5
/** 「一条顶十句」的阈值：一条 200 字节 ≈ 60–70 个汉字，已经是一到两句。 */
export const FLOW_MEGA_BYTES = 200

/**
 * 课堂积累文件名（英语在用；别的科目将来也可以有同名的一份）。
 * 它**不进注入**（按学期累积、会一直长），所以它的规则只能靠"有人去读 + 有人去量"。
 */
export const CLASS_NOTES_NAME = '词汇情景本.md'

/**
 * 文件**自己**规定的拆分阈值：「文件超过约 60 KB（≈ 一学期满量）」→ 把旧的切到
 * `词汇情景本-<学期>.md`（归档、不注入）。★ 这个数字**抄自文件**，不是我定的——
 * 改文件时这里要跟着改，否则就变成一句会漂移的假话（F24）。
 */
export const CLASS_NOTES_SPLIT_BYTES = 60 * 1024

/**
 * **「陪伴」预设的记忆文件**——与 `学习档案.md` 平级的**另一套契约**。
 *
 * 为什么是**另一个文件名**，而不是"给 学习档案.md 加一个 kind 字段"（2026-10-11 学员纠正）：
 * 学员说得很准：*「它的定位不是科目，定位是陪伴，是日常，是聊天」*。
 * 而 `discoverSubjects` 认科目的唯一判据就是**这个文件名**。所以：
 *
 *   改名 ⇒ 它**天然**不是科目 ⇒ 不进看板、不排 MVE、不被逼下发 `本周任务.md`、看板 +0 字节。
 *   加字段 ⇒ 需要新造「科目类型」这一概念，还要在 discoverSubjects / analyzeSubject /
 *            replanVerdict / renderSubjectHead / validatePlan 五处各判一次——**五处都会漏**。
 *
 * 实测（`.verify/probe-companion-corrected.mjs`）：只放这个文件的目录，科目表一字不变、看板 +0 B。
 * 代价是三条既有通路会**同时断掉**（它们都以 `学习档案.md` 为入口），必须逐条补：
 *   ① 注入（companion-core 的档案块）→ `noteName` 配置
 *   ② 去路（`collectHandoffs` 扫兄弟目录）→ 载体表加这个名字
 *   ③ 账本（"收下"凭据只认 `复习提纲.md`）→ 改成"账本 = 你自己的记忆文件"
 *
 * 放这里是因为 **plan-core 是依赖根**（companion-core 与 file-guard 都 import 它，反向会成环），
 * 而看板尾部那一块要由 plan-core 渲染。
 */
export const COMPANION_NOTE_NAME = '心灵笔记.md'
/** 陪伴笔记里**唯一会外流**的那一节：只有这一节的内容会进总规划看板。 */
export const COMPANION_SECTION_PLAN = '要跟总规划说的'
/**
 * 看板尾部最多渲染几条「要跟总规划说的」（**条数**封顶）。
 *
 * 条数封顶**不够**——单条自己曾经没有长度上限，而笔记本身允许 4096 字节：
 * 一条 2000 字的「要跟总规划说的」实测把看板顶到 **7720 字节**，超过看板自己的
 * 4096 上限，还把头部挤到只剩一行截断提示语。所以还需要体量封顶（下面两个常量）
 * 与**预算协商**（见 `buildBoard` 里"这一块只能吃余量"那段）。
 */
export const COMPANION_PLAN_ITEMS_MAX = 2
/** 单条「要跟总规划说的」在看板上最多占多少字节（超出加「…」）。 */
export const COMPANION_ITEM_MAX_BYTES = 150
/**
 * 「心灵的话」整块在看板尾部最多占多少字节。
 *
 * ★ 2026-10-11 修（`test/verify-companion-budget.mjs` 钉着这条）：这一块**不再无条件占尾部**。
 *   尾部永不截断 ⇒ 每字节都从头部预算里扣 ⇒ 原来那一版把 2 条各 120 字的「要说的」
 *   写进尾部时，头部预算被压到 1745，掉进 `cutoffBytes` 的**字节硬截断**：
 *   实测**丢掉 4 条代码算出来的漂移事实**（英语"零回执"、Python 三条），
 *   而 `headTierNotice` 里那句「⚠️ 漂移行与任务条目未丢」在那条路径上是**假的**。
 *
 *   改法一（2026-10-11）：头部**先**按"不含这一块"的预算渲染，这一块只能吃**剩下的余量**。
 *   于是有一条强不变量——**加不加陪伴块，头部逐字节相同**。
 *   余量不够就逐级降（少显示几条 → 只留标题行 → 整块不渲染），绝不反向挤掉学业信息：
 *   拿聊天信息换学业信息，方向是反的。
 *
 * ★ 2026-10-12 学员纠正（*「…就应该有相应的变化，所以这个可能还需要预设自己来判断，
 *   不是那种说什么就写什么」*）之后，"只吃余量"这条**不成立了**——实测（`.verify/measure-judgment-fit.mjs`）：
 *   现场看板 3878/4096，头部**已经在最低档**（摘要整段省略）、余量只剩 **104 B**，
 *   而一条判断至少要 ~180 B ⇒ 这一块**根本不渲染**，只留一句指路（= 通道静默失效）。
 *   而头部**降无可降**：再压就是 `cutoffBytes` 硬截断，会丢漂移与任务条目
 *   ——那正是上面 2026-10-11 修掉的同一个后果，也是 `verify-board-fit` 钉死的不变量。
 *   ⇒ 两头都挤不出来。所以这一块改成**自己的预算**（下面这个常量），
 *     从"看板 4096 里的余量"变成"看板之后独立的一块"：
 *       · 头部逐字节不变（强不变量**继续成立**，学业信息一个字节都不让）
 *       · 看板的 4096 仍然只装学业内容
 *       · 这一块自己有上限，只在学员真的写了东西时才出现
 *   代价（如实记）：整条注入的上限从 4096 变成 4096 + 512 = 4608 B。
 *
 * 为什么 400 → 512：400 装不下"两条各 150 B 的判断 + 固定开销"（实测 460 B），
 * 会退到把每条压到 70 B（≈23 个汉字）——一句话的判断被截半句，比不显示更糟。
 */
export const COMPANION_BLOCK_MAX_BYTES = 512

/**
 * 从陪伴笔记里取「要跟总规划说的」那一节的条目（**只有这一节外流**）。
 *
 * 自动看板的投递边界在本函数：其他章节不渲染。载体读取仍是全文，非文件 ACL；
 * 学科定向移交由 companion-core 另行限定章节与目标。
 * @returns {Array<string>} 去掉列表符的条目文本
 */
export function companionPlanItems(noteText, max = COMPANION_PLAN_ITEMS_MAX) {
  if (typeof noteText !== 'string') return []
  const lines = noteText.replaceAll('\r\n', '\n').split('\n')
  const start = lines.findIndex((l) => /^##\s+/.test(l) && l.includes(COMPANION_SECTION_PLAN))
  if (start < 0) return []
  let end = lines.length
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s+/.test(lines[i])) {
      end = i
      break
    }
  }
  const out = []
  for (let i = start + 1; i < end && out.length < max; i += 1) {
    // 列表符后面**必须有空白**才算条目：`*斜体说明*` 不是条目，而它的第一个字符恰好是 `*`
    // （实测踩过：生成器把各节说明写成斜体，于是空笔记也在看板上占了一行）。
    const m = /^\s*[-*]\s+(\S.*)$/.exec(lines[i])
    if (m === null) continue
    const item = m[1].trim()
    // 占位行（整行被全角括号包住）不算内容。
    if (/^[（(].*[）)]$/.test(item)) continue
    out.push(item)
  }
  return out
}

/**
 * 渲染看板尾部的「心灵的话」块，**在给定字节预算内**（超出就逐级降，而不是挤头部）。
 *
 * @param {string|undefined} noteRaw 陪伴笔记全文
 * @param {number} maxBytes 这一块最多能占多少字节（含自己前面那个空行）
 * @returns {string[]} 要 push 进 tail 的行；`[]` = 完全不渲染（余量连标题都放不下）
 *
 * 降级顺序（**先舍聊天信息，再舍学业信息**——方向不能反）：
 *   ① 全部条目（每条截到 COMPANION_ITEM_MAX_BYTES）
 *   ② 少显示几条（从**最后一条**开始丢；最新的在最前面，先保最新）
 *   ③ 只留标题行 + 一句"去看原文件"
 *   ④ 整块不渲染
 * 前 3 档都带销账方式（否则"说了但没说怎么销账"，条目会永远挂着）。
 */
function companionTailBlock(noteRaw, maxBytes) {
  if (typeof noteRaw !== 'string' || noteRaw.trim().length === 0) return []
  const items = companionPlanItems(noteRaw)
  if (items.length === 0) return []
  const noteStamp = archiveStamp(noteRaw) ?? '无日期戳'
    // ★ 2026-10-12 学员纠正：*「…就应该有相应的变化，所以这个可能还需要预设自己来判断，
  //   不是那种说什么就写什么」* —— 这一块装的是**陪伴判断出的影响**，不是学员说的话。
  //   所以标题不用「要说的」（读作转述），用「待规划处理」（读作待办）；销账行也点明
  //   **由陪伴自己删**——规划删不掉这一行（那是陪伴的文件，写了会被守护拒绝）。
  const head = `■ 心灵（陪伴，不是科目）｜笔记 ${noteStamp}｜${items.length} 条待规划处理`
  const absorb = '  变更记录.md 记对应结果；心灵据此核对（同日也算）'
  const b = (s) => Buffer.byteLength(s, 'utf8')
  // 这些行是 `splice` 进 tail 的：k 行插进去，新增字节 = join('\n') + 1（那个连接用的换行）。
  // ⚠️ 第一版写成 `+ lines.length` —— 高估了 (k-1) 字节，会让本可整条显示的条目**无谓降级**。
  //    高估是"安全"的（不会溢出），但会静默地把功能做残：这正是本文件反复记的那个形状。
  const cost = (lines) => b(lines.join('\n')) + 1
  const build = (n, cap) => {
    const lines = ['', head]
    for (const it of items.slice(0, n)) lines.push(`  · ${ellipsisBytes(it, cap)}（心灵 ${noteStamp}）`)
    lines.push(absorb)
    return lines
  }

  // ①②③ 先试「全量」，再逐条减，再逐级压单条。
  //   顺序是**先舍条数、后舍长度**：一条完整的意思比两条都只剩半句更有用。
  //   （实测现场余量只有 ~252B：一条 20 字的能整条显示，两条各 120 字的会退到压长度。）
  for (const cap of [COMPANION_ITEM_MAX_BYTES, 100, 70, 45]) {
    for (let n = Math.min(items.length, COMPANION_PLAN_ITEMS_MAX); n >= 1; n -= 1) {
      const lines = build(n, cap)
      if (cost(lines) <= maxBytes) return lines
    }
  }

  // ④ 只留标题 + 指路。正文一个字都不放，避免半个句子被当成完整意思。
  const lean = [
    '',
    `${head}（独立块预算不足，正文未展开：请陪伴精简或确认安排信息）`,
    absorb,
  ]
  if (cost(lean) <= maxBytes) return lean

  // ⑤ 连标题都放不下：整块不渲染。**不静默**——调用方会补一句"去哪看"（见 buildBoard）。
  return []
}

/**
 * **课堂积累文件的体量卫生**（2026-10-09 学员问「只写在文件里面能不能起到良好的规范作用」）。
 *
 * 为什么需要：把该文件的 10 条约束逐条判定"守护结构上能否执行"后，能管的只有 3 条
 * （文件名唯一 / 不按周新建 / 写者范围），其余 5 条（产量上限、复习=召回、裸说稿自己写……）
 * 是"一句话怎么说"，**守护看不到**。而**"超过 60KB 就拆"这条是机械事实、完全量得出来**，
 * 却原来没有任何地方在查 —— 又是一次「规定写在文件里、没有代码在查」（F27 的同族）。
 * 按 F26 的纪律：**别等超过了才说**，接近阈值就该报。
 *
 * @returns {{exists:boolean, bytes:number, splitAt:number, ratio:number, nearSplit:boolean,
 *            family:string[], splitDone:boolean}}
 */
export function classNotesHygiene(cwd) {
  const abs = join(cwd, CLASS_NOTES_NAME)
  let probe
  try {
    probe = statSync(abs)
  } catch {
    return { exists: false, bytes: 0, splitAt: CLASS_NOTES_SPLIT_BYTES, ratio: 0, nearSplit: false, family: [], splitDone: false }
  }
  // F11：存在但读不到（目录 / 权限）不能当 0 字节——那会让"很大"看起来"很空"。
  if (!probe.isFile()) {
    return { exists: true, bytes: 0, splitAt: CLASS_NOTES_SPLIT_BYTES, ratio: 0, nearSplit: false, family: [], splitDone: false, unreadable: true }
  }
  let bytes = probe.size
  try {
    bytes = Buffer.byteLength(readFileSync(abs, 'utf8'), 'utf8')
  } catch {
    /* 用 stat 的大小兜底：问不出内容不等于没有大小 */
  }
  // 同族文件：拆分之后 `词汇情景本-2026秋.md` 是**合法的**（归档），
  // 但 `词汇情景本-2.md` / `词汇情景本2.md` 这类才是违反「一份，一直用」。
  let family = []
  try {
    family = readdirSync(cwd).filter((n) => n.startsWith('词汇情景本') && n.endsWith('.md'))
  } catch {
    /* 列不出来就不报 */
  }
  const archives = family.filter((n) => new RegExp(`^词汇情景本-.+\\.md$`).test(n))
  const suspicious = family.filter((n) => n !== CLASS_NOTES_NAME && !archives.includes(n))
  const ratio = Math.round((100 * bytes) / CLASS_NOTES_SPLIT_BYTES)
  return {
    exists: true,
    bytes,
    splitAt: CLASS_NOTES_SPLIT_BYTES,
    ratio,
    nearSplit: ratio >= 85, // F26：接近就说，别等撞上
    family,
    splitDone: archives.length > 0,
    suspicious,
  }
}

/**
 * **档案卫生**：把 persona 里那几条"写状态不写流水账"的规定，变成**算得出来的数字**。
 *
 * 为什么需要（2026-10-06 学员问「这个网安的学习档案总是满呢？」）：
 *   实测网安档案 6113/6144 = **99%**，但它只有 31 行 —— 平均 197 字节/行（英语是 91）。
 *   逐条量下去，根因是 persona 里**本来就有**的两条规定被违反了：
 *     · 「『已答主题与卡点』只留最近 5 个学习日的流水」→ 实际覆盖 7 个日期（超窗）
 *     · 「每条一句话」→ 最长一条 **931 字节**（一条占档案 15%）
 *   而这两条**只有 persona 在说，没有代码在查**（60 行 / 6KB 有守护硬拒，这两条没有）。
 *   于是模型只在**被拒之后**才压缩，档案长期贴着 99% 跑，每次写入都在打架。
 *   —— 又一次「声明 ≠ 执行」；这次的声明写在 persona 里。
 *
 * 所以这里把它变成事实：算出来、注入给模型（见 companion-core）、体检里报出来。
 * **不硬拒**（那会让模型为了合法而删掉有用信息），只让它**在被拒之前就知道自己超了**。
 *
 * @returns {{flowItems:number, flowDates:string[], longestFlow:number, flowBytes:number,
 *            bytes:number, ratio:number, overWindow:boolean, megaItems:number}}
 */
export function archiveHygiene(content) {
  const text = String(content ?? '')
  const bytes = Buffer.byteLength(text, 'utf8')
  const lines = text.replaceAll('\r\n', '\n').split('\n')
  // 只看「已答主题与卡点」这一节：它是流水所在的地方（薄弱点那一节是要长期保留的，不算流水）
  const flow = []
  let inFlow = false
  for (const l of lines) {
    const h = /^##\s*(.+?)\s*$/.exec(l)
    if (h !== null) { inFlow = h[1].includes('已答主题'); continue }
    if (inFlow && /^\s*[-*]\s*\S/.test(l)) flow.push(l.trim())
  }
  // 日期怎么认 —— 这里踩过两个坑，都踩在**漏报**那一侧（漏报会让窗口检查静默通过）：
  //   ① C 科写成 `- **09-22**：…`（日期被 ** 包住 + 全角冒号）→ 只认裸行首日期会**一条都认不出**，实测报「0 天」。
  //   ② 英语把日期写在句中（`- 已答（…）：09-04 …｜09-08 …`）→ 同样认不出。
  // 所以分两个口径，并且**取并集判超窗**：
  //   · flowDates    行首口径（去掉 ** 和 ` 之后仍在行首）—— 回答"有几条是当天的流水"
  //   · flowDatesAny 全行口径（只收**合法** MM-DD：月 01–12、日 01–31）—— 回答"这一节一共谈到了几天"
  // 全行口径会顺带把 `09-23～09-26` 这种写成 2 天。**故意宁可多报**：这套系统的取向是「宁可有声地错」，
  // 唠叨一句远好过静默漏掉一个真实的超窗。`18-11`（月 18 不合法）、`4f60`（不匹配）都会被自动排除。
  const DATES_OK = /\b(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/g
  const dates = new Set()
  const datesAny = new Set()
  for (const l of flow) {
    const bare = l.replaceAll('**', '').replaceAll('`', '')
    const m = /^[-*]\s*(\d{2}-\d{2})\b/.exec(bare)
    if (m !== null) dates.add(m[1])
    for (const d of l.matchAll(DATES_OK)) datesAny.add(d[0])
  }
  const sizes = flow.map((l) => Buffer.byteLength(l, 'utf8'))
  const flowBytes = sizes.reduce((a, b) => a + b, 0)
  return {
    flowItems: flow.length,
    flowDates: [...dates],
    flowDatesAny: [...datesAny],
    longestFlow: sizes.length === 0 ? 0 : Math.max(...sizes),
    megaItems: sizes.filter((n) => n > FLOW_MEGA_BYTES).length,
    flowBytes,
    bytes,
    ratio: bytes === 0 ? 0 : Math.round((flowBytes / bytes) * 100),
    // 超窗判据用**并集**：两个口径任一说超了就算超（见上"宁可多报"）
    overWindow: dates.size > FLOW_DAYS || datesAny.size > FLOW_DAYS,
    days: Math.max(dates.size, datesAny.size),
    megaThreshold: FLOW_MEGA_BYTES,
    dayWindow: FLOW_DAYS,
  }
}

/** 从 MVE 区块里数出「每个科目小节各有几条复选框」。 */
function mveCounts(content) {
  const all = String(content ?? '').split('\n')
  const start = all.findIndex((l) => /^##\s+/.test(l) && l.includes('MVE'))
  if (start < 0) return []
  let end = all.length
  for (let i = start + 1; i < all.length; i += 1) {
    if (/^##\s+/.test(all[i])) { end = i; break }
  }
  const out = []
  let cur
  for (let i = start + 1; i < end; i += 1) {
    const h = /^###\s+(.+?)\s*$/.exec(all[i])
    if (h !== null) {
      cur = { name: h[1].replace(/[:：]\s*$/, '').trim(), used: 0 }
      out.push(cur)
      continue
    }
    if (cur !== undefined && CHECKBOX_RE.test(all[i])) cur.used += 1
  }
  return out
}

/**
 * **计划卫生**：把 `总规划.md` 各**封顶区块的占用**算成数字。
 *
 * 为什么需要（2026-10-08 学员问「我的规划文档似乎也遇到了字数不够的问题」）：
 *   实测 `总规划.md` **4199B / 8192B = 51%** —— 字节预算**只用了一半**，
 *   可是四个封顶区块里 **三个已经满了**：
 *     · 本周硬约束 5/5（上限 5）· 漂移与风险 6/6（上限 6）· 下周预备 5/5（上限 5）· 网安 MVE 3/3
 *   ⇒ **卡住它的不是字节，是"格子"。**
 *   而"格子满了"这件事，`validatePlan` 只在**你写了第 6 条之后**才说 —— 写入之前、
 *   看板上、注入里，**没有任何地方告诉你**。于是每想补一件事，都要先试一次、被拒一次、
 *   删一条、再试一次，一个回合就这么烧掉了。
 *   —— 跟档案那边（见 `archiveHygiene`）**同一个形状**：规定写在 persona 里、没有代码在查。
 *   只是那次管的是"字节/天数"，这次管的是"条数"。
 *
 * 所以这里把它变成事实：算出来 → 注入进看板（见 `buildBoard` 尾部）→ 体检里报出来。
 * **不硬拒**（那会让模型为了合法而删掉有用信息），只让它**在动笔之前就知道还剩几个格子**。
 *
 * @param planRaw `总规划.md` 全文（undefined = 还没有计划）
 * @param subjects 科目列表（仅用于将来扩展；当前占用统计不依赖它）
 * @returns {{exists:boolean, bytes:number, lines:number, maxBytes:number, maxLines:number,
 *            blocks:Array<{key:string,name:string,used:number,cap:number,room:number,full:boolean}>,
 *            mve:Array<{name:string,used:number,cap:number,room:number,full:boolean}>,
 *            full:string[], fullCount:number}}
 */
export function planHygiene(planRaw, subjects = []) {
  const text = String(planRaw ?? '')
  const blocks = [
    { key: 'constraints', name: '硬约束', used: listItemsInSection(text, '硬约束').length, cap: MAX_CONSTRAINT_ITEMS },
    { key: 'risks', name: '漂移', used: listItemsInSection(text, '漂移').length, cap: MAX_RISK_ITEMS },
    { key: 'next', name: '预备', used: listItemsInSection(text, '下周预备').length, cap: MAX_NEXT_ITEMS },
  ].map((b) => ({ ...b, room: b.cap - b.used, full: b.used >= b.cap }))
  const mve = mveCounts(text).map((m) => ({
    ...m,
    cap: MAX_MVE_PER_SUBJECT,
    room: MAX_MVE_PER_SUBJECT - m.used,
    full: m.used >= MAX_MVE_PER_SUBJECT,
  }))
  const full = [
    ...blocks.filter((b) => b.full).map((b) => b.name),
    ...mve.filter((m) => m.full).map((m) => `MVE ${m.name}`),
  ]
  return {
    exists: text.trim().length > 0,
    bytes: Buffer.byteLength(text, 'utf8'),
    lines: text === '' ? 0 : text.split('\n').length,
    maxBytes: DEFAULT_MAX_PLAN_BYTES,
    maxLines: DEFAULT_MAX_PLAN_LINES,
    blocks,
    mve,
    full,
    fullCount: full.length,
    subjectCount: subjects.length,
  }
}

/** 计划/任务正文里的「生成: YYYY-MM-DD」。 */
export function genStamp(content) {
  if (typeof content !== 'string') return undefined
  const m = GEN_STAMP_RE.exec(content)
  return m === null ? undefined : `${m[1]}-${m[2]}-${m[3]}`
}

/** 任务正文里的「依据: … 学习档案 更新于 YYYY-MM-DD」（行内，不要求自成一行）。 */
export function basisStamp(content) {
  if (typeof content !== 'string') return undefined
  const line = /^\s*(?:[-*]\s*)?依据[:：].*$/m.exec(content)
  if (line === null) return undefined
  const m = INLINE_STAMP_RE.exec(line[0])
  return m === null ? undefined : `${m[1]}-${m[2]}-${m[3]}`
}

/**
 * 解析「数据基准: 英语=2026-09-09｜网安=2026-09-09」→ Map<科目, 日期|'无档案'>。
 * 手写切分而不是正则字符集：科目名里带 `=`（如 `A=B`）时，按**最后一个** `=` 断才不会截断名字，
 * 否则看板给出的「照抄行」自己就过不了自己的校验，模型怎么写都会被拒。
 */
export function parseBasis(content) {
  const out = new Map()
  if (typeof content !== 'string') return out
  const line = BASIS_RE.exec(content)
  if (line === null) return out
  for (const raw of line[1].split(BASIS_SEP_RE)) {
    const item = raw.trim()
    if (item.length === 0) continue
    const eq = item.lastIndexOf('=')
    if (eq <= 0) continue
    const name = item.slice(0, eq).trim()
    const value = item.slice(eq + 1).trim()
    if (name.length === 0) continue
    if (NO_ARCHIVE_RE.test(value)) {
      out.set(name, '无档案')
      continue
    }
    if (STAMP_VALUE_RE.test(value)) out.set(name, value)
  }
  return out
}

/** 渲染数据基准行（守护拒绝时回给模型，让它直接照抄正确值）。 */
export function renderBasis(subjects) {
  return `数据基准: ${subjects.map((s) => `${s.name}=${s.archiveStamp ?? '无档案'}`).join('｜')}`
}

// ── 读取与解析 ──────────────────────────────────────────────────────────────

function readText(abs) {
  try {
    return readFileSync(abs, 'utf8')
  } catch {
    return undefined
  }
}

function fileSignature(abs) {
  try {
    const st = statSync(abs)
    return `${st.size}@${Math.round(st.mtimeMs)}`
  } catch {
    return '-'
  }
}

/** 按 `## ` 标题切段：返回 Map<标题, 该段正文行数组>。 */
function sectionsOf(content) {
  const map = new Map()
  let cur
  for (const line of content.split('\n')) {
    const h = /^##\s+(.+?)\s*$/.exec(line)
    if (h !== null) {
      cur = h[1]
      map.set(cur, [])
      continue
    }
    if (cur !== undefined) map.get(cur).push(line)
  }
  return map
}

/** 段内要点清洗：去掉列表符 / 引用符 / 加粗标记与空行，单条截断到 90 字。 */
function itemsOf(body) {
  return body
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith('#'))
    .map((s) => s.replace(/^[-*>]\s*/, '').replace(/\*\*/g, ''))
    .filter((s) => s.length > 0)
    .map((s) => (s.length > 90 ? `${s.slice(0, 90)}…` : s))
}

/** 取某个字段段的**前** n 条要点。用于**优先级列表**：重要的写在前面。 */
function pick(sections, keys, n) {
  for (const [title, body] of sections) {
    if (!keys.some((k) => title.includes(k))) continue
    const items = itemsOf(body).slice(0, n)
    if (items.length > 0) return items
  }
  return []
}

/**
 * 取某个字段段的**末** n 条要点，用于**日志型段落**：新的写在后面。
 * 「已答主题与卡点」是按时间追加的流水，取头部会把最老的几条当成"当前卡点"
 * 送上全科看板——实测网安档案最前面两条是 09-04 的「网安是什么 / 定位与起步」，
 * 而 09-15、09-16 的条目永远送不到计划模型眼前。
 * 「学校当前进度」是总述在前、「未消化薄弱点」是最阻塞的在前，都仍用 pick。
 */
function pickTail(sections, keys, n) {
  for (const [title, body] of sections) {
    if (!keys.some((k) => title.includes(k))) continue
    const all = itemsOf(body)
    const items = all.slice(Math.max(0, all.length - n))
    if (items.length > 0) return items
  }
  return []
}

/** 统计正文里的复选框：`- [ ]` 未完成、`- [x]` 已完成（有序列表 `1. [ ]` 也算）。 */
export function checkboxes(content) {
  const done = []
  const open = []
  for (const line of content.split('\n')) {
    const m = CHECKBOX_RE.exec(line)
    if (m === null) continue
    ;(m[1] === ' ' ? open : done).push(m[2])
  }
  return { done, open }
}

/**
 * 取某个「## 含关键词」小节里的列表条目（复选框行不算）。
 * 用来给每个会增长的区块单独封顶——只封一处等于没封。
 */
export function listItemsInSection(content, keyword) {
  const all = content.split('\n')
  const start = all.findIndex((l) => /^##\s+/.test(l) && l.includes(keyword))
  if (start < 0) return []
  const items = []
  for (let i = start + 1; i < all.length; i += 1) {
    if (/^##\s+/.test(all[i])) break
    if (CHECKBOX_RE.test(all[i])) continue
    if (/^\s*(?:[-*+]|\d+[.)])\s+\S/.test(all[i])) items.push(all[i].trim())
  }
  return items
}

/**
 * 单行/单条摘要截断：超上限就切到接近上限并加一个「…」。maxBytes <= 0 表示不截断。
 * 按**字节**二分（中文 3 字节/字），并且不把代理对切成半个字符。
 */
function ellipsisBytes(text, maxBytes) {
  if (!(maxBytes > 0)) return text
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  const room = maxBytes - 3 // 「…」自己占 3 字节
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (Buffer.byteLength(text.slice(0, mid), 'utf8') <= room) lo = mid
    else hi = mid - 1
  }
  let end = lo
  const last = text.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end -= 1
  return `${text.slice(0, end)}…`
}

/**
 * 按**字节**（不是 UTF-16 码元）截断到上限。旧实现用字节判断、用码元切，
 * 两种错都出过：「明明超了却一个字符没切」和「真切了，却把唯一的可照抄基准行切掉」。
 * 现在这只是**最后一道兜底**（科目多到连「只留核心行」都装不下）；正常的超长由
 * BOARD_HEAD_TIERS 分档处理，不再整块切尾。
 *
 * ★ 2026-10-06 修：提示语自己也要占地方。旧实现先切到 maxBytes、**再**追加这行提示，
 * 于是返回值必然比 maxBytes 多 118B（正是那行提示的长度），看板总字节 4214 > 上限 4096 —— 
 * **"强制上限"的函数自己突破了上限**。现在先扣掉提示语的字节再切。
 *
 * ★ 2026-10-11 修**文案撒谎**：旧文案只说"各科摘要要还原…"，读起来像"只是摘要被压短了"，
 *   而这条路径恰恰是**末尾几科被整段切掉、它们的漂移与任务条目一并丢失**（实测 5 科时
 *   丢掉 4 条漂移）。头部降档时那句「⚠️ 漂移行与任务条目未丢」在这条路径上不成立，
 *   但它在 `candidate` 的**最后一行**、而这里切的是**尾部** —— 所以它总是**第一个被切掉**，
 *   于是模型永远看不到任何"有东西丢了"的提示。现在把这句话直接写进提示语本身。
 *   （提示语变长约 60B 是**安全**的：room 已经把它扣掉了，只是正文少留 60B，总量不涨。）
 */
const CUTOFF_NOTICE = '\n…（看板过长已按上限截断：**末尾几科被整段切掉**，它们的漂移与任务条目也一并丢了，别当成"它们没事"。还原请到该科预设精简档案——总规划只读档案）'
function cutoffBytes(text, maxBytes) {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  const room = maxBytes - Buffer.byteLength(CUTOFF_NOTICE, 'utf8')
  if (room <= 0) return CUTOFF_NOTICE.trimStart() // 预算连提示语都放不下：只留提示，至少不撒谎
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (Buffer.byteLength(text.slice(0, mid), 'utf8') <= room) lo = mid
    else hi = mid - 1
  }
  let end = lo
  const last = text.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end -= 1 // 别把代理对切成半个字符
  return `${text.slice(0, end)}${CUTOFF_NOTICE}`
}

/** 正文准入：控制字符（含 NUL）会把文件变成工具再也读不了的二进制。违规返回拒绝原因。 */
export function screenText(content, label) {
  if (typeof content !== 'string') return `${label}内容必须是字符串`
  if (BAD_CONTROL_RE.test(content)) return `${label}含控制字符（如 NUL），会导致该文件之后无法被读取或编辑。请去掉这些字符再写入`
  return undefined
}

/**
 * 读一个受管文件，把**三种结果分开**（F11）：
 *
 *   { ok: true, text }                        读到了
 *   { ok: false, missing: true }              真的不存在（ENOENT）——"还没建"，正常
 *   { ok: false, missing: false, code, name } **存在但这次读不到**——权限 / 被占用 / 是目录 / 磁盘错
 *
 * 旧实现一律返回 `undefined`，于是"读不到"和"还没建"长得一模一样，而后果是**三个静默失效**：
 *   1. `companion-core` 的注入凭空消失，模型不知道有这一科；
 *   2. 科目从总规划看板上凭空消失（看起来像被删了）；
 *   3. **`looksLikeStudyRoot` 会把整个学习树判成"不是学习树"，于是守护不再执法。**
 * 放在 plan-core 是因为它是依赖根（companion-core / file-guard 都 import 它），一处实现三处用。
 */
export function readProbe(abs, name) {
  try {
    return { ok: true, text: readFileSync(abs, 'utf8') }
  } catch (e) {
    return {
      ok: false,
      missing: e?.code === 'ENOENT',
      code: e?.code ?? String(e?.message ?? e),
      name: name ?? basename(abs),
    }
  }
}

/**
 * **跨科移交标记**：档案里以 `@<科目>` 开头的条目。
 *
 * 语法：`- @Python：变量名不能含短横线` / `- @Python 09-28 列表忘下标`（日期可选）。
 *
 * 为什么需要它（2026-09-28 学员追问"所以之后要我自己在对应的学科里提醒吗"）：
 * 上一版把移交设计成"发现方**直接写进目标科目的复习提纲**"。那是个**跨文件动作**——
 * 在打 CTF 的中途很容易不做，而**不做的话任何地方都不会有痕迹**（正是这套系统一直
 * 在消灭的那种静默失败）。而且它把搬运工的活推给了学员。
 *
 * 改成"**在自己本来就要写的档案里打一个标记**，剩下由代码送到位"之后：
 *   · 发现方只碰自己的文件（它本来就在写）；
 *   · 目的地由**代码**解析（`companion-core` 注入给目标科目、`study-doctor` 报悬空）；
 *   · 目标科目下一次开会话**就会看到**，不需要谁去传话、也不需要学员当搬运工。
 *
 * ⚠️ 2026-09-28 实测教训：网安会话**自发**做了移交，但它写的形态是
 * `- 09-28 \`@Python\` 表达式三件套：…`（反引号包着、夹在日期之后），
 * 而这里要求 `@` **紧跟子弹行开头** → **代码一条也认不出来**（parseHandoffs 返回 0）。
 * 结论：标记的语法必须**又短又唯一**，而且 persona 里的例子要跟解析器**逐字对齐**；
 * 宁可放宽解析（见下面的 `@` 允许出现在日期前后），也不要让"人写对了、机器看不见"。
 *
 * 语法刻意做成"子弹行 + `@` 开头"：档案正文里到处是 `→`（"进度 → 卡点"这类），
 * 用箭头当标记必然误判；`@` 在现有档案里几乎不出现，且一眼能看出"这条是给谁看的"。
 * 日期可选——没写就用**来源档案的「更新于」**兜底（那时"什么时候发现的"本来就是那一天）。
 */
const HANDOFF_RE = /^\s*[-*]\s*(\d{2}-\d{2})?\s*`?@([^\s:：,，`]+)`?\s*[:：]?\s*(?:(\d{2}-\d{2})\s+)?(.+?)\s*$/

/**
 * 取出一份档案里所有跨科移交标记。
 *
 * ★ 2026-10-07 修：行首那个 `MM-DD` 原本是**非捕获组**（`(?:…)`），被静默丢掉，
 *   于是 `h.date` 退回**来源档案的「更新于」** —— 而「更新于」每写一次档案就变。
 *   后果是**判据不稳定**：网安在 09-28 标给 Python，Python 提纲里老实写着
 *   `（源:网安 2026-09-28）`，但算出来的键是 `网安@2026-10-06` → 永远对不上 →
 *   **"已收下"的条目被无限重复提醒**（实测：网安档案 10-06 更新后，Python 那 9 条
 *   已经收好的知识点仍报「待收 1 条」）。
 *   真正的时间戳**是学员自己写在行首的那个日期**，不是"档案最后一次被改的时间"。
 *
 * 优先级：行首 `MM-DD` > `@科目` 之后的 `MM-DD` > `fallbackDate`（来源档案的「更新于」）。
 *
 * 年份：档案里只写 `MM-DD`，年份得补。补出来的日期**不可能是未来**（你没法记录明天发生的事），
 * 所以算出未来就说明跨了年、退一年。**这里必须钉死**——年末标、年初读时算错年份，
 * 「已收下」的凭据 `来源@日期` 就永远对不上，会变成**无限重复提醒**（跟上面那个 bug 同一类）。
 * @param archiveText 档案全文
 * @param options.source 来源科目名（写进结果的 `source`）
 * @param options.fallbackDate 条目没写日期时用的（一般是该档案的「更新于」，`YYYY-MM-DD`）
 * @param options.now 判"未来"用的今天（默认学习日；测试可注入）
 * @returns {Array<{target:string, date?:string, text:string, source?:string, line:string}>}
 */
export function parseHandoffs(archiveText, { source, fallbackDate, now } = {}) {
  const out = []
  const todayStr = studyDate(now)
  for (const raw of String(archiveText ?? '').replaceAll('\r\n', '\n').split('\n')) {
    const m = HANDOFF_RE.exec(raw)
    if (m === null) continue
    // 行内 `MM-DD` 优先（精确），否则退回来源档案的「更新于」（只要档案有戳就永不为空）
    const monthDay = m[1] ?? m[3]
    let date = fallbackDate
    if (monthDay !== undefined) {
      let year = Number(fallbackDate?.slice(0, 4)) || Number(todayStr.slice(0, 4))
      if (`${year}-${monthDay}` > todayStr) year -= 1
      date = `${year}-${monthDay}`
    }
    out.push({
      target: m[2],
      date,
      text: m[4],
      source,
      line: raw.trim(),
    })
  }
  return out
}

/** 列举根目录下的科目（子目录中存在 `学习档案.md` 的算一个科目）。 */
export function discoverSubjects(root, archiveName = ARCHIVE_NAME) {
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  const out = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const dir = join(root, entry.name)
    const probe = readProbe(join(dir, archiveName), archiveName)
    // 真的没有 → 不是科目。**存在但读不到 → 仍然是科目**：让它消失会让看板看起来像"这科被删了"。
    if (!probe.ok && probe.missing) continue
    out.push({ name: entry.name, dir, archiveRaw: probe.ok ? probe.text : '', unreadable: probe.ok ? undefined : probe.code })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
}

/**
 * 合成一个科目的状态（纯函数，便于单测）。
 * @returns {{name:string, dir:string, archiveStamp?:string, archiveAge?:number,
 *            lines:number, bytes:number, progress:string[], pain:string[], weak:string[],
 *            task:{exists:boolean, stamp?:string, age?:number, done:string[], open:string[]},
 *            receiptDate?:string, drift:string[]}}
 */
export function analyzeSubject({ name: subName, dir, archiveRaw, taskRaw, today, staleDays = DEFAULT_STALE_DAYS, unreadable }) {
  const sections = sectionsOf(archiveRaw)
  const archiveStampValue = archiveStamp(archiveRaw)
  const state = {
    name: subName,
    dir,
    archiveStamp: archiveStampValue,
    archiveAge: ageDays(archiveStampValue, today),
    lines: archiveRaw.split('\n').length,
    bytes: Buffer.byteLength(archiveRaw, 'utf8'),
    progress: pick(sections, ['进度'], 2),
    pain: pickTail(sections, ['卡点'], 2),
    weak: pick(sections, ['薄弱'], 3),
    task: { exists: false, done: [], open: [] },
    drift: [],
  }
  if (unreadable !== undefined) {
    // F11：文件在、但读不到。**不能让派生的漂移行冒充事实**——"缺少日期戳"会让人以为档案坏了，
    // 而我们其实只是没读到它。这一条必须说清"我们对它一无所知"。
    state.drift.push(`档案存在但读不到（${unreadable}）——本轮关于它的一切判断都不可信，先在本机确认权限/占用`)
  } else if (archiveStampValue === undefined) state.drift.push('档案缺少「更新于: YYYY-MM-DD」日期戳')
  else if (state.archiveAge !== undefined && state.archiveAge >= staleDays) {
    state.drift.push(`档案已 ${state.archiveAge} 天未更新（最后 ${archiveStampValue}）`)
  }

  if (taskRaw === undefined) return state
  const boxes = checkboxes(taskRaw)
  state.task = {
    exists: true,
    stamp: genStamp(taskRaw),
    // 「依据」= 这份任务是按哪一版档案写的。它与 validateTask / 勾选守护用的是**同一个**事实：
    // 判断"该不该重发"要看依据，不是看生成日期（见 replanVerdict.taskWork 的注释）。
    basis: basisStamp(taskRaw),
    age: ageDays(genStamp(taskRaw), today),
    done: boxes.done,
    open: boxes.open,
  }
  const taskAge = state.task.age
  if (taskAge !== undefined && taskAge >= TASK_MAX_AGE_DAYS) state.drift.push(`本周任务已 ${taskAge} 天未换（生成 ${state.task.stamp}）`)
  // 核心漂移信号：任务下发之后，该科档案有没有动过。
  if (state.task.stamp !== undefined && archiveStampValue !== undefined) {
    if (archiveStampValue < state.task.stamp) {
      state.drift.push(`任务下发（${state.task.stamp}）后该科零回执（档案仍停在 ${archiveStampValue}）`)
    } else {
      state.receiptDate = archiveStampValue
    }
  }
  return state
}

/** 读根目录下的科目现状（fs 包装，注入与守护共用）。 */
export function survey(root, today, opts = {}) {
  const archiveName = opts.archiveName ?? ARCHIVE_NAME
  const taskName = opts.taskName ?? TASK_NAME
  const staleDays = opts.staleDays ?? DEFAULT_STALE_DAYS
  return discoverSubjects(root, archiveName).map((s) =>
    analyzeSubject({
      name: s.name,
      dir: s.dir,
      archiveRaw: s.archiveRaw,
      unreadable: s.unreadable,
      taskRaw: readText(join(s.dir, taskName)),
      today,
      staleDays,
    }),
  )
}

/** 计划自身的漂移：数据基准与实际档案是否逐科相符。 */
export function planDrift(planRaw, subjects, today) {
  if (planRaw === undefined) return { exists: false, drift: ['尚无总规划'] }
  const drift = []
  const stampValue = genStamp(planRaw)
  const age = ageDays(stampValue, today)
  if (stampValue === undefined) drift.push('计划缺少「生成: YYYY-MM-DD」日期戳')
  else if (age !== undefined && age >= 7) drift.push(`计划已 ${age} 天未更新（生成 ${stampValue}）`)
  const basis = parseBasis(planRaw)
  const mismatched = []
  for (const s of subjects) {
    const want = s.archiveStamp ?? '无档案'
    const got = basis.get(s.name)
    if (got === undefined) mismatched.push(`${s.name}=未写基准`)
    else if (got !== want) mismatched.push(`${s.name}=基准 ${got} → 实际 ${want}`)
  }
  if (mismatched.length > 0) drift.push(`数据基准与实际不符：${mismatched.join('；')}`)
  const boxes = checkboxes(planRaw)
  return {
    exists: true,
    stamp: stampValue,
    age,
    basis,
    done: boxes.done.length,
    open: boxes.open.length,
    drift,
  }
}

/**
 * 计划里列了哪些科目的 MVE 小节（只扫 `## …MVE…` 那一节里的 `### 科目名`）。
 *
 * 必须与 `validatePlan` 用**同一套扫描口径**：那两个判断本来就该是同一件事的两面
 * （「计划覆盖了哪些科目」），口径一旦分叉就会立刻变成"看板说可以、守护说不行"。
 */
export function planSubjectHeadings(planRaw) {
  if (typeof planRaw !== 'string') return []
  const all = planRaw.split('\n')
  const mveStart = all.findIndex((l) => /^##\s+/.test(l) && l.includes('MVE'))
  if (mveStart < 0) return []
  let mveEnd = all.length
  for (let i = mveStart + 1; i < all.length; i += 1) {
    if (/^##\s+/.test(all[i])) {
      mveEnd = i
      break
    }
  }
  const out = []
  for (let i = mveStart + 1; i < mveEnd; i += 1) {
    const h = /^###\s+(.+?)\s*$/.exec(all[i])
    if (h === null) continue
    out.push(h[1].replace(/[:：]\s*$/, '').trim())
  }
  return out
}

/** 变更记录里最新一条的日期（条目形如 `- 2026-09-15 计划：跨周重排`）。 */
export function newestLogEntryDate(content) {
  if (typeof content !== 'string') return undefined
  let newest
  for (const line of content.split('\n')) {
    const m = LOG_ENTRY_RE.exec(line)
    if (m === null) continue
    if (newest === undefined || m[1] > newest) newest = m[1]
  }
  return newest
}

/**
 * 以周一为一周之始，返回该周的标识日期（YYYY-MM-DD）。
 * 用 `formatDate` 而不是 `studyDate`：入参是从日期串构造的**午夜锚点**，
 * 对它做学习日偏移会整体前移一天（见 formatDate 的注释）。
 */
export function weekStart(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`)
  if (Number.isNaN(d.getTime())) return undefined
  const dow = (d.getDay() + 6) % 7 // 周一 = 0
  d.setDate(d.getDate() - dow)
  return formatDate(d)
}

/**
 * 代码判定「本轮该动什么」。**默认是不动** —— 这是为了治「过于积极地调整规划」：
 * 旧实现把「要不要动笔」交给模型（persona 的触发条件是「或」逻辑，而"有漂移警报"几乎恒真），
 * 结果每轮都重写一份计划，内容只增不减，规划迅速变冗余。
 *
 * 三种动作分开算，因为它们的代价完全不同：
 *   planAction='none'    计划仍有效，一个字都不用改
 *   planAction='refresh' 只有基准过期 → **只改 `生成` 与 `数据基准` 两行**，绝不要重写内容
 *   planAction='rewrite' 跨周 / 计划超 7 天 / 缺日期戳 / 尚无计划 → 才值得重排
 *   taskWork             某科待下发或需按新依据重发（这**不**需要动 `总规划.md`）
 */
export function replanVerdict({ today, subjects, planRaw, planName = PLAN_NAME }) {
  const plan = planDrift(planRaw, subjects, today)
  const reasons = []
  let planAction = 'none'

  const taskWork = []
  for (const s of subjects) {
    if (!s.task.exists) {
      taskWork.push(`${s.name}（未下发）`)
      continue
    }
    // 用「依据」而不是「生成日期」判断该不该重发。
    // 依据是"这份任务按哪一版档案写的"，也正是 validateTask 在写入时校验、勾选守护在编辑时校验的
    // **同一个事实**；曾经这里比的是 `task.stamp < archiveStamp`，会漏掉「当天先下发任务、之后档案
    // 又更新」——那时两个日期相等，看板以为一切正常，可任务已经挂在旧档案版本上、连勾选都会被拒，
    // 而看板又不要求重发 → 又是一处死锁。同一个事实在一处比，才不会两边打架。
    if (s.task.basis !== s.archiveStamp) {
      taskWork.push(`${s.name}（依据 ${s.task.basis ?? '缺失'} 与档案 ${s.archiveStamp ?? '无日期戳'} 不一致，需按新依据重发）`)
    }
  }

  if (!plan.exists) {
    planAction = 'rewrite'
    reasons.push('尚无总规划')
  } else if (plan.stamp === undefined) {
    planAction = 'rewrite'
    reasons.push('计划缺少「生成」日期戳')
  } else if (weekStart(plan.stamp) !== weekStart(today)) {
    planAction = 'rewrite'
    reasons.push(`已跨周（计划属于 ${weekStart(plan.stamp)} 那一周，今天是 ${weekStart(today)} 那一周）`)
  } else if (plan.age !== undefined && plan.age >= 7) {
    planAction = 'rewrite'
    reasons.push(`计划已 ${plan.age} 天未更新`)
  } else if (plan.drift.some((d) => d.includes('数据基准与实际不符'))) {
    planAction = 'refresh'
    // 理由只陈述**事实**，不带动作指令——指令由看板按最终动作渲染。
    // 这里曾经写成「——只刷新基准行即可，内容不用重写」；一旦后面的理由把动作顶成 rewrite，
    // 那句话就会被原样拼进「需要重排。原因：…」里，出现"要求重排又劝你别重写"的自相矛盾。
    reasons.push('数据基准过期（写计划后有科目动过档案）')
  }

  // ── 科目变更：必须**独立**判定，且只能把动作升级、不能降级 ──────────────────────
  //
  // 这是一处真实的死锁（2026-09-16 新增 ST\C / ST\Python 时暴露）：
  //   计划里只有网安/英语两个 `### 小节`，而发现到 4 个科目 → 基准过期让上面的链子停在
  //   `refresh`，看板于是写「**其余内容原样保留，不要重写**」；可 `validatePlan` 又要求
  //   每个科目都有自己的 `### 科目名` 小节。模型照看板做 → 写入必被拒；想补齐小节 →
  //   就必须重写 MVE 区 → 违反看板那句「不要重写」。**两条代码路径结论互相矛盾，选哪条都错。**
  //   （原文这里是 `/*`，未闭合会直接把后面整段代码注释掉；改成行注释，语义不变。）
  //
  // 看板 `none` 分支的文案其实早就写着「没有新科目……就不要重排」，缺的正是这里真的去算它。
  // 放在 else-if 链之外，是因为它要能把已经定下的 `refresh` 顶回 `rewrite`；同时链上的
  // 跨周/超期理由仍会保留在 reasons 里（那些本来就都是重排理由，不冲突）。
  if (plan.exists) {
    const names = subjects.map((s) => s.name)
    const headings = planSubjectHeadings(planRaw)
    const missing = names.filter((n) => !headings.includes(n))
    const extra = headings.filter((h) => !names.includes(h))
    if (missing.length > 0 || extra.length > 0) {
      planAction = 'rewrite'
      const parts = []
      if (missing.length > 0) parts.push(`缺少 ${missing.join('、')}`)
      if (extra.length > 0) parts.push(`多出 ${extra.join('、')}`)
      reasons.push(
        `科目变更：计划里的 MVE 小节${parts.join('，')}——必须重排，把每科的「### 科目名」小节补齐/删掉` +
          `（本周确实没有最小必做的科目也要写一节 +「本周无 MVE」+ 一句理由，不能跳过）`,
      )
    }
  }

  return { planAction, taskWork, reasons, plan, planName }
}


/**
 * 渲染各科区块（不含首行）。tier 决定「哪些长摘要还在、单条压到多少字节」。
 * 无论哪一档：⚠️ 漂移行与任务条目都**不整条丢**——它们是代码判定的事实，
 * 也是模型唯一能据以动手的东西；超长时只截单条文字。
 */
function renderSubjectHead(subjects, tier) {
  const lines = []
  for (const s of subjects) {
    lines.push('', `■ ${s.name}`)
    if (s.archiveStamp === undefined) {
      lines.push(`  档案 无日期戳｜${s.lines} 行 / ${s.bytes} 字节`)
    } else {
      const age = s.archiveAge
      const ageText = age === undefined ? '' : age <= 0 ? '（今天）' : `（${age} 天前）`
      lines.push(`  档案 更新于 ${s.archiveStamp}${ageText}｜${s.lines} 行 / ${s.bytes} 字节`)
    }
    for (const [label, key] of BOARD_PROSE_FIELDS) {
      if (!tier.fields.includes(label)) continue
      const items = s[key]
      if (items.length === 0) continue
      lines.push(`  ${label} › ${items.map((i) => ellipsisBytes(i, tier.item)).join(' ｜ ')}`)
    }
    if (!s.task.exists) {
      lines.push('  本周任务 未下发')
    } else {
      const stampText = s.task.stamp ?? '无日期'
      const ageText = s.task.age === undefined ? '' : s.task.age <= 0 ? '（今天）' : `（${s.task.age} 天前）`
      lines.push(
        `  本周任务 下发于 ${stampText}${ageText}｜MVE ${s.task.done.length + s.task.open.length} 条：已完成 ${s.task.done.length} / 未完成 ${s.task.open.length}`,
      )
      for (const item of s.task.open) lines.push(`    ☐ ${ellipsisBytes(item, tier.task)}`)
      for (const item of s.task.done) lines.push(`    ☑ ${ellipsisBytes(item, tier.task)}`)
    }
    for (const d of s.drift) lines.push(`  ⚠️ 漂移 ${ellipsisBytes(d, tier.drift)}`)
  }
  return lines
}

/** 头部降档时必须说清「你看到的不是全文」，免得模型以为某科没有某条卡点。 */
function headTierNotice(tier) {
  if (tier === BOARD_HEAD_TIERS[0]) return undefined
  const dropped = BOARD_PROSE_FIELDS.filter(([label]) => !tier.fields.includes(label)).map(([label]) => label)
  const what = dropped.length > 0 ? `「${dropped.join('/')}」摘要已整段省略、其余摘要已缩短` : '各科摘要已按预算缩短'
  return `…（头部超预算：${what}；⚠️ 漂移行与任务条目未丢。要还原全文请到该科预设精简档案——总规划只读档案）`
}

/**
 * 合成全科看板（纯函数）。模型每轮读到的就是这段文本，漂移结论全部由代码给出。
 */

export function buildBoard(root, opts) {
  const today = opts.today
  const planName = opts.planName ?? PLAN_NAME
  const subjects = opts.subjects
  const lines = []
  lines.push(
    `【总规划·全科看板】系统当前日期：${today}（一切日期基准）｜学习根目录：${root}｜科目 ${subjects.length} 个`,
  )
  if (subjects.length === 0) {
    lines.push(
      '',
      `⚠️ 未发现任何科目：该目录下没有「子目录 + ${ARCHIVE_NAME}」的结构。请确认本会话工作目录就是学习根目录（各科是它的子目录），不要在这里凭空规划。`,
    )
  }

  const tail = []
  const plan = planDrift(opts.planRaw, subjects, today)
  const verdict = replanVerdict({ today, subjects, planRaw: opts.planRaw })
  tail.push('', `■ 计划自身（${planName}）`)
  if (!plan.exists) {
    tail.push('  尚未创建。先读上面的各科档案，再写一份周看板。')
  } else {
    tail.push(
      `  生成 ${plan.stamp ?? '无日期戳'}${plan.age === undefined ? '' : plan.age <= 0 ? '（今天）' : `（${plan.age} 天前）`}｜MVE 已完成 ${plan.done} / 未完成 ${plan.open}`,
    )
    if (plan.basis !== undefined) {
      tail.push(`  基准 ${plan.basis.size === 0 ? '缺失' : [...plan.basis].map(([k, v]) => `${k}=${v}`).join('｜')}`)
    }
    for (const d of plan.drift) tail.push(`  ⚠️ 漂移 ${d}`)
    // ★ 2026-10-08：把「哪些封顶格子已经满了」报出来。
    //   动机（学员问「我的规划文档似乎也遇到了字数不够的问题」）：写计划时卡住的**不是字节**
    //   （实测只用了 4199/8192 = 51%），而是**条数**——硬约束 5/5、漂移 6/6、预备 5/5、网安 MVE 3/3，
    //   四个格子全满。而"满了"只有在你写了第 N+1 条之后才由 validatePlan 告诉你，
    //   写入之前、看板上、注入里**没有任何地方说** → 每补一件事都要"试一次、被拒、删一条、再试"。
    //   跟档案那边（archiveHygiene）**同一个形状**：规定写在 persona 里、没有代码在查。
    //
    //   ⚠️ 这两行在**永不截断的尾部**里，加多长就从头部预算里扣多长（实测多写 2 行就把看板顶到
    //   4094/4096 并触发硬截断）。所以：**只在真的满了的时候才说话，且压成一行**——
    //   干净时零噪音，满了时一句话说清"要加就得先删"。跟 renderHygiene 同一条纪律。
    const hyg = planHygiene(opts.planRaw, subjects)
    if (hyg.fullCount > 0) {
      const fullSpec = [
        ...hyg.blocks.filter((b) => b.full).map((b) => `${b.name} ${b.used}/${b.cap}`),
        ...hyg.mve.filter((m) => m.full).map((m) => `MVE ${m.name} ${m.used}/${m.cap}`),
      ]
      tail.push(
        `  ⚠️ 格子满了：${fullSpec.join('｜')}——**要加一条就得先删/并一条**（不是字节不够：${hyg.bytes}/${hyg.maxBytes}）`,
      )
    }
  }
  // 变更记录状态 + 读侧一致性检查。
  // 「检测放在读侧」比「指望写入时不忘」可靠：写入是两个文件、无法原子校验，但读的时候一比对就知道漏了。
  const noticeStamp = opts.noticeRaw === undefined ? undefined : genStamp(opts.noticeRaw)
  const newestLog = opts.noticeRaw === undefined ? undefined : newestLogEntryDate(opts.noticeRaw)
  // ★ 2026-10-08：带上**体量**。实测学员在 20:00:28 被拒过一次
  //   `变更记录超过 1024 字节上限（当前 1124 字节）`——而当时只有 **7 条**（条数上限 10 条还有余），
  //   撞的是**字节**墙。看板原本只说「最新一条 2026-10-08」，**不说它有多大**，
  //   于是一个只有 11 行的小文件同样要"被拒了才知道写不下"。
  //   跟总规划那边的"格子满了"是**同一个形状**：能在读侧量出来的，就别留给写入侧去拒绝。
  const noticeSize =
    opts.noticeRaw === undefined
      ? undefined
      : (() => {
          const bytes = Buffer.byteLength(opts.noticeRaw, 'utf8')
          const items = opts.noticeRaw.split('\n').filter((l) => /^\s*[-*+]\s+\S/.test(l)).length
          return { bytes, items }
        })()
  // ⚠️ 尾部**永不截断**，所以这里每多一个字节都从头部预算里扣。原来的那句静态说明
  //   「各科下一轮会读到；追加新条目即可，**不要清空它**（清空等于让读者变成写者，谁先读谁清，别科就永远看不到）」
  //   有 130 字节，而它说的两件事**在注入块里已经说得更全**（见 companion-core 的 renderNotice，
  //   那里有完整的「不要清空/谁先读谁清」解释，且已由 verify-guard-v2 断言）。
  //   看板是"每轮都要挤进 4096"的地方 → 这里压到最短，把预算让给各科摘要。
  const noticeCap = noticeSize === undefined ? '' : `（${noticeSize.bytes}/${DEFAULT_MAX_NOTICE_BYTES} 字节、${noticeSize.items}/${MAX_NOTICE_ITEMS} 条）`
  // 快满时把警告**并进同一行**，不另起一行：尾部永不截断，每多一行都从头部预算里扣，
  // 而头部预算直接决定各科摘要能留多少（见下面 headBudget）。
  const noticeWarn =
    noticeSize !== undefined && (noticeSize.bytes > DEFAULT_MAX_NOTICE_BYTES * 0.85 || noticeSize.items >= MAX_NOTICE_ITEMS)
      ? '｜⚠️ 快满了：加新条目前先删最早的（它是流水不是档案）'
      : ''
  tail.push(
    opts.noticeRaw === undefined
      ? '  变更记录：还没有。（每次改计划 / 下发或重发任务 / 需要全科知道的全局变化，都追加一条）'
      : `  变更记录：最新一条 ${newestLog ?? '无日期条目'}（生成 ${noticeStamp ?? '无日期戳'}）${noticeCap}${noticeWarn}`,
  )
  if (plan.exists && plan.stamp !== undefined) {
    if (opts.noticeRaw === undefined) {
      tail.push(`  ⚠️ 变更记录缺失：计划已存在（生成 ${plan.stamp}），但还没有任何变更记录`)
    } else if (newestLog !== undefined && newestLog < plan.stamp) {
      tail.push(`  ⚠️ 变更记录没跟上：计划生成于 ${plan.stamp}，记录里最新一条是 ${newestLog}——计划改过就要补一条`)
    }
  }

  // ── 陪伴（「心灵」）的话：**唯一**会从聊天侧外流到规划侧的东西 ─────────────────
  // 它不是科目（`discoverSubjects` 只认 学习档案.md），所以上面各科区块里**不会**出现它；
  // 这一块是它与总规划之间**唯一**的通道，且**只有笔记里「要跟总规划说的」那一节**会外流——
  // 其余各节在代码里没有读取路径（结构性隐私，不靠 persona 自觉）。
  //
  // ★ 2026-10-11 修：这一块**不在这里 push**。尾部永不截断 ⇒ 在这里 push 就等于
  //   从头部预算里扣，实测把 2 条各 120 字的「要说的」写进尾部会丢掉 4 条漂移事实
  //   （详见 COMPANION_BLOCK_MAX_BYTES 的注释）。现在改成**头部先按不含它的预算渲染**，
  //   2026-10-12 再修为独立 512B 块（见函数末尾）；整块本体逐字节不变，不依赖余量。
  //
  // 销账不是日期过滤：规划写对应事项结果，陪伴核对后删除或更新；同日也有效。
  //    采纳、说明未采纳、撤回/过期均可结束；新日期或无关记录不是充分凭据。
  const noteRaw = opts.noteRaw
  // 陪伴块的**插入点**：排在变更记录之后、「本轮该动什么」之前。
  // 这里只记位置、不 push——正文等本体定稿后使用自己的独立预算（见函数末尾）。
  const companionAt = tail.length

  // ── 本轮该动什么：由代码判定，默认「什么都不用动」 ─────────────────────────
  // 旧实现在这里写了一句无条件的「漂移警报里的每一条，都要在下一次计划里有明确交代」，
  // 而漂移几乎每轮都非空 → 模型每轮都重写计划，内容只增不减。现在改成按动作分别下指令。
  tail.push('', '■ 本轮该动什么（代码判定，默认什么都不用动）')
  if (verdict.planAction === 'none') {
    tail.push('  计划：仍有效，**一个字都不要改**（不是这一周的新一周、没有新科目、无学员新要求就不要重排）。')
  } else if (verdict.planAction === 'refresh') {
    tail.push('  计划：**只需刷新基准行**——把「生成」改成今天、「数据基准」抄成下面那行，其余内容原样保留，不要重写。')
  } else {
    tail.push(`  计划：需要重排。原因：${verdict.reasons.join('；')}。`)
  }
  if (verdict.taskWork.length > 0) {
    tail.push(`  各科任务：${verdict.taskWork.join('；')}（写 本周任务.md 即可，与改不改计划无关）。`)
  } else {
    tail.push('  各科任务：均已下发且依据未过期，无需重发。')
  }
  tail.push(
    '  漂移留到下次**真正重排**时逐条交代即可；本轮计划无需改动就别为「交代漂移」而改。',
  )

  // 无科目时整段不渲染：否则会出现「不要凭空规划」紧接着「照抄下面这一行」的空基准行，自相矛盾。
  if (subjects.length > 0) {
    // 名字里带分隔符的科目写不进基准行（parseBasis 会把名字劈开），于是它的漂移永远消不掉。
    // 源码注释早就承诺"看板会提示改名"，但一直没有实现——这句补上，否则是永久噪音。
    const unrepresentable = subjects.filter((s) => BASIS_SEP_RE.test(s.name)).map((s) => s.name)
    if (unrepresentable.length > 0) {
      tail.push(
        '',
        `⚠️ 有科目名写不进数据基准行：${unrepresentable.join('、')}——「｜」是基准行的分隔符，名字里有它就读不回来，该科的漂移会永远消不掉。请把这些目录改成不含「｜」的名字`,
      )
    }
    tail.push(
      '',
      `写入纪律：数据基准必须与磁盘逐字一致（否则被拒）；写计划要**四个部分一起写**，并把下面这行原样抄进去：`,
      renderBasis(subjects),
    )
  }
  // ── 头部：尾部先定稿，再把剩下的预算给头部；装不下就降档，而不是切掉最后一科 ──────
  // ★ 顺序调整：陪伴块不参与学业本体定稿；后续用独立预算，不从头部扣。
  //   旧顺序（陪伴块先进 tail → 再算 headBudget）会让聊天信息压掉学业信息。
  const tailText = tail.join('\n')
  const tailBytes = Buffer.byteLength(tailText, 'utf8')
  // ★ 2026-10-06 修：下限不许把预算**抬到**真实余额之上。
  //   旧式 `Math.max(上限 - 尾部 - 1, 下限)`：尾部一长就把预算抬到 1024，于是"装得下"变成假的 ——
  //   头部按 1024 渲染、总字节却 > 上限。下限只在**还有余量**时才兜底；余量不足就如实给 0，
  //   让后面的硬截断（它现在会把提示语算进预算）去处理，至少总数不撒谎。
  const headBudget = Math.max(BOARD_MAX_BYTES - tailBytes - 1, 0)
  let headText = lines.join('\n') // 仅首行（空目录时另有报警段）；不需要压缩
  if (subjects.length > 0) {
    let candidate = headText
    for (const tier of BOARD_HEAD_TIERS) {
      const notice = headTierNotice(tier)
      const parts = [...lines, ...renderSubjectHead(subjects, tier)]
      if (notice !== undefined) parts.push('', notice)
      candidate = parts.join('\n')
      if (Buffer.byteLength(candidate, 'utf8') <= headBudget) break
    }
    // 兜底：科目多到连「只留核心行」都装不下时，才做字节截断（此时确实只能牺牲末尾几科）。
    headText = Buffer.byteLength(candidate, 'utf8') <= headBudget ? candidate : cutoffBytes(candidate, headBudget)
  }

  // ── 陪伴块：**自己的预算**，不从看板的 4096 里扣（见 COMPANION_BLOCK_MAX_BYTES 的注释）。
  //    头部已经按"不含这一块"的预算渲染完 ⇒ **加不加陪伴块，头部逐字节相同**（强不变量，仍然成立）。
  //    ★ 2026-10-12 改：旧写法 `room = 4096 - used` 在实测里已经失效——现场余量只剩 104 B，
  //      而头部已在最低档、降无可降（再压就是硬截断，会丢漂移与任务条目）。
  //      于是这一块**根本不渲染**，只留一句指路 ⇒ 通道静默失效。
  //      现在它用 COMPANION_BLOCK_MAX_BYTES 独立渲染、拼在看板之后。
  const companionLines = companionTailBlock(noteRaw, COMPANION_BLOCK_MAX_BYTES)
  if (companionLines.length > 0) {
    tail.splice(companionAt, 0, ...companionLines)
    // 尾部变了 ⇒ 重新拼一次（头部**不动**：它已经按不含陪伴块的预算渲染完了）
    return `${headText}\n${tail.join('\n')}`
  }
  // 有内容却没渲染（只可能是连最简形式都超过自己的上限，正常内容到不了这里）。
  // ⚠️ **不静默**——"没看到"会被读成"它没说话"，所以必须让读者知道去哪看。
  //    它自己也要占字节，所以**先量再写**：这里已经没有预算可借（头部已贴满），
  //    硬塞进去会让看板突破 4096——正是 2026-10-06 那个"函数自己破坏自己的契约"的形状。
  if (noteRaw !== undefined && companionPlanItems(noteRaw).length > 0) {
    const notice = `  ⚠️ 心灵有话说，但连最简形式都超过 ${COMPANION_BLOCK_MAX_BYTES} 字节：请陪伴精简或确认安排信息`
    const slack = BOARD_MAX_BYTES - (Buffer.byteLength(headText, 'utf8') + 1 + tailBytes)
    if (Buffer.byteLength(notice, 'utf8') + 1 <= slack) {
      return `${headText}\n${tailText}\n${notice}`
    }
  }
  return `${headText}\n${tailText}`
}

// ── 写入守护 ────────────────────────────────────────────────────────────────

/**
 * 校验 `总规划.md`：合法返回 undefined，违规返回拒绝原因（中文，面向模型可读）。
 */
export function validatePlan(content, { today, subjects, existing, maxLines = DEFAULT_MAX_PLAN_LINES, maxBytes = DEFAULT_MAX_PLAN_BYTES }) {
  if (typeof content !== 'string') return '总规划内容必须是字符串'
  if (subjects.length === 0) {
    return '当前学习根目录下未发现任何科目（子目录中没有「学习档案.md」）。总规划不能脱离各科档案凭空写：请确认本会话的工作目录就是学习根目录，各科是它的子目录'
  }
  const lines = content.split('\n').length
  if (lines > maxLines) return `总规划超过 ${maxLines} 行上限（当前 ${lines} 行）。周看板不是流水账：删掉过期内容与已完成的旧条目再写`
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > maxBytes) return `总规划超过 ${maxBytes} 字节上限（当前 ${bytes} 字节）。请先压缩再写入`

  const stampValue = genStamp(content)
  if (stampValue === undefined) return `总规划必须含一行「生成: YYYY-MM-DD」，日期取当前学习日（学习日是 ${today}）${DAY_RULE_HINT}`
  const age = ageDays(stampValue, today)
  if (age === undefined || Math.abs(age) > 1) {
    return `总规划的「生成」日期是 ${stampValue}，但当前学习日是 ${today} ${DAY_RULE_HINT}——先核对当前日期再写入`
  }

  // 「本次修订」是必填的：重写计划必须先回答「为什么又要改」。
  // 这是治「过于积极调整规划」的第二道闸——守护没法判断动机，但能让每次改动留下理由；
  // 而同一天内再写时必须给出一个具体理由，不能谎称「首次制定」。
  const revision = REVISION_RE.exec(content)
  if (revision === null) {
    return `总规划必须含一行「本次修订: <理由>」，理由取其一：${REVISION_KINDS.join(' / ')}`
  }
  const kind = revision[1].trim()
  if (!REVISION_KINDS.includes(kind)) {
    return `「本次修订」写成「${kind}」不是合法理由。请取其一：${REVISION_KINDS.join(' / ')}`
  }
  if (kind === REVISION_KINDS[0] && typeof existing === 'string' && existing.trim().length > 0) {
    return `磁盘上已经有总规划了，不能写「${REVISION_KINDS[0]}」。同一天内再写必须先想清楚理由：${REVISION_KINDS.slice(1).join(' / ')}——如果只是想刷新基准行，那就只改「生成」「数据基准」「本次修订」三行，其余原样保留`
  }

  const screened = screenText(content, '总规划')
  if (screened !== undefined) return screened

  // 四个部分必须是二级标题。旧实现只查子串——正文里随便写一句含「硬约束 / MVE / 漂移」的话就能过，
  // 而错误文案却自称「四个字段必须保留」。
  const all = content.split('\n')
  for (const marker of ['硬约束', 'MVE', '漂移', '下周预备']) {
    if (!all.some((l) => /^##\s+/.test(l) && l.includes(marker))) {
      return `总规划缺少「## ${marker}」这一节。四个二级标题必须都在：## 本周硬约束 / ## 每科 MVE（每科 ≤${MAX_MVE_PER_SUBJECT} 条）/ ## 漂移与风险 / ## 下周预备`
    }
  }

  // 反冗余：同一份计划里不许出现两条一模一样的条目；「下周预备」也要封顶，
  // 否则每次重写都往里堆，条目只增不减——这正是「规划冗余」的直接来源。
  const dupes = []
  const seenBoxes = new Set()
  for (const line of all) {
    const m = CHECKBOX_RE.exec(line)
    if (m === null) continue
    const text = m[2].trim()
    if (seenBoxes.has(text)) dupes.push(text)
    seenBoxes.add(text)
  }
  if (dupes.length > 0) {
    return `总规划里有重复条目：${[...new Set(dupes)].map((d) => `「${d}」`).join('、')}。同一件事只写一条，重排时把旧条目删掉再写新的`
  }
  const nextCount = listItemsInSection(content, '下周预备').length
  if (nextCount > MAX_NEXT_ITEMS) {
    return `「下周预备」有 ${nextCount} 条，超过 ${MAX_NEXT_ITEMS} 条上限。预备清单不是仓库：只留真正可能开工的，其余删掉`
  }
  const constraintCount = listItemsInSection(content, '硬约束').length
  if (constraintCount > MAX_CONSTRAINT_ITEMS) {
    return `「本周硬约束」有 ${constraintCount} 条，超过 ${MAX_CONSTRAINT_ITEMS} 条上限。硬约束是这一周真正卡住手脚的那几件事，不是待办清单`
  }
  const riskCount = listItemsInSection(content, '漂移').length
  if (riskCount > MAX_RISK_ITEMS) {
    return `「漂移与风险」有 ${riskCount} 条，超过 ${MAX_RISK_ITEMS} 条上限。已经处置过的旧条目写完就删`
  }

  const basis = parseBasis(content)
  if (basis.size === 0) return `总规划必须含一行数据基准，照抄看板给出的这一行：${renderBasis(subjects)}`
  const badBasis = []
  for (const s of subjects) {
    if (BASIS_SEP_RE.test(s.name)) continue // 名字含分隔符，无法写进基准行（看板会提示改名）
    const want = s.archiveStamp ?? '无档案'
    const got = basis.get(s.name)
    if (got === undefined) badBasis.push(`${s.name}（未写基准，实际 ${want}）`)
    else if (got !== want) badBasis.push(`${s.name}（基准写了 ${got}，磁盘实际 ${want}）`)
  }
  if (badBasis.length > 0) {
    return `总规划的数据基准与磁盘现状不符：${badBasis.join('；')}。基准行是乐观并发控制——写计划前请先重新读一遍各科档案，然后用这一行：${renderBasis(subjects)}`
  }

  // 复选框的位置与数量。旧实现只在「## MVE 到下一个 ## 」之间数，且只认 `-`/`*`/`+`：
  // 把 8 条写进「## 漂移与风险」、或用有序列表 `1. [ ]`，都能绕过「每科 ≤3」。
  const mveStart = all.findIndex((l) => /^##\s+/.test(l) && l.includes('MVE'))
  let mveEnd = all.length
  for (let i = mveStart + 1; i < all.length; i += 1) {
    if (/^##\s+/.test(all[i])) {
      mveEnd = i
      break
    }
  }
  const stray = all.findIndex((l, i) => (i < mveStart || i >= mveEnd) && CHECKBOX_RE.test(l))
  if (stray >= 0) {
    return `第 ${stray + 1} 行的复选框不在 MVE 区块里。复选框只能出现在「## 每科 MVE」这一节的科目小节内，每科 ≤${MAX_MVE_PER_SUBJECT} 条`
  }

  const counts = new Map()
  const headings = []
  let curName
  for (let i = mveStart + 1; i < mveEnd; i += 1) {
    const h = /^###\s+(.+?)\s*$/.exec(all[i])
    if (h !== null) {
      curName = h[1].replace(/[:：]\s*$/, '').trim()
      headings.push(curName)
      if (!counts.has(curName)) counts.set(curName, 0)
      continue
    }
    if (curName !== undefined && CHECKBOX_RE.test(all[i])) counts.set(curName, counts.get(curName) + 1)
  }
  if (headings.length === 0) {
    return `总规划的 MVE 必须按科目分小节写：每科一个「### 科目名」小节（标题只能是科目名本身，如「### ${subjects[0].name}」），小节内用「- [ ] 任务」列最小必做，每科 ≤${MAX_MVE_PER_SUBJECT} 条`
  }
  for (const [subName, count] of counts) {
    if (count > MAX_MVE_PER_SUBJECT) {
      return `「${subName}」的 MVE 有 ${count} 条，超过每科 ${MAX_MVE_PER_SUBJECT} 条上限。MVE 是最小必做：砍到 ${MAX_MVE_PER_SUBJECT} 条以内，其余移到「下周预备」`
    }
  }
  const names = subjects.map((s) => s.name)
  const missing = names.filter((n) => !headings.includes(n))
  if (missing.length > 0) {
    return `MVE 缺少这些科目的小节：${missing.join('、')}。小节标题必须正好是科目名（本工作区发现：${names.join('、')}）；本周确实没有最小必做的科目，也要写一节「### 科目名」+「本周无 MVE」+ 一句理由，不能跳过`
  }
  const unknown = headings.filter((h) => !names.includes(h))
  if (unknown.length > 0) {
    return `MVE 里有不属于本工作区的科目小节：${unknown.join('、')}。小节标题必须正好是发现的科目名（${names.join('、')}）——不要给没有档案的科目凭空排任务`
  }
  return undefined
}

/**
 * 校验 `本周任务.md`（总规划下发到某个科目目录）。
 */
export function validateTask(content, { today, subjectName, archiveStamp: stampValue, maxBytes = DEFAULT_MAX_TASK_BYTES }) {
  if (typeof content !== 'string') return '本周任务内容必须是字符串'
  const screened = screenText(content, '本周任务')
  if (screened !== undefined) return screened
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > maxBytes) return `本周任务超过 ${maxBytes} 字节上限（当前 ${bytes} 字节）。下发的是最小必做，不是教程`
  const gen = genStamp(content)
  if (gen === undefined) return `本周任务必须含一行「生成: YYYY-MM-DD」，日期取当前学习日（学习日是 ${today}）${DAY_RULE_HINT}`
  const age = ageDays(gen, today)
  // 未来日期一律拒（跨零点宽限 1 天）；**旧的**按 TASK_MAX_AGE_DAYS 判，不按 1 天判。
  //
  // 这里曾经是 `Math.abs(age) > 1`，与同一份文件里「本周任务已 7 天未换」那句自相矛盾：
  // 一份生成于 2 天前、依据仍与档案一致的任务，看板说「无需重发」（replanVerdict 只看依据）、
  // 也不报漂移（7 天才报），可科目侧**一勾就被守护拒绝**（本函数就是勾选路径上那个校验）——
  // 看板与守护对同一份文件给出相反结论，学员看到的是"勾了不算数"。
  // 生命期以「周」计（与 7 天漂移线、`weekStart` 的跨周重排对齐），依据仍由下面那条把关。
  if (age === undefined) return `本周任务的「生成」日期无法解析（当前学习日是 ${today}），请写成「生成: YYYY-MM-DD」`
  if (age < -1) {
    // 这条正是凌晨最容易踩的：0:30 时自然日已是新的一天，模型照自然日写下"明天"，
    // 学习日却还在昨天。所以拒绝话术必须把分界规则说出来，否则模型只会反复试同一个日期。
    return `本周任务的「生成」日期是 ${gen}，比当前学习日 ${today} 还晚 ${DAY_RULE_HINT}——先核对当前日期再写入`
  }
  if (age > TASK_MAX_AGE_DAYS) {
    return `本周任务的「生成」日期是 ${gen}，距学习日 ${today} 已 ${age} 天，超过任务生命期 ${TASK_MAX_AGE_DAYS} 天——请按当前档案重发一份（当前学习日是 ${today}）`
  }
  const basis = basisStamp(content)
  if (basis === undefined) {
    return `本周任务必须含一行「依据: 学习档案 更新于 YYYY-MM-DD」，写明按哪一版档案制定的（该科档案当前为 ${stampValue ?? '缺少日期戳'}）`
  }
  if (basis !== stampValue) {
    return `本周任务的依据日期是 ${basis}，但「${subjectName}」的档案现在是 ${stampValue ?? '缺少日期戳'}——基准对不上，任务不能按旧基准下发。请先读一遍该科档案（档案一更新，旧任务必须按新依据重发），再重新下发`
  }
  const boxes = checkboxes(content)
  const total = boxes.done.length + boxes.open.length
  if (total === 0) return '本周任务至少要有一条「- [ ] 任务」形式的最小必做'
  if (total > MAX_MVE_PER_SUBJECT) {
    return `本周任务有 ${total} 条，超过每科 ${MAX_MVE_PER_SUBJECT} 条上限。下发的是最小必做：砍到 ${MAX_MVE_PER_SUBJECT} 条以内`
  }
  return undefined
}

/**
 * 校验 `变更记录.md`（总规划写在**学习根目录**，各科只读）。
 *
 * 它是**事件流水**不是周报：每次改动追加一条，条目自带日期，读者自己判断新旧。
 * 它必须被压得很小，且**不许复制任务条目**——记录只说「哪里发生了改动」，否则就是第三个冗余来源。
 */
export function validateNotice(content, { today, maxBytes = DEFAULT_MAX_NOTICE_BYTES }) {
  const label = '变更记录'
  if (typeof content !== 'string') return `${label}内容必须是字符串`
  const screened = screenText(content, label)
  if (screened !== undefined) return screened
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > maxBytes) {
    return `${label}超过 ${maxBytes} 字节上限（当前 ${bytes} 字节）。它是流水不是文档：一条一句话，更早的自己删掉`
  }
  const gen = genStamp(content)
  if (gen === undefined) return `${label}必须含一行「生成: YYYY-MM-DD」，日期取当前学习日（学习日是 ${today}）${DAY_RULE_HINT}`
  const age = ageDays(gen, today)
  if (age === undefined || Math.abs(age) > 1) {
    return `${label}的「生成」日期是 ${gen}，但当前学习日是 ${today} ${DAY_RULE_HINT}——先核对当前日期再写入`
  }
  const boxes = checkboxes(content)
  if (boxes.done.length + boxes.open.length > 0) {
    return `${label}里不要放任务复选框：任务在各科的 本周任务.md 里，这里只记「哪里发生了改动」`
  }
  const bullets = content
    .split('\n')
    .filter((l) => !/^#{1,6}\s/.test(l) && /^\s*(?:[-*+]|\d+[.)])\s+\S/.test(l) && !CHECKBOX_RE.test(l))
  if (bullets.length === 0) {
    return `${label}至少要有一条。还没改过任何东西就先别建这个文件`
  }
  for (const b of bullets) {
    if (!LOG_ENTRY_RE.test(b)) {
      return `记录条目要写成「- YYYY-MM-DD 类型：一句话」，例如「- ${today} 计划：跨周重排」。这一条不合格式：${b.trim().slice(0, 40)}`
    }
  }
  if (bullets.length > MAX_NOTICE_ITEMS) {
    return `${label}有 ${bullets.length} 条，超过 ${MAX_NOTICE_ITEMS} 条上限。流水不是档案：把更早的删掉`
  }
  return undefined
}

const toLf = (s) => s.replaceAll('\r\n', '\n')

/**
 * 由 `edit` 参数重建改后内容。返回 `{ ok:true, content }`（content 为 undefined = 无需校验）
 * 或 `{ ok:false, reason }` —— 重建不了时守护**拒绝**，不再放行。
 *
 * 曾经这里是 fail-open，而重建语义又与真实 `edit` 不一致，等于开了两个口子：
 * - 真实工具先把文件与 old/new 都归一成 LF，这里却拿 CRLF 原文做 `includes` → 多行 old_string
 *   永远命中不了 → 「重建失败」被当成放行，而真实写入照样成功。
 * - 真实工具用 split/join 做**字面**替换，`String.replace` 却会展开 `$&` 这类替换模式
 *   → 校验的字符串 ≠ 真实落盘内容（正文里写 `$` 就能自然触发）。
 */
function reconstruct(abs, args) {
  let current
  try {
    current = readFileSync(abs, 'utf8')
  } catch {
    return { ok: true, content: undefined } // 文件不存在：真实工具会自己报错，没有写入发生
  }
  const oldString = args?.old_string
  const newString = args?.new_string
  if (typeof oldString !== 'string' || typeof newString !== 'string') return { ok: true, content: undefined }
  const cur = toLf(current)
  const old = toLf(oldString)
  const nw = toLf(newString)
  if (old.length === 0) return { ok: false, reason: 'old_string 为空' }
  if (!cur.includes(old)) return { ok: false, reason: 'old_string 在文件里找不到（多半是行尾 CRLF/LF 差异）' }
  if (args?.replace_all === true) return { ok: true, content: cur.split(old).join(nw) }
  const at = cur.indexOf(old)
  return { ok: true, content: cur.slice(0, at) + nw + cur.slice(at + old.length) }
}

export function apply(ctx, config) {
  const planName = typeof config?.planName === 'string' ? config.planName : PLAN_NAME
  const taskName = typeof config?.taskName === 'string' ? config.taskName : TASK_NAME
  const archiveName = typeof config?.archiveName === 'string' ? config.archiveName : ARCHIVE_NAME
  const noticeName = typeof config?.noticeName === 'string' ? config.noticeName : NOTICE_NAME
  const staleDays = Number.isSafeInteger(config?.staleDays) ? config.staleDays : DEFAULT_STALE_DAYS
  const maxPlanLines = Number.isSafeInteger(config?.maxPlanLines) ? config.maxPlanLines : DEFAULT_MAX_PLAN_LINES
  const maxPlanBytes = Number.isSafeInteger(config?.maxPlanBytes) ? config.maxPlanBytes : DEFAULT_MAX_PLAN_BYTES
  const maxTaskBytes = Number.isSafeInteger(config?.maxTaskBytes) ? config.maxTaskBytes : DEFAULT_MAX_TASK_BYTES
  const maxNoticeBytes = Number.isSafeInteger(config?.maxNoticeBytes) ? config.maxNoticeBytes : DEFAULT_MAX_NOTICE_BYTES
  const fixedRoot = typeof config?.root === 'string' && config.root.length > 0 ? config.root : undefined
  // 陪伴预设的目录名（`ST\心灵`）。**只有总规划需要配它**——它决定了看板尾部要不要渲染
  // 「心灵的话」那一块。别的预设不配 = 不渲染（零成本），所以这是纯增量的开关。
  const companionDir = typeof config?.companionDir === 'string' && config.companionDir.length > 0 ? config.companionDir : undefined

  const opts = { planName, taskName, archiveName, staleDays }
  const rootOf = (agent) => fixedRoot ?? (typeof agent?.session?.header?.cwd === 'string' ? agent.session.header.cwd : undefined)

  // ── 贡献 1：全科看板自动注入 ────────────────────────────────────────────
  // 每个 agent 最近一次注入的看板文本（内存即可：重启后首轮重新注入一次，无害）。
  const lastInjected = new Map()

  ctx.on('agent/pre-step', async ({ agent, step, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision
    if (step !== 1) return decision // 只在每轮开头注入，步骤中途不打扰
    const root = rootOf(agent)
    if (root === undefined) return decision
    const today = studyDate()
    const subjects = survey(root, today, opts)
    // 看板文本自带「系统当前日期」与各文件的 size/mtime 派生值：内容一变就重注入，
    // 跨天必然变化（日期行变），所以无需额外的缓存键。
    const signature = subjects
      .map((s) => `${s.name}:${s.archiveStamp ?? '-'}:${s.bytes}:${fileSignature(join(s.dir, taskName))}`)
      .join('|')
    const planRaw = readText(join(root, planName))
    const noticeRaw = readText(join(root, noticeName))
    // 陪伴笔记：读取载体全文，但只抽取「要跟总规划说的」节进入看板。
    // 它不是科目，所以不进 survey；这一行是它与看板之间唯一的通路。
    // 目录名与文件名都由 config 给（预设声明里写死，避免"猜哪个目录是心灵"）。
    const noteRaw = companionDir === undefined ? undefined : readText(join(root, companionDir, COMPANION_NOTE_NAME))
    const planSig = `${fileSignature(join(root, planName))}:${planRaw === undefined ? '-' : String(planRaw.length)}:${fileSignature(join(root, noticeName))}:${noticeRaw === undefined ? '-' : String(noticeRaw.length)}`
    // 日期进缓存键：跨天后即使文件一字未改也重注入一次，保证「系统当前日期」基准
    // 与漂移天数真的到达模型。
    // 陪伴不是 survey 的科目，必须把其公开出信单独计入去重键；只新增/删除它也要重注入。
    // 只纳入可渲染的日期与规划条目，不把私人状态全文放进规划缓存键。
    const companionSig = companionDir === undefined ? '' : JSON.stringify([archiveStamp(noteRaw), companionPlanItems(noteRaw)])
    const cacheKey = `${today}|${signature}|${planSig}|${companionSig}`
    if (lastInjected.get(agent.id) === cacheKey) return decision // 未变化，零成本
    lastInjected.set(agent.id, cacheKey)
    const board = buildBoard(root, { today, subjects, planRaw, noticeRaw, planName, noteRaw })
    return { ...decision, messages: [...decision.messages, snapshotMessage(board)] }
  }, { prepend: true })

  // 压缩（compaction）会把已注入的看板折叠进有损摘要；作废去重缓存，下一轮重新注入。
  ctx.on('session/event', (_session, event) => {
    if (event.type !== 'compaction/end') return
    if (event.data !== null && typeof event.data === 'object' && 'error' in event.data) return
    lastInjected.clear()
  })

  // ── 贡献 2：写入守护 ────────────────────────────────────────────────────
  // ★ 旧写法是 `ctx.get('tools')` + `if (undefined) return`——**服务没就位就静默不注册**。
  //   宿主平面的 file-guard 就是这么空转了一整天的（LRN-20260916-012）。预设平面的 apply
  //   跑在 agent 组装时（远晚于宿主服务），现在这条路是通的；但"通的"要用痕迹证明，不靠推理。
  const tools = ctx.get('tools')
  HEALTH.startedAt = new Date().toISOString()
  HEALTH.toolsAvailable = tools !== undefined
  if (tools === undefined) {
    writeHealth('plan-core', HEALTH)
    return
  }

  tools.guard((execution) => {
    HEALTH.calls += 1
    HEALTH.lastCallAt = new Date().toISOString()
    if (HEALTH.calls === 1) writeHealth('plan-core', HEALTH) // 真被调用过 = 接进管线了
    const tool = execution.name
    if (tool !== 'write' && tool !== 'edit') return undefined
    const args = execution.arguments
    const target = typeof args?.file_path === 'string' ? args.file_path : ''
    // 文件名比较必须大小写不敏感：Windows 上 `学习档案.MD` 与 `学习档案.md` 是**同一个文件**，
    // 按字节比较会让守护被一个字母的大小写整段绕过。
    const base = basename(target).toLowerCase()
    const planKey = planName.toLowerCase()
    const taskKey = taskName.toLowerCase()
    const archiveKey = archiveName.toLowerCase()
    const noticeKey = noticeName.toLowerCase()
    if (base !== planKey && base !== taskKey && base !== archiveKey && base !== noticeKey) return undefined

    const root = rootOf(execution.agent)
    if (root === undefined) return undefined
    // 相对路径按「写工具自己会落到哪里」解析（agent 的工作目录）；root 只用于科目发现。
    const cwd = typeof execution.agent?.session?.header?.cwd === 'string' ? execution.agent.session.header.cwd : root
    const abs = isAbsolute(target) ? target : join(cwd, target)
    // 只在学习根范围内执法，且用**路径包含性**而不是字符串前缀：`…\ST` 与 `…\ST2`、`\\?\` 前缀、
    // 正斜杠、小写盘符都会让前缀比较判错，而判错的后果是「该拦的放行」。
    if (!isWithin(root, abs)) return undefined

    const today = studyDate()
    const subjects = survey(root, today, opts)
    const dirName = basename(dirname(abs))
    const subject = subjects.find((s) => s.name.toLowerCase() === dirName.toLowerCase())
    // 磁盘上现有的计划：用于判断「同一天能不能再写」以及是否谎称首次制定。
    const existingPlan = base === planKey ? readText(join(root, planName)) : undefined

    // 平面不变量：各科档案由该科自己维护，总规划只读。否则总规划能自己把某科档案的「更新于」
    // 刷成今天，顺手擦掉看板里「任务下发后零回执」的漂移警报——整套检测就失真了。
    if (base === archiveKey) {
      if (subject === undefined) return undefined
      return `${archiveName} 由该科自己维护，总规划只读不改。要修正某科档案，请让学员到对应的伴学预设里更新（你代改会让漂移检测失真）`
    }

    const validate = (text) => {
      if (base === planKey) {
        return validatePlan(text, { today, subjects, existing: existingPlan, maxLines: maxPlanLines, maxBytes: maxPlanBytes })
      }
      if (base === noticeKey) {
        // 广播必须放在学习根目录（与 总规划.md 同级）：放进某个科目目录就退化成「只通知一科」。
        if (canonicalPath(dirname(abs)) !== canonicalPath(root)) {
          return `${noticeName} 只能写在学习根目录（与 ${planName} 同级），不要放进科目目录`
        }
        return validateNotice(text, { today, maxBytes: maxNoticeBytes })
      }
      if (subject === undefined) {
        return `${taskName} 只能下发到科目目录（${root} 下含「${archiveName}」的子目录）。当前目标目录「${dirName}」不是一个科目`
      }
      return validateTask(text, { today, subjectName: subject.name, archiveStamp: subject.archiveStamp, maxBytes: maxTaskBytes })
    }

    if (tool === 'write') return validate(args?.content)
    const built = reconstruct(abs, args)
    if (!built.ok) {
      return `无法重建改后内容（${built.reason}），为安全起见已拒绝这次 edit。请先 read 该文件，按读到的原文再 edit`
    }
    return built.content === undefined ? undefined : validate(built.content)
  })
  HEALTH.guardRegistered = true
  writeHealth('plan-core', HEALTH)
}