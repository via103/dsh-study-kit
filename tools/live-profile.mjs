// live-profile.mjs — **「学员的界面正跑着哪个 profile」的唯一答案处**。
//
// ═══ 为什么需要它（2026-10-09）════════════════════════════════════════════════
// 这是 F16/F21/F28 那条教训的**第四种形态**，也是最贵的一次：
//
//   `tools/presets.mjs` 写死 `PROFILE = 'web'`，而**桌面端跑的是 `profiles/desktop`**。
//   于是 2026-09-24 之后我写的每一条 persona 规则（学习日、@Python、档案卫生、计划格子、
//   课堂积累……整整 9 项）都落进了**没人读的那份 patch**，学员一条也没收到。而我的检查网
//   一路全绿——因为它检查的是我自己选的那个 profile。
//
// 与 F16（断言问不到问题）、F21（读着失效的机制）、F28（v3 日志文件名）同源：
// **工具链对"我问的是哪个对象"做了一个静默的假设，而假设错了。**
//
// 纪律（与 tools/dsh-install.mjs 完全一致）：**优先问正在跑的那个**，其次才是声明的；
// 并且把"我问的是谁"打进输出，让错的答案看得见。
//
// 判据的权威性：进程命令行里 `dsh-desktop-host/lib/index.js <dsh根> <profile目录>` 的
// 第三个参数就是 profile 目录——这是**运行时事实**，不是配置里的意图。
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PKG = dirname(dirname(fileURLToPath(import.meta.url)))
export const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
/** 探测结果的缓存。进程表查询在 Windows 上约 0.4–0.5s，而 doctor 与几十个测试都要问。 */
const CACHE = join(PKG, '.verify', 'live-profile.json')
/**
 * 缓存多久算新鲜。**10 分钟**，理由不是"猜的"：
 * 换 profile 意味着**重启桌面端**——那是个罕见且刻意的动作，不是会在一分钟内发生的事。
 * 而 TTL 太短的代价是真的：实测 60 秒时，我编辑文件、跑一条命令的间隔就超过它了，
 * 于是"查进程表"每次都要付 0.45s × 十几个测试文件 ≈ 5–8 秒。
 *
 * 缓存过期**不会**导致错读：每个消费方拿到的只是"上次由进程表得出的结论"，
 * 而 `test/check-profile-live.mjs` 与 doctor 都会**另查一遍进程表**来独立核对
 * （见那里的 `info_running_profiles()`）。缓存只影响"我默认读哪份"，不影响"活的是哪份"能不能被发现。
 */
const CACHE_TTL_MS = 10 * 60_000

/** 从一条命令行里抠出 profile 名。返回 null 表示这条不是宿主进程。 */
export function profileFromCommandLine(cmdline) {
  if (typeof cmdline !== 'string' || cmdline === '') return null
  // 宿主进程形态：... dsh-desktop-host/lib/index.js <dshRoot> <profileDir> [--remote-debugging-port=...]
  const host = /dsh-desktop-host[/\\]lib[/\\]index\.js\s+\S+\s+(\S+)/.exec(cmdline)
  if (host !== null) {
    const m = /[/\\]profiles[/\\]([^/\\\s"']+)/.exec(host[1])
    if (m !== null) return m[1]
  }
  // CLI 形态：node .../bin.js ... --profile <name>
  const flag = /--profile[=\s]+([A-Za-z0-9_-]+)/.exec(cmdline)
  if (flag !== null) return flag[1]
  // 兜底：命令行里任何 profiles/<name> 的痕迹
  const any = /[/\\]profiles[/\\]([^/\\\s"']+)/.exec(cmdline)
  return any === null ? null : any[1]
}

/** 列出所有活着的、能看出 profile 的进程。{pid, name, profile} */
export function runningProfiles() {
  let rows
  try {
    const out = execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'profiles' } | " +
        'Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress -Depth 3',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000, maxBuffer: 16 * 1024 * 1024 })
    rows = JSON.parse(out.trim() === '' ? '[]' : out)
  } catch {
    return []
  }
  if (!Array.isArray(rows)) rows = [rows]
  const seen = new Map()
  for (const row of rows) {
    const profile = profileFromCommandLine(row?.CommandLine ?? '')
    if (profile === null) continue
    // 同一个 profile 可能有好几个进程（主进程 + 渲染器）；只留第一条，另外记下 pid。
    if (!seen.has(profile)) seen.set(profile, { profile, pid: row.ProcessId, name: row.Name ?? '', pids: [row.ProcessId] })
    else seen.get(profile).pids.push(row.ProcessId)
  }
  return [...seen.values()]
}

/** 读缓存。默认只要新鲜的（< TTL）；`anyAge` 时连过期的也返回（进程刚退出时仍比猜好）。 */
function readCache({ anyAge = false } = {}) {
  if (!existsSync(CACHE)) return null
  try {
    const c = JSON.parse(readFileSync(CACHE, 'utf8'))
    if (typeof c?.at !== 'number') return null
    return anyAge || Date.now() - c.at < CACHE_TTL_MS ? c : null
  } catch {
    return null
  }
}

/**
 * 决定"学员的界面正跑着哪个 profile"。顺序即优先级：
 *   1. `DSH_STUDY_PROFILE` 环境变量（显式指定，最高优先——测试靠它钉住）
 *   2. **新鲜缓存里记着的、上一次由进程表得出的事实**（< 60 秒）——
 *      换 profile 意味着重启应用，所以 60 秒内它不会变；这条纯为省掉每次查进程表的 ~450ms
 *      （几十个测试文件各自 import 一次，累计就是十几秒）
 *   3. 查**正在跑的进程**（运行时事实）
 *   4. 过期缓存里最近一次探测到的（进程刚退出时仍然比猜好）
 *   5. `desktop` 作为最后兜底——本机学员用的是桌面端
 *
 * @returns {{profile, source, evidence, running, candidates}}
 *   `source` ∈ env | cache | running | stale-cache | fallback —— **必须打进输出**，
 *   因为"我是怎么知道该读哪份的"正是过去出错的地方。
 */
export function detectProfile({ fresh = false } = {}) {
  const env = process.env.DSH_STUDY_PROFILE
  if (typeof env === 'string' && env !== '') {
    // **不查进程表**：显式指定时"我该读哪份"已经有答案，没必要为它付 0.45s。
    // 需要"活的是哪份"的调用方请单独调 liveProfileNames()。
    return { profile: env, source: 'env', evidence: `DSH_STUDY_PROFILE=${env}`, running: [], candidates: [], probedNow: false }
  }
  // ② 新鲜缓存优先——但**只信"来自进程表"的那种缓存**。
  //    缓存里若是 env/fallback 得出的结论，那不是运行时事实，不能当成"活的是它"。
  //    ★ 这一条是**热路径**：走它就不查进程表（省 0.45s）。代价是 `running` 会是空的，
  //      所以下面用 `running: []` 明确表示"这次没查"，而不是假装查过。
  const cachedFresh = readCache()
  if (!fresh && cachedFresh !== null && cachedFresh.source === 'running') {
    return {
      profile: cachedFresh.profile,
      source: 'cache',
      evidence: `${Math.round((Date.now() - cachedFresh.at) / 1000)} 秒前由进程表得出：${cachedFresh.evidence}`,
      running: RUNNING_MEMO ?? [],
      candidates: [cachedFresh.profile],
      // 明确告诉消费方"我没有现查进程"——需要独立证据的调用方（check-profile-live / doctor）
      // 必须自己去查 `runningProfiles()`，不能把这个 `running` 当成"已核实"。
      probedNow: false,
    }
  }
  const running = maybeRunning(fresh)
  const candidates = [...new Set(running.map((r) => r.profile))]
  if (candidates.length >= 1) {
    const hit = running[0]
    const info = {
      profile: hit.profile,
      source: 'running',
      evidence: candidates.length === 1
        ? `pid ${hit.pid}（${hit.name}）的命令行里有 profiles\\${hit.profile}`
        : `有 ${candidates.length} 个 profile 活着（${candidates.join('、')}），取了 ${hit.profile}`,
      running,
      candidates,
      probedNow: true,
    }
    rememberProfile(info) // ★ 让 ② 那条快速路径真的有东西可读（否则它是死代码）
    return info
  }
  const stale = readCache({ anyAge: true })
  if (stale !== null && typeof stale.profile === 'string' && stale.profile !== '') {
    return {
      profile: stale.profile,
      source: 'stale-cache',
      evidence: `上次探测（${new Date(stale.at).toLocaleString('zh-CN')}）：${stale.evidence}`,
      running,
      candidates,
      probedNow: true,
    }
  }
  return { profile: 'desktop', source: 'fallback', evidence: '没有活着的进程，也没有缓存——按本机默认（桌面端）', running, candidates, probedNow: true }
}

let RUNNING_MEMO = null
function maybeRunning(fresh) {
  if (fresh) RUNNING_MEMO = null
  if (RUNNING_MEMO === null) RUNNING_MEMO = runningProfiles()
  return RUNNING_MEMO
}

/** 探测一次并把结果写进缓存（供 detectProfile 的 cache 分支使用）。 */
export function rememberProfile(info) {
  try {
    mkdirSync(dirname(CACHE), { recursive: true })
    writeFileSync(CACHE, JSON.stringify({ at: Date.now(), profile: info.profile, source: info.source, evidence: info.evidence }, null, 2))
  } catch { /* 缓存写不了不算错误 */ }
}

/** 一行话说明"我问的是谁"，给 doctor / 测试日志用。 */
export function describeProfile(info) {
  return `profiles/${info.profile}（依据：${info.source} —— ${info.evidence}）`
}

if (process.argv[1] !== undefined && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) {
  const info = detectProfile({ fresh: process.argv.includes('--fresh') })
  console.log(`\n学员界面跑着的 profile：${describeProfile(info)}`)
  console.log(`  活着的进程：${info.running.length === 0 ? '（没有）' : ''}`)
  for (const r of info.running) console.log(`    pid ${r.pid}  ${r.name}  → profiles/${r.profile}` + (r.pids.length > 1 ? `（共 ${r.pids.length} 个进程）` : ''))
  console.log(`  目录：${join(DSH_HOME, 'profiles', info.profile)}`)
  console.log(`  patch：${join(DSH_HOME, 'profiles', info.profile, 'cordis.patch.yml')}`)
}
