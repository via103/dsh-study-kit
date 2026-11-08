// code-run（编程判定层）的独立验证：先测纯函数，再用**真实工具链**端到端跑通。
// 这台机器上 gcc 与 python 都是真家伙，所以这里不 mock 任何东西——编不过就是编不过。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, delimiter } from 'node:path'
import { pathToFileURL } from 'node:url'

const PLUGINS = '<study-plugins>/'
const cr = await import(pathToFileURL(PLUGINS + 'code-run.js').href)

let pass = 0
let fail = 0
function check(label, cond, extra) {
  if (cond) { pass += 1; console.log('  ✅', label) }
  else { fail += 1; console.log('  ❌', label, extra === undefined ? '' : `→ ${extra}`) }
}

// ── 接线 ────────────────────────────────────────────────────────────────────
function mount(config) {
  const registered = []
  cr.apply({ get: (n) => (n === 'tools' ? { register: (t) => registered.push(t) } : undefined) }, config)
  return registered[0]
}
const tool = mount({})
const run = (args) => tool.execute(args)
const render = (v) => tool.output.render({}, v).map((b) => b.text).join('\n')
const toolNoC = mount({ cCompiler: 'C:/definitely/not/here/gcc.exe' })
const toolNoPy = mount({ python: 'C:/definitely/not/here/python.exe' })

console.log('\n① 接线')
check('注册了 code_run', tool !== undefined && tool.name === 'code_run')
check('不会被误标为并发不安全', tool.isConcurrencySafe() === true)

console.log('\n② 输出归一化（判题口径）')
check('CRLF → LF', cr.normalizeOutput('a\r\nb\r\n') === 'a\nb')
check('去掉行尾空白', cr.normalizeOutput('a   \nb\t\n') === 'a\nb')
check('去掉末尾空行', cr.normalizeOutput('a\n\n\n') === 'a')
// 回归：行首空白绝不能归一——「星号金字塔」的对错全在这里
check('保留行首空白', cr.normalizeOutput('  *\n ***\n') === '  *\n ***')
check('compareCase：相同 → 通过', cr.compareCase('42\n', '42\n') === true)
check('compareCase：行尾空白差异 → 仍通过', cr.compareCase('42  \n\n', '42') === true)
check('compareCase：缩进少一格 → 不通过', cr.compareCase(' *\n', '  *\n') === false)
check('compareCase：内部空白不同 → 不通过', cr.compareCase('a  b', 'a b') === false)
check('compareCase：大小写不同 → 不通过', cr.compareCase('AB', 'ab') === false)

console.log('\n③ 输出截断')
check('truncateHead：短串原样', cr.truncateHead('abc', 10) === 'abc')
check('truncateHead：长串标注截断', cr.truncateHead('x'.repeat(20), 5).includes('已截断'))
check('headTail：短串原样', cr.headTail('abc', 10, 10) === 'abc')
const ht = cr.headTail('A'.repeat(50) + 'B'.repeat(50), 10, 10)
check('headTail：长串留头尾', ht.startsWith('A'.repeat(10)) && ht.endsWith('B'.repeat(10)) && ht.includes('省略'))

console.log('\n④ cases 参数解析（空用例必须被拒）')
const pUndef = cr.parseCases(undefined)
check('未给 cases → 单次运行模式', pUndef.ok === true && pUndef.cases === undefined)
const pEmpty = cr.parseCases([])
check('空数组 → 拒绝', pEmpty.ok === false)
check('  拒绝理由点明「没有做任何判定」', String(pEmpty.reason).includes('没有做任何判定'))
check('非数组 → 拒绝', cr.parseCases({ a: 1 }).ok === false)
check('缺 expect → 拒绝', cr.parseCases([{ input: '1' }]).ok === false)
check('超过 20 条 → 拒绝', cr.parseCases(Array.from({ length: 21 }, () => ({ expect: 'x' }))).ok === false)
const pJson = cr.parseCases('[{"input":"1\\n","expect":"2\\n"}]')
check('接受 JSON 字符串形式', pJson.ok === true && pJson.cases.length === 1)
const pNum = cr.parseCases([{ expect: 42 }])
check('expect 数字 → 转字符串', pNum.ok === true && pNum.cases[0].expect === '42')
check('用例名有默认值', cr.parseCases([{ expect: 'x' }]).cases[0].name === '用例 1')

console.log('\n⑤b 应用控制策略拦截的识别（本机 Smart App Control）')
check('识别 WinError 4551', cr.isPolicyBlocked('OSError: [WinError 4551] 应用程序控制策略已阻止此文件。') === true)
check('识别英文措辞', cr.isPolicyBlocked('An Application Control policy has blocked this file') === true)
check('普通报错不误判', cr.isPolicyBlocked('Traceback: ZeroDivisionError') === false)
check('空 stderr 不误判', cr.isPolicyBlocked('') === false)
check('真实拦截样本（本机采集）可识别', cr.isPolicyBlocked('  OSError: [WinError 4551] 应用程序控制策略已阻止此文件。\n') === true)

// 重试**必须递增退避**：2026-09-18 从真实会话日志里挖到，模型连试三次全被拦之后改用 shell 绕过去了。
// 根因是固定 400ms 等于在同一个信誉判定窗口里连试。这组断言盯的就是"别再退回去用固定间隔"。
const d1 = cr.policyDelayFor(1)
const d2 = cr.policyDelayFor(2)
const d3 = cr.policyDelayFor(3)
check('退避：第 1 档与第 2 档严格递增', d2 > d1, `${d1} → ${d2}`)
check('退避：第 2 档与第 3 档严格递增', d3 > d2, `${d2} → ${d3}`)
check('退避：第一档不为 0（不空转）', d1 > 0, String(d1))
check('退避：超出档位沿用最后一档（不会退化成"不等待"）', cr.policyDelayFor(99) === d3 && cr.policyDelayFor(4) === d3)
check('退避总时长有上界（不能把一次讲评拖死）', d1 + d2 + d3 < 10000, String(d1 + d2 + d3))

console.log('\n⑤ 工具链发现')
const fakePath = ['C:/nope', 'C:/yes'] .join(delimiter)
const isFile = (p) => p === join('C:/yes', 'gcc.exe')
check('searchPath：命中', cr.searchPath(['gcc.exe'], fakePath, isFile) === join('C:/yes', 'gcc.exe'))
check('searchPath：未命中 → undefined', cr.searchPath(['clang.exe'], fakePath, isFile) === undefined)
const croot = mkdtempSync(join(tmpdir(), 'croot-'))
mkdirSync(join(croot, 'w64devkit', 'bin'), { recursive: true })
writeFileSync(join(croot, 'w64devkit', 'bin', 'gcc.exe'), '')
check('findPortableGcc：平铺布局', cr.findPortableGcc(croot) === join(croot, 'w64devkit', 'bin', 'gcc.exe'))
const croot2 = mkdtempSync(join(tmpdir(), 'croot2-'))
mkdirSync(join(croot2, 'w64devkit', 'w64devkit', 'bin'), { recursive: true })
writeFileSync(join(croot2, 'w64devkit', 'w64devkit', 'bin', 'gcc.exe'), '')
check('findPortableGcc：多套一层也能找到（SFX 解压形态）', cr.findPortableGcc(croot2) === join(croot2, 'w64devkit', 'w64devkit', 'bin', 'gcc.exe'))
check('findPortableGcc：空目录 → undefined', cr.findPortableGcc(mkdtempSync(join(tmpdir(), 'croot3-'))) === undefined)
const g = cr.resolveGcc({})
check('resolveGcc：本机真找到编译器', g.missing === undefined, JSON.stringify(g))
const gBad = cr.resolveGcc({ cCompiler: 'C:/definitely/not/here/gcc.exe' })
check('resolveGcc：配置路径不存在 → 明确报 missing（不静默回退）', typeof gBad.missing === 'string' && gBad.path === undefined)
const py = cr.resolvePython({})
check('resolvePython：本机真找到解释器', py.missing === undefined, JSON.stringify(py))

rmSync(croot, { recursive: true, force: true })
rmSync(croot2, { recursive: true, force: true })

// ── 端到端 ──────────────────────────────────────────────────────────────────

console.log('\n⑥ 端到端 · Python（真解释器）')
{
  const r = await run({ language: 'python', code: 'print(6*7)' })
  check('单次运行：退出码 0', r.exitCode === 0, JSON.stringify(r))
  check('单次运行：stdout = 42', cr.normalizeOutput(r.stdout) === '42')
  check('单次运行：不产生判定', r.pass === undefined)
  check('工具链路径回报出来', String(r.toolchain).includes('python'))
}
{
  const r = await run({ language: 'python', code: 'x=int(input())\nprint(x*2)' , cases: [
    { input: '3\n', expect: '6\n' }, { input: '21\n', expect: '42\n' },
  ] })
  check('用例模式：2/2 通过', r.pass === true && r.passed === 2 && r.total === 2, JSON.stringify(r.results))
}
{
  const r = await run({ language: 'python', code: 'print(1)', cases: [{ input: '', expect: '2' }] })
  check('用例模式：答错 → 未通过', r.pass === false && r.passed === 0)
  // got 回传的是**原始 stdout**：讲评时要看到真实字节。Windows 文本模式会写成 CRLF，
  // 归一化是判定时才做的事，回传不替学员美化——所以这里按归一化值断言。
  check('  失败用例带实际/期望输出', cr.normalizeOutput(r.results[0].got) === '1' && r.results[0].expect === '2' && r.results[0].got.includes('\r\n'), JSON.stringify(r.results[0]))
}
{
  const r = await run({ language: 'python', code: 'print("中文输出：你好")' })
  check('中文输出不乱码（-X utf8 生效）', r.stdout.includes('你好'), JSON.stringify(r.stdout))
}
{
  const r = await run({ language: 'python', code: 'import sys\nprint(42)\nsys.exit(3)', cases: [{ expect: '42' }] })
  check('退出码非 0：输出虽对仍判未过', r.pass === false && r.results[0].outputMatched === true)
}
{
  const r = await run({ language: 'python', code: 'print(1/0)' })
  check('运行期异常：不算「未做判定」', r.usageError === undefined && r.exitCode !== 0)
  check('  异常信息进 stderr', r.stderr.includes('ZeroDivisionError'))
}
{
  const r = await run({ language: 'python', code: 'while True:\n    pass', timeoutMs: 900 })
  check('死循环：超时被强制结束', r.timedOut === true, JSON.stringify({ t: r.timedOut, e: r.exitCode }))
}
{
  const r = await run({ language: 'python', code: 'n=int(input())\nprint(n+1)', stdin: '41\n' })
  check('单次运行：stdin 生效', cr.normalizeOutput(r.stdout) === '42')
}

console.log('\n⑦ 端到端 · C（真编译器）')
{
  const r = await run({ language: 'c', code: '#include <stdio.h>\nint main(void){printf("%d\\n",6*7);return 0;}' })
  check('单次运行：compileOk 为 true', r.compileOk === true, JSON.stringify(r.compileOutput))
  check('单次运行：stdout = 42', cr.normalizeOutput(r.stdout) === '42', JSON.stringify(r.stdout))
  check('无警告时 compileWarnings=false', r.compileWarnings === false)
  check('标明执行方式为共享库宿主', r.runMode === 'dll-host')
}
{
  const r = await run({ language: 'c', code: 'int main(void){ return oops; }' })
  check('编译错误：phase=compile', r.phase === 'compile')
  check('编译错误：compileOk=false', r.compileOk === false)
  check('编译错误：带 gcc 诊断', String(r.compileOutput).includes('oops'), String(r.compileOutput))
  check('编译错误：**不是** usageError（是真编译失败）', r.usageError === undefined)
  check('编译错误：没有运行、没有判定', r.pass === undefined && r.exitCode === undefined)
}
{
  const r = await run({ language: 'c', code: 'int main(void){ int unused; return 0; }' })
  check('只有警告：仍然编译通过', r.compileOk === true && r.compileWarnings === true)
}
{
  // 共享库不要求 main，所以「没写 main」会以链接错误出现——必须翻译成人话
  const r = await run({ language: 'c', code: 'int add(int a,int b){return a+b;}' })
  check('缺 main：编译失败', r.compileOk === false)
  check('缺 main：给出可读提示', String(r.compileOutput).includes('没有 `main` 函数'), String(r.compileOutput).slice(-160))
}
{
  // 退出码必须从 C 的 return 透传出来（经 python 宿主）
  const r = await run({ language: 'c', code: '#include <stdio.h>\nint main(void){printf("42\\n");return 3;}' })
  check('C 的 return 3 透传为退出码 3', r.exitCode === 3, JSON.stringify(r.exitCode))
}
{
  const r = await run({ language: 'c', code: '#include <stdio.h>\nint main(void){int*p=0;*p=1;return 0;}', cases: [{ expect: 'x' }] })
  check('C 段错误：是「崩溃」而不是「未做判定」', r.usageError === undefined && r.pass === false, JSON.stringify(r).slice(0, 160))
  check('  段错误退出码非 0', r.results?.[0]?.exitCode !== 0, JSON.stringify(r.results?.[0]))
}
{
  const readInt = '#include <stdio.h>\nint main(void){int n;scanf("%d",&n);printf("%d\\n",n*2);return 0;}'
  const r = await run({ language: 'c', code: readInt, cases: [{ input: '3\n', expect: '6\n' }, { input: '21\n', expect: '42\n' }] })
  check('用例模式：scanf 读 stdin，2/2 通过', r.pass === true, JSON.stringify(r.results))
  const r2 = await run({ language: 'c', code: readInt, cases: [{ input: '3\n', expect: '999' }] })
  check('用例模式：答错 → 未通过', r2.pass === false)
}
{
  // 回归：行首空格必须参与判定（金字塔题）
  const good = '#include <stdio.h>\nint main(void){for(int i=1;i<=3;i++){for(int j=0;j<3-i;j++)putchar(\' \');for(int k=0;k<2*i-1;k++)putchar(\'*\');putchar(\'\\n\');}return 0;}'
  const bad = '#include <stdio.h>\nint main(void){for(int i=1;i<=3;i++){for(int j=0;j<2-i;j++)putchar(\' \');for(int k=0;k<2*i-1;k++)putchar(\'*\');putchar(\'\\n\');}return 0;}'
  const expect = '  *\n ***\n*****\n'
  const rGood = await run({ language: 'c', code: good, cases: [{ expect }] })
  const rBad = await run({ language: 'c', code: bad, cases: [{ expect }] })
  check('金字塔：正确的缩进 → 通过', rGood.pass === true, JSON.stringify(rGood).slice(0, 200))
  check('金字塔：缩进少一格 → 不通过', rBad.pass === false)
}
{
  const r = await run({ language: 'c', code: '#include <stdio.h>\nint main(void){printf("你好\\n");return 0;}' })
  check('C 中文输出不乱码', r.stdout.includes('你好'), JSON.stringify(r.stdout))
}
{
  const r = await run({ language: 'c', code: 'int main(void){for(;;);}', timeoutMs: 900 })
  check('C 死循环：超时被强制结束', r.timedOut === true)
}

console.log('\n⑧ 诚实性：没跑起来 ≠ 答错')
{
  const r = await run({ language: 'c', code: 'int main(void){return 0;}', cases: [{ expect: 'x' }] })
  check('（前置确认）正常 C 用例能跑', r.usageError === undefined)
  const bad = await run({ language: 'ruby', code: 'puts 1' })
  check('language 不支持 → usageError', bad.usageError === true)
  check('  明确「没有编译也没有运行」', String(bad.detail).includes('没有编译也没有运行'))
}
{
  const r = await run({ language: 'python', code: 'print(1)', path: 'C:/nope.py' })
  check('code 与 path 同给 → usageError', r.usageError === true && String(r.detail).includes('无法确定'))
}
{
  const r = await run({ language: 'python' })
  check('code 与 path 都没给 → usageError', r.usageError === true)
}
{
  const r = await run({ language: 'python', code: 'print(1)', cases: [] })
  check('空 cases → usageError（不是 0/0 全过）', r.usageError === true && r.pass === undefined)
  check('  理由含「没有做任何判定」', String(r.detail).includes('没有做任何判定'))
}
{
  const r = await run({ language: 'python', path: 'C:/definitely/not/here.py' })
  check('path 不存在 → usageError', r.usageError === true)
}
{
  const r = await toolNoC.execute({ language: 'c', code: 'int main(void){return 0;}' })
  check('C 工具链缺失 → usageError', r.usageError === true)
  check('  理由含「没有做任何判定」', String(r.detail).includes('没有做任何判定'))
  const r2 = await toolNoPy.execute({ language: 'python', code: 'print(1)' })
  check('Python 工具链缺失 → usageError', r2.usageError === true)
}

console.log('\n⑨ 渲染：模型看到的话不能有歧义')
{
  const v = await run({ language: 'c', code: 'int main(void){ return oops; }' })
  const text = render(v)
  check('编译失败渲染含「编译」与诊断', text.includes('编译：❌') && text.includes('oops'))
  check('  明说「代码没有被运行」', text.includes('没有被运行'))
}
{
  const v = await run({ language: 'python', code: 'print(1)', cases: [] })
  const text = render(v)
  check('usageError 渲染为「未做判定」', text.includes('未做判定'))
  check('  且**不出现**「未通过」', !text.includes('未通过'))
}
{
  const v = await run({ language: 'python', code: 'print(1)', cases: [{ name: '加法', expect: '2' }] })
  const text = render(v)
  check('用例失败渲染含用例名与对比', text.includes('加法') && text.includes('实际输出') && text.includes('期望输出'))
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
