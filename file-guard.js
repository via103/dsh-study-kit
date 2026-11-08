// file-guard — 宿主平面的写入守护（覆盖**所有**预设，不只是挂了学习插件的那四个）
//
// 为什么需要它：预设里的守护只在那一行被挂载时生效。`standard`（全局默认）、`fact-verify`、
// `router-standard` 等预设一个学习插件都没挂，所以在学习根目录下开一个这样的会话，就能无检查地
// 覆盖 `总规划.md` 与任何 `学习档案.md` ——「一文件一写者」这条不变量只在四个预设里成立。
// 而它本质上是**跨会话**的不变量，按 DSH 的两平面规则本来就该落在宿主平面。
//
// 与预设内守护的分工：
//   - 本插件负责**归属**（谁可以写哪个文件）+ 写入时的内容校验（write）。
//   - 预设内的守护负责**该会话自己的**内容细节（含 edit 的改后内容重建）。
//   两者规则一致、范围不同：预设内是"我这一摊"，这里是"整个学习根"。
//
// ⚠️ 全局守护必须 **fail-open**：它一旦抛异常，影响面是"所有会话的所有写入"。
//    所以整个判定包在 try/catch 里，出任何内部错误一律放行（放行的代价远小于卡死整个 harness）。
//
// 挂在宿主平面（用户层 profile 的 cordis.patch.yml），不发布任何服务，无需 isolate realm。

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import {
  canonicalPath,
  studyDate,
  survey,
  validateNotice,
  validatePlan,
  validateTask,
  writeHealth,
} from './plan-core.js'
// 协议常量与数值上限、以及 edit 的改后内容重建，**全部从 companion-core 取**，不在这里再抄一遍。
// 规则只有一份，检查点有两个（宿主平面全覆盖 + 预设内纵深）——这才是"冗余"的正确形态：
// 复用同一份实现，而不是两处各写一套相似的逻辑。
import {
  ARCHIVE_NAME,
  companionArchiveRefusal,
  COMPANION_MAX_BYTES,
  COMPANION_MAX_LINES,
  COMPANION_NOTE_NAME,
  DEFAULT_MAX_BYTES as MAX_ARCHIVE_BYTES,
  DEFAULT_MAX_LINES as MAX_ARCHIVE_LINES,
  looksLikeCompanionDir,
  NOTICE_NAME as LOG_NAME,
  OUTLINE_NAME,
  PLAN_NAME,
  reconstruct,
  TASK_NAME,
  taskBasisContext,
  validateArchive,
  validateCompanionNote,
  validateOutlineForeignWrite,
  validateTaskWrite,
} from './companion-core.js'

export const name = 'file-guard'

/**
 * ★ 这一行是整条宿主守护的命门：**apply 必须等 `tools` 就位才跑**。
 *
 * 2026-09-17 实测（`LRN-20260916-012`）：没有它时，这个宿主行的 `apply()` 跑在 `tools` 行
 * **被提供之前**，`ctx.get('tools')` 返回 `undefined`，于是下一行就 `return` ——
 * **守卫从来没注册过，整条宿主守护是装饰性的**：工作目录在别处的会话能直接覆盖
 * `ST\<科目>\学习档案.md`（实测两次成功，无任何报错）。
 *
 * 判定逻辑本身是好的：`test/probe-guard-logic.mjs` 给 `apply()` 一个假 ctx
 * （`get('tools')` 返回把守卫回调截下来的假对象），再直接调用那个回调——四条探针
 * （外会话写本科档案 / 本科写非法内容 / 别处项目同名文件 / 非协议文件）全部符合预期。
 * **坏的只有"接上"这一步**，所以修法也只有一行。
 *
 * `inject` 是 Cordis 的原生机制：声明后 fiber 会等服务到齐再调 `apply`
 * （shipped 的 `dsh-agent-tool-presentation` 就是 `export { apply, inject }` 这么写的）。
 */
export const inject = ['tools']

/**
 * 启动痕迹：schema 与 plan-core / companion-core 一致，写盘走 `writeHealth`（在 plan-core，
 * 那是依赖根）。`study-doctor.mjs` 的层 4 读它：
 *   toolsAvailable   apply 时 ctx.get('tools') 拿没拿到
 *   guardRegistered  tools.guard() 有没有真的注册上
 *   calls            守卫被工具管线调用过几次（>0 = 真的接进去了，不只是注册了）
 *   denied           拦住过几次（**这是"守护真的在工作"的最强证据**）
 */
const HEALTH = {
  plugin: 'file-guard',
  pid: process.pid,
  startedAt: undefined,
  toolsAvailable: false,
  guardRegistered: false,
  calls: 0,
  lastCallAt: undefined,
  denied: 0,
  lastDeniedAt: undefined,
}

/**
 * 判断一个路径属于协议里的哪个角色；不属于则返回 undefined（不归本插件管）。
 *
 * **大小写不敏感**：Windows 上 `学习档案.MD` 与 `学习档案.md` 是同一个文件，按字节精确比较
 * 等于把整条守护放行给"换个扩展名大小写"这一招。预设内的守护一直是这么做的；本插件当初写成
 * 了精确比较，等于把红队当年指出、并且已经在预设里修掉的别名绕过又请了回来
 * （2026-09-16 协议审计发现，实测 `学习档案.MD` / `总规划.MD` / `本周任务.MD` 全部直接放行）。
 */
export function classify(target) {
  const base = basename(target).toLowerCase()
  const dir = dirname(target)
  if (base === ARCHIVE_NAME.toLowerCase()) return { kind: 'archive', scopeDir: dir, root: dirname(dir) }
  if (base === TASK_NAME.toLowerCase()) return { kind: 'task', scopeDir: dir, root: dirname(dir) }
  if (base === PLAN_NAME.toLowerCase()) return { kind: 'plan', scopeDir: undefined, root: dir }
  if (base === LOG_NAME.toLowerCase()) return { kind: 'log', scopeDir: undefined, root: dir }
  // 复习提纲也归本科（scopeDir = 该科目录）。它的规则与上面四个**不同**：跨科不是禁止而是限追加
  // ——知识点会在别科会话里产生（实测：网安打 CTF 时学员的 Python 表述错了一片），
  // 而提纲是"知识点唯一的家"，所以必须允许别科把它记进去，但只许追加、且要带来源戳。
  if (base === OUTLINE_NAME.toLowerCase()) return { kind: 'outline', scopeDir: dir, root: dirname(dir) }
  // 陪伴笔记（`心灵笔记.md`）：与 `学习档案.md` **平级**的另一套契约（陪伴不是学业）。
  // 它必须在这里认出来，否则它是一块**自由写入区**：无行数上限、无字节上限、无控制字符校验、
  // 无大小写防绕过（`心灵笔记.MD` 会直接溜过去）——而它恰恰是**唯一**每轮都进上下文的东西。
  // 与 archive 一样 scopeDir = 该目录（只有"工作目录就是陪伴目录"的会话能写它）。
  if (base === COMPANION_NOTE_NAME.toLowerCase()) return { kind: 'companion', scopeDir: dir, root: dirname(dir) }
  return undefined
}

/**
 * 这个目录看起来是「学习根」吗（至少有一个子目录里放着 学习档案.md）？
 * 用**管辖权**而不是文件名来判断，避免去管别的项目里恰好同名的文件——
 * 这是红队指出的「过度拦截」问题的正解。
 */
export function looksLikeStudyRoot(root) {
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return false
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    // ★ 看**存在性**，不看**可读性**（F11）：用 readFileSync 判存在时，只要有一个档案读不到
    //   （权限 / 被占用 / 是目录 / 磁盘错），整棵树就会被判成"不是学习树"，
    //   于是**守护静默停止执法**——这是 F11 三个后果里最危险的那个。
    //   存在性用 statSync 问：它不需要读内容。
    try {
      if (statSync(join(root, entry.name, ARCHIVE_NAME)).isFile()) return true
    } catch {
      /* 换下一个 */
    }
  }
  return false
}

const samePath = (a, b) => canonicalPath(a) === canonicalPath(b)

export function apply(ctx) {
  // `inject: ['tools']` 保证走到这里 tools 一定在；这个判断留着只是兜底
  // （没有 tools 就没有写入可守，静默退出好过抛错）。
  const tools = ctx.get('tools')
  HEALTH.startedAt = new Date().toISOString()
  HEALTH.toolsAvailable = tools !== undefined
  if (tools === undefined) {
    writeHealth('file-guard', HEALTH)
    return
  }

  // 判定体单独抽成 `decide`，外面套一层只做记账——这样"拦住过几次"也能留下痕迹。
  const decide = (execution) => {
    try {
      if (execution?.name !== 'write' && execution?.name !== 'edit') return undefined
      const args = execution.arguments
      const target = typeof args?.file_path === 'string' ? args.file_path : ''
      if (target.length === 0) return undefined
      const cwd = execution.agent?.session?.header?.cwd
      const abs = isAbsolute(target) ? target : typeof cwd === 'string' && cwd.length > 0 ? join(cwd, target) : undefined
      if (abs === undefined) return undefined

      const where = classify(abs)
      if (where === undefined) return undefined
      if (!looksLikeStudyRoot(where.root)) return undefined // 不是学习树：不管

      if (typeof cwd !== 'string' || cwd.length === 0) {
        return `${basename(abs)} 是受守护的学习文件，但无法确定本会话的工作目录，已拒绝这次写入`
      }
      const inRoot = samePath(cwd, where.root)
      const inScope = where.scopeDir !== undefined && samePath(cwd, where.scopeDir)

      if (where.kind === 'archive') {
        // ── ★ 陪伴目录里不许出现 `学习档案.md` ──────────────────────────────────────
        // 必须放在下面 `inScope` 那条放行**之前**：`inScope` 判的是"cwd 就是这一科自己的目录"，
        // 而陪伴会话的 cwd 恰好就是 `ST\心灵` ⇒ 那条规则**正好会放行**这一种最危险的写法。
        // 为什么危险：认科目的唯一判据就是这个文件名，所以放进来之后陪伴**静默变成第七个科目**
        // （进看板、被排 MVE、总规划开始点名要任务）——不是报错，是变形。
        // 2026-10-12 实测：三层守护没有一层拦它，见 `.verify/probe-selfdestruct-enforcement.mjs`。
        if (looksLikeCompanionDir(where.scopeDir)) {
          return companionArchiveRefusal(where.scopeDir)
        }
        if (!inScope) {
          return `${ARCHIVE_NAME} 由该科自己维护（只允许工作目录就是该科目录的会话写入）。总规划只读它，别处会话不要代改——代改会让漂移检测失真`
        }
        return checkEdited(execution, abs, args, (content) => validateArchive(content, MAX_ARCHIVE_LINES, MAX_ARCHIVE_BYTES))
      }

      if (where.kind === 'companion') {
        if (!inScope) {
          return `${COMPANION_NOTE_NAME} 由陪伴会话自己维护（只允许工作目录就是该目录的会话写入）。别的会话不要代改`
        }
        return checkEdited(execution, abs, args, (content) => validateCompanionNote(content, COMPANION_MAX_LINES, COMPANION_MAX_BYTES))
      }

      // 复习提纲：**跨科允许，但只许追加 + 带来源戳**。
      // 必须放在下面那条「不在归属范围内就拒」**之前**——这条规则管的正是"别科的文件"。
      // 本科自己的提纲完全不管（那是学员自己的笔记本，怎么整理都行）。
      if (where.kind === 'outline') {
        if (inScope) return undefined
        const oldOutline = readText(abs)
        const newOutline = execution.name === 'write'
          ? args?.content
          : (() => { const b = reconstruct(abs, args); return b.ok ? b.content : undefined })()
        if (typeof newOutline !== 'string') return undefined // 判不出改后内容：交给工具自己报错
        return validateOutlineForeignWrite(oldOutline === undefined ? '' : oldOutline, newOutline)
      }

      if (!inRoot && !inScope) {
        return `${basename(abs)} 只能由总规划（工作目录 = 学习根）或该科自己写入；本会话工作目录不在其归属范围内`
      }

      if (where.kind === 'plan') {
        if (!inRoot) return `${PLAN_NAME} 由总规划维护，本科只读。要改计划请到总规划预设里改`
        const today = studyDate()
        return checkEdited(execution, abs, args, (content) =>
          validatePlan(content, { today, subjects: survey(where.root, today), existing: readText(join(where.root, PLAN_NAME)) }),
        )
      }

      if (where.kind === 'log') {
        if (!inRoot) return `${LOG_NAME} 是总规划维护、供全部科目看的变更流水，本科只读、也不能清空`
        return checkEdited(execution, abs, args, (content) => validateNotice(content, { today: studyDate() }))
      }

      // 本周任务：总规划下发（write），该科只能改勾选状态（edit）
      if (inScope && (execution.name === 'edit' || execution.name === 'write')) {
        if (execution.name === 'write') {
          return `${TASK_NAME} 由「总规划」下发，本科只读：只允许把「- [ ]」改成「- [x]」勾选完成，不能整体重写`
        }
        return validateTaskWrite('edit', args, taskBasisContext(abs, join(where.scopeDir, ARCHIVE_NAME)))
      }
      if (execution.name !== 'write') return undefined
      const today = studyDate()
      const subjects = survey(where.root, today)
      const subject = subjects.find((s) => s.name.toLowerCase() === basename(where.scopeDir).toLowerCase())
      if (subject === undefined) {
        return `${TASK_NAME} 只能下发到科目目录（${where.root} 下含「${ARCHIVE_NAME}」的子目录）`
      }
      return validateTask(args?.content, { today, subjectName: subject.name, archiveStamp: subject.archiveStamp })
    } catch {
      return undefined // fail-open：全局守护绝不能因为自己的 bug 卡住所有写入
    }
  }

  tools.guard((execution) => {
    HEALTH.calls += 1
    HEALTH.lastCallAt = new Date().toISOString()
    const verdict = decide(execution)
    if (typeof verdict === 'string') {
      // **拦住一次就刷一次盘**：拦截是稀有事件，而且比"注册了"强得多——它证明守卫在真管事。
      HEALTH.denied += 1
      HEALTH.lastDeniedAt = HEALTH.lastCallAt
      writeHealth('file-guard', HEALTH)
    } else if (HEALTH.calls === 1) {
      writeHealth('file-guard', HEALTH) // 被真正调用过一次 = 已经接进工具管线，不只是"注册了"
    }
    return verdict
  })
  HEALTH.guardRegistered = true
  writeHealth('file-guard', HEALTH)
}

/**
 * write 直接校验 content；**edit 必须先重建改后内容再校验**。
 *
 * 旧实现在这里对 archive / plan / log 的 edit 一律放行，理由是"改后内容重建交给预设内守护"——
 * 可那个守护只存在于挂了 companion-core 的那几个预设里。用 `standard`、`fact-verify` 这类预设
 * 在学习根开会话，改一次就能把档案/计划/变更记录改成任意内容，所有内容校验形同虚设（实测确认）。
 * 宿主守护的存在意义就是"覆盖所有预设"，这条旁路等于把它整个架空。
 */
function checkEdited(execution, abs, args, validate) {
  if (execution.name === 'write') return validate(args?.content)
  const built = reconstruct(abs, args)
  if (built.ok !== true) {
    return `无法重建改后内容（${built.reason}），为安全起见已拒绝这次 edit。请先 read 该文件，按读到的原文再 edit`
  }
  return built.content === undefined ? undefined : validate(built.content)
}

/** 读文件，失败返回 undefined（不抛）。 */
function readText(abs) {
  try {
    return readFileSync(abs, 'utf8')
  } catch {
    return undefined
  }
}
