// verify-correction-rules.mjs — 预设“听得懂话”的两类结构性规则（2026-10-29）
//
// 起因：学员的 C 会话被配成「网安伴学」，一整轮用错身份硬教；同一会话里学员连续两次
// 说「不是这个」「太套路」「跟我的痛点无关」，模型仍换数字出同型题。两类失效都不会报错，
// 只能靠结构性检查钉住：
//   ① companion-core 的注入里必须有【身份自检】：工作区科目 ≠ 预设身份时第一轮就提醒；
//   ② 四个教学预设 + Model 必须有「纠偏」节：先复述、换结构不换参数、一题一考点、指令高于流程。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DSH_HOME, allProfiles } from '../tools/presets.mjs'

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`✅ ${name}`) }
  else { fail += 1; console.log(`❌ ${name}${detail ? ' — ' + detail : ''}`) }
}

console.log('① companion-core：身份自检注入')

const core = readFileSync(new URL('../companion-core.js', import.meta.url), 'utf8')
check('注入块含【身份自检】', core.includes('【身份自检】'))
check('对照表来自配置而不是代码常量', core.includes('.科目预设.json') && !core.includes('EXPECTED_PRESET'))
check('代码里不再写死任何具体科目名（可移植性）',
  !['网安伴学', 'Model 伴学', '竞赛项目教练', '心灵陪伴'].some((s) => core.includes(s)))
check('注入文案要求第一轮提醒学员换预设', core.includes('第一轮先提醒学员'))

console.log('\n② 教学 persona：纠偏节')
const PHRASES = ['# 纠偏（学员说', '先复述，再动手', '否定不是换参数', '一题一考点', '指令高于流程']
const TEACHING = ['netsec-tutor', 'math-tutor', 'english-tutor', 'code-tutor', 'model-tutor']
let checkedProfiles = 0
for (const profile of allProfiles()) {
  const patch = join(DSH_HOME, 'profiles', profile, 'cordis.patch.yml')
  const text = readFileSync(patch, 'utf8')
  const headings = (text.match(/^\s*# 回答的默认形态\s*$/gm) ?? []).length
  if (headings === 0) {
    console.log(`ℹ️ ${profile}: 没有教学 persona（辅助 profile），跳过`)
    continue
  }
  checkedProfiles += 1
  check(`${profile}: 5 个教学预设都有「回答的默认形态」`, headings === 5, `实际 ${headings}`)
  check(`${profile}: 5 个教学预设 id 都在`, TEACHING.every((id) => text.includes(`id: "${id}"`)))
  for (const phrase of PHRASES) {
    const n = text.split(phrase).length - 1
    check(`${profile}: 「${phrase}」出现 5 次`, n === 5, `实际 ${n}`)
  }
}
check('至少检查了 2 份真实 profile（desktop / web）', checkedProfiles >= 2, `实际 ${checkedProfiles}`)

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
