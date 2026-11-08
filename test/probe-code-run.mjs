// probe-code-run.mjs — code_run 到底能不能用？**两条独立的路都要过**：
//
//   ① 套件挂载：`study-suite` 用 `parts: ['code-run']` 挂上去之后，`code_run` 是否真的注册进了 tools
//   ② 真跑一次：C 与 Python 各跑一遍（这是学员实际看到的那条路）
//
// 为什么要单独一个脚本：`verify-code-run.mjs` 测的是**纯函数与判定逻辑**，它根本不碰
// "这个工具在真会话里挂不挂得上"。而"听说 code-run 不能用"这类报告，多半正好落在 ① 或 ② 上。
//
// 用法：node test/probe-code-run.mjs
import { pathToFileURL } from 'node:url'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG = dirname(dirname(fileURLToPath(import.meta.url)))
const CORDIS = '~/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/cordis/lib/index.js'

let pass = 0
let fail = 0
const check = (label, cond, extra) => {
  if (cond) { pass += 1; console.log('  ✅', label) }
  else { fail += 1; console.log('  ❌', label, extra === undefined ? '' : `→ ${extra}`) }
}

// ── ① 套件挂载：真的 Cordis Context + 一个真的 tools 注册表替身 ───────────────
console.log('\n① 套件挂载：parts: ["code-run"] 之后 code_run 有没有真的注册上')
let captured
{
  const { Context } = await import(pathToFileURL(CORDIS).href)
  const suite = await import(pathToFileURL(join(PKG, 'study-suite.js')).href)
  const ctx = new Context()
  // 只替身"注册表"本身；apply/作用域/子插件挂载全部走真 Cordis。
  ctx.provide('tools', {
    register: (def) => { captured = def; return () => {} },
    guard: () => () => {},
  })
  let mounted = true
  try { await ctx.plugin(suite, { parts: ['code-run'] }) } catch (e) { mounted = false; check('套件挂得上', false, e.message) }
  if (mounted) check('套件挂得上', true)
  check('  code_run 注册到了 tools', captured !== undefined && captured.name === 'code_run', captured?.name)
  check('  它带 execute 与 parameters', typeof captured?.execute === 'function' && captured?.parameters?.properties?.language !== undefined)
}

if (captured === undefined) {
  console.log('\n❌ 工具压根没注册上——不用再测真跑了，问题在挂载这一层。')
  console.log(`\n❌ 有失败：${pass} passed, ${fail} failed`)
  process.exit(1)
}

// ── ② 真跑：C 与 Python ─────────────────────────────────────────────────────
console.log('\n② 真跑一次（学员实际看到的那条路）')
{
  const cCode = '#include <stdio.h>\nint main(void){ int a,b; if(scanf("%d %d",&a,&b)!=2) return 1; printf("%d\\n", a+b); return 0; }'
  const r1 = await captured.execute({ language: 'c', code: cCode, cases: [{ input: '1 2', expect: '3', name: '1+2' }] })
  console.log(`     C：compileOk=${r1.compileOk} runMode=${r1.runMode ?? '-'} retries=${r1.retries ?? 0} usageError=${r1.usageError ?? false} pass=${r1.pass}`)
  check('C：编译通过', r1.compileOk === true, JSON.stringify(r1.compileOutput ?? r1.detail ?? '').slice(0, 200))
  check('C：判定为通过', r1.pass === true, JSON.stringify(r1.results ?? r1.detail ?? '').slice(0, 200))
  if (r1.runMode === 'dll-host') console.log('     （走的是共享库 + python 宿主——本机应用控制策略会拦新生成的 .exe）')
  if ((r1.retries ?? 0) > 0) console.log(`     ⚠️ 被策略拦了 ${r1.retries} 次后重试成功`)

  const pyCode = 'import sys\na, b = map(int, sys.stdin.read().split())\nprint(a - b)'
  const r2 = await captured.execute({ language: 'python', code: pyCode, cases: [{ input: '5 3', expect: '2', name: '5-3' }] })
  console.log(`     Python：compileOk=${r2.compileOk} usageError=${r2.usageError ?? false} pass=${r2.pass}`)
  check('Python：判定为通过', r2.pass === true, JSON.stringify(r2.results ?? r2.detail ?? '').slice(0, 200))

  // 单次运行模式（不传 cases）
  const r3 = await captured.execute({ language: 'python', code: 'print("hello")' })
  check('单次运行模式：stdout 原样回报', r3.exitCode === 0 && String(r3.stdout).includes('hello'), JSON.stringify({ exit: r3.exitCode, stdout: r3.stdout }))
}

console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
