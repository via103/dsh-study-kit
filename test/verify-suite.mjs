// verify-suite.mjs — 套件入口（study-suite）的不变量。
//
// 它存在的理由：把「每个预设列 2~3 行学习插件」收敛成「列 1 行套件入口」，
// 好让"加一个通用工具"从 4 × N 处降到 2 处。**收敛的前提是这一行真的靠得住**，
// 所以两组都要钉：① 契约（给什么挂什么、名字写错时说得清）② 真喂给 Cordis 能不能挂上。
//
// 用法：node test/verify-suite.mjs
import { pathToFileURL } from 'node:url'

const PLUGINS = '<study-plugins>/'
const CORDIS = '~/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/cordis/lib/index.js'

let pass = 0
let fail = 0
const check = (label, cond, extra) => {
  if (cond) { pass += 1; console.log('  ✅', label) }
  else { fail += 1; console.log('  ❌', label, extra === undefined ? '' : `→ ${extra}`) }
}
const throws = (fn) => {
  try { fn(); return undefined } catch (e) { return String(e?.message ?? e) }
}
/** 假 ctx：把 `ctx.plugin(模块, config)` 的调用记下来——契约层不需要真运行时。 */
const fakeCtx = () => {
  const calls = []
  return { calls, ctx: { plugin: (mod, cfg) => { calls.push({ mod, cfg }); return Promise.resolve() } } }
}

const suite = await import(pathToFileURL(PLUGINS + 'study-suite.js').href)

// ── ① 契约：给什么挂什么 ────────────────────────────────────────────────────
console.log('\n① 契约：parts 决定挂谁，一个不多一个不少')
{
  const A = fakeCtx()
  await suite.apply(A.ctx, { parts: ['companion', 'judge'] })
  check('挂了 2 个子插件', A.calls.length === 2, String(A.calls.length))
  check('  挂的正是 companion-core 与 study-judge', A.calls.map((c) => c.mod.name).join() === 'companion-core,study-judge', A.calls.map((c) => c.mod.name).join())
  check('  没给 options 时子插件的 config 是 undefined', A.calls.every((c) => c.cfg === undefined))

  const B = fakeCtx()
  await suite.apply(B.ctx, { parts: ['companion'], options: { companion: { maxBytes: 8192 } } })
  check('options 按部件名透传', JSON.stringify(B.calls[0].cfg) === '{"maxBytes":8192}', JSON.stringify(B.calls[0].cfg))

  const C = fakeCtx()
  await suite.apply(C.ctx, { parts: ['plan', 'companion', 'judge', 'code-run', 'netsec-range'] })
  check('五个部件都能一次挂上', C.calls.length === 5, String(C.calls.length))
}

// ── ② 名字写错时必须**说清楚**，而不是悄悄少一个工具 ────────────────────────
console.log('\n② 写错部件名：报错要能直接照着改')
{
  const msg = throws(() => suite.apply(fakeCtx().ctx, { parts: ['campanion'] })) // 故意拼错
  check('未知部件 → 抛错', typeof msg === 'string', msg)
  check('  错误里带上写错的那个名字', msg?.includes('campanion'), msg)
  for (const p of ['plan', 'companion', 'judge', 'code-run', 'netsec-range']) {
    check(`  可用列表里有 ${p}`, msg?.includes(p), msg)
  }
  check('空 parts → 抛错（不能"什么都不挂"还算成功）', typeof throws(() => suite.apply(fakeCtx().ctx, {})) === 'string')
  check('parts 不是数组 → 抛错', typeof throws(() => suite.apply(fakeCtx().ctx, { parts: 'companion' })) === 'string')
  check('完全没有 config → 抛错', typeof throws(() => suite.apply(fakeCtx().ctx, undefined)) === 'string')
}

// ── ③ 集成：真的喂给 Cordis 的 ctx.plugin() ─────────────────────────────────
// 契约层是对的，不代表这个**形状**被 Cordis 接受（ESM 命名空间是只读的、还带一堆额外导出）。
console.log('\n③ 集成：裸 Cordis Context 上真挂一次')
{
  const { Context } = await import(pathToFileURL(CORDIS).href)
  const ctx = new Context()
  let ok = true
  let why
  try {
    await ctx.plugin(suite, { parts: ['companion'] })
  } catch (e) {
    ok = false
    why = e?.message
  }
  check('ctx.plugin(套件命名空间, {parts}) 挂得上并 settle', ok, why)

  const ctx2 = new Context()
  let rejected = false
  try { await ctx2.plugin(suite, { parts: ['nope'] }) } catch { rejected = true }
  check('  部件名写错时，失败落在套件这一行（而不是静默少一个）', rejected)
}

// ── ④ 六个预设里那一行：parts 必须都认（**写错的名字最难查**） ────────────────
// 这一组覆盖的是"预设指向了一个不存在的部件"——它在运行时的表现是**预设能开、但那个工具就是没有**，
// 而且不会有任何报错。所有预设都过一遍，不只 code-tutor。
console.log('\n④ 各预设的 study 行：点名的部件必须都认')
{
  // 0.1.7：预设不再是一个目录，而是组合树里的**声明行**——统一从唯一来源读。
  const { declById, findPluginRow } = await import('../tools/presets.mjs')
  // mind-companion 的 parts 是 `[ companion, plan ]`——它**故意**不挂 judge/code-run：
  // 陪伴不出题、不判分。这一组只验"点名的名字都认"，不验"该挂哪几个"（那是 verify-mind-preset 的事）。
  for (const id of ['netsec-tutor', 'math-tutor', 'english-tutor', 'code-tutor', 'study-planner', 'mind-companion']) {
    const decl = declById(id)
    if (decl === undefined) { check(`${id}：有声明`, false, '组合树里找不到这条预设'); continue }
    const row = findPluginRow(decl, 'study')
    if (row === undefined) { check(`${id}：有 study 行`, false, '这一行不在'); continue }
    const parts = row.config?.parts
    let err
    try { await suite.apply(fakeCtx().ctx, { parts }) } catch (e) { err = e.message }
    check(`${id}：parts ${JSON.stringify(parts)} 全部认得`, err === undefined, err)
  }
}

console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
