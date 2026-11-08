// verify-remount.mjs — 不变量三组：
//   ① F10 会话中途换预设（mount → 卸载 → 重新 mount）时，我们的插件会怎样？
//   ② F11 「存在但读不到」必须说出来，不能被当成「不存在」（注入路径）
//   ③ F11 的另外两个后果：科目不能从看板上凭空消失、`looksLikeStudyRoot` 不能因此判 false
//
// 为什么要单独测这个：预设切换在 DSH 里的实现是**把 agent 的 scope 重新挂到另一个 standing mount 上**
// （`agent-presets.recompose()` → `binding.rebind()`），不是把旧插件 dispose 掉重建。
// 于是我们这边真正要保证的只有两件事：
//   ① **注册必须是每次 apply 一份，不能有模块级残留**——否则切换后会双份注入 / 双份守护；
//   ② **缓存必须是每次 apply 一份**——新 mount 的 `lastInjected` 是空的，所以切换后那一轮**会重新注入**
//      （这正是我们要的：换了预设，模型要重新看到档案）。
// 这个脚本用一个假 ctx 把 listener 与 guard 都截下来，直接驱动 `agent/pre-step`，不需要真会话。
//
// 用法：node test/verify-remount.mjs
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const PLUGINS = '<study-plugins>/'
const ST = 'ST'
const NETSEC = `${ST}/网安`

let pass = 0
let fail = 0
const check = (label, cond, extra) => {
  if (cond) { pass += 1; console.log('  ✅', label) }
  else { fail += 1; console.log('  ❌', label, extra === undefined ? '' : `→ ${extra}`) }
}

/**
 * 一个假 ctx：`on` / `tools.guard` / `tools.register` 都把回调截下来，并返回**真的能撤销**的 disposer
 * ——这样才能模拟"这个预设的 standing mount 被卸载"。
 */
function fakeCtx() {
  const listeners = []
  const guards = []
  const registered = []
  const tools = {
    guard: (fn) => {
      guards.push(fn)
      return () => { const i = guards.indexOf(fn); if (i >= 0) guards.splice(i, 1) }
    },
    register: (def) => {
      registered.push(def)
      return () => { const i = registered.indexOf(def); if (i >= 0) registered.splice(i, 1) }
    },
  }
  const disposers = []
  const ctx = {
    get: (n) => (n === 'tools' ? tools : undefined),
    on: (event, fn) => {
      const entry = { event, fn }
      listeners.push(entry)
      const off = () => { const i = listeners.indexOf(entry); if (i >= 0) listeners.splice(i, 1) }
      disposers.push(off)
      return off
    },
    inject: (names, cb) => { const d = cb(ctx); if (typeof d === 'function') disposers.push(d) },
  }
  return { ctx, listeners, guards, registered, unmount: () => { for (const d of disposers.splice(0)) d(); listeners.splice(0); guards.splice(0) } }
}

const preStep = (m, agent, step = 1) =>
  m.listeners.filter((l) => l.event === 'agent/pre-step').map((l) => l.fn)

const agent = { id: 'test-agent-1', session: { header: { cwd: NETSEC } } }
const next = () => Promise.resolve({ kind: 'allow', messages: [] })

const companion = await import(pathToFileURL(PLUGINS + 'companion-core.js').href)
const plan = await import(pathToFileURL(PLUGINS + 'plan-core.js').href)
const guardMod = await import(pathToFileURL(PLUGINS + 'file-guard.js').href)

// ── ① 一次 mount 的基线 ─────────────────────────────────────────────────────
console.log('\n① 第一次 mount（相当于会话第一次绑定这个预设）')
const A = fakeCtx()
companion.apply(A.ctx)
check('companion-core 注册了 1 个 agent/pre-step', preStep(A).length === 1, String(preStep(A).length))
check('  且注册了 1 个工具守卫', A.guards.length === 1, String(A.guards.length))

const r1 = await preStep(A)[0]({ agent, step: 1, signal: { aborted: false } }, next)
check('  第一轮注入了内容（档案 + 课程路线提示 + 本周任务 + 变更记录）', r1.messages.length === 4, JSON.stringify(r1.messages.length))
const r2 = await preStep(A)[0]({ agent, step: 1, signal: { aborted: false } }, next)
check('  第二轮去重，零成本', r2.messages === undefined || r2.messages.length === 0, JSON.stringify(r2.messages?.length))

// ── ② 卸载（旧预设被换成别的，或这个 standing mount 被弃用） ─────────────────
console.log('\n② 卸载：所有注册都必须真的撤回')
A.unmount()
check('listener 清空', preStep(A).length === 0, String(preStep(A).length))
check('守卫清空', A.guards.length === 0, String(A.guards.length))

// ── ③ 重新 mount（换成另一个预设，恰好也挂了同一个插件） ─────────────────────
console.log('\n③ 重新 mount：不能有模块级残留')
const B = fakeCtx()
companion.apply(B.ctx)
check('又是 1 个 listener（不是 2 个）', preStep(B).length === 1, String(preStep(B).length))
check('  又是 1 个守卫', B.guards.length === 1, String(B.guards.length))
check('  旧 mount 依旧是空的（没有被"复活"）', preStep(A).length === 0)
const r3 = await preStep(B)[0]({ agent, step: 1, signal: { aborted: false } }, next)
check('  新 mount 的缓存是空的 → **切换后会重新注入**（这正是我们要的）', r3.messages.length === 4, JSON.stringify(r3.messages.length))
B.unmount()

// ── ④ plan-core 同样跑一遍（它也有 listener + 守卫） ─────────────────────────
console.log('\n④ plan-core：同一套不变量')
const C = fakeCtx()
plan.apply(C.ctx)
check('注册了 1 个 agent/pre-step', preStep(C).length === 1, String(preStep(C).length))
check('  注册了 1 个工具守卫', C.guards.length === 1, String(C.guards.length))
const board = await preStep(C)[0]({ agent: { id: 'p1', session: { header: { cwd: ST } } }, step: 1, signal: { aborted: false } }, next)
const boardText = board.messages?.[0]?.content?.[0]?.text ?? ''
check('  看板注入成功', board.messages.length === 1 && boardText.includes('全科看板'), boardText.slice(0, 40))
C.unmount()
check('卸载后清空', preStep(C).length === 0 && C.guards.length === 0)
const D = fakeCtx()
plan.apply(D.ctx)
check('重新 mount 无残留', preStep(D).length === 1 && D.guards.length === 1)
D.unmount()

// ── ⑤ 宿主平面的 file-guard 与预设切换**无关** ──────────────────────────────
console.log('\n⑤ file-guard：宿主平面，不受任何预设切换影响')
const E = fakeCtx()
guardMod.apply(E.ctx)
check('它一个 listener 都不注册（只注册守卫）', preStep(E).length === 0 && E.listeners.length === 0, JSON.stringify(E.listeners.map((l) => l.event)))
check('  只注册 1 个守卫', E.guards.length === 1)
E.unmount()
check('  卸载后清空', E.guards.length === 0)

// ── ⑥ F11：文件「存在但读不到」必须说出来，不能被当成「不存在」 ────────────────
// 制造"读不到"最省事、最可移植的办法：**拿一个目录冒充档案**——readFileSync 会抛（EISDIR/EPERM），
// 而不是 ENOENT。这正好落在"存在但读不到"那一格里，不需要动权限。
console.log('\n⑥ F11：读不到 ≠ 不存在')
{
  const TMP = mkdtempSync(join(tmpdir(), 'study-unreadable-'))
  mkdirSync(join(TMP, '学习档案.md')) // ← 目录，不是文件
  writeFileSync(join(TMP, '本周任务.md'), '# 本周任务\n\n生成: 2026-09-18\n依据: 学习档案 更新于 2026-09-18\n\n- [ ] 随便一条\n')

  const F = fakeCtx()
  companion.apply(F.ctx)
  const res = await preStep(F)[0]({ agent: { id: 'r1', session: { header: { cwd: TMP } } }, step: 1, signal: { aborted: false } }, next)
  const texts = (res.messages ?? []).map((m) => m.content[0].text)

  check('出现了「读取异常」告警', texts.some((t) => t.includes('读取异常')), JSON.stringify(texts.map((t) => t.slice(0, 18))))
  const warn = texts.find((t) => t.includes('读取异常')) ?? ''
  check('  告警指名了那个文件（带错误码）', warn.includes('学习档案.md（'), warn.slice(0, 120))
  check('  明说这不是「还没建」', warn.includes('不是「还没建」'))
  check('  明说**不要凭记忆补写**（那是不可逆覆盖）', warn.includes('不要凭记忆'))
  check('  同目录里**能读到**的文件照常注入（只影响读不到的那一个）', texts.some((t) => t.includes('本周任务')), JSON.stringify(texts.map((t) => t.slice(0, 18))))
  check('  档案正文没有被当成空内容注入', !texts.some((t) => t.includes('伴学档案·自动注入')))

  const again = await preStep(F)[0]({ agent: { id: 'r1', session: { header: { cwd: TMP } } }, step: 1, signal: { aborted: false } }, next)
  check('  第二轮仍然去重（不每轮重复告警）', again.messages === undefined || again.messages.length === 0, JSON.stringify(again.messages?.length))
  F.unmount()
  rmSync(TMP, { recursive: true, force: true })
}

// ── ⑦ F11 的另外两个后果：看板不能丢科目，守护不能停止执法 ────────────────────
console.log('\n⑦ F11：同一个「读不到」在看板与守护上的后果')
{
  const TMP = mkdtempSync(join(tmpdir(), 'study-unreadable2-'))
  mkdirSync(join(TMP, '数学'))
  mkdirSync(join(TMP, '数学', '学习档案.md')) // ← 唯一的"档案"是个目录 = 读不到

  // 这两条以前是**静默失效**：科目凭空消失；整棵树被判成"不是学习树"→ 守护不再执法。
  check('读不到的科目**仍在科目表里**（没有凭空消失）', plan.discoverSubjects(TMP).map((s) => s.name).join() === '数学', JSON.stringify(plan.discoverSubjects(TMP).map((s) => s.name)))

  const today = plan.studyDate()
  const math = plan.survey(TMP, today).find((s) => s.name === '数学')
  check('  它的漂移行说的是「读不到」', math !== undefined && math.drift.some((d) => d.includes('读不到')), JSON.stringify(math?.drift))
  check('  而**不是**冒充成「缺少日期戳」这类事实', math !== undefined && !math.drift.some((d) => d.includes('缺少「更新于')), JSON.stringify(math?.drift))

  // 再加一个完全正常的科目：两个都要在，正常那个照常分析。
  mkdirSync(join(TMP, '英语'))
  writeFileSync(join(TMP, '英语', '学习档案.md'), `# 学习档案\n\n更新于: ${today}\n\n## 学校当前进度\n- x\n\n## 已答主题与卡点\n- y\n\n## 未消化薄弱点\n- z\n`)
  const both = plan.survey(TMP, today)
  check('  两个科目都在', both.length === 2, JSON.stringify(both.map((s) => s.name)))
  check('  正常那科照常分析（日期戳读得到）', both.find((s) => s.name === '英语')?.archiveStamp === today)

  rmSync(TMP, { recursive: true, force: true })
}

// ⑦b `looksLikeStudyRoot` 那条要用**真文件 + 真拒绝读**才测得出来：
//     上面"目录冒充档案"的招数在这里不成立——`statSync().isFile()` 对目录本来就返回 false，
//     新旧实现在这一格上答案相同，测了等于没测（第一版就是这么写错的）。
//     Windows 上用 icacls 临时拒绝当前用户读它；**拿不到权限就跳过**，不把环境限制伪装成失败。
console.log('\n⑦b F11：档案存在但**读不到**时，守护仍须认它是学习树')
{
  const TMP2 = mkdtempSync(join(tmpdir(), 'study-denied-'))
  const dir = join(TMP2, '物理')
  mkdirSync(dir)
  const file = join(dir, '学习档案.md')
  writeFileSync(file, '# 学习档案\n\n更新于: 2026-09-18\n\n## 学校当前进度\n- x\n\n## 已答主题与卡点\n- y\n\n## 未消化薄弱点\n- z\n')
  const user = process.env.USERNAME
  const acl = (args) => { try { execFileSync('icacls', args, { stdio: 'ignore' }); return true } catch { return false } }
  const denied = acl([file, '/deny', `${user}:(R)`])
  if (!denied) {
    console.log('  ⏭️  跳过：本机 icacls 没能拒绝读权限，造不出"存在但读不到的真文件"')
  } else {
    // statSync 只看属性（可遍历即可），readFileSync 要真读——这正是新旧实现的差别所在。
    check('守护仍然认为这是学习树（否则整棵树不再受执法）', guardMod.looksLikeStudyRoot(TMP2) === true)
    acl([file, '/remove:d', user])
  }
  rmSync(TMP2, { recursive: true, force: true })
}

console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
