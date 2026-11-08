// probe-metamount.mjs — 决定性实验：`ctx.plugin(模块命名空间)` 到底行不行？
//
// 为什么要问：想把「每个预设挂 3 行学习插件」收敛成「挂 1 行套件入口」，就得让套件在内部
// 用 `ctx.plugin(子插件模块)` 把兄弟模块挂起来。而 ESM 命名空间对象是**冻结的**、还带着
// 一堆额外导出（我们的插件每个都有 5~28 个导出），Cordis 只认 `{ apply }` 这一种对象插件形状。
//
// 这个脚本直接建一个裸 Cordis Context，把**真的模块命名空间**喂给 `ctx.plugin()`，看它认不认。
// 不需要 DSH 在跑，也不碰任何文件。
//
// 用法：node test/probe-metamount.mjs
import { pathToFileURL } from 'node:url'

const CORDIS = '~/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/cordis/lib/index.js'
const PLUGINS = '<study-plugins>/'

let pass = 0
let fail = 0
const check = (label, cond, extra) => {
  if (cond) { pass += 1; console.log('  ✅', label) }
  else { fail += 1; console.log('  ❌', label, extra === undefined ? '' : `→ ${extra}`) }
}

const { Context } = await import(pathToFileURL(CORDIS).href)
console.log('cordis 导出的名字：', Object.keys(await import(pathToFileURL(CORDIS).href)).slice(0, 8).join(', '))

const companion = await import(pathToFileURL(PLUGINS + 'companion-core.js').href)
// ⚠️ 别用 `Object.isFrozen` 判 ESM 命名空间：V8 把命名空间属性的 descriptor 报成 writable: true，
//    于是 isFrozen 返回 **false**——可对象其实是不可写的。（这条断言我第一版就写错了，第 8 次。）
let actuallyWritable = false
try { companion.__probe = 1; actuallyWritable = companion.__probe === 1 } catch { actuallyWritable = false }
check('命名空间对写入免疫（Cordis 往上写属性不会成功）', actuallyWritable === false)
check('  它带着一堆额外导出（不只是 apply/name/inject）', Object.keys(companion).length > 5, String(Object.keys(companion).length))

// ① 裸 ctx 直接挂命名空间
console.log('\n① ctx.plugin(命名空间) 认不认')
const ctx = new Context()
let mounted = null
try {
  mounted = ctx.plugin(companion)
  check('没有抛「invalid plugin」', true)
} catch (e) {
  check('没有抛「invalid plugin」', false, e.message)
}
if (mounted) {
  try {
    await mounted
    check('  fiber 正常 settle（apply 跑完了）', true)
  } catch (e) {
    check('  fiber 正常 settle（apply 跑完了）', false, e.message)
  }
}

// ② 换个形状再试：显式只挑 apply/name/inject 包一层
console.log('\n② 对照：显式包一层 { apply, name, inject }')
const ctx2 = new Context()
try {
  await ctx2.plugin({ name: companion.name, inject: companion.inject, apply: companion.apply })
  check('包一层也能挂', true)
} catch (e) {
  check('包一层也能挂', false, e.message)
}

// ③ 挂一个**不存在 apply** 的命名空间，确认报错信息正常（说明 ① 的成功不是因为"什么都接受"）
console.log('\n③ 反例：没有 apply 的对象必须被拒')
const ctx3 = new Context()
let rejected = false
try { ctx3.plugin({ foo: 1 }) } catch { rejected = true }
check('没有 apply → 抛错', rejected)

console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
