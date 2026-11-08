// 证伪：课堂积累体量检查**能不能真的报红**？
// 一个只会在"健康"时不说话的检查，和一个永远不说话的检查，输出长得一模一样（F16/F28）。
// 做法：造三个临时目录 —— 接近阈值 / 正常 / 违规同族文件 —— 直接调 classNotesHygiene，
// 断言它分别给出 nearSplit / 干净 / suspicious。
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { classNotesHygiene, CLASS_NOTES_SPLIT_BYTES } from '../plan-core.js'

let pass = 0
let fail = 0
const check = (name, ok, extra) => {
  if (ok) { pass += 1; console.log('  ✅ ' + name) } else { fail += 1; console.log('  ❌ ' + name + (extra === undefined ? '' : '  → ' + extra)) }
}

const BASE = './创建预设/.tmp-classnotes'
const mk = (name, bytes, files = {}) => {
  const d = join(BASE, name)
  rmSync(d, { recursive: true, force: true })
  mkdirSync(d, { recursive: true })
  for (const [fn, size] of Object.entries(files)) writeFileSync(join(d, fn), 'x'.repeat(size), 'utf8')
  return d
}

console.log('① 接近阈值（90%）→ 必须报')
{
  const d = mk('near', 0, { '词汇情景本.md': Math.round(CLASS_NOTES_SPLIT_BYTES * 0.9) })
  const h = classNotesHygiene(d)
  check('识别出 exists', h.exists === true)
  check('ratio 算对（90% 上下）', h.ratio >= 89 && h.ratio <= 91, String(h.ratio))
  check('nearSplit = true', h.nearSplit === true)
  check('字节是真实大小（不是 0）', h.bytes === Math.round(CLASS_NOTES_SPLIT_BYTES * 0.9), String(h.bytes))
}

console.log('② 正常体量（35%）→ 必须安静')
{
  const d = mk('ok', 0, { '词汇情景本.md': Math.round(CLASS_NOTES_SPLIT_BYTES * 0.35) })
  const h = classNotesHygiene(d)
  check('nearSplit = false', h.nearSplit === false)
  check('suspicious 空', h.suspicious.length === 0)
}

console.log('③ 没有这个文件 → 安静且 exists=false（英语之外的四科就是这样）')
{
  const h = classNotesHygiene(mk('none', 0, {}))
  check('exists = false', h.exists === false)
  check('nearSplit = false', h.nearSplit === false)
}

console.log('④ 违反「一份，一直用」→ 必须报可疑同族文件')
{
  const d = mk('dup', 0, { '词汇情景本.md': 100, '词汇情景本2.md': 100, '词汇情景本-2026秋.md': 100 })
  const h = classNotesHygiene(d)
  check('合法归档（-2026秋）**不算**可疑', !h.suspicious.includes('词汇情景本-2026秋.md'), JSON.stringify(h.suspicious))
  check('splitDone = true（已拆过）', h.splitDone === true)
  check('week 式命名（词汇情景本2.md）算可疑', h.suspicious.includes('词汇情景本2.md'), JSON.stringify(h.suspicious))
}

console.log('⑤ 边界：正好等于阈值 → nearSplit（不是"超过才报"）')
{
  const h = classNotesHygiene(mk('exact', 0, { '词汇情景本.md': CLASS_NOTES_SPLIT_BYTES }))
  check('正好 100% 时报', h.nearSplit === true)
  check('ratio = 100', h.ratio === 100, String(h.ratio))
}

rmSync(BASE, { recursive: true, force: true })
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
