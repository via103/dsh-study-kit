// companion-core — 伴学底座插件（DSH Cordis，宿主侧，纯 ESM，无外部依赖）
//
// 两个贡献：
// 1) 档案自动注入：监听 agent/pre-step（与 shipped dsh-time-context 同一机制），
//    每轮第一步把当前工作区 `学习档案.md` 以 snapshot 用户消息注入，按会话记忆
//    上次注入文本，内容未变不重复注入（零累积、未变零成本；跨天强制重注入一次）。
//    注入块在档案陈旧（「更新于」落后今天 ≥2 天）时追加一行提醒，把「档案该更新了」
//    放在模型读的那一刻，而不是只靠写入守护事后拦截。模型不再依赖「记得读档」的自觉。
// 2) 任务下发只读注入：`本周任务.md`（由「总规划」预设下发到本工作区）存在时一并注入，
//    位置紧跟档案，并写明它是只读的：只许勾选框，回执走档案。这是「总规划 → 各科」
//    方向的下行通道；上行通道是该科自己的 `学习档案.md`，方向分离、写者不重叠。
// 3) 写入守护：tools.guard 拦截对 `学习档案.md` 的 write/edit，超限/破坏三字段
//    结构即拒绝并说明原因，倒逼模型先合并压缩再写入；对 `本周任务.md` 只放行
//    「纯勾选状态变化」的 edit，其余一律拒绝（防止任务被就地改写、漂移检测失真）。
//
// 只消费宿主服务（tools 可选获取），不发布服务，无需 isolate realm。
// 挂载：预设 agent.cordis.yml 加一行 name 指向本文件绝对路径。
// 可选 config：{ maxLines?: number, maxBytes?: number }

import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { archiveHygiene, archiveStamp, basisStamp, parseHandoffs, readProbe, writeHealth, COMPANION_NOTE_NAME, COMPANION_SECTION_PLAN } from './plan-core.js'

export const name = 'companion-core'

// 协议常量与两个数值上限：**只在这里定义一次**。宿主平面的 file-guard 从这里 import，
// 而不是再抄一遍字面量——抄一遍就等于埋一个"改了这边忘了那边"的地雷
//（4096 → 6144 那次改动就差点只改了一边）。
export const ARCHIVE_NAME = '学习档案.md'
export const TASK_NAME = '本周任务.md'
export const PLAN_NAME = '总规划.md'
/**
 * 总规划写的**变更记录**（放在学习根目录，即本工作区的父目录）。科目只读。
 * 它是事件流水不是周报：每次改动追加一条、条目自带日期；**读者不要清空它**
 * （清空等于让读者变成写者，谁先读谁清，别科就永远看不到）。
 */
export const NOTICE_NAME = '变更记录.md'
/**
 * 学过的知识点**只存在一处**：`复习提纲.md`（各科目录，与档案同级）。
 *
 * 2026-09-17 的合并记录：`复习清单.md`（≤6 条回看队列）作为**第三个协议文件**已经删掉。
 * 它和提纲装的是同一样东西——**知识点**，两处各写一遍是纯重复；而提纲每多一个文件，
 * 模型就多一件要记的事。现在提纲一行一条、自己记 `复 N｜上 MM-DD`：**队列和账本合成一个**。
 * 代价是提纲每次复习要整份读一遍（DSH 强制"编辑前必须先读"），换来的是"复习只有一处入口"。
 *
 * ═══ 2026-09-28 修正：关于「只有该科会话能写」 ═══════════════════════════════════
 * 上面那句原先写的是「只有该科会话能写」。**那是一句声明，没有任何东西在执行它**——守护不覆盖
 * 这个文件，所以它一直是"事实上的自由写入"。而它也不该是绝对的：
 * 学员的知识点**会在别的会话里产生**（实测：网安会话打 CTF 时，学员的 Python 表述错了一片——
 * 变量名带 `-`、列表忘下标、`%` 误用 `/`、`print` 加引号、缺 `long_to_bytes`——而 Python 会话
 * 自 09-22 起就没再跑过，这些一手证据一条都没到它手里）。
 *
 * 知识点**永远写进它所属科目的提纲**（"一份事实一个家"的直接推论），所以跨科写入必须允许；
 * 但按规矩允许，而不是无规矩地允许：
 *   · 本科自己的提纲     —— 怎么改都行（本来就是他的笔记本）
 *   · 别科的提纲         —— **只许追加**：旧行一条都不能少，新增的每一行都要带**来源戳**
 *                          `（源:<科目> YYYY-MM-DD）`
 * 这条规则由 `validateOutlineForeignWrite` 实现，并被两个守护（本插件 + 宿主平面的 file-guard）
 * 共同执行 —— 于是"只有该科会话能写"这句话，现在是真的（对本科自由、对别科限追加）。
 */
export const OUTLINE_NAME = '复习提纲.md'
/**
 * ★ 课程路线（2026-10-17，学员原话：*「教学深度不足，教学路线不清晰，教学内容不完整」*）。
 *
 * 为什么需要第三个协议文件：`学习档案.md` 只装**状态**（6KB／60 行，一学期就满），
 * `复习提纲.md` 只装**已经学到的知识点**（账本，不知道"应该学什么"）。于是"路线"与
 * "覆盖全集"没有任何载体——模型每次只能追着学员的问题跑；学员把它总结成「追坑式教学」，
 * 这次点名批评的就是它。文件不是又一份清单：单元顺序（前置）、每单元目标深度（L1–L4）、
 * 状态与证据、**唯一一条「下一课」**、课程知识点覆盖清单，全部装在一份人类可读的文件里。
 *
 * 投递（设计文档 §37.7：写在文件里 ≠ 规则生效）：摘要与覆盖统计每轮注入，详情按需读文件；
 * 这样"路线"每次都在模型眼前，而不靠它记得去读。
 *
 * 归属：属于**该科自己的工作区**（与 `学习档案.md` 同级）；陪伴目录没有课程路线。
 * 守护：预设内写守护按下面的行格式执法（格式与解析用同一套正则，规则只有一份）；
 * 宿主平面 file-guard 暂不覆盖它——记录在案：目前唯一的写者是该科会话本人。
 */
export const ROUTE_NAME = '课程路线.md'
export const DEFAULT_ROUTE_MAX_LINES = 140
export const DEFAULT_ROUTE_MAX_BYTES = 24 * 1024
/**
 * 单词复习站（2026-10-19）：源数据与 HTML 产物。只在**学科工作区**（有 `学习档案.md`）
 * 且数据文件存在时投递一条机械状态；进度在手机浏览器 localStorage，PC 端看不到，
 * 所以这里只报"当前单元 / 条目数 / 构建同步状态"，不冒充熟悉度。
 */
export const WORD_REVIEW_DATA_NAME = '单词复习数据.json'
export const WORD_REVIEW_HTML_NAME = '单词复习站.html'
/**
 * 「陪伴」预设的记忆文件（`ST\心灵\心灵笔记.md`）——**与 `学习档案.md` 平级的另一套契约**。
 *
 * 学员 2026-10-11 纠正：*「它的定位不是科目，定位是陪伴，是日常，是聊天」*。
 * 而认科目的唯一判据就是这个文件名，所以**改名 = 天然不是科目**
 * （不进看板、不排 MVE、不被逼下发任务、看板 +0 字节）。
 *
 * 代价是三条以 `学习档案.md` 为入口的通路**同时断掉**，本文件负责补其中两条：
 *   ① 注入：`noteName` 配置 + 下面 `readMemory()` 的记忆文件选择
 *   ② 去路：`collectHandoffs` 的载体表
 *   ③ 账本：`pendingHandoffs` 的"已收下"凭据（调用点传自己的记忆文件当账本）
 */
// 这两个名字必须 **import** 进来（上面那行），不能只 `export … from`：
// 后者只做转发、**不建立本地绑定**，而本文件下面真的要用它们
// （2026-09-25 在 studyDate 上踩过同一个坑；2026-10-12 又踩了一次——`COMPANION_SECTION_PLAN`
//  在注入文案里渲染成了字面量 `undefined`，因为当时只 `export … from` 了它）。
export { COMPANION_NOTE_NAME, COMPANION_SECTION_PLAN }

/**
 * ★ 一个目录是不是**陪伴目录**（里面放着 `心灵笔记.md` 而不是 `学习档案.md`）？
 *
 * 为什么需要这个判据：`discoverSubjects` 认科目的**唯一**判据就是文件名 `学习档案.md`。
 * 「陪伴不是科目」这条不变量因此**完全由文件名撑着**——我在 `test/verify-mind-preset.mjs` 里
 * 用**反向自证**钉住了它（往 `ST\心灵` 放一个 `学习档案.md`，它立刻进看板、被排 MVE）。
 *
 * 当时那条反向自证只证明了"机制是这样"，**没有证明"这条路走不通"**。2026-10-12 实测
 * （`.verify/probe-selfdestruct-enforcement.mjs`）：三层守护**没有一层**拦它——
 *   ① `file-guard.classify()` 认 archive ⇒ 但 `cwd === scopeDir`（陪伴会话就在自己目录里），
 *      于是"本科自己写自己的档案"这条规则**正好放行**；
 *   ② `companion-core` 的预设内守护同理（`sameDir(dirname(abs), cwd)` ⇒ 放行）；
 *   ③ persona 只写了「别去改**别科**的文件」，没写「别在自己目录里建那个名字」。
 * 后果不是报错，而是**静默变形**：陪伴忽然变成第七个科目，看板多出一节
 * 「■ 心灵 … 本周任务 未下发」，总规划开始点名 `心灵（未下发）` 要任务——
 * 也就是把"聊天"硬塞进 KPI，正是学员明确不要的东西。
 *
 * 判据用**存在性**（statSync）而不是可读性：与 `looksLikeStudyRoot` 同一条纪律（F11）——
 * 用 readFileSync 判存在时，一个读不到的文件会让守护静默停止执法。
 */
export function looksLikeCompanionDir(dir, noteName = COMPANION_NOTE_NAME) {
  try {
    return statSync(join(dir, noteName)).isFile()
  } catch {
    return false
  }
}

/**
 * 拒绝理由：在陪伴目录里建 `学习档案.md` 会把它变成科目。
 * 抽成函数是为了让**两个检查点**（宿主平面 file-guard + 预设内 companion-core）说同一句话。
 */
export function companionArchiveRefusal(dir) {
  return `${ARCHIVE_NAME} 不能建在陪伴目录里（${dir} 是「${COMPANION_NOTE_NAME}」所在的那一档，不是科目）：`
    + `科目是**按 ${ARCHIVE_NAME} 这个名字**认出来的，放进来它立刻会变成第七个科目——`
    + `进总规划看板、被排本周任务，聊天就变成打卡了。要记东西请写 ${COMPANION_NOTE_NAME}`
}


/**
 * 来源戳：`（源:网安 2026-09-28）`。全角括号与半角冒号都认，年份写全（避免跨年歧义）。
 * 它同时是**给人看的出处**（"这条是在打 CTF 时学的"）与**给代码看的判据**
 * （注入提醒靠它过滤；"这条已经收下了"也靠它认——见 `pendingHandoffs`）。
 *
 * ★ 必须落在**行尾**：不加这个锚点的话，某个知识点的正文里顺口提一句"（源:英语 2026-09-10）"
 *   就会被当成一条跨科条目抽出来。锚住位置，误报就基本不可能——这也是这条格式唯一的硬要求。
 */
const SOURCE_TAG_RE = /（\s*源\s*[:：]\s*([^）\s]+)\s+(\d{4}-\d{2}-\d{2})\s*）\s*$/

/** 一行是不是"带来源戳的跨科追加行"。 */
export function hasSourceTag(line) {
  return SOURCE_TAG_RE.test(String(line ?? ''))
}

/**
 * 本提纲里**别科追加进来的**条目（按日期升序）。
 * @param outlineText 提纲全文
 * @param after 只要日期**严格晚于**这个 YYYY-MM-DD 的
 */
export function foreignOutlineEntries(outlineText, { after } = {}) {
  const out = []
  for (const line of String(outlineText ?? '').replaceAll('\r\n', '\n').split('\n')) {
    const m = SOURCE_TAG_RE.exec(line)
    if (m === null) continue
    if (after !== undefined && !(m[2] > after)) continue
    out.push({ source: m[1], date: m[2], line: line.trim() })
  }
  return out.toSorted((a, b) => (a.date === b.date ? 0 : a.date < b.date ? -1 : 1))
}

/**
 * 别科会话对**本科** `复习提纲.md` 的写：只许追加。
 * 合法返回 undefined，违规返回拒绝原因（中文，面向模型可读）。
 *
 * 判据（刻意选"最松但仍能防丢"的那一种）：
 *   · 旧文件的**每一行都还在**（多重集包含）—— 允许在任意位置插入，禁止删除与改写；
 *   · **新增的每一行都要带来源戳** —— 让"这条是谁带来的"永远可查；
 *   · 旧文件不存在时按空处理（等价于"全是新增"，于是每一行都得带戳）。
 * 为什么不更严（比如只许插在最前面）：条目顺序是"新的在上"，但也可能按主题分节，
 * 强制位置会让模型为了满足格式而把内容塞错地方 —— 那是格式压倒内容。
 */
export function validateOutlineForeignWrite(oldText, newText) {
  if (typeof newText !== 'string') return '复习提纲内容必须是字符串'
  if (BAD_CONTROL_RE.test(newText)) return `${OUTLINE_NAME} 含控制字符（如 NUL），会导致该文件之后无法被读取或编辑。请去掉这些字符再写入`

  const split = (s) => String(s ?? '').replaceAll('\r\n', '\n').split('\n').map((l) => l.trim()).filter((l) => l.length > 0)
  const oldLines = split(oldText)
  const newLines = split(newText)

  // ① 旧行一条都不能少（多重集比较，允许重复行）
  const pool = new Map()
  for (const l of newLines) pool.set(l, (pool.get(l) ?? 0) + 1)
  const missing = []
  for (const l of oldLines) {
    const n = pool.get(l) ?? 0
    if (n === 0) missing.push(l)
    else pool.set(l, n - 1)
  }
  if (missing.length > 0) {
    return `${OUTLINE_NAME} 是**这一科自己的**知识账本：别的科目只许往里**追加**，不能删改已有的行（这次少了/改了 ${missing.length} 行，例如「${missing[0].slice(0, 40)}」）。` +
      `要把本科的知识点记进它，请用 edit 在文件里**插入**新行；本科自己的复习与整理由该科会话做`
  }

  // ② 新增的每一行都要带来源戳
  const untouched = new Map()
  for (const l of oldLines) untouched.set(l, (untouched.get(l) ?? 0) + 1)
  const added = []
  for (const l of newLines) {
    const n = untouched.get(l) ?? 0
    if (n > 0) untouched.set(l, n - 1)
    else added.push(l)
  }
  const untagged = added.filter((l) => !hasSourceTag(l))
  if (untagged.length > 0) {
    // 消息里刻意**不用反引号举例**（避免模板串里再套反引号，那种转义很容易写错）。
    return `跨科追加的每一行都要带**来源戳**，写明这条是在哪一科、哪一天学到的。格式（全角括号）：` +
      `「- 09-28 变量名不能含短横线（源:网安 2026-09-28）」。这次有 ${untagged.length} 行没带，例如「${untagged[0].slice(0, 40)}」。` +
      `出处不是装饰：本科复习时要靠它决定先问哪条，代码也靠它判断"有没有新东西进来"`
  }
  return undefined
}

/**
 * 把档案卫生算出来的数字渲染成注入里的一行提醒。
 *
 * 动机（2026-10-06 学员问「这个网安的学习档案总是满呢？」）：persona 里那两条
 * 「流水只留最近 5 个学习日」「每条一句话」**只有 persona 在说、没有代码在查**，
 * 于是模型只在写入**被拒之后**才压缩 —— 档案长期贴着 99% 跑。
 * 这里把规定变成**算得出来的数字**报给它，让它**在被拒之前**自己收。
 *
 * **不硬拒**：硬拒会逼模型为了合法而删掉有用信息。这里只唠叨，且只在真有问题时唠叨。
 * @returns 需要提醒时返回一段文本；档案干净时返回空串（零噪音）。
 */
export function renderHygiene(h) {
  const problems = []
  const fixes = []
  if (h.overWindow) {
    problems.push(`流水覆盖 **${h.days} 个学习日**（规定只留最近 ${h.dayWindow} 个）`)
    // 只把**真的超了**那条的修法写出来。旧版两处都写死：C 科只超了长度、却也被要求
    // "把超出窗口的旧日期条目合并"，等于让模型去做一件没必要的事（还可能顺手删掉有用信息）。
    fixes.push('· 把超出窗口的旧日期条目**合并成一句状态**（还活着的问题留在「未消化薄弱点」，那节不受这个窗口限制）；')
  }
  if (h.megaItems > 0) {
    problems.push(`有 **${h.megaItems} 条**超过 ${h.megaThreshold} 字节（最长 ${h.longestFlow} 字节；规定"每条一句话"）`)
    fixes.push(
      `· 把超长的条目拆成**一句话 + 详情指针**：过程细节（题解步骤、命令、报错原文）搬进**不进注入**的文件` +
      `（${OUTLINE_NAME} 或另建 ` + '`' + `题目记录.md` + '`' + ` 之类，它们不占这 6KB，30KB 也没问题）。`,
    )
  }
  if (problems.length === 0) return ''
  // 「两处」是按**实际**项数说的，不能写死 —— 写死会让"只超了一条"读起来像"超了两条"。
  const where = problems.length === 1 ? '有一处已经超了' : `有 ${problems.length} 处已经超了`
  return `【档案卫生·自动提醒】你的 ${ARCHIVE_NAME} 现在 ${h.bytes} 字节，其中「已答主题与卡点」占 ${h.flowBytes} 字节（${h.ratio}%）。` +
    `按你 persona 里的规定，这里${where}：${problems.join('；')}。\n` +
    `**请在写入新条目之前，先做一次收拢**（不要等到被守护拒了才压缩——那时你只能删，而现在是整理）：\n` +
    `${fixes.join('\n')}\n` +
    `注意：这是**整理**不是删除 —— 学员以后问起还得找得到；不确定某段该不该搬，就先搬到详情文件里再在档案留指针。`
}

/** 把"别科追加进来的条目"渲染成注入块。 */
export function renderForeignOutline(entries) {
  const bySource = new Map()
  for (const e of entries) bySource.set(e.source, [...(bySource.get(e.source) ?? []), e])
  const lines = [...bySource].map(([source, list]) => `${source}（${list.at(-1).date}）${list.length} 条`)
  return `【跨科知识点·别科追加】你的 ${OUTLINE_NAME} 里有 ${entries.length} 条是**别的科目会话**追加的，来自 ${lines.join('、')}。\n` +
    `含义：这些是你在**别的科目**里暴露出来的**本科**知识点（例如打 CTF 时写 Python 踩的坑）——它们已经记在你的账本上了，不用去别处找。\n` +
    `你该做的：复习/出题时把它们一并抽问；确认消化后按常规更新它们的「复 N｜上 MM-DD」（**不要删掉来源戳**，那是出处）。\n` +
    `下面是原文：\n${entries.map((e) => `  ${e.line}`).join('\n')}`
}

// 只认陪伴的学科出信节，不扩展整份笔记的隐私出口；示例代码块不当出信。
function companionTeachingBody(text) {
  const lines = []
  let active = false
  let fence
  for (const line of String(text ?? '').replaceAll('\r\n', '\n').split('\n')) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)
    if (marker !== null) {
      if (fence === undefined) fence = marker[1]
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = undefined
      continue
    }
    if (fence !== undefined) continue
    if (/^#{1,2}\s/.test(line)) {
      active = /^##\s+要跟学科说的\s*$/.test(line)
      continue
    }
    if (active) lines.push(line)
  }
  return lines.join('\n')
}

// 陪伴相关移交按“来源、日期、必要正文”收件，不把同日全部事项合成一张收据。
// 允许去掉列表符、显式日期与来源/复习元数据；不做模糊匹配，宁可多提醒，不静默吞信。
function handoffReceiptText(text) {
  return String(text ?? '').replace(SOURCE_TAG_RE, '').trim()
    .replace(/^[-*]\s+(?:\[[ xX]\]\s*)?/, '')
    .replace(/^(?:\d{4}-)?\d{2}-\d{2}\s+/, '')
    .replace(/｜复\s+.*$/, '').trim()
}

/**
 * 扫**兄弟科目**的档案，收集标给本科的移交条目（`- @本科 …`）。
 *
 * 只读，不改任何东西：读别科文件一直是允许的（守护只拦写）。
 * @param cwd 本科工作目录
 * @param after 只保留**日期严格晚于**它的；省略则全收
 */
export function collectHandoffs(cwd, after, { noteName = COMPANION_NOTE_NAME } = {}) {
  const root = dirname(cwd)
  const selfName = basename(cwd)
  const out = []
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    if (entry.name === selfName) continue // 自己的文件不给自己打移交标记
    // ★ **陪伴目录没有 `学习档案.md`**，而旧实现是「没有它就 `continue` 跳过整个目录」——
    //   于是「心灵 → 数学」的移交**永远送不出去**（实测：0 条，且与"真的没有"长得一样）。
    //   修法是把闸门从「有没有那一个文件名」改成「**所有载体一个都不存在**」：
    //   语义没变（一个载体都读不到 = 这个目录跟我们无关），但不再把陪伴目录误判成"无关"。
    const carriers = [ARCHIVE_NAME, OUTLINE_NAME, noteName]
    const probes = carriers.map((file) => ({ file, p: readProbe(join(root, entry.name, file), file) }))
    if (probes.every(({ p }) => !p.ok && p.missing)) continue // 一个载体都没有：跳过
    const archive = probes.find(({ file }) => file === ARCHIVE_NAME)
    // 档案的「更新于」是**首选**兜底日期（学科档案每写一次就变，那是"什么时候发现的"）。
    // 陪伴目录没有档案，就退回**这个载体自己的戳**——否则 `fallbackDate` 为空，
    // 而 `parseHandoffs` 的年份补全会退回"今天"所在年，年末年初会算错一年，
    // 「已收下」的凭据 `来源@日期` 就永远对不上（那是无限重复提醒，见 parseHandoffs 的注释）。
    const archiveStampValue = archive?.p.ok ? (archiveStamp(archive.p.text) ?? undefined) : undefined
    // ★ **档案与提纲都要扫**（2026-09-28 实测回填）：网安会话把 `@Python` 标在了**提纲**里
    //   （"标在要移交的那样东西上"），而第一版只扫档案 → 又一条认不出来。
    //   同一件事的教训出现了两次，所以这里一次把所有载体都覆盖掉。
    const seen = new Set()
    for (const { file, p } of probes) {
      if (!p.ok) continue
      const fallbackDate = archiveStampValue ?? (archiveStamp(p.text) ?? undefined)
      // 陪伴定向出信必须限定章节；私人状态里即使出现合法 @标记也不能被投递。
      const carrierText = file === noteName ? companionTeachingBody(p.text) : p.text
      for (const h of parseHandoffs(carrierText, { source: entry.name, fallbackDate })) {
        if (h.target !== selfName) continue
        if (after !== undefined && h.date !== undefined && !(h.date > after)) continue
        if (seen.has(h.line)) continue // 同一个标记不该因为出现在两个文件里就被数两遍
        seen.add(h.line)
        out.push({ ...h, sourceStamp: archiveStampValue, foundIn: file })
      }
    }
  }
  return out
}

/**
 * 还没被本科**收下**的移交条目。
 *
 * ★ 判据是"**提纲里有没有这一条**"，而不是"本科档案有没有更新过"（2026-09-28 修正）。
 *   旧判据（日期晚于档案的「更新于」）有一条**静默丢失**：学员下次开 Python 会话、顺手更新了档案
 *   却没真把移交收进提纲 —— 提醒就永久消失了，东西也丢了，而且**没有任何地方会知道**。
 *   改成"以提纲为准"之后：**没真收下就一直提醒**，收下（提纲里出现带同一来源戳的条目）就自动消失。
 *   代价是"忘了办"会一直唠叨 —— 而唠叨远好过丢失，这也是这套系统一贯的取舍。
 *
 * @returns {{pending: Array, stale: number, absorbedCount: number}}
 */
export function pendingHandoffs(cwd, { outlineText = '', companionReceiptText = '', archiveStampValue, noteName = COMPANION_NOTE_NAME } = {}) {
  const all = collectHandoffs(cwd, undefined, { noteName })
  // "收下了"的凭据：提纲里出现了来源与日期都对应的条目（`（源:网安 2026-09-28）`）。
  const receipts = foreignOutlineEntries(outlineText)
  const absorbed = new Set(receipts.map((e) => `${e.source}@${e.date}`))
  const companionReceiver = looksLikeCompanionDir(cwd, noteName)
  // 教学偏好属于自己的记忆，不强迫学科把陪伴协调写进知识点提纲。
  // 提纲里已有的同条收据仍兼容，新增可放自己的档案；两种载体都必须匹配具体正文。
  const companionReceipts = [...receipts, ...foreignOutlineEntries(companionReceiptText)]
  const pending = all.filter((h) => {
    if (!companionReceiver && h.foundIn !== noteName) return !absorbed.has(`${h.source}@${h.date}`)
    return !companionReceipts.some((e) => e.source === h.source && e.date === h.date
      && handoffReceiptText(e.line) === handoffReceiptText(h.text))
  })
  // "你之后更新过档案、却还没收下" —— 这几条要多说一句，否则学员会以为"更新过档案就没事了"。
  const stale = archiveStampValue === undefined ? 0 : pending.filter((h) => h.date !== undefined && !(h.date > archiveStampValue)).length
  return { pending, stale, absorbedCount: absorbed.size }
}

/** 把跨科移交条目渲染成注入块。 */
export function renderHandoffs(handoffs, { staleCount = 0, ledgerName = OUTLINE_NAME, companionSourceName = COMPANION_NOTE_NAME } = {}) {
  const bySource = new Map()
  for (const h of handoffs) bySource.set(h.source, [...(bySource.get(h.source) ?? []), h])
  const head = [...bySource].map(([src, list]) => `${src}（${list.map((h) => h.date).filter(Boolean).sort().at(-1) ?? '无日期'}）${list.length} 条`).join('、')
  // 账本名可配：学科是 `复习提纲.md`，陪伴是自己的笔记（它没有提纲）。
  // 写死的话，陪伴会被告知"收进 复习提纲.md"——那个文件它既没有、也不该有。
  if (ledgerName !== OUTLINE_NAME) {
    return `【跨科移交·别科指出】${handoffs.length} 条与陪伴有关的线索，来自 ${head}。\n` +
      `这是别科观察到的处境，不是诊断、任务或要求你讲课。先理解，适合当前话题才回应，不必立即追问学员。\n` +
      `收下时在 ${ledgerName} 的「收下的移交」留一行，保留该条必要正文、行尾注明出处；同来源同日的不同条目分别收下，不能只写“收到”。收下不代表问题已经解决。\n` +
      `下面是移交内容：\n${handoffs.map((h) => `  ${h.line}`).join('\n')}`
  }
  const coordination = handoffs.filter((h) => h.foundIn === companionSourceName)
  if (coordination.length > 0) {
    const teaching = handoffs.filter((h) => h.foundIn !== companionSourceName)
    const guidance = `【跨科移交·陪伴协调】${coordination.length} 条已授权的教学方式需要，不是知识点或新任务。按需要调整讲法 / 节奏 / 反馈；任务量交总规划，不自行改 ${TASK_NAME}。\n` +
      `收下可在自己的 ${ARCHIVE_NAME} 留该条必要正文、行尾来源戳；同来源同日分条收件，不把私事写进 ${OUTLINE_NAME}。收下不代表已办成。\n` +
      coordination.map((h) => `  ${h.line}（源:${h.source} ${h.date}）`).join('\n')
    return teaching.length === 0 ? guidance : `${guidance}\n\n${renderHandoffs(teaching, { staleCount, ledgerName, companionSourceName })}`
  }
  return `【跨科移交·别科指出】${handoffs.length} 条知识点是**别的科目会话**指出「归你」的，来自 ${head}。\n` +
    `含义：学员在那一科的会话里踩到了**本科**的坑（例如打 CTF 时写 Python 出错），那边的伴学助手已把它标给你。\n` +
    (staleCount > 0 ? `⚠️ 其中 ${staleCount} 条**你之后更新过档案、但还没收进${ledgerName === OUTLINE_NAME ? '提纲' : '账本'}** —— 这条提醒会一直留着，直到 ${ledgerName} 里真的出现它们。\n` : '') +
    `你该做的：① 用学员当时的情境讲一遍（别当新知识从头讲）；② 收进 ${ledgerName}——一行一条、按该文件既有格式，**行尾注明出处**（如 \`（源:网安 2026-09-28）\`，这条戳同时也是"已经收下"的凭据）；③ 之后照常复习与记账。\n` +
    `下面是原文：\n${handoffs.map((h) => `  ${h.line}`).join('\n')}`
}

export const DEFAULT_MAX_LINES = 60
// 4096 太紧：真实网安档案到过 4025/4195 字节，而三个伴学 persona 从头到尾只写了「60 行」这个上限，
// 模型根本没被告知还有字节墙 —— 结果是「按 persona 做却撞上没写出来的规则」。放宽 + 把数字写进 persona。
export const DEFAULT_MAX_BYTES = 6144
/**
 * 陪伴笔记的限额：**比学业档案更小**。
 *
 * 理由不是"聊天不重要"，而是**它每一轮都在上下文里**：学科档案只在那一科的会话里注入，
 * 而陪伴笔记在陪伴会话的**每一轮**都注入。上限越大，学员为每轮付的钱越多。
 * 40 行 / 4096 B 足够记"最近在想什么 + 要跟谁说什么"，而流水账本来就该被滚动掉。
 */
export const COMPANION_MAX_LINES = 40
export const COMPANION_MAX_BYTES = 4096

/** companion-core 的启动痕迹（schema 与 file-guard / plan-core 一致，doctor 的层 4 读它）。 */
const HEALTH = {
  plugin: 'companion-core',
  pid: process.pid,
  startedAt: undefined,
  toolsAvailable: false,
  guardRegistered: false,
  calls: 0,
  lastCallAt: undefined,
}
// eslint-disable-next-line no-control-regex
const BAD_CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/
const toLf = (s) => s.replaceAll('\r\n', '\n')

/** 两个路径是否指向同一个目录：大小写、正斜杠、`..`、`\\?\` 前缀都归一到同一结果。 */
function sameDir(a, b) {
  const canon = (p) => {
    let cur = resolve(p)
    const tail = []
    for (;;) {
      try {
        return join(realpathSync.native(cur), ...tail.slice().reverse())
      } catch {
        const parent = dirname(cur)
        if (parent === cur) return resolve(p)
        tail.push(basename(cur))
        cur = parent
      }
    }
  }
  return canon(a) === canon(b)
}

/**
 * 由 `edit` 参数重建改后内容。`{ok:true, content}`（content undefined = 无需校验）或 `{ok:false, reason}`。
 * 重建不了时守护**拒绝**：曾经这里 fail-open，而真实 `edit` 会先把文件与 old/new 归一成 LF、
 * 并用 split/join 做字面替换，于是「多行 old_string + CRLF 文件」和「new_string 里的 `$&`」
 * 都能让守护校验一份与真实落盘不同的文本，甚至直接跳过校验。
 *
 * 导出给宿主平面的 file-guard 复用——**两个平面共用同一份重建逻辑**，否则又会出现
 * "一边认 CRLF、一边不认"这类只在某个预设里才暴露的差异。
 */
export function reconstruct(abs, args) {
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

/**
 * 本周任务文件的受限写入判定：只允许「纯勾选状态变化」。
 * 把 `[x]`/`[X]` 归一成 `[ ]` 后两串相同，说明这次 edit 只动了勾选框，放行；
 * 任何文字改动（增删条目、改任务内容、整篇重写）都会被拒绝。
 * 返回 undefined 表示放行，否则返回拒绝原因。
 *
 * 第二道判定：**依据已作废的任务连勾选都不算数**。三份伴学 persona 一直这么写着，
 * 但代码里从来没有实现过（协议审计发现）——结果是档案更新之后，学员仍能勾掉一份属于
 * 旧档案版本的任务，总规划看板上就多出一条"已完成"，而它早就不在当前基准之上了。
 * `opts.basis` / `opts.archiveStamp` 由调用方从磁盘读出后传进来（本函数保持纯函数）。
 */
export function validateTaskWrite(tool, args, opts = {}) {
  if (tool === 'write') {
    return `${TASK_NAME} 是「总规划」下发的只读文件，不能整体重写。只允许把未完成的「- [ ]」改成「- [x]」表示勾选完成；你这一周的进展请写进 ${ARCHIVE_NAME}（总规划靠档案的更新日期判断本科有没有动作）`
  }
  const oldString = args?.old_string
  const newString = args?.new_string
  if (typeof oldString !== 'string' || typeof newString !== 'string') return undefined
  const norm = (s) => s.replace(/\[[xX]\]/g, '[ ]')
  // 依据对不上就没有"勾选"这件事可谈：先拦这一条，说法比"不许改文字"贴切得多。
  // 只在两边都拿得到时比较——拿不到（文件缺失、无依据行）不算违规，交回给下面的勾选判定。
  if (
    norm(oldString) === norm(newString) &&
    opts.basis !== undefined &&
    opts.archiveStamp !== undefined &&
    opts.basis !== opts.archiveStamp
  ) {
    return `${TASK_NAME} 的依据是「${opts.basis}」，但本科档案现在是 ${opts.archiveStamp}——**旧依据已经作废，这份任务连勾选都不算数**（勾了会让总规划误以为它完成了）。请把这一周的进展写进 ${ARCHIVE_NAME}，由总规划按新依据重新下发任务`
  }
  if (norm(oldString) === norm(newString)) return undefined
  return `${TASK_NAME} 是「总规划」下发的只读文件：只允许把「- [ ]」改成「- [x]」勾选完成，不得修改任务文字、增删条目或重写内容。如果任务本身需要调整，请在 ${ARCHIVE_NAME} 里写清情况与卡点，由总规划重新下发`
}

/**
 * 从磁盘取出「该科档案的日期戳」与「任务文件当前的依据」，喂给 `validateTaskWrite`。
 * 两个守护（宿主平面 file-guard 与预设内 companion-core）都走这一个函数，
 * 免得两处各读一遍、各解析一遍——口径分叉就是这样长出来的。
 */
export function taskBasisContext(taskAbs, archiveAbs) {
  const read = (p) => {
    try {
      return readFileSync(p, 'utf8')
    } catch {
      return undefined
    }
  }
  const task = read(taskAbs)
  const archive = read(archiveAbs)
  return {
    basis: task === undefined ? undefined : basisStamp(task),
    archiveStamp: archive === undefined ? undefined : archiveStamp(archive),
  }
}

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

function archivePath(cwd) {
  return join(cwd, ARCHIVE_NAME)
}

// `readProbe` 在 plan-core（依赖根）里，一处实现三处用：这里、file-guard 的存在性判断、看板的科目发现。
function readArchive(cwd) {
  return readProbe(archivePath(cwd), ARCHIVE_NAME)
}

function readText(abs, name) {
  return readProbe(abs, name)
}

/** 总规划下发的本周任务的注入块（头 + 正文）。 */
function renderTask(body) {
  return `【本周任务·总规划下发】这是「总规划」为本工作区下发的本周最小必做（MVE）。它**只读**：你可以也应当把完成的条目从「- [ ]」改成「- [x]」（只许勾选，改任务文字会被写入守护拒绝），其余一律不动。回执走 ${ARCHIVE_NAME}——周内取得进展照常更新它的进度/卡点/薄弱点，总规划靠档案的「更新于」日期判断本科这一周有没有动作；档案一直不动，就会在下一次周看板里变成一条漂移警报。\n\n${body}`
}

/**
 * 总规划的变更记录注入块。
 * 它是**流水**不是任务：每条自带日期，最新的在最上面；本科的具体任务仍然只看 `本周任务.md`。
 */
function renderNotice(body, isCompanion = false) {
  if (isCompanion) return `【变更记录·总规划维护】这是公开的安排改动及处理结果，只读，不是你的任务。可核对对应事项；同日结果也有效，不能只按最新日期猜测已经办理。你只维护自己的陪伴笔记，不改这份记录，不为它教学、复习或布置任务。\n\n${body}`
  return `【变更记录·总规划维护】这是「总规划」对全部科目公开的改动流水（谁改了什么，最新在上），不是你这一科的任务——你的任务以上面的 ${TASK_NAME} 为准。它是只读的，**不要清空、不要改写**：清空会让别科看不到，也会破坏「一文件一写者」（谁先读谁清 = 广播变成先到先得）。读到与你相关的改动照做即可，不必回执；有困难照常写进 ${ARCHIVE_NAME}。\n\n${body}`
}

/**
 * 「今天是几号」**只有一份实现**，在 plan-core —— 这里**不再**自己算一遍。
 *
 * 2026-09-25：`localDate` 曾在本文件与 plan-core 各有一份，实现相同但语义待改（学习日规则）。
 * 两份实现意味着这次改动要么改两处、要么改一处而两边悄悄不一致——所以直接删掉这份，
 * 改成 import + 原样再导出（`export ... from` 只做转发，**不建立本地绑定**，
 * 而本文件下面要用 studyDate，所以必须 import；同时再导出是为了让 `core.studyDate` 这类外部用法不断）。
 * 依赖方向本来就是 plan-core → companion-core（单向，不成环），所以这是安全的。
 */
import { DAY_RULE_HINT, DAY_START_HOUR, formatDate, studyDate } from './plan-core.js'
export { DAY_RULE_HINT, DAY_START_HOUR, archiveHygiene, formatDate, studyDate }
// 日期戳必须自成一行：否则正文里一句「见 09-01 那版，更新于 2026-01-01」会被当成真日期戳，
// 而且与 plan-core 的解析规则不一致会让两个插件对同一份档案得出不同基准。
const STAMP_RE = /^\s*(?:[-*]\s*)?更新于\s*[:：]?\s*(\d{4})-(\d{2})-(\d{2})/m

/** 校验档案内容；合法返回 undefined，违规返回拒绝原因（中文，面向模型可读）。 */
export function validateArchive(content, maxLines, maxBytes, today = studyDate()) {
  if (typeof content !== 'string') return '学习档案内容必须是字符串'
  if (BAD_CONTROL_RE.test(content)) return '学习档案含控制字符（如 NUL），会导致该文件之后无法被读取或编辑。请去掉这些字符再写入'
  const lines = content.split('\n').length
  if (lines > maxLines) {
    return `学习档案超过 ${maxLines} 行上限（当前 ${lines} 行）。档案写状态不写流水账：请先合并、删除已消化条目，再写入压缩后的版本`
  }
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > maxBytes) {
    return `学习档案超过 ${maxBytes} 字节上限（当前 ${bytes} 字节）。请先压缩到一页以内再写入`
  }
  for (const marker of ['进度', '卡点', '薄弱']) {
    if (!content.includes(marker)) {
      return `学习档案缺少「${marker}」字段。三个字段必须保留：学校当前进度 / 已答主题与卡点 / 未消化薄弱点`
    }
  }
  // 日期戳：强制写入者面对真实「今天」，把日期错乱拦在写入边界
  const m = STAMP_RE.exec(content)
  if (m === null) {
    return `学习档案必须含一行「更新于: YYYY-MM-DD」，日期取系统当前的学习日（今天是 ${today} ${DAY_RULE_HINT}）`
  }
  const stamped = `${m[1]}-${m[2]}-${m[3]}`
  const diffDays = Math.abs((Date.parse(`${stamped}T00:00:00`) - Date.parse(`${today}T00:00:00`)) / 86400000)
  if (!(diffDays <= 1)) {
    return `档案的「更新于」日期是 ${stamped}，但系统今天（学习日）是 ${today} ${DAY_RULE_HINT}——先核对当前日期、修正档案里的全部日期（计划表等）再写入`
  }
  return undefined
}

/**
 * 校验**陪伴笔记**（`心灵笔记.md`）；合法返回 undefined，违规返回拒绝原因。
 *
 * 与 `validateArchive` 的**不同**之处，每一条都是"陪伴不是学业"的直接后果：
 *   · **不要求** 进度 / 卡点 / 薄弱 —— 那是学业档案的三字段，聊天没有"薄弱点"。
 *   · 限额更小（40 行 / 4096 字节 vs 60 / 6144）——聊天记忆不该比学业档案还大。
 *   · 不查流水窗口与长条（`archiveHygiene` 是学业口径，拿它量聊天只会产生假警报）。
 *   · **仍然要求** 「更新于」日期戳，且必须在写入边界对上真实学习日：
 *     跨会话衔接全靠它，日期错乱会让"最近在想什么"变成一句不可信的话。
 *
 * 为什么必须**存在**（而不是"不受守护更自由"）：`file-guard.classify()` 认不出它
 * ⇒ 无行数上限、无字节上限、无控制字符校验、无大小写防绕过（`心灵笔记.MD` 直接放行）。
 * 那是一块自由写入区，而它恰恰是**唯一**会被注入进每一轮上下文的东西——
 * 无上限 = 每一轮都在为它付钱（实测：`.verify/probe-companion-memory-placement.mjs`）。
 */
export function validateCompanionNote(content, maxLines = COMPANION_MAX_LINES, maxBytes = COMPANION_MAX_BYTES, today = studyDate()) {
  if (typeof content !== 'string') return `${COMPANION_NOTE_NAME} 内容必须是字符串`
  if (BAD_CONTROL_RE.test(content)) return `${COMPANION_NOTE_NAME} 含控制字符（如 NUL），会导致该文件之后无法被读取或编辑。请去掉这些字符再写入`
  const lines = content.split('\n').length
  if (lines > maxLines) {
    return `${COMPANION_NOTE_NAME} 超过 ${maxLines} 行上限（当前 ${lines} 行）。陪伴笔记只记"最近在想什么、卡在哪、有什么要说"，不记流水账：请先合并、删掉已经过去的事再写入`
  }
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > maxBytes) {
    return `${COMPANION_NOTE_NAME} 超过 ${maxBytes} 字节上限（当前 ${bytes} 字节）。请先压缩再写入`
  }
  const m = STAMP_RE.exec(content)
  if (m === null) {
    return `${COMPANION_NOTE_NAME} 必须含一行「更新于: YYYY-MM-DD」，日期取系统当前的学习日（今天是 ${today} ${DAY_RULE_HINT}）`
  }
  const stamped = `${m[1]}-${m[2]}-${m[3]}`
  const diffDays = Math.abs((Date.parse(`${stamped}T00:00:00`) - Date.parse(`${today}T00:00:00`)) / 86400000)
  if (!(diffDays <= 1)) {
    return `笔记的「更新于」日期是 ${stamped}，但系统今天（学习日）是 ${today} ${DAY_RULE_HINT}——先核对当前日期、修正笔记里的日期再写入`
  }
  return undefined
}

// ── 课程路线：解析 / 校验 / 摘要 ────────────────────────────────────────────────
// 行格式（写入守护按这个格式执法；解析与校验共用同一套正则 —— 口径只留一份）：
//   单元：  `- C02 数据类型与表达式｜教材 第2章｜前置 C01｜目标 L3｜状态 进行中｜证据 10-17 复习 6.5/10`
//   下一课：`- 主题：…｜为什么现在：…｜目标 L3｜验收：…`
//   覆盖：  `- [x] 知识点` / `- [ ] 知识点`（可分组：`### 组名`）
const ROUTE_BASIS = '课程基准'
const ROUTE_UNITS = '单元进度'
const ROUTE_NEXT = '下一课'
const ROUTE_COVERAGE = '覆盖清单'
const ROUTE_REQUIRED = [ROUTE_BASIS, ROUTE_UNITS, ROUTE_NEXT, ROUTE_COVERAGE]
const ROUTE_UNIT_RE = /^- ([A-Za-z]+\d+) (.+?)｜教材 (.+?)｜前置 (.+?)｜目标 L([1-4])｜状态 (未开始|进行中|已过|待复)｜证据 (.+)$/
const ROUTE_EVIDENCE_EMPTY = new Set(['—', '-', '无', '无。', '暂无', '空'])

/** 取 `## 小节` 的正文行（不含标题本身）；小节不存在时返回 []。 */
function routeSectionLines(content, name) {
  const out = []
  let inside = false
  for (const raw of content.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('## ')) {
      inside = line === `## ${name}`
      continue
    }
    if (inside) out.push(raw)
  }
  return out
}

/** 「下一课」那一行 → 四字段对象（解析与校验共用）。 */
function parseNextRow(sectionLines) {
  for (const raw of sectionLines) {
    const t = raw.trim()
    if (!t.startsWith('- ')) continue
    const obj = {}
    for (const part of t.slice(2).split('｜')) {
      const i = part.indexOf('：')
      if (i > 0) {
        obj[part.slice(0, i).trim()] = part.slice(i + 1).trim()
        continue
      }
      // 「目标 L3」这种"键 空格 值"也认（模板里不强制冒号，但字段名必须认得出）
      const m = /^(主题|为什么现在|目标|验收)\s+(.+)$/.exec(part.trim())
      if (m !== null) obj[m[1]] = m[2].trim()
    }
    if ((obj['主题'] ?? '').length > 0) return obj
  }
  return undefined
}

/** 「覆盖清单」→ [{group, label, checked}]。 */
function parseCoverageItems(content) {
  const items = []
  let group = ''
  for (const raw of routeSectionLines(content, ROUTE_COVERAGE)) {
    const t = raw.trim()
    if (t.startsWith('### ')) { group = t.slice(4).trim(); continue }
    const m = /^- \[( |x|X)\] (.+)$/.exec(t)
    if (m !== null) items.push({ group, label: m[2].trim(), checked: m[1].toLowerCase() === 'x' })
  }
  return items
}

/**
 * 把 `课程路线.md` 解析成结构化事实（纯函数，不判合法性 —— 判合法性归 validateRoute）。
 * 解析不出来时返回空结构，调用方据此给出"格式提醒"，**不会**把空结果当成"路线是空的"。
 */
export function parseRoute(content) {
  const empty = { stamp: undefined, basis: [], units: [], next: undefined, coverage: { groups: [], items: [], checked: 0, total: 0 } }
  if (typeof content !== 'string') return empty
  const m = STAMP_RE.exec(content)
  const basis = routeSectionLines(content, ROUTE_BASIS)
    .map((l) => l.trim().replace(/^[-*]\s+/, ''))
    .filter((l) => l.length > 0 && !l.startsWith('#') && !l.startsWith('>'))
  const units = []
  for (const raw of routeSectionLines(content, ROUTE_UNITS)) {
    const u = ROUTE_UNIT_RE.exec(raw.trim())
    if (u !== null) units.push({ code: u[1], name: u[2], chapter: u[3], prereq: u[4], depth: Number(u[5]), status: u[6], evidence: u[7] })
  }
  const nextRow = parseNextRow(routeSectionLines(content, ROUTE_NEXT))
  const items = parseCoverageItems(content)
  const groups = []
  for (const raw of routeSectionLines(content, ROUTE_COVERAGE)) {
    const t = raw.trim()
    if (t.startsWith('### ')) groups.push(t.slice(4).trim())
  }
  return {
    stamp: m === null ? undefined : `${m[1]}-${m[2]}-${m[3]}`,
    basis,
    units,
    next: nextRow === undefined ? undefined : { ...nextRow, text: nextRowText(nextRow) },
    coverage: { groups, items, checked: items.filter((i) => i.checked).length, total: items.length },
  }
}

function nextRowText(next) {
  return `主题：${next['主题']}｜为什么现在：${next['为什么现在'] ?? ''}｜目标 ${next['目标'] ?? ''}｜验收：${next['验收'] ?? ''}`
}

/**
 * 校验 `课程路线.md`；合法返回 undefined，违规返回拒绝原因（中文、面向模型可读）。
 *
 * 与 `validateArchive` 的分工：档案管**状态量**（三字段、6KB/60 行），路线管**课程级骨架**
 * （四节固定、单元行六字段、状态只能按证据升级、覆盖清单必须非空）。两者都要求日期戳落在
 * 写入当天 —— 让"路线早就该更新了"在写入边界就暴露，而不是靠模型自觉。
 * `stampFresh:false` 只给**读取时**用（读一份旧路线很正常；写才要求今天）。
 */
export function validateRoute(content, maxLines = DEFAULT_ROUTE_MAX_LINES, maxBytes = DEFAULT_ROUTE_MAX_BYTES, today = studyDate(), { stampFresh = true } = {}) {
  if (typeof content !== 'string') return `${ROUTE_NAME} 内容必须是字符串`
  if (BAD_CONTROL_RE.test(content)) return `${ROUTE_NAME} 含控制字符（如 NUL），会导致该文件之后无法被读取或编辑。请去掉这些字符再写入`
  const lineCount = content.split('\n').length
  if (lineCount > maxLines) return `${ROUTE_NAME} 超过 ${maxLines} 行上限（当前 ${lineCount} 行）。路线是课程级骨架：细节（题解、报错、代码）放进 题目记录.md / 复习提纲.md，这里只留单元、下一课与覆盖勾选`
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > maxBytes) return `${ROUTE_NAME} 超过 ${maxBytes} 字节上限（当前 ${bytes} 字节）。先压缩：单元行各一句话、证据只写"日期＋判据"，覆盖清单只留知识点名`
  for (const name of ROUTE_REQUIRED) {
    const headings = content.split('\n').filter((l) => l.trim() === `## ${name}`).length
    if (headings !== 1) return `${ROUTE_NAME} 必须含且只含一个「## ${name}」小节（当前 ${headings} 个）。四节固定：## ${ROUTE_REQUIRED.join(' / ## ')}——课程路线是课程级事实，不装流水账`
  }
  const m = STAMP_RE.exec(content)
  if (m === null) return `${ROUTE_NAME} 必须含一行「更新于: YYYY-MM-DD」，日期取系统当前的学习日（今天是 ${today} ${DAY_RULE_HINT}）`
  const stamped = `${m[1]}-${m[2]}-${m[3]}`
  if (stampFresh) {
    const diffDays = Math.abs((Date.parse(`${stamped}T00:00:00`) - Date.parse(`${today}T00:00:00`)) / 86400000)
    if (!(diffDays <= 1)) return `路线的「更新于」是 ${stamped}，但系统今天（学习日）是 ${today} ${DAY_RULE_HINT}——先核对日期再写（写今天）`
  }
  const basis = parseRoute(content).basis
  if (!basis.some((l) => l.includes('教材'))) return `「## ${ROUTE_BASIS}」必须写明教材（教材是覆盖清单的基准）：例如「教材＝苏小红《C语言程序设计》第五版」`
  const unitRaw = routeSectionLines(content, ROUTE_UNITS).map((l) => l.trim()).filter((l) => l.length > 0 && !l.startsWith('#'))
  if (unitRaw.length === 0) return `「## ${ROUTE_UNITS}」至少要有 1 个单元（格式：- C02 名称｜教材 第2章｜前置 C01｜目标 L3｜状态 进行中｜证据 10-17 …）`
  const seen = new Set()
  for (const line of unitRaw) {
    const u = ROUTE_UNIT_RE.exec(line)
    if (u === null) return `单元行格式不对：${line.slice(0, 80)}。必须写成「- 编号 名称｜教材 章节｜前置 编号或—｜目标 L1–L4｜状态 未开始/进行中/已过/待复｜证据 …」六个字段用全角｜分隔`
    if (seen.has(u[1])) return `单元编号 ${u[1]} 重复：每个单元只写一行`
    seen.add(u[1])
    if (u[6] === '已过' && ROUTE_EVIDENCE_EMPTY.has(u[7].trim())) return `单元 ${u[1]} 标了「已过」但证据是空的：状态只能按证据升级（code_run 用例通过 / study_judge 判定 / 学员独立复现），「老师讲过」「我讲过」都不算`
  }
  const next = parseNextRow(routeSectionLines(content, ROUTE_NEXT))
  if (next === undefined) return `「## ${ROUTE_NEXT}」必须有一行：- 主题：…｜为什么现在：…｜目标 L3｜验收：…（唯一一条，是学员和你的下一个动作）`
  const missingKeys = ['主题', '为什么现在', '目标', '验收'].filter((k) => (next[k] ?? '').length === 0)
  if (missingKeys.length > 0) return `「${ROUTE_NEXT}」缺少字段：${missingKeys.join('、')}。四段都要写全：主题 / 为什么现在 / 目标 L1–L4 / 验收`
  if (!/^L[1-4]$/.test(next['目标'].trim())) return `「${ROUTE_NEXT}」的目标深度要写 L1–L4（当前「${next['目标'].trim()}」）`
  const items = parseCoverageItems(content)
  if (items.length === 0) return `「## ${ROUTE_COVERAGE}」至少要有 1 条知识点（- [ ] 或 - [x]）：这是"教学内容完整"的判据，空清单等于没有覆盖基线`
  return undefined
}

/**
 * 课程路线的**注入摘要**（投递的那一半：每轮在模型眼前；详情仍按需读文件）。
 * 只放决策所需：基准、单元状态计数、覆盖统计与缺口、唯一的下一条、以及"已陈旧"的提醒。
 * 抬头自报"我不是权威"（§37.7-3）：摘要会陈旧，冲突时以文件原文为准。
 */
export function renderRouteDigest(parsed, { bytes = 0, maxBytes = DEFAULT_ROUTE_MAX_BYTES, today = studyDate(), archiveStamp } = {}) {
  const counts = { 未开始: 0, 进行中: 0, 已过: 0, 待复: 0 }
  for (const u of parsed.units) counts[u.status] += 1
  const total = parsed.units.length
  const cov = parsed.coverage
  const pct = cov.total > 0 ? Math.round((cov.checked / cov.total) * 100) : 0
  const gaps = cov.items.filter((i) => !i.checked).map((i) => (i.group.length > 0 ? `${i.group}·${i.label}` : i.label))
  const basis = parsed.basis.join(' · ').slice(0, 260)
  const lines = [
    `【课程路线·自动注入】系统当前日期：${today} ${DAY_RULE_HINT}。下面是从本工作区 ${ROUTE_NAME} 自动生成的摘要（${bytes} / ${maxBytes} 字节，更新于 ${parsed.stamp ?? '缺日期戳'}）——**可能陈旧，详情以文件为准**；路线改动后下一轮会重新注入。**改它之前先 read 一遍**（注入不算读过；DSH 重启/恢复后观察清零）。`,
  ]
  if (basis.length > 0) lines.push(`- 基准：${basis}`)
  lines.push(`- 进度：已过 ${counts['已过']} · 进行中 ${counts['进行中']} · 未开始 ${counts['未开始']}${counts['待复'] > 0 ? ` · 待复 ${counts['待复']}` : ''}（共 ${total} 单元）｜覆盖 ${cov.checked}/${cov.total}（${pct}%，缺口 ${gaps.length} 条）`)
  lines.push(`- 下一课：${parsed.next === undefined ? '缺（路线必须写唯一一条「下一课」）' : parsed.next.text.slice(0, 300)}`)
  if (gaps.length > 0) lines.push(`- 覆盖缺口（最先出现的）：${gaps.slice(0, 5).join('、')}${gaps.length > 5 ? ` 等 ${gaps.length} 条` : ''}`)
  const warn = []
  if (parsed.stamp === undefined) {
    warn.push('路线缺「更新于: YYYY-MM-DD」日期戳——写入守护会拒绝这种写法，先补日期再改。')
  } else {
    if (archiveStamp !== undefined && parsed.stamp < archiveStamp) warn.push(`路线（${parsed.stamp}）比 ${ARCHIVE_NAME}（${archiveStamp}）旧：这期间学过的内容先补进路线，再继续教新的。`)
    const days = Math.round((Date.parse(`${today}T00:00:00`) - Date.parse(`${parsed.stamp}T00:00:00`)) / 86400000)
    if (Number.isFinite(days) && days >= 3) warn.push(`课程路线已 ${days} 天未更新：覆盖清单和「下一课」可能已对不上实际进度。`)
  }
  if (warn.length > 0) lines.push(...warn.map((w) => `⚠️ ${w}`))
  return lines.join('\n')
}

/**
 * 学科工作区里**没有**课程路线时的注入文案。
 * 刻意只在存在 `学习档案.md` 的学科目录触发：非学科工作区（如项目目录）不该被这份协议打扰。
 */
export const ROUTE_MISSING_HINT = `【课程路线·缺失】本工作区还没有 ${ROUTE_NAME}（课程级学习路线）。本预设的职责不只是答疑：系统教学必须先有路线。现在就做两件事——① 若学员只是来问一个问题：先答（答完把结果归位到"该知识点属于哪个单元"）；② 若学员要系统学/复习，先用 2–3 分钟对话摸底（教材哪本、学校课上到哪、怎么考、已经学过什么），按「## 课程基准 / ## 单元进度 / ## 下一课 / ## 覆盖清单」四节建一份再教。不编教材章节，不假装知道学校进度；单元行格式见本预设「教学契约」。`

/**
 * 「写前先读」提示（2026-10-18：学员看到数学会话里多次出现 `file has not been read`）。
 *
 * 真因不是模型"忘了"，而是两层设计的接缝：`dsh-fs-observation-policy` 要求 write/edit 一个
 * **已存在**文件前，本会话必须**真的 read** 过它；而观察记录是**内存态、不跨宿主进程/会话恢复持久化**
 * （官方 README 原话："a resumed session starts with no observations"）。可档案/笔记/路线是每轮
 * **注入**的——模型每轮都"看见"档案正文，很容易把注入当成"读过了"，于是直接写 → 第一次必被拒，
 * 然后 read + 重试（恢复动作是对的，数据不丢，但同一个坑天天重撞）。
 *
 * 解法只能是**把边界放到模型读书的位置**：每次注入都带这句。它不是一个新规则，而是宿主策略的
 * 说明书——写在模型最容易误判的那一行旁边，比写在 persona 里更可能被看见。
 */
const READ_BEFORE_WRITE_NOTE = '\n**写前先读**：上面是注入的快照，`write`/`edit` 已存在的文件前必须先用 `read` 读它（注入 ≠ 读过；DSH 重启或恢复会话后观察会清零）。被拒 `file has not been read` / `FS_STALE_VERSION` 时按提示 read 后重试，**不要改用 shell 或脚本绕过**——那会让版本保护变成假象。'


/**
 * 档案陈旧提示：`更新于` 落后系统日期 ≥2 天时返回一行提醒，否则返回 ''。
 * 写在读的那一刻（注入块头部），与写入守护互补：守护管「写进来的日期对不对」，
 * 这里管「档案自己有没有过期没人管」。
 */
export function staleNotice(content, today = studyDate()) {
  const m = STAMP_RE.exec(content)
  if (m === null) return ''
  const stamped = `${m[1]}-${m[2]}-${m[3]}`
  const days = Math.round((Date.parse(`${today}T00:00:00`) - Date.parse(`${stamped}T00:00:00`)) / 86400000)
  if (!Number.isFinite(days) || days < 2) return ''
  return `\n⚠️ 档案已 ${days} 天未更新（「更新于: ${stamped}」，今天 ${today}）：本轮若产生新的进度 / 卡点 / 薄弱点，先更新 ${ARCHIVE_NAME} 再收尾。`
}

export function apply(ctx, config) {
  const maxLines = Number.isSafeInteger(config?.maxLines) ? config.maxLines : DEFAULT_MAX_LINES
  const maxBytes = Number.isSafeInteger(config?.maxBytes) ? config.maxBytes : DEFAULT_MAX_BYTES
  // 「陪伴」模式：记忆文件是 `心灵笔记.md`（另一套契约），而不是 `学习档案.md`。
  // 不配 = 今天的行为（学科档案），所以这是纯增量开关。
  const companionNoteName = typeof config?.noteName === 'string' && config.noteName.length > 0 ? config.noteName : undefined
  const isCompanion = companionNoteName !== undefined
  const companionMaxLines = Number.isSafeInteger(config?.noteMaxLines) ? config.noteMaxLines : COMPANION_MAX_LINES
  const companionMaxBytes = Number.isSafeInteger(config?.noteMaxBytes) ? config.noteMaxBytes : COMPANION_MAX_BYTES
  // 记忆文件（注入块的头号内容）与**账本**（"这条移交收下了没有"的凭据）。
  // 陪伴没有 `复习提纲.md`——它自己的笔记就是账本（`收下的移交`那一节里带来源戳）。
  const memoryName = isCompanion ? companionNoteName : ARCHIVE_NAME
  const ledgerName = isCompanion ? companionNoteName : OUTLINE_NAME
  const readMemory = (cwd) => readProbe(join(cwd, memoryName), memoryName)
  const statOf = (p) => {
    try { const s = statSync(p); return { size: s.size, mtimeMs: s.mtimeMs } } catch { return null }
  }

  // ── 贡献 1：档案自动注入 ────────────────────────────────────────────────
  // 每个 agent 最近一次注入的文本（内存即可：重启后首轮重新注入一次，无害）。
  // 科目→预设对照：读 `<学习根>/.科目预设.json`，形如 `{ "<科目目录名>": "<预设显示名>" }`。
// 缺文件 / 坏 JSON / 值不是字符串 → 一律当作"没有对照"，只走通用提醒（绝不因为配置坏了就报错）。
const SUBJECT_PRESET_FILE = '.科目预设.json'
const presetMapCache = new Map()
function readSubjectPreset(cwd, subjectName) {
  const root = dirname(cwd)
  const file = join(root, SUBJECT_PRESET_FILE)
  let map = presetMapCache.get(file)
  if (map === undefined) {
    map = null
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
        map = Object.fromEntries(
          Object.entries(raw).filter(([, v]) => typeof v === 'string' && v.trim().length > 0),
        )
      }
    } catch (err) {
      if (err?.code !== 'ENOENT') {
        console.warn('[companion-core] .科目预设.json 读取失败，按"无对照"继续：', err?.message ?? err)
      }
    }
    presetMapCache.set(file, map)
  }
  if (map === null) return undefined
  const hit = map[subjectName]
  return typeof hit === 'string' ? hit : undefined
}

const lastInjected = new Map()

  ctx.on('agent/pre-step', async ({ agent, step, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision
    if (step !== 1) return decision // 只在每轮开头注入，步骤中途不打扰
    const cwd = agent.session?.header?.cwd
    if (typeof cwd !== 'string' || cwd.length === 0) return decision
    const a = readMemory(cwd)
    const t = readText(join(cwd, TASK_NAME), TASK_NAME)
    // 广播放在**学习根目录**（本工作区的父目录），与 总规划.md 同级；各科只读。
    const n = readText(join(dirname(cwd), NOTICE_NAME), NOTICE_NAME)
    // 自己的提纲（陪伴模式：自己的笔记）：只为下面两条"跨科"判据服务，
    // **正文本身不进注入**（那是账本，进来只会挤上下文）。
    const o = readProbe(join(cwd, ledgerName), ledgerName)
    // 课程路线（2026-10-17）：只有**学科工作区**（本目录有 `学习档案.md`）才有路线文件；
    // 陪伴目录没有课程路线。读不到时留 code，下面的注入会如实说明（F11：读不到 ≠ 没有）。
    const r = !isCompanion && a.ok ? readProbe(join(cwd, ROUTE_NAME), ROUTE_NAME) : { ok: false, missing: true }
    const w = !isCompanion && a.ok ? readProbe(join(cwd, WORD_REVIEW_DATA_NAME), WORD_REVIEW_DATA_NAME) : { ok: false, missing: true }
    const probes = [a, t, n]
    // 「一个都没有」= 三个都**确实不存在**。读不到**不算**"没有"——见下面的告警（F11）。
    if (probes.every((p) => !p.ok && p.missing)) {
      lastInjected.delete(agent.id) // 全都没了：之后重建时重新注入
      return decision
    }
    const unreadable = probes.filter((p) => !p.ok && !p.missing)
    let text = a.ok ? a.text.trim() : ''
    if (text.length > maxBytes) text = text.slice(0, maxBytes) + '\n…（档案超长，注入已截断；请尽快压缩到一页以内）'
    const taskText = t.ok ? t.text.trim() : ''
    const noticeText = n.ok ? n.text.trim() : ''
    // ── 跨科知识点：两条来路，判据都是"**提纲里到底有没有这一条**" ─────────────────
    // ① 别科在自己的档案里打了 `@本科` 标记（**主路**：发现方只碰自己的文件）；
    // ② 别科直接追加进了本科的提纲（备选路）。
    // ★ 判据刻意选"以提纲为准"（没收下就一直提醒），而不是"本科档案更新过没有"——
    //   后者有一条**静默丢失**：顺手更新了档案却没真收下，提醒就永久消失、东西也丢了。
    const outlineText = o.ok ? o.text : ''
    const ownStamp = a.ok ? (archiveStamp(a.text) ?? undefined) : undefined
    const { pending: handoffs, stale: staleHandoffs } = pendingHandoffs(cwd, {
      outlineText,
      companionReceiptText: a.ok ? a.text : '',
      archiveStampValue: ownStamp,
      ...(isCompanion ? { noteName: companionNoteName } : {}),
    })
    const handoffText = handoffs.length > 0 ? renderHandoffs(handoffs, { staleCount: staleHandoffs, ledgerName, companionSourceName: companionNoteName ?? COMPANION_NOTE_NAME }) : ''
    // 陪伴的收件凭据不是复习知识点，不再用学科“复习/出题”模板重复渲染。
    const foreign = isCompanion ? [] : foreignOutlineEntries(outlineText)
    const foreignText = foreign.length > 0 ? renderForeignOutline(foreign) : ''
    // 档案卫生（2026-10-06）：把 persona 那两条规定算成数字，在**被拒之前**提醒。
    // 陪伴笔记**不算**这个卫生：那两条规定（流水只留 5 个学习日、每条一句话）是**学业档案**的，
    // 陪伴的记忆规则不同（见 validateCompanionNote），拿学业口径去量它只会产生假警报。
    const hygieneText = !isCompanion && text.length > 0 ? renderHygiene(archiveHygiene(text)) : ''
    // 课程路线摘要（2026-10-17）：路线在文件里，但**每轮都在眼前**才算投递到位（设计文档 §37.7）。
    // 只在学科工作区注入：有 `学习档案.md` 才有课程路线；非学科工作区（项目目录）不打扰。
    let routeBlock = ''
    if (!isCompanion && a.ok) {
      if (r.ok) {
        const parsed = parseRoute(r.text)
        const invalid = validateRoute(r.text, DEFAULT_ROUTE_MAX_LINES, DEFAULT_ROUTE_MAX_BYTES, studyDate(), { stampFresh: false })
        const digest = renderRouteDigest(parsed, { bytes: Buffer.byteLength(r.text, 'utf8'), today: studyDate(), archiveStamp: ownStamp })
        routeBlock = invalid === undefined
          ? digest
          : `【课程路线·格式提醒】${ROUTE_NAME} 存在，但写法会被写入守护拒绝（${invalid}）。先用文件工具按模板修正，别在修好前把下面的摘要当事实：\n\n${digest}`
      } else if (r.missing) {
        routeBlock = ROUTE_MISSING_HINT
      } else {
        routeBlock = `【课程路线·读取异常】${ROUTE_NAME} 存在、但这次读不出来（${r.code}）：不要凭记忆补写它的内容；先如实告诉学员，让他确认文件状态后再重试。`
      }
    }
    // 单词复习站（2026-10-19）：只报机械状态（当前单元 / 条目 / 构建同步），
    // 不报熟悉度——F 等级在手机浏览器 localStorage，PC 端看不到。
    let wordReviewBlock = ''
    if (!isCompanion && a.ok) {
      const dataStat = statOf(join(cwd, WORD_REVIEW_DATA_NAME))
      const htmlStat = statOf(join(cwd, WORD_REVIEW_HTML_NAME))
      const bookStat = statOf(join(cwd, '词汇情景本.md'))
      if (w.ok) {
        let data = null
        try { data = JSON.parse(w.text) } catch { data = null }
        if (data === null || !Array.isArray(data.units) || !Array.isArray(data.items)) {
          wordReviewBlock = `【单词复习站·数据异常】${WORD_REVIEW_DATA_NAME} 存在，但不是可解析的结构（需要 units/items 数组）。先修数据再构建；不要手改 ${WORD_REVIEW_HTML_NAME}。`
        } else {
          const current = data.units.filter((u) => u && u.current === true)
          const currentUnit = current.length === 1 ? current[0] : null
          const currentTitle = currentUnit ? (currentUnit.title || currentUnit.id) : (current.length === 0 ? '缺 current 单元' : '多个 current 单元')
          const currentItems = currentUnit ? data.items.filter((i) => i && i.unitId === currentUnit.id).length : 0
          const pending = data.items.filter((i) => i && i.testable === false && i.kind !== 'knowledge').length
          const keyed = data.items.filter((i) => i && typeof i.key === 'string' && i.key.length > 0).length
          const reading = currentUnit && currentUnit.reading
          const readingThemes = reading && Array.isArray(reading.parts) ? reading.parts.map((p) => p && p.theme).filter(Boolean) : []
          const themes = readingThemes.length ? readingThemes : [...new Set((data.contexts || []).filter((c) => c && c.unitId === (currentUnit && currentUnit.id)).map((c) => c.theme || '本单元'))]
          const sync = htmlStat === null
            ? `${WORD_REVIEW_HTML_NAME} 还没构建`
            : (dataStat !== null && htmlStat.mtimeMs > dataStat.mtimeMs ? 'HTML 与数据同步' : '数据比 HTML 新，需重建')
          const bookNote = bookStat !== null && dataStat !== null && bookStat.mtimeMs > dataStat.mtimeMs ? '；书比数据新，先同步数据' : ''
          const currentNote = currentUnit ? `当前单元：${currentTitle}（${currentItems} 项）` : `单元状态异常：${currentTitle}`
          const readingParts = reading && Array.isArray(reading.parts) ? reading.parts.length : 0
          wordReviewBlock = `【单词复习站·自动注入】${currentNote}；共 ${data.units.length} 个单元 / ${data.items.length} 项${pending > 0 ? ` / 待补语境 ${pending}` : ''}；稳定 key ${keyed}/${data.items.length}；阅读 ${readingParts || '?'} 篇 ${reading ? `（${reading.wordCount || '?'} 词 / ${themes.join('/') || '—'}）` : '（缺 reading）'}；${sync}${bookNote}。进度文件格式 v1 / schema 5，可按 key 长期导入；卡片是主路径（固定视口/翻面记忆/左右切卡/上滑拼写；四档 忘记/模糊/认识/非常熟悉，S4 当天回访，词库 294 条义项，卡背四象限，固定底部 toast）；拼写独立（中文提示→英文、不与其他板块重合）；易混 5 变体 + 48 相关词题（正确项可为相关词，选项必含原词）/每道≥2 个站外项；分板块状态（词汇/短语/句式/替换主 items，易混独立 sections.pitfalls，阅读 3/7/21 天），动态只写 nextDue、不自动升降；到期词移入独立「遗忘复习」入口（普通卡片/盲测不再混入，可按板块勾选、每批最多 10 题）；结果页 lastSummary 兜底；六板块、一轮覆盖全词、无大小上限；这是机械状态，**不是学员的熟悉度**——熟悉度与卡片自评在手机浏览器 localStorage，你看不到，不要声称知道。改数据前先 read；改完跑 word-review-change.mjs --data-only，再 --build，再 verify-word-review.mjs；不要手改 HTML。学员说「更新/重建复习站」时先读 单词复习站规范.md §13 与 单词复习站修改SOP.md。`
        }
      } else if (!w.missing) {
        wordReviewBlock = `【单词复习站·读取异常】${WORD_REVIEW_DATA_NAME} 存在、但这次读不出来（${w.code}）：不要凭记忆补写；先让学员确认文件状态。`
      } else if (htmlStat !== null) {
        wordReviewBlock = `【单词复习站·状态】${WORD_REVIEW_HTML_NAME} 存在，但 ${WORD_REVIEW_DATA_NAME} 缺失：先补数据，再构建；不要手改 HTML。`
      }
    }
    // 可读性进缓存键：占用解除之后必须重注入一次，否则模型永远停在"读不到"那一版。
    const unreadableKey = unreadable.map((p) => `${p.name}:${p.code}`).join(',')
    // 日期进缓存键：跨天后即使档案一字未改也重注入一次，保证「系统当前日期」基准
    // 与陈旧提醒真的到达模型（否则内容未变就永不注入，跨天基准会停在旧日期）。
    const cacheKey = `${studyDate()}|${text}|${taskText}|${noticeText}|${unreadableKey}|${handoffText}|${foreignText}|${hygieneText}|${routeBlock}|${wordReviewBlock}`
    if (lastInjected.get(agent.id) === cacheKey) return decision // 未变化，零成本
    lastInjected.set(agent.id, cacheKey)
    // ★ 身份自检：工作区科目和预设身份不一致时，模型自己不会报错，
    // 只会用错口径硬教（真实发生过：某个科目目录里跑着别的门类的预设，一整轮都在用错身份）。
    // 错配只能靠开头这句点破；它是注入的一部分，所以只随档案变化重发，零额外轮次成本。
    const subjectName = basename(cwd)
    // ★ 2026-11-07 可移植性：科目→预设的对照**不再是代码里的常量**。
    //   以前这里写死了维护者的 8 个科目，别人的科目对不上、且把某一个人的配置固化进了产品。
    //   现在读学习根下的 `.科目预设.json`（`{ "科目目录名": "预设显示名" }`，可选）：
    //   没有这个文件就只做"科目 vs 预设"的通用提醒，不点名期望预设——功能不降级，产品不带个人配置。
    const expectedPreset = readSubjectPreset(cwd, subjectName)
    const identityBlock =
      `【身份自检】本工作区科目「${subjectName}」` +
      (expectedPreset ? `，对应预设应是「${expectedPreset}」` : '') +
      '。若你当前的预设身份与它不符（科目目录里跑着别的门类的预设），**第一轮先提醒学员：当前预设与工作区不符，建议新会话换回对应预设**；不要用错身份硬教，确认一致再继续。'
    const injected = []
    // ★ F11：**"读不到"必须说出来**。这一条是给模型的护栏——它看不到档案就不知道有这一科，
    // 而"凭记忆补写"会覆盖掉真实内容（那是一次不可逆的数据丢失）。
    if (unreadable.length > 0) {
      injected.push(
        snapshotMessage(
          `【伴学文件·读取异常】本工作区有 ${unreadable.length} 个受管文件**存在、但这次读不出来**：${unreadable.map((p) => `${p.name}（${p.code}）`).join('、')}。\n这不是「还没建」，也不是你的错——常见原因是权限、被别的进程占用、磁盘错误，或者那个路径其实是个目录。\n**绝对不要凭记忆把它们的"内容"补写回去**：你并没有读到原文，补写等于覆盖。先如实告诉学员这件事，让他在本机确认后再重试。`,
        ),
      )
    }
    if (text.length > 0) {
      injected.push(
        snapshotMessage(
          (identityBlock.length > 0 ? identityBlock + '\n\n' : '') +
          (isCompanion
            ? `【陪伴笔记·自动注入】系统当前日期：${studyDate()} ${DAY_RULE_HINT}（这是核对笔记里一切日期的唯一基准）。以下是本工作区 ${memoryName} 的当前内容（${Buffer.byteLength(text, 'utf8')} / ${maxBytes} 字节），每次变化时自动同步，你无需再手动读取它；聊完一轮后若有值得记住的状态，仍要及时更新它，写入时须含一行「更新于: YYYY-MM-DD」（取上面那个系统当前日期）。${READ_BEFORE_WRITE_NOTE}\n` +
              `它是**陪伴**的记忆，不是学业档案：不记流水账、不打分、不布置任务。总规划的自动看板只渲染「${COMPANION_SECTION_PLAN}」；学科定向移交只投递「要跟学科说的」节内匹配 @目标科目 的条目。普通状态不进入这些自动注入，但这是通道隔离，不是文件访问隔离；有文件权限的工具仍可能读取笔记。出信先判断影响与授权，只传必要结论。`
            : `【伴学档案·自动注入】系统当前日期：${studyDate()} ${DAY_RULE_HINT}（这是核对档案里一切日期的唯一基准）。以下是本工作区 ${ARCHIVE_NAME} 的当前内容（${Buffer.byteLength(text, 'utf8')} / ${maxBytes} 字节），每次变化时自动同步，你无需再手动读取它；对话中取得进展后仍要及时更新它，写入时须含一行「更新于: YYYY-MM-DD」（取上面那个系统当前日期）。${READ_BEFORE_WRITE_NOTE}`) +
            `${isCompanion ? '' : staleNotice(text)}\n\n${text}` +
          (handoffText.length > 0 ? `\n\n${handoffText}` : '') +
          (foreignText.length > 0 ? `\n\n${foreignText}` : '') +
          (hygieneText.length > 0 ? `\n\n${hygieneText}` : ''),
        ),
      )
    }
    if (routeBlock.length > 0) injected.push(snapshotMessage(routeBlock))
    if (wordReviewBlock.length > 0) injected.push(snapshotMessage(wordReviewBlock))
    if (taskText.length > 0) injected.push(snapshotMessage(renderTask(taskText)))
    if (noticeText.length > 0) injected.push(snapshotMessage(renderNotice(noticeText, isCompanion)))
    if (injected.length === 0) return decision
    return { ...decision, messages: [...decision.messages, ...injected] }
  }, { prepend: true })

  // 上下文压缩（compaction）会把已注入的档案快照折叠进摘要节点，
  // 表面从此只剩有损摘要；此时必须作废去重缓存，让下一轮 step 1
  // 从磁盘重新注入最新档案（含「系统当前日期」基准行）。
  // 失败的压缩（event.data.error 存在）不改变表面，不动缓存以免重复注入。
  ctx.on('session/event', (_session, event) => {
    if (event.type !== 'compaction/end') return
    if (event.data !== null && typeof event.data === 'object' && 'error' in event.data) return
    lastInjected.clear()
  })

  // ── 贡献 2：写入守护 ────────────────────────────────────────────────────
  const tools = ctx.get('tools')
  HEALTH.startedAt = new Date().toISOString()
  HEALTH.toolsAvailable = tools !== undefined
  if (tools === undefined) {
    // 无工具注册表的环境（理论上不会发生）只保留注入——但要留下痕迹，别静默。
    writeHealth('companion-core', HEALTH)
    return
  }

  tools.guard((execution) => {
    HEALTH.calls += 1
    HEALTH.lastCallAt = new Date().toISOString()
    if (HEALTH.calls === 1) writeHealth('companion-core', HEALTH) // 真被调用过 = 接进管线了
    const tool = execution.name
    if (tool !== 'write' && tool !== 'edit') return undefined
    const args = execution.arguments
    const target = typeof args?.file_path === 'string' ? args.file_path : ''
    // 大小写不敏感：Windows 上 `学习档案.MD` 与 `学习档案.md` 是同一个文件，按字节比较等于放行。
    const base = basename(target).toLowerCase()
    // 陪伴笔记：它**不是**学科档案，走另一套校验（见 validateCompanionNote）。
    // 这条必须放在下面那串「认不认识这个文件名」之前，否则它会被当成"不归我管"直接放行。
    if (base === COMPANION_NOTE_NAME.toLowerCase()) {
      const cwd0 = execution.agent?.session?.header?.cwd
      const hasCwd0 = typeof cwd0 === 'string' && cwd0.length > 0
      const abs0 = hasCwd0 ? (isAbsolute(target) ? target : join(cwd0, target)) : target
      // 只执法**本工作区自己那一份**：别处项目里的同名文件不归本预设管（与其它文件同一条纪律）。
      if (hasCwd0 && !sameDir(dirname(abs0), cwd0)) return undefined
      const content = tool === 'write'
        ? args?.content
        : (() => { const b = reconstruct(abs0, args); return b.ok ? b.content : undefined })()
      if (typeof content !== 'string') return undefined // 判不出改后内容：交给工具自己报错
      return validateCompanionNote(content, companionMaxLines, companionMaxBytes)
    }
    if (
      base !== ARCHIVE_NAME.toLowerCase() &&
      base !== TASK_NAME.toLowerCase() &&
      base !== PLAN_NAME.toLowerCase() &&
      base !== NOTICE_NAME.toLowerCase() &&
      base !== OUTLINE_NAME.toLowerCase() &&
      base !== ROUTE_NAME.toLowerCase()
    ) {
      return undefined
    }
    const cwd = execution.agent?.session?.header?.cwd
    const hasCwd = typeof cwd === 'string' && cwd.length > 0
    const abs = hasCwd ? (isAbsolute(target) ? target : join(cwd, target)) : target

    // ── 复习提纲：跨科**允许**写，但只许追加 + 带来源戳 ──────────────────────────
    // 必须放在下面那条「只管本工作区同级文件」的早退**之前**——这条规则管的正是"别科的文件"。
    // 本科自己的提纲不受约束（那是他自己的笔记本，怎么整理都行）。
    if (base === OUTLINE_NAME.toLowerCase()) {
      if (!hasCwd) return undefined
      if (sameDir(dirname(abs), cwd)) return undefined // 本科的，随便改
      // ⚠️ 本文件的 `readText` 返回的是**探针**（`{ok,text}`），不是字符串——与 file-guard 里
      //    从 plan-core import 的那个同名函数形状不同。写错过一次：探针被当成字符串传进判定，
      //    于是"旧行一条都对不上"→ 合法追加也被拒。
      const probe = readText(abs, OUTLINE_NAME)
      // F11 的纪律：**存在但读不到 ≠ 不存在**。读不到就无法确认"哪些行是已有的"，
      // 而"当成空文件"等于放行一次整份重写——宁可有声地拒绝。
      if (!probe.ok && !probe.missing) {
        return `${OUTLINE_NAME} 存在、但这次读不出来（${probe.code}）：无法确认哪些行是已有的，为安全起见拒绝这次跨科写入。稍后重试，或让本科会话自己整理`
      }
      const oldOutline = probe.ok ? probe.text : ''
      const newOutline = tool === 'write'
        ? args?.content
        : (() => { const b = reconstruct(abs, args); return b.ok ? b.content : undefined })()
      if (typeof newOutline !== 'string') return undefined // 判不出改后内容，交给工具自己报错
      return validateOutlineForeignWrite(oldOutline, newOutline)
    }
    // ── 课程路线：本科自己的，怎么改都行，但**必须过结构校验**；别科的只读 ──────────
    // 位置必须在这串早退**之前**：它要拦的正是"别科目录里的那一份"，而下面那条
    // 「只执法本工作区同级文件」会把它放行（file-guard 宿主平面暂不覆盖本文件，见常量注释）。
    if (base === ROUTE_NAME.toLowerCase()) {
      if (!hasCwd) return `${ROUTE_NAME} 只能在所属科目自己的工作区里维护（当前会话没有工作目录，判不出归属）`
      const absRoute = isAbsolute(target) ? target : join(cwd, target)
      if (!sameDir(dirname(absRoute), cwd)) return `${ROUTE_NAME} 属于该科自己的教学工作区，别科只读：请在你所学科目自己的会话里维护那一份`
      if (looksLikeCompanionDir(dirname(absRoute))) return `陪伴目录不放 ${ROUTE_NAME}：它不是科目，没有课程路线`
      const content = tool === 'write'
        ? args?.content
        : (() => { const b = reconstruct(absRoute, args); return b.ok ? b.content : undefined })()
      if (typeof content !== 'string') return undefined // 判不出改后内容：交给工具自己报错
      return validateRoute(content, DEFAULT_ROUTE_MAX_LINES, DEFAULT_ROUTE_MAX_BYTES)
    }
    // 广播的归属判断必须单独做：它放在**父目录**（学习根），不在本科工作目录里，
    // 等下面那条「只执法本工作区同级文件」的判断就等于让它从父目录溜过去。
    if (base === NOTICE_NAME.toLowerCase()) {
      if (!hasCwd) return `${NOTICE_NAME} 是「总规划」维护的变更记录，本科只读`
      const inCwd = sameDir(dirname(abs), cwd)
      const inParent = sameDir(dirname(abs), dirname(cwd))
      if (!inCwd && !inParent) return undefined // 别处项目里的同名文件不归本预设管
      return `${NOTICE_NAME} 是「总规划」维护、供全部科目看的变更流水，本科只读、也不能清空（清空会让别科看不到）。你这一科的进展与困难写进 ${ARCHIVE_NAME} 即可`
    }
    // 只执法**本工作区直接下辖**的同级文件。旧实现只看 basename，会把别的项目、别的科目目录里的
    // 同名文件一起拦下（过度拦截），而真正该管的那份照样漏。
    // cwd 未知（ToolExecutionInput.agent 是可选的）时不放行：判不出归属就按「只看文件名」从严执法，
    // 宁可多拦一个同名文件，也不能让受守护的档案/任务从这条路径溜过去。
    if (hasCwd && !sameDir(dirname(abs), cwd)) return undefined

    // ── ★ 陪伴目录里不许出现 `学习档案.md` ────────────────────────────────────────
    // 必须放在下面 `validateArchive` **之前**：那条规则只查**内容**（三字段/日期戳/限额），
    // 而这里要拦的是**身份**——一份内容完全合法的档案，放在陪伴目录里照样是灾难
    // （它会让陪伴变成第七个科目，见 `looksLikeCompanionDir` 的注释）。
    // 位置也必须在「本科自己写自己的档案」那条放行**之前**，因为那条正好会放行这一种。
    if (base === ARCHIVE_NAME.toLowerCase() && looksLikeCompanionDir(dirname(abs))) {
      return companionArchiveRefusal(dirname(abs))
    }

    // 平面不变量：`总规划.md` 与 `本周通告.md` 由总规划预设维护，科目会话只读。
    // 通告尤其不能改——那是所有科目共看的一份广播。
    if (base === PLAN_NAME.toLowerCase()) {
      return `${PLAN_NAME} 由「总规划」预设维护，本科只读。要改计划，请让学员到总规划预设里改`
    }
    if (base === TASK_NAME.toLowerCase()) {
      // 把「依据 vs 档案」的现状一并交给判定：旧依据的任务连勾选都不算数。
      // 走到这里已经确认 dirname(abs) 就是本工作区，所以档案就是它旁边的 学习档案.md。
      return validateTaskWrite(tool, args, taskBasisContext(abs, join(dirname(abs), ARCHIVE_NAME)))
    }
    if (tool === 'write') return validateArchive(args?.content, maxLines, maxBytes)

    const built = reconstruct(abs, args)
    if (!built.ok) {
      return `无法重建改后内容（${built.reason}），为安全起见已拒绝这次 edit。请先 read 该文件，按读到的原文再 edit`
    }
    return built.content === undefined ? undefined : validateArchive(built.content, maxLines, maxBytes)
  })
  HEALTH.guardRegistered = true
  writeHealth('companion-core', HEALTH)
}
