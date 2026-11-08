// verify-tool-output.mjs — **宿主契约测试**：每个工具的回执都必须是宿主的 lossless JSON。
//
// 为什么单独有这个文件（这是本套件里最重要的一条断言，写在最前面）：
// 2026-09-18 ~ 09-20 学员两次报告「code_run 不能用」。我查了两轮都归因到
// Smart App Control（还为此加了退避重试），**全错**。真正的原因在这条契约上：
//
//   宿主拿到工具返回值后会做一次 lossless JSON 快照（`snapshotJsonValue`），任一处
//   `undefined` —— 哪怕只是某个属性的值 —— 就让快照失败，于是**整条回执**被丢掉，
//   模型只看到 `ToolOutputError: value is not lossless JSON`。
//
// code_run 的 Python 分支当时写的是 `compileOk: o.language === 'c' ? true : undefined`，
// 而 C 分支是 `true`。于是「C 通道正常、Python 通道永远报错」——和工具链、和应用控制
// 策略都没有关系，重试也永远不可能修好它。
//
// **为什么以前的测试全都放过了它**（这是本文件存在的理由）：
//   · verify-code-run 测纯函数，不碰返回值形状；
//   · probe-code-run 调 `execute()` 然后 `console.log` —— `{compileOk: undefined}`
//     在控制台上和 `{}` 长得一模一样，肉眼看不出；
//   · 谁都没有问过"宿主收不收得下这个值"。
// 所以这里不问逻辑对不对，只问**宿主收不收**，而且用的是宿主自己那份 `isJsonValue`，
// 不是我自己重写的一份规则（重写一份就又会漂移）。
//
// 用法：
//   node test/verify-tool-output.mjs            全量（含真编译 C 的那几条，约 20 秒）
//   node test/verify-tool-output.mjs --quick    跳过要真编译 C 的用例（约 1 秒）——doctor 第 4 层用这档
//
// 快速档**不是**"随便跑跑"：它照样走真 Cordis 挂载、真 execute、宿主的真校验器，
// 只是省掉最慢的几条。要证明的契约（回执必须是 lossless JSON）两档一模一样。
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const QUICK = process.argv.includes('--quick')

const PKG = dirname(dirname(fileURLToPath(import.meta.url)))
const CORDIS = '~/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/cordis/lib/index.js'

let pass = 0
let fail = 0
const check = (label, cond, extra) => {
  if (cond) { pass += 1; console.log('  ✅', label) }
  else { fail += 1; console.log('  ❌', label, extra === undefined ? '' : `→ ${extra}`) }
}

// ── 取宿主的真校验器 ────────────────────────────────────────────────────────
// 找不到就**直接失败**，绝不跳过：一个会自动跳过的契约测试，正是这个 bug 活下来的方式。
async function loadValidator() {
  const candidates = [
    join(process.env.DSH_INSTALL ?? '~/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh', 'node_modules/@deepseek-ai/dsh-util-values/lib/index.js'),
    join(process.env.DSH_HOME ?? '', 'profiles/web/node_modules/@deepseek-ai/dsh-util-values/lib/index.js'),
  ]
  for (const c of candidates) {
    if (existsSync(c)) {
      const m = await import(pathToFileURL(c).href)
      if (typeof m.isJsonValue === 'function') return { mod: m, from: c }
    }
  }
  return undefined
}

const validator = await loadValidator()
if (validator === undefined) {
  console.log('❌ 找不到宿主的 @deepseek-ai/dsh-util-values —— 这个测试不能跳过（跳过就等于没测）。')
  console.log('   用 DSH_INSTALL=<dsh 安装目录> 指过去。')
  process.exit(1)
}
// 用宿主**自己那两个**函数，不自己重写规则：`isJsonValue` 判定，`snapshotJsonValue` 是宿主
// 真正调用的那个（dsh-tools/lib/index.js 的 snapshotToolValue → 返回 undefined 就抛错）。
const { isJsonValue, snapshotJsonValue } = validator.mod
console.log(`\n校验器：${validator.from}`)
check('校验器自检：{a:undefined} 必须被判为非法（这就是那个 bug 的形状）', isJsonValue({ a: undefined }) === false)
check('校验器自检：snapshotJsonValue({a:undefined}) 必须失败（宿主就是这么丢回执的）', snapshotJsonValue({ a: undefined }) === undefined)

// ── 挂载：真 Cordis + 捕获式 tools 注册表 ───────────────────────────────────
// 每个部件单独挂一次，这样"某一行挂了但什么都没贡献"能被看见——那正是
// LRN-20260916-012（file-guard 空转一整天）的形状，必须有断言钉住。
const parts = ['plan', 'companion', 'judge', 'code-run', 'netsec-range']
const registered = []   // { part, def }
const guards = []       // { part, fn }
const perPart = new Map()
{
  const { Context } = await import(pathToFileURL(CORDIS).href)
  const suite = await import(pathToFileURL(join(PKG, 'study-suite.js')).href)
  const hostGuard = await import(pathToFileURL(join(PKG, 'file-guard.js')).href)

  /** 每个部件一套全新的替身与全新的 Cordis 上下文——互不污染。 */
  const mountOne = async (label, plugin, config) => {
    const ctx = new Context()
    const contributed = { tools: 0, guards: 0 }
    ctx.provide('tools', {
      register: (def) => { registered.push({ part: label, def }); contributed.tools += 1; return () => {} },
      guard: (fn) => { guards.push({ part: label, fn }); contributed.guards += 1; return () => {} },
    })
    // netsec-range 还要求 webServer；不给它的话 `range_start/range_submit` 根本不会注册，
    // 而"没注册"与"注册了但坏了"在报告里长得一样——所以替身要给全。
    ctx.provide('webServer', { register: () => {} })
    try {
      await ctx.plugin(plugin, config)
    } catch (error) {
      check(`部件 ${label} 挂得上`, false, error.message)
    }
    perPart.set(label, contributed)
  }

  for (const part of parts) await mountOne(part, suite, { parts: [part] })
  await mountOne('file-guard(宿主平面)', hostGuard, undefined)
}
console.log('\n各部件贡献：')
for (const [label, c] of perPart) console.log(`   ${label}: ${c.tools} 个工具 / ${c.guards} 个守护`)
console.log(`   合计：${registered.length} 个工具、${guards.length} 个守护`)
check(
  '每个部件都至少贡献了一样东西（挂了却什么都不给 = 最难查的那种故障）',
  [...perPart.values()].every((c) => c.tools + c.guards > 0),
  [...perPart].filter(([, c]) => c.tools + c.guards === 0).map(([l]) => l).join('、'),
)
check('5 个部件各自都注册了东西', perPart.size === 6, `${perPart.size} 个部件`)

// ── 每个工具的代表性入参 ────────────────────────────────────────────────────
// 目标不是"跑通"，而是**把每条 return 路径都走一遍**——出问题的恰恰是那条平时没人看的路径
// （Python 的成功回执）。所以每个工具都同时喂合法与非法入参。
const CASES = {
  code_run: [
    ['python 单跑成功', { language: 'python', code: 'print("hello")' }],
    ['python 判题通过', { language: 'python', code: 'import sys\nprint(int(sys.stdin.read())*2)', cases: [{ input: '21', expect: '42', name: '倍数' }] }],
    ['python 判题不通过', { language: 'python', code: 'print(1)', cases: [{ expect: '2' }] }],
    ['python 运行时异常', { language: 'python', code: 'print(1)\nprint(undefined_variable)' }],
    ['python 死循环超时', { language: 'python', code: 'while True: pass', timeoutMs: 1000 }],
    ['c 单跑成功', { language: 'c', code: '#include <stdio.h>\nint main(void){puts("hi");return 0;}' }],
    ['c 判题通过', { language: 'c', code: '#include <stdio.h>\nint main(void){int a,b;scanf("%d %d",&a,&b);printf("%d\\n",a+b);return 0;}', cases: [{ input: '1 2', expect: '3' }] }],
    ['c 编译失败（缺分号）', { language: 'c', code: '#include <stdio.h>\nint main(void){puts("hi") return 0;}' }],
    ['c 没有 main', { language: 'c', code: 'int helper(void){return 1;}' }],
    ['用法错：language 非法', { language: 'java', code: 'x' }],
    ['用法错：两个源码来源都给', { language: 'c', code: 'int main(void){return 0;}', path: 'x.c' }],
    ['用法错：源码一个都没给', { language: 'c' }],
    ['用法错：cases 空数组', { language: 'python', code: 'print(1)', cases: [] }],
    ['用法错：cases 不是数组', { language: 'python', code: 'print(1)', cases: 'nope' }],
    ['用法错：用例缺 expect', { language: 'python', code: 'print(1)', cases: [{ input: '1' }] }],
    ['用法错：path 读不到', { language: 'python', path: 'C:/definitely/not/here.py' }],
  ],
  study_judge: [
    ['choice 答对', { kind: 'choice', answer: 'B', key: 'B' }],
    ['choice 答错', { kind: 'choice', answer: 'A', key: 'B' }],
    ['choice 等价组', { kind: 'choice', answer: 'b', key: '["B","b"]' }],
    ['cloze 正则', { kind: 'cloze', answer: 'printf', key: '/^print/' }],
    ['numeric 答对', { kind: 'numeric', answer: '0.5', key: '1/2' }],
    ['numeric 答错', { kind: 'numeric', answer: '0.7', key: '1/2' }],
    ['numeric 带容差', { kind: 'numeric', answer: '0.51', key: '{"value":0.5,"tolerance":0.05}' }],
    ['numeric 朴素分数答对（1/2 vs 0.5）', { kind: 'numeric', answer: '1/2', key: '0.5' }],
    ['flag 答对（自证也标出来）', { kind: 'flag', answer: 'flag{x}', key: 'flag{x}' }],
    ['flag 答错', { kind: 'flag', answer: 'flag{y}', key: 'flag{x}' }],
    ['code 判题通过', { kind: 'code', answer: 'function solve(input){ return String(Number(input) * 2) }', key: '{"cases":[{"input":"21","expect":"42"}]}' }],
    ['code 判题不通过', { kind: 'code', answer: 'function solve(input){ return "0" }', key: '{"cases":[{"input":"21","expect":"42"}]}' }],
    ['code 语法错误', { kind: 'code', answer: 'function solve( {', key: '{"cases":[{"input":"1","expect":"1"}]}' }],
    ['用法错：kind 为空', { kind: '', answer: 'x', key: 'y' }],
    ['用法错：flag key 为空', { kind: 'flag', answer: 'x', key: '' }],
    ['用法错：code key 不是 JSON', { kind: 'code', answer: 'function solve(){}', key: 'nope' }],
    ['用法错：code 没定义 solve', { kind: 'code', answer: 'var x = 1', key: '{"cases":[{"input":"1","expect":"1"}]}' }],
    ['用法错：什么都不给', {}],
  ],
  range_start: [
    ['正常开局', { level: 'sqli' }],
    ['用法错：缺 level', {}],
    ['用法错：未知关卡', { level: 'nope' }],
  ],
  range_submit: [
    ['flag 正确', { level: 'sqli', flag: 'flag{sqli_login_bypass_ok}' }],
    ['flag 错误', { level: 'sqli', flag: 'flag{guess}' }],
    ['用法错：缺 level', { flag: 'flag{x}' }],
    ['用法错：缺 flag', { level: 'sqli' }],
  ],
}
/** 没写用例的工具也要过一遍最省事的入参，并**如实报告它没被深测**。 */
const shallowOnly = []

// ── 逐个工具过契约 ──────────────────────────────────────────────────────────
function repr(v) {
  const s = JSON.stringify(v)
  if (s !== undefined) return s.slice(0, 160)
  return `<不可 JSON 序列化：${Object.prototype.toString.call(v)}>`
}

for (const { part, def } of registered) {
  console.log(`\n── ${def.name}（部件 ${part}）`)
  let cases = CASES[def.name] ?? [['（浅测）空参数', {}]]
  if (CASES[def.name] === undefined) shallowOnly.push(def.name)
  // 快速档：跳过需要真编译 C 的用例（`c ` 开头的那几条）。Python 与全部用法错误路径照跑。
  let skipped = 0
  if (QUICK) {
    const before = cases.length
    cases = cases.filter(([label]) => !label.startsWith('c '))
    skipped = before - cases.length
    if (skipped > 0) console.log(`     ⏩ 快速档：跳过 ${skipped} 条要真编译 C 的用例`)
  }

  // ① 注册面：宿主要先收得下 parameters / output.schema
  check(`  ${def.name}：parameters 是 lossless JSON`, isJsonValue(def.parameters === undefined ? {} : def.parameters), repr(def.parameters))
  if (def.output?.schema !== undefined) {
    check(`  ${def.name}：output.schema 是 lossless JSON`, isJsonValue(def.output.schema), repr(def.output.schema))
  }

  // ② 回执面：每条 return 路径都要过
  for (const [label, args] of cases) {
    let result
    try {
      result = await def.execute(args)
    } catch (error) {
      check(`  ${def.name} · ${label}：execute 不该抛异常`, false, error?.message)
      continue
    }
    const okShape = isJsonValue(result)
    // 双保险：isJsonValue 说合法还不够，宿主真正调用的是 snapshotJsonValue（它会"脱壳"
    // 成一份独立副本，失败返回 undefined）。两者都过，才算宿主收得下。
    const snapOk = snapshotJsonValue(result) !== undefined
    check(`  ${def.name} · ${label}：回执是 lossless JSON`, okShape, okShape ? '' : `违规值：${repr(result)}`)
    check(`  ${def.name} · ${label}：回执能过宿主的 snapshot（真正被调用的那个）`, snapOk, snapOk ? '' : `违规值：${repr(result)}`)

    // classify() 与 render() 也各要过一遍：render 的产物会进模型上下文，同样落盘。
    if (okShape && typeof def.output?.render === 'function') {
      let parts_
      try {
        parts_ = def.output.render(args, result)
      } catch (error) {
        check(`  ${def.name} · ${label}：render 不该抛异常`, false, error?.message)
        continue
      }
      check(`  ${def.name} · ${label}：render 产物是 lossless JSON`, isJsonValue(parts_), repr(parts_))
      check(`  ${def.name} · ${label}：render 产物能过 snapshot`, snapshotJsonValue(parts_) !== undefined, repr(parts_))
    }
  }
}

// ── 守护面：拒绝给字符串、放行给 undefined、绝不抛异常 ──────────────────────
// 守护的返回值不是工具回执，但它**同样会进模型上下文**（拒绝理由），而且它跑在每次
// write/edit 的关键路径上——它一抛异常，学员的每次写文件都会失败。
console.log(`\n── 守护（${guards.length} 个）`)
check('至少注册了 1 个写入守护（companion / plan / file-guard 都该有）', guards.length > 0, `实际 ${guards.length}`)
check('3 个写入守护都在（companion-core / plan-core / file-guard）', guards.length === 3, `实际 ${guards.length}`)

{
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-tool-output-'))
  const today = new Date()
  const stamp = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  const archiveText = (marker) => `# 学习档案\n\n更新于: ${stamp}\n\n## 学校当前进度\n第 3 章。\n\n## 已答主题与卡点\n- ${marker}。\n\n## 未消化薄弱点\n- 可变默认参数。\n`
  // 目录布局照抄真实工作区：学习根下每个科目一个目录，各科目自己一份档案。
  // 少了"科目子目录"这一层，plan-core 的平面不变量（总规划只读科目档案）根本走不到。
  const mathDir = join(tmp, '数学')
  const engDir = join(tmp, '英语')
  mkdirSync(mathDir, { recursive: true })
  mkdirSync(engDir, { recursive: true })
  const VALID = archiveText('指针与数组退化')
  const NO_STAMP = VALID.replace(`更新于: ${stamp}\n`, '')
  const mathArchive = join(mathDir, '学习档案.md')
  writeFileSync(mathArchive, VALID, 'utf8')
  writeFileSync(join(engDir, '学习档案.md'), archiveText('时态'), 'utf8')
  writeFileSync(join(mathDir, '别的东西.md'), 'x', 'utf8')

  const inMath = { session: { header: { cwd: mathDir } } }   // 科目会话（自己的档案）
  const atRoot = { session: { header: { cwd: tmp } } }       // 总规划 / 外来会话

  // 三条平面不变量各钉一条具名断言（不是"随便拒绝一次就算过"）。
  const GUARD_CASES = [
    ['write 本科档案（合规）', { name: 'write', arguments: { file_path: mathArchive, content: VALID }, agent: inMath }, 'either'],
    ['write 本科档案（缺日期戳）', { name: 'write', arguments: { file_path: mathArchive, content: NO_STAMP }, agent: inMath }, 'either'],
    ['write 本科无关文件', { name: 'write', arguments: { file_path: join(mathDir, '别的东西.md'), content: 'x' }, agent: inMath }, 'either'],
    ['write 无 agent（cwd 未知）', { name: 'write', arguments: { file_path: mathArchive, content: VALID } }, 'either'],
    ['★跨科写别科档案（外来 cwd）', { name: 'write', arguments: { file_path: mathArchive, content: VALID }, agent: atRoot }, 'either'],
    ['★总规划写科目档案', { name: 'write', arguments: { file_path: join(engDir, '学习档案.md'), content: VALID }, agent: atRoot }, 'either'],
    ['edit 本科档案', { name: 'edit', arguments: { file_path: mathArchive, old_string: '第 3 章。', new_string: '第 4 章。' }, agent: inMath }, 'either'],
    ['edit old_string 找不到', { name: 'edit', arguments: { file_path: mathArchive, old_string: '不存在的串', new_string: 'x' }, agent: inMath }, 'either'],
    ['别的工具', { name: 'pwsh', arguments: { command: 'echo hi' }, agent: inMath }, 'allow'],
    ['参数里没有 file_path', { name: 'write', arguments: {}, agent: inMath }, 'allow'],
    ['arguments 整个缺失', { name: 'write', agent: inMath }, 'allow'],
    ['file_path 是空串', { name: 'write', arguments: { file_path: '', content: 'x' }, agent: inMath }, 'allow'],
    ['file_path 是个目录', { name: 'write', arguments: { file_path: mathDir, content: 'x' }, agent: inMath }, 'either'],
  ]
  const DENY_REASONS = []
  for (const { fn, part } of guards) {
    let denied = 0
    let threw = 0
    let badShape = 0
    for (const [label, execution, expect] of GUARD_CASES) {
      let r
      try {
        r = fn(execution)
      } catch (error) {
        threw += 1
        check(`  ${part} · ${label}：守护不该抛异常`, false, error?.message)
        continue
      }
      const isAllow = r === undefined
      if (!isAllow && (typeof r !== 'string' || r.length === 0)) badShape += 1
      if (!isAllow) { denied += 1; DENY_REASONS.push({ part, label, reason: r }) }
      if (expect === 'allow' && !isAllow) check(`  ${part} · ${label}：应放行却拒绝了`, false, String(r).slice(0, 120))
    }
    check(`  ${part}：守护返回值只有 undefined 或非空字符串（${GUARD_CASES.length} 种输入）`, badShape === 0, `${badShape} 次形状非法`)
    // 每个守护都必须**真的拒绝过**：一个从不拒绝的守护在"全绿"里和坏掉的守护长得一样。
    check(`  ${part}：13 种输入里至少拒绝 1 次（拒绝路径活着）`, denied > 0, `实际拒绝 ${denied} 次`)
    console.log(`     ${part}：${GUARD_CASES.length - threw} 次调用无异常，拒绝 ${denied} 次`)
  }

  // 具名不变量：拒绝理由必须指向"该找谁改"，而不是一句"不允许"。
  const companionDeny = DENY_REASONS.find((d) => d.part === 'companion' && d.label.includes('缺日期戳'))
  check('companion：缺日期戳的拒绝理由点明了日期戳要求', companionDeny !== undefined && companionDeny.reason.includes('更新于'), companionDeny?.reason)
  const planDeny = DENY_REASONS.find((d) => d.part === 'plan' && d.label.includes('总规划写科目档案'))
  check('plan：拒绝总规划代改科目档案，并指出该由该科自己更新', planDeny !== undefined && planDeny.reason.includes('该科'), planDeny?.reason)
  const guardDeny = DENY_REASONS.find((d) => d.part.startsWith('file-guard') && d.label.includes('跨科'))
  check('file-guard：外来 cwd 写受守护档案被拦下', guardDeny !== undefined, '没有拦下（这正是 2026-09-16 那个"守护空转"的形状）')

  rmSync(tmp, { recursive: true, force: true })
}

if (shallowOnly.length > 0) {
  console.log(`\n⚠️ 只做了浅测（没写代表性入参）：${shallowOnly.join('、')}`)
  console.log('   浅测只能证明"空参数这条路不炸"，证明不了别的 return 路径——有空的补上。')
}

console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)