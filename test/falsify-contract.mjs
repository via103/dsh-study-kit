// falsify-contract.mjs —— **验证那条断言不是空的**：把历史上真实的坏形状塞回去，
// 契约测试必须变红；再还原，必须变绿。跑完自动还原（finally），不留痕迹。
//
// 一个从没红过的测试等于没有测试 —— 这次 "code_run 的 Python 通道" 就是被三个"全绿"
// 的测试放过去的，所以这里专门做一次变异检验。
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG = dirname(dirname(fileURLToPath(import.meta.url)))
const TARGET = join(PKG, 'code-run.js')
const BACKUP = join(PKG, '.verify', 'code-run.js.falsify-backup')
const TEST = join(PKG, 'test', 'verify-tool-output.mjs')
const FIXED = '...compileOkField(o.language),'
const BAD = "compileOk: o.language === 'c' ? true : undefined,"

// 这个脚本会**临时改写一个正在被会话加载的插件文件**（code-run.js）。
// 所以：先留一份备份、多处兜底还原、并且**绝不在已经处于坏状态时再跑一次**。
if (existsSync(BACKUP)) {
  console.log(`⚠️ 发现上次留下的备份 ${BACKUP} —— 说明上一次没跑完就被中断了。`)
  console.log('   先把它还原回去再跑本脚本。')
  process.exit(1)
}

const original = readFileSync(TARGET, 'utf8')
const alreadyBad = original.includes(BAD) && !original.includes(FIXED)
if (alreadyBad) {
  console.log('❌ code-run.js 现在就是坏形状（compileOk: undefined）——先修好再跑变异检验，')
  console.log('   否则这次"检验"会把坏版本当成原版备份下来。')
  process.exit(1)
}
if (!original.includes(FIXED)) {
  console.log(`❌ 找不到修好的写法 ${FIXED} —— 先确认 code-run.js 是修好后的版本`)
  process.exit(1)
}

const restore = () => {
  try {
    writeFileSync(TARGET, original, 'utf8')
    if (existsSync(BACKUP)) rmSync(BACKUP, { force: true })
  } catch { /* 尽力而为 */ }
}
// 三处兜底：正常 finally、进程退出、以及 Ctrl-C。宁可多写一遍也不能留个坏文件在盘上。
process.on('exit', restore)
process.on('SIGINT', () => { restore(); process.exit(130) })
process.on('SIGTERM', () => { restore(); process.exit(143) })

const runTest = () => {
  try {
    return { ok: true, out: execFileSync(process.execPath, [TEST], { encoding: 'utf8' }) }
  } catch (error) {
    return { ok: false, out: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

try {
  console.log('① 注入历史坏形状（compileOk: undefined）…')
  copyFileSync(TARGET, BACKUP)
  writeFileSync(TARGET, original.replaceAll(FIXED, BAD), 'utf8')
  const bad = runTest()
  const badLines = bad.out.split('\n').filter((l) => l.includes('回执是 lossless JSON') && l.includes('❌'))
  console.log(`   契约测试结果：${bad.ok ? '❌ 仍然全绿——这条断言是空的！' : '✅ 变红了（断言有效）'}`)
  for (const l of badLines.slice(0, 4)) console.log(`   ${l.trim()}`)
  const exitCorrect = bad.ok === false

  console.log('② 还原修复…')
  restore()
  const good = runTest()
  console.log(`   契约测试结果：${good.ok ? '✅ 回到全绿' : '❌ 还原后仍失败'}`)

  const verdict = exitCorrect && good.ok
  console.log(`\n${verdict ? '✅ 变异检验通过：断言能抓住这个 bug，修好后也不再误报' : '❌ 变异检验失败'}`)
  process.exit(verdict ? 0 : 1)
} finally {
  restore()
}