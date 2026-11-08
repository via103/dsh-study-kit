// probe-guard-logic.mjs — 决定性实验：file-guard 的**判定逻辑**本身是对的吗？
//
// 背景：实测「工作目录在别处的会话」能直接 write 到 ST\<科目>\学习档案.md，宿主守护没有出声。
// 这有两种可能，必须分开：
//   (A) 判定逻辑没问题，是 **tools.guard() 根本没注册**（apply 时 ctx.get('tools') 为 undefined）
//   (B) 逻辑自己坏了——比如中间抛异常，被 fail-open 的 catch 吞掉，于是"永远放行"
//
// 做法：给 apply() 一个假的 ctx（get('tools') 返回假 tools，把守卫回调截下来），
// 然后**直接调用那个回调**，喂几条构造好的 execution，看它答什么。
// 这个实验不需要会话、不需要重启，也不会改任何文件。
//
// 用法：node test/probe-guard-logic.mjs
import { pathToFileURL } from 'node:url'

const PLUGINS = '<study-plugins>/'
const mod = await import(pathToFileURL(PLUGINS + 'file-guard.js').href)

let captured = null
const fakeCtx = {
  get: (name) => (name === 'tools' ? { guard: (fn) => { captured = fn; return () => {} } } : undefined),
}

console.log('file-guard 导出的名字：', Object.keys(mod).join(', '))
console.log('声明了 inject 吗：', 'inject' in mod ? JSON.stringify(mod.inject) : '❌ 没有（所以 apply 一上来就执行，拿不到 tools 就直接 return）')

mod.apply(fakeCtx)
console.log('假 ctx 下守卫被注册了吗：', captured === null ? '❌ 没有' : '✅ 注册了')
if (captured === null) {
  console.log('\n→ apply() 在 ctx.get("tools") 为 undefined 时直接 return。')
  console.log('  这正是 (A)：**不是逻辑错，是这一行压根没被调用**。')
  process.exit(0)
}

const ST = 'ST'
const CWD_FOREIGN = './创建预设'
const CWD_SUBJECT = `${ST}/英语`
const file = (p) => `${ST}/英语/学习档案.md`

let bad = 0
const probe = (label, expectBlocked, exec) => {
  let verdict
  try { verdict = captured(exec) } catch (e) { verdict = `THREW: ${e.message}` }
  const blocked = typeof verdict === 'string'
  const pass = blocked === expectBlocked
  if (!pass) bad += 1
  console.log(`  ${pass ? '✅' : '❌'} ${label} → ${blocked ? `拦下：${verdict}` : '放行（undefined）'}`)
  if (String(verdict).startsWith('THREW')) console.log('      ⚠️ 抛异常会被 fail-open 的 catch 吞掉 = 永远放行，这属于 (B)')
}

console.log('\n① 外会话改本科档案（按规则应当拦下）')
probe('cwd=创建预设 写 英语/学习档案.md', true, {
  name: 'write',
  arguments: { file_path: file(), content: '随便' },
  agent: { session: { header: { cwd: CWD_FOREIGN } } },
})

console.log('\n② 本科自己改（应当放行，且内容非法时拦下）')
probe('cwd=英语 写 英语/学习档案.md（非法内容）', true, {
  name: 'write',
  arguments: { file_path: file(), content: '随便' },
  agent: { session: { header: { cwd: CWD_SUBJECT } } },
})

console.log('\n③ 别处项目的同名文件（按管辖权应当不管）')
probe('cwd=创建预设 写 创建预设/学习档案.md', false, {
  name: 'write',
  arguments: { file_path: `${CWD_FOREIGN}/学习档案.md`, content: '随便' },
  agent: { session: { header: { cwd: CWD_FOREIGN } } },
})

console.log('\n④ 非协议文件（应当不管）')
probe('cwd=创建预设 写 ST/英语/随便.md', false, {
  name: 'write',
  arguments: { file_path: `${ST}/英语/随便.md`, content: '随便' },
  agent: { session: { header: { cwd: CWD_FOREIGN } } },
})

console.log(`\n${bad === 0 ? '✅ 判定逻辑本身是好的 → 问题在「守卫没注册」' : `❌ 有 ${bad} 条判定逻辑不对 → 问题不止是注册`}`)
process.exit(bad === 0 ? 0 : 1)
