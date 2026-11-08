// study-judge — 通用判题器（DSH Cordis，宿主侧，纯 ESM，无外部依赖）
//
// 定位：模型出题时同步交出「判定逻辑」，判分从模型感觉变成代码判定。
// 判定归代码，讲评归模型。
//
// 工具 study_judge({kind, answer, key})，key 一律为字符串（结构化内容内含 JSON）：
// - choice/cloze：key = '标准答案' 或 '["等价1","等价2"]' 或 '/正则/'
// - numeric：    key = '0.333'、'1/3'（可求值表达式）或 '{"value":0.333,"tolerance":0.001}'
// - code：       key = '{"cases":[{"input":...,"expect":...}]}'，answer 须定义 solve(input)，
//                经宿主 codeRuntime（worker 线程沙箱）真实运行比对
// - flag：       key = 'flag 串'，定长安全比较
//
// 只消费宿主服务（tools / codeRuntime 可选获取），不发布服务，无需 isolate realm。

export const name = 'study-judge'

import { timingSafeEqual } from 'node:crypto'

// ── 纯判定逻辑（导出以便 node 单测） ─────────────────────────────────────────

/** 归一化文本答案：去首尾空白、小写、压连续空白、去句末标点。 */
export function normalizeText(s) {
  return String(s).trim().toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[。．.，,；;：:！!？?、\s]+$/u, '')
}

/** 客观题判定。key:  plain | '["a","b"]' | '/regex/' 。 */
export function judgeText(answer, key) {
  const a = normalizeText(answer)
  const k = String(key).trim()
  if (k.startsWith('/') && k.lastIndexOf('/') > 0) {
    const last = k.lastIndexOf('/')
    try {
      const re = new RegExp(k.slice(1, last), k.slice(last + 1))
      return { pass: re.test(String(answer).trim()), actual: String(answer).trim(), expected: k }
    } catch {
      return { pass: false, actual: String(answer), expected: k, detail: '无效正则 key' }
    }
  }
  if (k.startsWith('[')) {
    try {
      const list = JSON.parse(k)
      if (Array.isArray(list)) {
        const hit = list.some((item) => normalizeText(item) === a)
        return { pass: hit, actual: a, expected: list.join(' | ') }
      }
    } catch { /* fall through：按普通答案串处理 */ }
  }
  return { pass: a === normalizeText(k), actual: a, expected: k }
}

/** 可求值表达式白名单：数字、运算符、括号、小数点、空白、逗号、百分号。 */
const EXPR_SAFE = /^[0-9+\-*/%().,\s]+$/

function evalNumeric(text) {
  const t = String(text).trim().replace(/,/g, '')
  if (t === '') return undefined
  if (!EXPR_SAFE.test(t)) {
    const n = Number(t)
    return Number.isFinite(n) ? n : undefined
  }
  try {
    const v = new Function(`"use strict"; return (${t});`)()
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined
  } catch {
    return undefined
  }
}

/** 数值题判定。key: '0.5' | '1/2' | '{"value":0.5,"tolerance":0.01}' 。 */
export function judgeNumeric(answer, key) {
  let expectedRaw = String(key).trim()
  let tolerance
  if (expectedRaw.startsWith('{')) {
    try {
      const spec = JSON.parse(expectedRaw)
      expectedRaw = String(spec.value)
      if (typeof spec.tolerance === 'number') tolerance = Math.abs(spec.tolerance)
    } catch {
      return { pass: false, actual: String(answer), expected: String(key), detail: '无效 JSON key' }
    }
  }
  const expected = evalNumeric(expectedRaw)
  const actual = evalNumeric(answer)
  if (expected === undefined) return { pass: false, actual: String(answer), expected: expectedRaw, detail: 'key 无法解析为数值' }
  if (actual === undefined) return { pass: false, actual: String(answer), expected: expectedRaw, detail: '答案无法解析为数值' }
  // 默认容差：期望值的千分之一（容忍三位小数舍入）；需严格判定由出题方显式给 tolerance
  const tol = tolerance ?? Math.max(1e-6, Math.abs(expected) * 1e-3)
  return { pass: Math.abs(actual - expected) <= tol, actual: String(answer), expected: expectedRaw, tolerance: tol }
}

/** flag 判定：去首尾空白后等长定时常数比较。 */
export function judgeFlag(answer, key, timingSafeEqualFn) {
  const a = String(answer).trim()
  const k = String(key).trim()
  if (a.length === k.length && timingSafeEqualFn) {
    return { pass: timingSafeEqualFn(Buffer.from(a), Buffer.from(k)), actual: a, expected: '<hidden>' }
  }
  return { pass: a === k, actual: a, expected: '<hidden>' }
}

/** 从运行日志中提取 JUDGE 结果行。 */
export function parseJudgeLogs(logs) {
  for (let i = logs.length - 1; i >= 0; i -= 1) {
    const line = logs[i]
    const idx = typeof line === 'string' ? line.indexOf('JUDGE:') : -1
    if (idx >= 0) {
      try {
        return JSON.parse(line.slice(idx + 6))
      } catch {
        return undefined
      }
    }
  }
  return undefined
}

/** 拼装沙箱运行程序：学员代码 + 判定 runner。 */
export function buildCodeProgram(answer, cases) {
  return `${answer}
;(() => {
  const __cases = ${JSON.stringify(cases)}
  const __results = []
  for (const __c of __cases) {
    try {
      const __got = solve(__c.input)
      __results.push({ got: __got === undefined ? null : __got, expect: __c.expect === undefined ? null : __c.expect, pass: JSON.stringify(__got) === JSON.stringify(__c.expect) })
    } catch (__e) {
      __results.push({ error: String(__e && __e.message || __e), pass: false })
    }
  }
  console.log('JUDGE:' + JSON.stringify(__results))
})()
`
}

// ── 插件本体 ────────────────────────────────────────────────────────────────

export function apply(ctx) {
  const tools = ctx.get('tools')
  if (tools === undefined) return

  tools.register({
    name: 'study_judge',
    description:
      '用代码判定学员作答，出题判分时调用，不要凭感觉判分。' +
      'kind=choice/cloze：key 为标准答案、\'["等价1","等价2"]\' 或 \'/正则/\'；' +
      'kind=numeric：key 为数值、可求值表达式（如 1/3）或 \'{"value":0.5,"tolerance":0.01}\'（默认容差为期望值的千分之一，需严格判定时显式给 tolerance）；' +
      'kind=code：key 为 \'{"cases":[{"input":...,"expect":...}]}\'，answer 代码必须定义 solve(input) 函数，将在沙箱中真实运行比对；' +
      'kind=flag：key 为 flag 串。返回 pass 与失败细节；讲评由你完成，本工具只给判定。',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string' },
        answer: { type: 'string' },
        key: { type: 'string' },
      },
      required: ['kind', 'answer', 'key'],
    },
    output: {
      schema: { type: 'object' },
      render(_args, value) {
        const v = value
        if (v.usageError === true) {
          return [{ type: 'text', text: `⚠️ 无法判定（用法错误，不是答错）\n作答：${v.actual}\n说明：${v.detail}` }]
        }
        const lines = [
          `判定：${v.pass ? '✅ 通过' : '❌ 未通过'}（${v.kind}）`,
          `作答：${v.actual}`,
          `期望：${v.expected}`,
        ]
        if (v.failingCase !== undefined) lines.push(`失败用例：${v.failingCase}`)
        if (v.detail !== undefined) lines.push(`说明：${v.detail}`)
        if (v.selfKeyed === true) lines.push('⚠️ 未独立校验：key 与作答完全相同，本次判定等价于字符串自比（标准答案并非来自独立答案源，判定权仍在模型手里）')
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const kind = String(args?.kind ?? '')
      const answer = String(args?.answer ?? '')
      const key = String(args?.key ?? '')

      if (kind === 'choice' || kind === 'cloze') return { kind, ...judgeText(answer, key) }
      if (kind === 'numeric') return { kind, ...judgeNumeric(answer, key) }
      if (kind === 'flag') {
        // key 为空时不可能判定：绝不能悄悄返回「未通过」——那是用法错误，不是答错
        if (String(key).trim() === '') {
          return { kind, pass: false, actual: String(answer).trim(), expected: '(空 key)', usageError: true, detail: 'key 为空：flag 题必须给出标准 flag 串，本次没有做任何判定' }
        }
        const result = judgeFlag(answer, key, timingSafeEqual)
        // 自证检测：key 与作答完全相同 → 本次"判定"等价于字符串自比，判定权仍在模型手里。
        // 只在 flag 上标记（choice 答对时答案本来就等于 key，标了纯属噪音）。
        const selfKeyed = String(answer).trim() === String(key).trim()
        return { kind, ...result, ...(selfKeyed ? { selfKeyed: true } : {}) }
      }

      if (kind === 'code') {
        const runtime = ctx.get('codeRuntime')
        if (runtime === undefined) {
          return { kind, pass: false, actual: '(未运行)', expected: key, detail: 'codeRuntime 服务不可用：本部署未装代码沙箱，改为人工审阅代码' }
        }
        let cases
        try {
          const parsed = JSON.parse(key)
          cases = parsed.cases
          if (!Array.isArray(cases) || cases.length === 0) throw new Error('empty')
        } catch {
          return { kind, pass: false, actual: '(未运行)', expected: key, detail: 'key 必须是 {"cases":[...]} 且 cases 非空' }
        }
        let result
        try {
          result = await runtime.run({ program: buildCodeProgram(answer, cases), bindings: [] })
        } catch (error) {
          return { kind, pass: false, actual: '(运行失败)', expected: key, detail: `沙箱调用失败：${String(error && error.message || error)}` }
        }
        if (result.error !== undefined) {
          return { kind, pass: false, actual: '(运行失败)', expected: key, detail: `${result.error.kind}: ${result.error.message}` }
        }
        const results = parseJudgeLogs(result.logs)
        if (results === undefined) {
          return { kind, pass: false, actual: '(无判定输出)', expected: key, detail: '程序未输出 JUDGE 行：确认 answer 定义了 solve(input)' }
        }
        const failed = results.find((r) => r.pass !== true)
        return {
          kind,
          pass: failed === undefined,
          actual: `${results.filter((r) => r.pass === true).length}/${results.length} 用例通过`,
          expected: `${results.length} 用例全部通过`,
          ...(failed !== undefined ? { failingCase: JSON.stringify(failed) } : {}),
        }
      }

      return { kind, pass: false, actual: answer, expected: key, detail: `未知 kind：${kind}（可用 choice/cloze/numeric/code/flag）` }
    },
  })
}
