// code-run — 编程判定层（DSH Cordis，宿主侧，纯 ESM，只用 node 内置模块）
//
// 定位：让「这段 C / Python 代码到底对不对」由**真实的编译与运行**决定，而不是模型印象。
// 这是 study-judge 的姊妹件，分工明确、不重叠：
//   - study-judge：客观题（choice/cloze/numeric/flag）与 **JavaScript** 沙箱判题。
//   - code-run  ：本机**真实工具链**上的 C 与 Python —— 编译报错、运行输出、用例比对全归代码。
//
// 工具 code_run({language, code|path, stdin?, cases?})：
//   - 无 cases：编译（C）并运行一次，回报 exit code / stdout / stderr —— 用于「跑给学员看」。
//   - 有 cases：[{input, expect}] 逐条以 input 作 stdin 跑一遍，比对 stdout —— 判定归代码。
//
// 诚实性约定（与 study-judge 一致，这是本插件最重要的部分）：
//   1) 工具链缺失、参数非法、cases 为空数组 —— 一律 `usageError`，明确写出「本次没有做任何判定」。
//      绝不让「根本没跑起来」混进「答错/未通过」——那是两件完全不同的事。
//   2) 编译失败（phase=compile）与用例不通过（phase=cases）分开表达，不混为一谈。
//   3) 输出超长一律截断并**标注**，不假装完整。
//
// 为什么 cases 走 stdin/stdout 而不是函数调用：这是 C 与 Python 唯一共通的、不依赖某种语言
// 约定的判题契约，也是学员本来就会写的形态（`int main` 读输入、打印结果）。
//
// 只消费宿主服务（tools），不发布服务，无需 isolate realm。

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

export const name = 'code-run'

/**
 * 声明依赖 `tools` 服务。
 *
 * ★ 少了这一行会有一个**静默**的故障形态：apply 在服务就位前跑，`ctx.get('tools')` 是
 * `undefined`，于是下面的 `if (tools === undefined) return` 直接返回——工具**根本没注册**，
 * 而外面看起来"插件挂上了、没报错、就是没有 code_run 这个工具"。宿主平面的 file-guard
 * 就是这样空转了一整天（LRN-20260916-012 / 失效模式 F3）。
 *
 * 预设平面里 apply 跑在 agent 组装时（远晚于宿主服务），所以本来是通的；但"通的"是**顺序**
 * 给的，不是插件自己保证的。声明 inject 之后，挂在哪一层都由运行时负责等待——2026-09-20
 * 往 headless profile 根组合里插一行做端到端探针时，正是这一行让它真的挂上了。
 */
export const inject = ['tools']

// ── 常量 ────────────────────────────────────────────────────────────────────
// 学员代码里最常见的 bug 就是死循环，超时是必须的而不是可选的。
const DEFAULT_RUN_TIMEOUT_MS = 10_000
const MAX_RUN_TIMEOUT_MS = 30_000
const COMPILE_TIMEOUT_MS = 30_000
const MAX_CASES = 20
// 一个 while(1) putchar 能在一秒内吐出几百 MB。不设上限就是等着把宿主内存打满。
const MAX_OUTPUT_BYTES = 64 * 1024
const COMPILE_HEAD = 6 * 1024
const COMPILE_TAIL = 2 * 1024

// ── Windows Smart App Control（智能应用控制）─────────────────────────────────
// 这台机器上 SAC 处于强制模式：按云端信誉拦截**刚生成的**可执行文件与共享库，
// 而 gcc.exe / python.exe 这类广泛分发的二进制有信誉、能跑。实测（见设计文档）：
//   · 直接跑刚编译出的 .exe：首次约 4/12 放行
//   · 换成共享库 + python 宿主加载：首次约 6/10~7/8 放行
//   · 对被拦的文件**隔几百毫秒重试**：8/8 放行——SAC 对一部分文件是「暂时」拒绝。
// 所以 C 走「编译成 DLL，由 python.exe 加载执行」，并对拦截做延迟重试。
// 关键纪律：重试仍失败时**必须报「未做判定」**，绝不能让它变成「答错」。
//
// 2026-09-18 补：**固定间隔是错的**。从真实会话日志里挖到，模型连试三次全被拦之后
// 改用 shell 绕过去了（它自己写"code_run 工具还是连着几次返回异常"）。原因是 400ms 太短——
// 基本等于在**同一个信誉判定窗口**里连试。改成递增退避后总等待约 4.6 秒，仍远短于一次讲评。
const POLICY_BLOCK_RE = /WinError\s*4551|应用程序控制策略已阻止|Application Control policy has blocked/i
const POLICY_RETRY_ATTEMPTS = 4
/** 第 i 次失败之后等多久（毫秒）。**必须递增**，见上面那段。 */
const POLICY_RETRY_DELAYS_MS = [400, 1200, 3000]

/**
 * 第 `attempt` 次失败之后应该等多久（纯函数，便于断言）。
 * 次数超出列表时沿用最后一档——不会因为多试一次就退化成"不等待"。
 */
export function policyDelayFor(attempt) {
  const i = Math.max(0, Math.min(attempt - 1, POLICY_RETRY_DELAYS_MS.length - 1))
  return POLICY_RETRY_DELAYS_MS[i]
}

/**
 * C 程序的执行宿主。学员代码照原样编译成共享库，其 `main` 经
 * `-Dmain=dsh_student_main` 改名后由这里的 `dsh_run` 调用。
 *
 * 为什么必须 `fflush(NULL)`：mingw 的 DLL 自带一套静态 CRT 与自己的 stdio 缓冲，
 * python 宿主退出时并不保证替我们 flush —— 少了这一句，学员的输出会整个丢掉。
 */
const C_WRAPPER_SOURCE = `#include <stdio.h>

extern int dsh_student_main(int argc, char **argv);

__declspec(dllexport) int dsh_run(int argc, char **argv) {
  int rc = dsh_student_main(argc, argv);
  fflush(NULL);
  return rc;
}
`

/** 加载共享库并调用 dsh_run 的 python 宿主。stdin/stdout/退出码语义与直接运行程序一致。 */
const PY_HOST_SOURCE = `import ctypes
import os
import sys

dll = sys.argv[1]
args = sys.argv[2:]

if not os.path.exists(dll):
    print('DLL not found: %s' % dll, file=sys.stderr)
    sys.exit(127)

lib = ctypes.CDLL(dll)
lib.dsh_run.restype = ctypes.c_int
lib.dsh_run.argtypes = [ctypes.c_int, ctypes.POINTER(ctypes.c_char_p)]

buf = (ctypes.c_char_p * (len(args) + 1))()
for i, a in enumerate(args):
    buf[i] = a.encode('utf-8')
buf[len(args)] = None

rc = lib.dsh_run(len(args), buf)
sys.stdout.flush()
sys.stderr.flush()
sys.exit(rc & 0xFF)
`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 这段 stderr 是不是「系统应用程序控制策略拦了文件」而不是程序自己的错误？ */
export function isPolicyBlocked(stderr) {
  return POLICY_BLOCK_RE.test(String(stderr ?? ''))
}

// ── 纯函数（导出以便 node 单测） ─────────────────────────────────────────────

/**
 * 判题用的输出归一化：CRLF→LF、去掉每行行尾空白、去掉整体末尾空行。
 * 只做这三件事，而且**绝不能碰行首空白**——「星号金字塔」这类题的对错全在行首空格数上，
 * 一旦把行首空白也归一掉，缩进少两格的错误答案会被判成通过。
 * （同理不做大小写折叠、不做内部空白折叠：那是把「格式错误」也判成通过。）
 */
export function normalizeOutput(s) {
  return String(s ?? '')
    .replaceAll('\r\n', '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\s+$/, '')
}

/** 单条用例比对：只比归一化后的 stdout（退出码与 stderr 作为诊断信息回报，判定时另算）。 */
export function compareCase(got, expect) {
  return normalizeOutput(got) === normalizeOutput(expect)
}

/** 超过 max 时保留头部；超出部分用省略号标注并给出原始长度。 */
export function truncateHead(s, max) {
  const t = String(s ?? '')
  if (t.length <= max) return t
  return `${t.slice(0, max)}\n…（已截断，原文共 ${t.length} 字符）`
}

/**
 * 编译输出（gcc 诊断）保留头尾：错误信息可能很多，而**最后一条**往往是真正的原因
 * （比如先报一堆语法错、最后才是 "ld returned 1"）。程序 stdout 不能这么切——顺序即语义。
 */
export function headTail(s, head, tail) {
  const t = String(s ?? '')
  if (t.length <= head + tail) return t
  return `${t.slice(0, head)}\n…（中间省略 ${t.length - head - tail} 字符）…\n${t.slice(-tail)}`
}

/**
 * 是「普通文件」吗。目录也叫 gcc.exe 时 existsSync 会撒谎，所以这里必须 stat。
 * 它同时是下面两个搜索函数的默认探测谓词——探测谓词可注入，单测才能不依赖真实磁盘。
 * （早先的写法把注入谓词和一次无条件 statSync 串起来，注入就完全失效了。）
 */
export function isRegularFile(p) {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

/** 在给定 PATH 字符串里按顺序找可执行文件，返回绝对路径或 undefined。 */
export function searchPath(names, pathValue, isFile = isRegularFile) {
  const dirs = String(pathValue ?? '').split(delimiter).filter((d) => d.length > 0)
  for (const name of names) {
    for (const dir of dirs) {
      const p = join(dir, name)
      if (isFile(p)) return p
    }
  }
  return undefined
}

/**
 * 在 `<root>/toolchains/*` 下找最新的便携工具链（每个子目录找 bin/gcc.exe）。
 * 按目录名倒序取第一个命中的——w64devkit 升级只是换目录名（2.9.1 → 2.10.0），
 * 写死版本号的路径会在下次升级时静默失效。
 */
export function findPortableGcc(toolchainsRoot, readDir = readdirSync, isFile = isRegularFile) {
  let entries
  try {
    entries = readDir(toolchainsRoot, { withFileTypes: true })
  } catch {
    return undefined
  }
  const dirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort((a, b) => b.localeCompare(a, 'en', { numeric: true }))
  for (const d of dirs) {
    const p = join(toolchainsRoot, d, 'bin', 'gcc.exe')
    if (isFile(p)) return p
    // w64devkit 的发布物是自解压 7z：按它自己的方式解会多套一层同名目录
    //（toolchains/w64devkit/w64devkit/bin/gcc.exe）。多探一层，免得"装了却找不到"。
    const nested = join(toolchainsRoot, d, d, 'bin', 'gcc.exe')
    if (isFile(nested)) return nested
  }
  return undefined
}

/**
 * C 有编译阶段、Python 没有，所以 `compileOk` 只对 C 有意义。
 *
 * ★★ 这里必须**整个键都不出现**，绝不能写成 `compileOk: o.language === 'c' ? true : undefined`。
 * 宿主拿到工具返回值后会做一次 lossless JSON 快照（`snapshotJsonValue`），而
 * `undefined` —— **哪怕只是某个属性的值** —— 会让 snapshot 返回 undefined，于是
 * **整条回执**被丢弃并抛 `ToolOutputError: "value is not lossless JSON"`。
 * 模型看到的是一句与代码毫无关系的工具错误，只能重试或改用 shell。
 *
 * 2026-09-18 ~ 09-20 报告里的「code_run 的 Python 通道不能用」就是这个，跟 Smart App Control
 * 无关（C 通道一直正常，因为 C 那条路的值是 `true`）。重试永远不可能修好它。
 * 断言在 `test/verify-tool-output.mjs`（用宿主的真 `isJsonValue` 逐个工具过一遍）。
 */
export function compileOkField(language) {
  return language === 'c' ? { compileOk: true } : {}
}

/**
 * 解析学员给的 cases 参数：接受真数组或 JSON 字符串，逐条校验。
 */
export function parseCases(raw) {
  if (raw === undefined || raw === null) return { ok: true, cases: undefined }
  let list = raw
  if (typeof list === 'string') {
    try {
      list = JSON.parse(list)
    } catch {
      return { ok: false, reason: 'cases 既不是数组、也不是合法 JSON' }
    }
  }
  if (!Array.isArray(list)) return { ok: false, reason: 'cases 必须是数组' }
  if (list.length === 0) {
    return {
      ok: false,
      reason:
        'cases 是空数组：没有任何可比对的用例，本次**没有做任何判定**。' +
        '要么给出至少一条 {expect} 用例，要么整条去掉 cases —— 这里不接受「0 条用例全部通过」这种空判定',
    }
  }
  if (list.length > MAX_CASES) return { ok: false, reason: `cases 最多 ${MAX_CASES} 条（当前 ${list.length} 条）` }
  const cases = []
  for (let i = 0; i < list.length; i += 1) {
    const c = list[i]
    if (c === null || typeof c !== 'object' || Array.isArray(c)) {
      return { ok: false, reason: `第 ${i + 1} 条用例不是对象（需要 {input?, expect}）` }
    }
    if (c.expect === undefined || c.expect === null) {
      return { ok: false, reason: `第 ${i + 1} 条用例缺少 expect：没有期望输出就无法判定` }
    }
    cases.push({
      name: typeof c.name === 'string' && c.name.length > 0 ? c.name : `用例 ${i + 1}`,
      input: c.input === undefined || c.input === null ? '' : String(c.input),
      expect: String(c.expect),
    })
  }
  return { ok: true, cases }
}

// ── 进程执行 ───────────────────────────────────────────────────────────────

/**
 * 跑一个子进程并收全输出。**不用 spawnSync**：那会阻塞整个 DSH 事件循环，
 * 学员一个死循环就能让所有人的会话一起卡住。
 *
 * 关键细节：按 Buffer 收集再一次性解码，不按 chunk 做 toString——
 * 一个 UTF-8 汉字被切在两个 chunk 之间就变成乱码（中文输出必踩）。
 */
function runProcess(cmd, args, { cwd, input, timeoutMs, env }) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd, args, { cwd, env, windowsHide: true })
    } catch (error) {
      resolve({ spawnError: String(error?.message ?? error) })
      return
    }
    const outChunks = []
    const errChunks = []
    let outBytes = 0
    let errBytes = 0
    let settled = false
    let timedOut = false

    const collect = (chunks, buf, which) => {
      const counter = which === 'out' ? outBytes : errBytes
      if (counter >= MAX_OUTPUT_BYTES) return
      chunks.push(buf)
      if (which === 'out') outBytes += buf.length
      else errBytes += buf.length
    }

    child.stdout.on('data', (d) => collect(outChunks, d, 'out'))
    child.stderr.on('data', (d) => collect(errChunks, d, 'err'))
    // 程序早早退出时 stdin 会 EPIPE；那是正常现象，不是错误。
    child.stdin.on('error', () => {})

    const finish = (payload) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        ...payload,
        timedOut,
        stdout: Buffer.concat(outChunks).toString('utf8'),
        stderr: Buffer.concat(errChunks).toString('utf8'),
      })
    }

    const timer = setTimeout(() => {
      timedOut = true
      try {
        child.kill('SIGKILL')
      } catch { /* 已经退出 */ }
    }, timeoutMs)

    child.on('error', (error) => finish({ spawnError: String(error?.message ?? error) }))
    child.on('close', (code) => finish({ code }))

    try {
      child.stdin.end(input === undefined ? '' : input)
    } catch { /* 管道已关 */ }
  })
}

// ── 工具链发现 ─────────────────────────────────────────────────────────────

/** DSH 家目录：优先 DSH_HOME，否则 ~/.dsh —— 便携工具链放在它下面。 */
function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  return join(homedir(), '.dsh')
}

/**
 * 找 C 编译器。顺序即优先级：
 *   1) 预设显式配置的路径（存在就用，不存在**不静默回退**——那是配置写错了，得让人看见）
 *   2) ~/.dsh/toolchains/<版本目录>/bin/gcc.exe（本机便携工具链，见设计文档）
 *   3) PATH 上的 gcc / clang
 */
export function resolveGcc(config) {
  if (typeof config?.cCompiler === 'string' && config.cCompiler.length > 0) {
    if (isRegularFile(config.cCompiler)) return { path: config.cCompiler, source: '预设配置' }
    return { missing: `预设配置的 cCompiler 路径不存在：${config.cCompiler}` }
  }
  const portable = findPortableGcc(join(dshHome(), 'toolchains'))
  if (portable !== undefined) return { path: portable, source: '便携工具链' }
  const onPath = searchPath(['gcc.exe', 'gcc', 'clang.exe', 'clang'], process.env.PATH)
  if (onPath !== undefined) return { path: onPath, source: 'PATH' }
  return {
    missing:
      '本机没有 gcc / clang（也未在 ' + join(dshHome(), 'toolchains') + ' 下发现便携工具链）',
  }
}

/** 找 Python 解释器。 */
export function resolvePython(config) {
  if (typeof config?.python === 'string' && config.python.length > 0) {
    if (isRegularFile(config.python)) return { path: config.python, source: '预设配置' }
    return { missing: `预设配置的 python 路径不存在：${config.python}` }
  }
  const onPath = searchPath(['python.exe', 'python', 'python3.exe', 'python3', 'py.exe'], process.env.PATH)
  if (onPath !== undefined) return { path: onPath, source: 'PATH' }
  return { missing: '本机 PATH 上没有 python / python3' }
}

// ── 插件本体 ────────────────────────────────────────────────────────────────

/** 统一的失败返回：一切「没跑起来」都走这里，带上 usageError 以免被读成「答错」。 */
function usageFailure(language, detail) {
  return { ok: false, language, usageError: true, detail }
}

export function apply(ctx, config) {
  const tools = ctx.get('tools')
  if (tools === undefined) return

  const cFlags = Array.isArray(config?.cFlags) && config.cFlags.length > 0 ? config.cFlags : ['-std=c11', '-O0', '-Wall']
  const defaultTimeout =
    Number.isSafeInteger(config?.defaultTimeoutMs) && config.defaultTimeoutMs > 0
      ? Math.min(config.defaultTimeoutMs, MAX_RUN_TIMEOUT_MS)
      : DEFAULT_RUN_TIMEOUT_MS

  tools.register({
    name: 'code_run',
    description:
      '在本机真实工具链上编译/运行 C 或 Python 代码，并把判定交给真实结果——学员的代码、你出的编程题都走这里，不要靠读代码猜对不对。' +
      'language: "c" | "python"。代码来源二选一：code（内联源码）或 path（磁盘文件绝对路径，优先用它读学员的文件，避免你转述时改动原文）。' +
      '不传 cases：编译并运行一次，回报 exitCode / stdout / stderr（用于"跑给学员看"）。' +
      '传 cases（[{input?, expect}]）：逐条以 input 作 stdin 运行，比对 stdout，全过才算通过（用于判题）。' +
      '注意：本工具只认 C/Python；study_judge 的 kind=code 只能跑 JavaScript，别拿它判 C/Python。' +
      '编译失败、工具链缺失、用例为空都会明确标为"未做判定"，与"答错"是两回事。',
    parameters: {
      type: 'object',
      properties: {
        language: { type: 'string', description: '"c" 或 "python"' },
        code: { type: 'string', description: '内联源码。与 path 二选一' },
        path: { type: 'string', description: '源码文件绝对路径。与 code 二选一；读学员文件时用这个' },
        stdin: { type: 'string', description: '单次运行模式下的标准输入' },
        cases: {
          type: 'array',
          description: '判题用例；给了就进判题模式，逐条运行比对 stdout',
          items: {
            type: 'object',
            properties: {
              input: { type: 'string', description: '该用例的 stdin' },
              expect: { type: 'string', description: '期望的 stdout' },
              name: { type: 'string', description: '用例名，便于讲评时指认' },
            },
            required: ['expect'],
          },
        },
        timeoutMs: { type: 'number', description: `运行超时毫秒，默认 ${DEFAULT_RUN_TIMEOUT_MS}，上限 ${MAX_RUN_TIMEOUT_MS}` },
      },
      required: ['language'],
    },
    output: {
      schema: { type: 'object' },
      render(_args, v) {
        const lines = []
        if (v.usageError === true) {
          return [
            { type: 'text', text: `⚠️ 未做判定（用法/环境问题，**不是**答错）\n${v.detail}` },
          ]
        }
        if (v.toolchain !== undefined) lines.push(`工具链：${v.toolchain}`)
        if (v.runMode === 'dll-host') {
          lines.push('运行方式：编译为共享库后由 python 宿主调用（本机的应用控制策略会拦截新生成的 .exe；标准输入输出与返回值语义一致）')
        }
        if (v.retries > 0) lines.push(`（应用控制策略首次拦截，第 ${v.retries + 1} 次重试通过）`)
        if (v.compileOk === false) {
          lines.push('编译：❌ 失败')
          lines.push(v.compileOutput)
          lines.push('—— 这是编译错误，学员的代码**没有被运行**，判定到此为止；逐条讲评由你完成。')
          return [{ type: 'text', text: lines.join('\n') }]
        }
        if (v.compileOk === true) lines.push('编译：✅ 通过')
        if (v.compileWarnings === true) lines.push(`⚠️ 有编译警告（不影响运行，但值得讲）：\n${v.compileOutput}`)

        if (v.mode === 'cases') {
          lines.push(`判定：${v.pass ? '✅ 全部通过' : '❌ 未通过'}（${v.passed}/${v.total} 用例）`)
          for (const r of v.results) {
            if (r.pass) lines.push(`  ✅ ${r.name}`)
            else {
              lines.push(`  ❌ ${r.name}`)
              if (r.timedOut === true) lines.push('     超时：程序没有在时限内结束（多半是死循环）')
              else if (r.exitCode !== 0 && r.exitCode !== null) {
                lines.push(`     退出码：${r.exitCode}（程序非正常结束）`)
                if (r.outputMatched === true) {
                  lines.push('     注意：输出本身是对的，但程序退出码非 0，所以仍判未通过——崩溃/异常退出是要修的')
                }
              }
              lines.push(`     实际输出：${JSON.stringify(r.got)}`)
              lines.push(`     期望输出：${JSON.stringify(r.expect)}`)
              if (r.stderr.trim().length > 0) lines.push(`     错误输出：${r.stderr.trim()}`)
            }
          }
        } else {
          lines.push(`运行：退出码 ${v.exitCode === null ? '(被信号终止)' : v.exitCode}${v.timedOut ? '（超时被强制结束）' : ''}`)
          lines.push(`标准输出：\n${v.stdout.length > 0 ? v.stdout : '(空)'}`)
          if (v.stderr.length > 0) lines.push(`标准错误：\n${v.stderr}`)
        }
        lines.push('—— 判定归工具，讲评归你：指出具体到行的问题与改进方向，不给「不错」式空评。')
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const languageRaw = String(args?.language ?? '').trim().toLowerCase()
      const language = languageRaw === 'c' || languageRaw === 'c11' || languageRaw === 'c99' ? 'c' : languageRaw === 'py' || languageRaw === 'python' || languageRaw === 'python3' ? 'python' : undefined
      if (language === undefined) {
        return usageFailure(languageRaw, `language 只能是 "c" 或 "python"（收到 "${languageRaw}"），本次没有编译也没有运行任何代码`)
      }

      // 代码来源：二选一。两个都给一律拒绝——"到底跑的是哪份"必须唯一且无歧义，
      // 否则讲评会对着错的源码讲（学员文件 vs 你转述的版本）。
      const hasCode = typeof args?.code === 'string' && args.code.length > 0
      const hasPath = typeof args?.path === 'string' && args.path.length > 0
      if (hasCode && hasPath) {
        return usageFailure(language, 'code 与 path 同时给了：无法确定要跑哪一份。只给其中一个——读学员磁盘上的文件就用 path')
      }
      if (!hasCode && !hasPath) {
        return usageFailure(language, 'code 与 path 都没给：没有源码可跑，本次没有做任何判定')
      }
      let source
      let sourceLabel
      if (hasPath) {
        try {
          source = readFileSync(args.path, 'utf8')
          sourceLabel = args.path
        } catch (error) {
          return usageFailure(language, `读不到源码文件 ${args.path}：${String(error?.message ?? error)}`)
        }
      } else {
        source = args.code
        sourceLabel = '(内联源码)'
      }

      const parsedCases = parseCases(args?.cases)
      if (!parsedCases.ok) return usageFailure(language, `${parsedCases.reason}`)
      const cases = parsedCases.cases

      const requested = Number(args?.timeoutMs)
      const timeoutMs =
        Number.isFinite(requested) && requested > 0 ? Math.min(Math.floor(requested), MAX_RUN_TIMEOUT_MS) : defaultTimeout

      const tool = language === 'c' ? resolveGcc(config) : resolvePython(config)
      if (tool.missing !== undefined) {
        // 「没有做任何判定」这句话只在这里拼一次。曾经每个 missing 消息各自写一遍，
        // 结果「配置路径不存在」那条漏了，用法失败的三种情形就出现了不一致的措辞。
        return usageFailure(language, `${tool.missing}。因此**没有做任何判定**——不要据此判定学员答错`)
      }

      // 工具链描述只算一次：编译失败、单次运行、逐用例运行三条路径必须说同一句话。
      //（早先 runOnce 用 toolchainNote、runCases 用 o.toolchain.path，字段名还不一致，
      //  结果逐用例那条路直接读 undefined 崩掉——同一份事实不该有两个来源。）
      const toolchainLabel =
        language === 'c'
          ? `gcc (${tool.source}) ${tool.path} · ${cFlags.join(' ')}`
          : `python (${tool.source}) ${tool.path}`

      const env = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
      let dir
      try {
        dir = mkdtempSync(join(tmpdir(), 'dsh-code-run-'))

        if (language === 'c') {
          // C 的执行模型：**编译成共享库，由 python.exe 加载运行**（见文件头 SAC 说明）。
          // 直接跑 .exe 在开着 Smart App Control 的机器上首次只有 4/12 放行；共享库 + 宿主
          // 明显更稳，且 stdin / stdout / 返回值的语义与直接运行程序一致。
          const src = join(dir, 'main.c')
          const wrapper = join(dir, 'wrapper.c')
          const dll = join(dir, 'prog.dll')
          writeFileSync(src, source, 'utf8')
          writeFileSync(wrapper, C_WRAPPER_SOURCE, 'utf8')
          const compiled = await runProcess(
            tool.path,
            [...cFlags, '-shared', '-Dmain=dsh_student_main', '-o', dll, src, wrapper],
            { cwd: dir, timeoutMs: COMPILE_TIMEOUT_MS, env },
          )
          if (compiled.spawnError !== undefined) {
            return usageFailure(language, `调用编译器失败：${compiled.spawnError}`)
          }
          const rawDiagnostics = headTail(`${compiled.stdout}${compiled.stderr}`, COMPILE_HEAD, COMPILE_TAIL)
          const compileOk = compiled.code === 0 && existsSync(dll)
          if (!compileOk) {
            // 共享库不要求 main，所以「学员没写 main」会以链接错误的形式出现。
            // 这条错误对初学者完全看不懂，翻译成人话再给。
            const hint = /dsh_student_main/.test(rawDiagnostics)
              ? '\n提示：链接器找不到 `dsh_student_main` —— 学员的代码里没有 `main` 函数（或它不是外部链接的普通 `int main(void)`）。C 程序必须有 main 才能运行。'
              : ''
            return {
              ok: true,
              language,
              mode: cases === undefined ? 'run' : 'cases',
              toolchain: toolchainLabel,
              source: sourceLabel,
              phase: 'compile',
              compileOk: false,
              compileOutput:
                (rawDiagnostics.length > 0
                  ? rawDiagnostics
                  : compiled.timedOut
                    ? '编译器在 30 秒内没有结束（异常情况）'
                    : '(编译器没有输出诊断信息)') + hint,
            }
          }
          const host = join(dir, 'host.py')
          writeFileSync(host, PY_HOST_SOURCE, 'utf8')
          const hostTool = resolvePython(config)
          if (hostTool.missing !== undefined) {
            return usageFailure(language, `C 已编译成功，但本机没有 python 可作执行宿主：${hostTool.missing}`)
          }
          const hostArgs = ['-X', 'utf8', '-B', host, dll]
          const runOpts = {
            dir,
            sourceLabel,
            toolchain: toolchainLabel,
            language,
            // 编译已经成功，此时 stderr 里只可能是警告，不是错误。
            compileOutput: compiled.stderr,
            compileWarnings: compiled.stderr !== '',
            runMode: 'dll-host',
            timeoutMs,
            env,
          }
          return cases === undefined
            ? await runOnce(hostTool.path, hostArgs, { ...runOpts, stdin: args?.stdin })
            : await runCases(hostTool.path, hostArgs, { ...runOpts, cases })
        }

        // Python：不需要编译阶段，但语法错误会在运行时以非零退出暴露，同样归入判定。
        const src = join(dir, 'main.py')
        writeFileSync(src, source, 'utf8')
        const pyArgs = ['-X', 'utf8', '-B', src]
        const pyOpts = {
          dir,
          sourceLabel,
          toolchain: toolchainLabel,
          language,
          compileOutput: '',
          compileWarnings: false,
          runMode: 'interpreter',
          timeoutMs,
          env,
        }
        return cases === undefined
          ? await runOnce(tool.path, pyArgs, { ...pyOpts, stdin: args?.stdin })
          : await runCases(tool.path, pyArgs, { ...pyOpts, cases })
      } finally {
        if (dir !== undefined) {
          try {
            rmSync(dir, { recursive: true, force: true })
          } catch { /* 清理失败不影响结果 */ }
        }
      }
    },
  })

  /**
   * 跑一次程序，并对「系统应用程序控制策略拦截」做**递增退避**重试。
   *
   * Smart App Control 对一部分**新生成**的二进制是「暂时」拒绝：同一文件隔一会儿再加载
   * 就通过了。本机实测首次约 60%~85% 放行，重试后 8/8。所以这里不是"多试一次图个安心"，
   * 而是这条执行路径能不能用的关键。**间隔必须递增**——固定 400ms 连试等于在同一个判定
   * 窗口里空转（2026-09-18 真实会话就是这么连挂三次的）。
   *
   * 返回值里的 `blocked` 必须被上游当真：它是「没跑起来」，不是「跑错了」。
   */
  async function runGuarded(cmd, args, o, input) {
    for (let attempt = 1; attempt <= POLICY_RETRY_ATTEMPTS; attempt += 1) {
      const r = await runProcess(cmd, args, { cwd: o.dir, input, timeoutMs: o.timeoutMs, env: o.env })
      if (r.spawnError !== undefined) {
        return { blocked: true, spawnError: r.spawnError, attempts: attempt }
      }
      if (isPolicyBlocked(r.stderr)) {
        if (attempt < POLICY_RETRY_ATTEMPTS) {
          await sleep(policyDelayFor(attempt))
          continue
        }
        return { ...r, blocked: true, attempts: attempt }
      }
      return { ...r, blocked: false, attempts: attempt }
    }
    /* istanbul ignore next：循环必然在上面 return */
    return { blocked: true, attempts: POLICY_RETRY_ATTEMPTS }
  }

  /** 被策略拦截时的统一话术：说清「没跑起来」、原因、以及改哪里。 */
  function blockedFailure(language, attempts) {
    return usageFailure(
      language,
      `系统应用程序控制策略（Smart App Control）拦截了这次运行：本机对**新生成**的可执行文件/共享库按云端信誉放行，` +
        `重试 ${attempts} 次仍未通过。**本次没有做任何判定**——不要据此判定学员答错。\n` +
        `可选处置：① 稍等片刻让本插件重试即可（多数文件重试 1 次就通过）；` +
        `② 若要彻底不再出现，在「Windows 安全中心 → 应用和浏览器控制 → 智能应用控制」中关闭 Smart App Control` +
        `（注意：微软说明关闭后需重装/重置 Windows 才能重新开启，属于一次性决定，请自行权衡）。`,
    )
  }

  /** 单次运行：只回报事实，不做任何判定。 */
  async function runOnce(cmd, baseArgs, o) {
    const r = await runGuarded(cmd, baseArgs, o, o.stdin)
    if (r.blocked === true) return blockedFailure(o.language, r.attempts)
    return {
      ok: true,
      language: o.language,
      mode: 'run',
      toolchain: o.toolchain,
      source: o.sourceLabel,
      runMode: o.runMode,
      retries: r.attempts - 1,
      phase: 'run',
      ...compileOkField(o.language),
      compileWarnings: o.compileWarnings === true,
      compileOutput: o.compileOutput ?? '',
      exitCode: r.code ?? null,
      timedOut: r.timedOut,
      stdout: truncateHead(r.stdout, MAX_OUTPUT_BYTES),
      stderr: truncateHead(r.stderr, MAX_OUTPUT_BYTES),
    }
  }

  /** 逐用例运行并比对：这里才是「判定」。 */
  async function runCases(cmd, baseArgs, o) {
    const results = []
    for (const c of o.cases) {
      const r = await runGuarded(cmd, baseArgs, o, c.input)
      // 一条用例没跑起来，整批判定就不成立：宁可交白卷，也不给"部分通过"这种假确定。
      if (r.blocked === true) return blockedFailure(o.language, r.attempts)
      results.push({
        name: c.name,
        // 退出码参与判定：安全地打印完正确输出、然后崩掉，仍然是错。
        // 只比 stdout 会放过「段错误但恰好答对」这类最该被指出的问题。
        pass: r.timedOut ? false : r.code === 0 && compareCase(r.stdout, c.expect),
        got: truncateHead(r.stdout, 2048),
        expect: truncateHead(c.expect, 2048),
        stderr: truncateHead(r.stderr, 1024),
        exitCode: r.code ?? null,
        timedOut: r.timedOut,
        outputMatched: r.timedOut ? false : compareCase(r.stdout, c.expect),
      })
    }
    const passed = results.filter((r) => r.pass === true).length
    return {
      ok: true,
      language: o.language,
      mode: 'cases',
      toolchain: o.toolchain,
      source: o.sourceLabel,
      runMode: o.runMode,
      phase: 'cases',
      ...compileOkField(o.language),
      compileWarnings: o.compileWarnings === true,
      compileOutput: o.compileOutput ?? '',
      pass: passed === results.length,
      passed,
      total: results.length,
      results,
    }
  }
}
