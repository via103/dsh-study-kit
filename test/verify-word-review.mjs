// verify-word-review-v5.mjs — v5 卡片主模式 / 统一熟悉度 / 全量轮 / 七板块 / 多主题长阅读
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compileContent, buildHtml } from '../tools/build-word-review.mjs'
import '../templates/word-review-app.js'

const W = globalThis.WordReview
const PKG = dirname(dirname(fileURLToPath(import.meta.url)))
const STUDY_ROOT = process.env.DSH_STUDY_ROOT ?? 'ST'
const EN = join(STUDY_ROOT, '英语')
const DATA = join(EN, '单词复习数据.json')
const BOOK = join(EN, '词汇情景本.md')
const TEMPLATE = join(PKG, 'templates', 'word-review.template.html')
const APP = join(PKG, 'templates', 'word-review-app.js')
const DSH_HOME = process.env.DSH_HOME ?? '~/.dsh'

let pass = 0, fail = 0
const check = (label, ok, extra) => {
  if (ok) { pass += 1; console.log('  ✅ ' + label) }
  else { fail += 1; console.log('  ❌ ' + label + (extra === undefined ? '' : ' → ' + extra)) }
}
const clone = (x) => JSON.parse(JSON.stringify(x))
const today = W.studyDate()

console.log('\n⓪ v5.4 卡片手势/翻面状态')
const fc = { flips: {} }
check('flips 记录单卡翻面状态', W.cardFlipped(fc, 'a') === false && (W.setCardFlipped(fc, 'a', true), W.cardFlipped(fc, 'a') === true) && (W.setCardFlipped(fc, 'a', false), W.cardFlipped(fc, 'a') === false))
check('手势定轴：横/竖/未动', W.cardGestureMode(0, 0) === 'pending' && W.cardGestureMode(60, 4) === 'h' && W.cardGestureMode(4, -60) === 'v' && W.cardGestureMode(30, -20) === 'h')
check('上滑进度与 55% 门槛', W.cardPullProgress(-260, 520) === 0.5 && W.cardPullProgress(-300, 520) > 0.55 && W.cardShouldCommitV(0.5) === false && W.cardShouldCommitV(0.55) === true)
check('左右提交门槛 28%/最大 72px', W.cardShouldCommitH(72, 300) === true && W.cardShouldCommitH(60, 300) === false && W.cardShouldCommitH(100, 390) === true)

console.log('\n① 真实数据 / v5 构建')
if (!existsSync(DATA) || !existsSync(BOOK)) { console.log('  ❌ 缺数据'); process.exit(1) }
const raw = JSON.parse(readFileSync(DATA, 'utf8'))
const real = compileContent(raw, { dataDir: EN, bookPath: BOOK, buildTime: '2026-10-20T00:00:00+08:00' })
check('真实数据 --check 通过', real.ok, real.ok ? '' : real.errors.slice(0, 3).join(' | '))
if (!real.ok) { console.log(`\n通过 ${pass} 条 / ${fail + 1} 失败`); process.exit(1) }
const content = real.content
const meta = content.meta
const unit1 = content.units.find((u) => u.id === 'u1-chinese-culture')
const unit0 = content.units.find((u) => u.id === 'u0-first-week')
const related = content.questions.filter((q) => q.related === true)
check('v5.6 相关词题 44 条', related.length === 44)
check('相关词题：正确项+原单元词都在选项、notes 全覆盖、至少 2 个站外', related.every((q) =>
  q.options && q.options.includes(q.correctTerm) && q.options.includes(q.targetTerm) &&
  q.options.every((o) => q.optionNotes && q.optionNotes[o]) &&
  (q.externalTerms || []).filter((t) => q.options.includes(t)).length >= 2
))

check('9 个容器（4 单元 + 4 专题 + 1 翻译专项）+ 1 个 current', content.units.length === 9 && content.units.filter((u) => u.current).length === 1)
check('七节固定顺序（含熟词生义、无独立 golden）', content.sections.map((s) => s.id).join(',') === 'vocab,phrases,substitutions,patterns,contexts,pitfalls,sheng,culture')
check('句式与金句合并标题', content.sections.find((s) => s.id === 'patterns').title.includes('金句'))
check('533 项 / 1202 题 / 43 contexts / 223 clusters', content.items.length === 533 && content.questions.length === 1202 && content.contexts.length === 43 && content.clusters.length === 223)
const wordItems = content.items.filter((i) => i.kind === 'word')
check('389 个单词都有 1–4 条词典义项', wordItems.length === 389 && wordItems.every((i) => Array.isArray(i.senses) && i.senses.length >= 1 && i.senses.length <= 4))
check('词典义项共 537 条且字段时间完整', wordItems.reduce((n, i) => n + i.senses.length, 0) === 537 && wordItems.every((i) => i.senses.every((s) => s.pos && s.definition && s.example && s.translation && /^(OLD|CAM|ODE):/.test(s.source))))
check('每个 item 有稳定 key 且唯一', content.items.every((i) => i.id && i.id === i.key) && new Set(content.items.map((i) => i.id)).size === content.items.length)
{
  // v5.14 回归守护：进入翻译专项必须强制 c2e，但离开时要还原成 e2c（或用户自选），否则普通单元的卡片也会变成中→英。
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'templates', 'word-review-app.js'), 'utf8')
  check('翻译专项的 c2e 不污染普通单元（进入即判定、离开即还原）', /isTrans \? 'c2e' : \(state\.progress\.settings\.lastMode/.test(src))
}
check('每个 item 有 clusterId，无孤儿簇', content.items.every((i) => i.clusterId && content.clusters.some((c) => c.id === i.clusterId)))
check('每个 cluster ≥4 成员', content.clusters.every((c) => c.members.length >= 4))
check('102 个 phrase：有 hint；无空必 testable:false；有空必有 answer', content.items.filter((i) => i.kind === 'phrase').length === 102
  && content.items.filter((i) => i.kind === 'phrase').every((i) => {
    if (!i.phrase || !i.phrase.hint) return false
    const blanks = i.phrase.blanks || []
    if (!blanks.length) return i.testable === false
    return blanks.every((b) => typeof b.answer === 'string' && b.answer.length > 0)
  }))
check('4 个 substitution 各有 ≥2 alternatives', content.items.filter((i) => i.kind === 'substitution').every((i) => (i.alternatives || []).length >= 2))
check('Unit1 reading 一篇 4 主题、约 1400 词', unit1.reading && unit1.reading.parts.length >= 3 && unit1.reading.wordCount >= 900 && unit1.reading.wordCount <= 1700)
check('Unit0 reading 一篇 2 主题、约 500 词', unit0.reading && unit0.reading.parts.length === 2 && unit0.reading.wordCount >= 450 && unit0.reading.wordCount <= 600)
check('Unit1 reading 覆盖全部 word', unit1.reading.itemIds.length >= content.items.filter((i) => i.unitId === unit1.id && i.kind === 'word').length)
check('Unit0 reading 覆盖全部 word', unit0.reading.itemIds.length >= content.items.filter((i) => i.unitId === unit0.id && i.kind === 'word').length)
const allParts = [unit1, unit0].flatMap((u) => u.reading.parts)
check('每个主题有独立标题', allParts.every((p) => p.title && p.title.length >= 6))
check('每个主题至少 1 条长难句 notes', allParts.every((p) => p.notes && p.notes.length >= 1))
check('每条 notes 的 sentence 逐字在正文中', allParts.every((p) => p.notes.every((n) => p.paragraphs.some((para) => para.text.includes(n.sentence)))))
check('多主题不是一篇大卡（parts ≥2 + 标题）', unit1.reading.parts.length >= 3 && unit0.reading.parts.length >= 2)
check('Unit1 其他主题各覆盖 ≥30 个词', unit1.reading.parts.filter((p) => p.theme !== '本单元').every((p) => p.itemTerms.length >= 30))
check('Unit0 城市主题覆盖 ≥14 个词', unit0.reading.parts.find((p) => p.theme === '城市').itemTerms.length >= 14)
check('每篇文章有 itemTerms（article 覆盖率）', allParts.every((p) => p.itemTerms && p.itemTerms.length > 0))
check('高级替换独立成 4 条、不进盲测题', content.items.filter((i) => i.kind === 'substitution').length === 4 && !content.questions.some((q) => q.type.includes('subst')))
check('待补语境已清零；4 条 card-only 短语为非可测', content.items.filter((i) => i.testable === false && i.kind !== 'knowledge').length === 4
  && content.items.filter((i) => i.testable === false && i.kind !== 'knowledge').every((i) => i.kind === 'phrase' && !(i.phrase.blanks || []).length)
  && content.meta.pendingContextCount === 0)

console.log('\n② 题型 / 选项 / 盲测')
const types = new Set(content.questions.map((q) => q.type))
check('没有 e2c-scene/e2c-meaning/c2e-choose 旧题型', !['e2c-scene', 'e2c-meaning', 'c2e-choose'].some((t) => types.has(t)))
const testableNoSub = content.items.filter((i) => i.testable && i.kind !== 'substitution' && i.kind !== 'knowledge')
const noBlind = testableNoSub.filter((i) => !content.questions.some((q) => q.itemId === i.id && !q.options))
check('每个可测词/短语/句式都有无选项题', noBlind.length === 0, noBlind.map((i) => i.term || i.title).join(' / '))
const opts = content.questions.filter((q) => q.options)
check('options 只属于 pitfalls / 短语介词题', opts.every((q) => q.type === 'pitfall-choice' || q.type === 'phrase-prep-choice'))
check('所有选项池 4–8、显示 3–5、correctTerm 一致', opts.every((q) => q.optionPool.length >= 4 && q.optionPool.length <= 8 && q.optionCount >= 3 && q.optionCount <= 5 && q.options[q.answer] === q.correctTerm))
check('pitfalls 至少 1 道选择题', opts.some((q) => q.type === 'pitfall-choice'))
check('高级替换不出普通题', !content.questions.some((q) => q.type.includes('substit') || q.type.startsWith('replace')))
check('每道选择题每个选项都有 optionNotes', opts.every((q) => q.options.every((opt) => q.optionNotes && q.optionNotes[opt])))
check('短语介词只出选择题、不再出手写介词', !content.questions.some((q) => q.type === 'phrase-prep-fill') && opts.filter((q) => q.type === 'phrase-prep-choice').length === 89)
const externalPit = content.questions.filter((q) => q.type === 'pitfall-choice' && q.externalTerms && q.externalTerms.length)
check('生成式易混题至少一个本单元外选项', externalPit.every((q) => q.options.some((opt) => q.externalTerms.includes(opt))))
check('外部干扰项带讲解', externalPit.every((q) => q.externalTerms.every((t) => q.optionNotes && q.optionNotes[t])))
check('error 题的逐项讲解存在', content.items.filter((i) => i.error).every((i) => i.error.optionNotes && i.error.optionNotes.length === i.error.options.length))
const pitQ = content.questions.filter((q) => q.type === 'pitfall-choice')
check('易混板块只有选择题、题量 ≥120', pitQ.length >= 120 && pitQ.every((q) => q.type === 'pitfall-choice'))
check('易混题不会混入整句改错/短语介词题', !pitQ.some((q) => /选出正确表达/.test(q.prompt)))
check('每个易混词有 5 个变体、含 least 题', new Set(pitQ.map((q) => q.itemId)).size >= 20 && pitQ.filter((q) => /pitfall-least$/.test(q.id)).length === new Set(pitQ.map((q) => q.itemId)).size)
check('生僻/站外选项至少 2 个且带讲解', pitQ.every((q) => q.externalTerms.filter((t) => q.options.includes(t)).length >= 2 && q.externalTerms.every((t) => q.optionNotes && q.optionNotes[t])))
check('least 题正确答案是站外词', pitQ.filter((q) => /pitfall-least$/.test(q.id)).every((q) => q.externalTerms.includes(q.correctTerm)))
const spellQ = content.questions.filter((q) => q.type === 'spell-word')
check('拼写专用题 491、全部有中文提示（含 card-only 短语）', spellQ.length === 491 && spellQ.every((q) => q.stem && !q.reveal.sentence && q.answers && q.answers.length && !q.options)
  && content.items.filter((i) => i.kind === 'phrase' && i.testable === false).every((i) => spellQ.some((q) => q.itemId === i.id)))
check('词义/短语/句式题量随迁移更新', content.questions.filter((q) => q.type === 'word-cloze').length === 365 && content.questions.filter((q) => q.type === 'phrase-core-fill').length === 74 && content.questions.filter((q) => q.type === 'recite-full').length === 29)

console.log('\n③ 熟悉度 / 轮 / 卡片')
let p = W.newProgress()
check('schema 5 / format 1 / 无 dailyCap', p.schemaVersion === 5 && W.FORMAT_VERSION === 1 && !('dailyCap' in p.settings))
check('熟悉度 4 档标签', W.FAM_LABELS.join(',') === '忘记,模糊,认识,非常熟悉')
const itemA = testableNoSub[0]
W.setFamiliarity(p, itemA, 2, 'card')
check('卡片改 2 认识', W.familiarityOf(p, itemA.id) === 2)
const before = W.familiarityOf(p, itemA.id)
W.recordTest(p, itemA, false, content.questions.find((q) => q.itemId === itemA.id), today)
check('盲测答错不自动升降', W.familiarityOf(p, itemA.id) === before)
W.setFamiliarity(p, itemA, 3, 'card')
const rec4 = W.recommend(content, p, unit1.id, today)
check('S4 不进默认推荐', !rec4.items.some((r) => r.item.id === itemA.id))
const cards4 = content.items.filter((i) => i.unitId === unit1.id && ['vocab', 'phrases', 'patterns'].includes(i.sectionId) && W.familiarityOf(p, i.id) !== 3)
check('S4 不进默认卡组', !cards4.some((i) => i.id === itemA.id))
check('熟悉度权重随做对下降', W.itemWeight(p, testableNoSub[1].id) > 0.2)
const mastP = W.newProgress()
const mastItem = testableNoSub[1]
W.setMastered(mastP, mastItem, 'vocab', true)
check('完全掌握：排除推荐/遗忘，仍可取消', W.isMastered(mastP, mastItem, 'vocab') && W.reviewDueOf(W.stateOf(mastP, mastItem.id, 'vocab'), today).state === 'mastered' && W.recommend(content, mastP, unit1.id, today).counts.perfect >= 1 && !W.recommend(content, mastP, unit1.id, today).items.some((r) => r.item.id === mastItem.id))
W.setFamiliarity(mastP, mastItem, 2, 'card', 'vocab')
check('改熟悉度会退出完全掌握', !W.isMastered(mastP, mastItem, 'vocab') && W.familiarityOf(mastP, mastItem.id, 'vocab') === 2)

// v5.6 分板块状态与动态排期
const isoItem = content.items.find((i) => i.kind === 'word' && (i.confusables || []).length)
const iso = W.newProgress()
W.setFamiliarity(iso, isoItem, 3, 'card', 'vocab')
check('词汇 F4 不写易混状态', W.familiarityOf(iso, isoItem.id, 'vocab') === 3 && W.familiarityOf(iso, isoItem.id, 'pitfalls') === null)
W.setFamiliarity(iso, isoItem, 0, 'card', 'pitfalls')
check('易混 F0 不覆盖词汇 F3', W.familiarityOf(iso, isoItem.id, 'vocab') === 3 && W.familiarityOf(iso, isoItem.id, 'pitfalls') === 0)
W.recordTest(iso, isoItem, false, content.questions.find((q) => q.itemId === isoItem.id), today, 'pitfalls')
const pitDue = W.reviewDueOf(W.stateOf(iso, isoItem.id, 'pitfalls'), today)
check('易混答错当天到期，词汇仍 F3', pitDue.due === true && W.familiarityOf(iso, isoItem.id, 'vocab') === 3)
const recIsoP = W.recommend(content, iso, unit1.id, today, { sectionId: 'pitfalls' })
const recIsoV = W.recommend(content, iso, unit1.id, today, { sectionId: 'vocab' })
check('推荐按板块独立', recIsoP.counts.forget >= 1 && !recIsoP.items.some((r) => r.item.id === isoItem.id) && !recIsoV.items.some((r) => r.item.id === isoItem.id))

const dyn = W.newProgress()
W.setFamiliarity(dyn, isoItem, 1, 'card', 'vocab')
const dyn2 = W.stateOf(dyn, isoItem.id, 'vocab')
check('v5.18 排期只在「非常熟悉」开始：F1 不写 nextDue', dyn2.nextDue === null && dyn2.reviewInterval === null)
W.recordTest(dyn, isoItem, false, content.questions.find((q) => q.itemId === isoItem.id), today, 'vocab')
const dynWrong = W.stateOf(dyn, isoItem.id, 'vocab')
check('v5.18 盲测答错不排期、不降 F', dynWrong.nextDue === null && dynWrong.familiarity === 1 && dynWrong.lapses >= 1)
W.setFamiliarity(dyn, isoItem, 3, 'card', 'vocab')
const dyn4 = W.stateOf(dyn, isoItem.id, 'vocab')
check('v5.18 首次「非常熟悉」= 3 天回看', dyn4.nextDue === W.addDays(today, 3) && dyn4.reviewInterval === 3 && dyn4.reviewStreak === 0)
const earlyAgain = W.setFamiliarity(dyn, isoItem, 3, 'card', 'vocab')
check('v5.18 未到期再自评不重置排期', earlyAgain.nextDue === W.addDays(today, 3) && earlyAgain.reviewInterval === 3)
const dueFuture = W.reviewDueOf(dyn4, W.addDays(today, 2))
const dueNow = W.reviewDueOf(dyn4, W.addDays(today, 3))
const dueLate = W.reviewDueOf(dyn4, W.addDays(today, 9))
check('v5.18 3 天前不出现、到期出现、逾期给降档建议', dueFuture.due === false && dueNow.due === true && dueLate.suggestedFamiliarity === 2)
const ladder = []
for (let k = 0; k < 6; k++) {
  dyn.items[isoItem.id].nextDue = today
  W.setFamiliarity(dyn, isoItem, 3, 'forget', 'vocab')
  ladder.push(W.stateOf(dyn, isoItem.id, 'vocab').reviewInterval)
}
check('v5.18 到期连胜阶梯 7/15/30/60/60/60', ladder.join(',') === '7,15,30,60,60,60')

// v5.18：卡片池 / 遗忘池的不变式
const poolP = W.newProgress()
const poolItem = content.items.find((i) => i.kind === 'word' && i.testable && !i.archived)
W.setFamiliarity(poolP, poolItem, 2, 'card', 'vocab')
const pool2 = W.stateOf(poolP, poolItem.id, 'vocab')
check('v5.18 未到「非常熟悉」不计时、不进遗忘池', pool2.nextDue === null && W.isDueReview(poolP, poolItem, 'vocab') === false)
W.setFamiliarity(poolP, poolItem, 3, 'card', 'vocab')
const pool3 = W.stateOf(poolP, poolItem.id, 'vocab')
check('v5.18 到「非常熟悉」才开始 3 天计时', pool3.nextDue === W.addDays(today, 3) && pool3.reviewInterval === 3)
poolP.items[poolItem.id].nextDue = today
check('v5.18 非常熟悉且到期 → 进遗忘池', W.isDueReview(poolP, poolItem, 'vocab') === true)
W.setFamiliarity(poolP, poolItem, 2, 'card', 'vocab')
const poolBack = W.stateOf(poolP, poolItem.id, 'vocab')
check('v5.18 遗忘回看评低了 → 回卡片池', poolBack.nextDue === null && W.isDueReview(poolP, poolItem, 'vocab') === false)

const senseItem = content.items.find((i) => i.kind === 'word' && (i.senses || []).some((s) => s.example))
const altSense = senseItem ? W.altSenseOf(senseItem) : null
check('v5.8 遗忘卡例句 ≠ 本单元语境句', !!altSense && String(altSense.example).trim() !== String(senseItem.sentence).trim())

const migRaw = W.newProgress()
const migKey = poolItem.id
migRaw.items[migKey] = { familiarity: 2, seen: true, nextDue: W.addDays(today, 5), reviewInterval: 5 }
migRaw.poolModel = 1
const migOut = W.ensureProgress(migRaw)
check('v5.18 迁移清掉「未到非常熟悉」的 nextDue', !!migOut && !!migOut.items[migKey] && migOut.items[migKey].nextDue === null && migOut.poolModel === 2 && migOut.scheduleModel === 3)

// 旧 30 天排期压回 7 天
const migTop = W.newProgress()
migTop.items[isoItem.id] = { familiarity: 3, seen: true, lastReviewAt: today, nextDue: W.addDays(today, 25), reviewInterval: 30 }
migTop.scheduleModel = 1
const migTopOut = W.ensureProgress(migTop)
check('v5.18 旧 30 天排期压回 7 天', migTopOut.items[isoItem.id].reviewInterval === 7 && migTopOut.items[isoItem.id].nextDue === W.addDays(today, 7) && migTopOut.items[isoItem.id].reviewStreak === 1)

// 旧进度里“非常熟悉但没有 nextDue”的卡必须进遗忘复习，不能继续出现在普通卡组
const legacyTop = W.newProgress()
legacyTop.items[isoItem.id] = { familiarity: 3, seen: true, nextDue: null, reviewInterval: null }
const legacyTop2 = W.ensureProgress(legacyTop)
check('旧 F4 缺 nextDue：ensure 后当天到期', legacyTop2.items[isoItem.id].nextDue === today && W.isDueReview(legacyTop2, isoItem, 'vocab') === true)
check('旧 F4 缺 nextDue：不再进普通推荐', !W.recommend(content, legacyTop2, unit1.id, today, { sectionId: 'vocab' }).items.some((r) => r.item.id === isoItem.id))

// v5.6 遗忘复习：到期从普通板块移到遗忘板块
const dueItem = content.items.find((i) => i.unitId === unit1.id && i.sectionId === 'vocab' && i.testable)
const forgetP = W.newProgress()
W.setFamiliarity(forgetP, dueItem, 4, 'card', 'vocab')
const dueState = forgetP.items[dueItem.id]
dueState.nextDue = today
check('到期词被识别为遗忘复习', W.isDueReview(forgetP, dueItem, 'vocab') === true)
const normalRec = W.recommend(content, forgetP, unit1.id, today, { sectionId: 'vocab' })
check('普通板块不再把到期词算作待复习', normalRec.counts.forget >= 1 && !normalRec.items.some((r) => r.item.id === dueItem.id))
const normalSess = W.buildSession(content, forgetP, { unitId: unit1.id, scope: 'section', sectionId: 'vocab', limit: 500, audioAvailable: false, seed: 'normal-nodue' })
check('普通测试不出到期词', !normalSess.questions.some((q) => q.itemId === dueItem.id))
const forgetSess = W.buildSession(content, forgetP, { unitId: unit1.id, scope: 'section', sectionId: 'vocab', limit: 500, onlyDue: true, audioAvailable: false, seed: 'forget-due' })
check('遗忘测试只出到期词', forgetSess.questions.length === 1 && forgetSess.questions[0].itemId === dueItem.id && forgetSess.questions[0].sectionId === 'vocab')

const flash = W.newProgress()
const phraseSess = W.buildSession(content, flash, { unitId: unit1.id, scope: 'section', sectionId: 'phrases', limit: 4, audioAvailable: false, seed: 'phrase-section' })
check('短语板块只出短语题', phraseSess.questions.length > 0 && phraseSess.questions.every((q) => q.type.indexOf('phrase-') === 0))
const patSess = W.buildSession(content, flash, { unitId: unit1.id, scope: 'section', sectionId: 'patterns', limit: 4, audioAvailable: false, seed: 'pat-section' })
check('句式板块只出默写题', patSess.questions.length > 0 && patSess.questions.every((q) => q.type === 'recite-full'))

const fresh = W.newProgress()
let round = null, sessions = 0
const seen = {}
for (let i = 0; i < 60; i += 1) {
  const b = W.buildSession(content, fresh, { unitId: unit1.id, scope: 'all', limit: 4, audioAvailable: false, round, seed: 'round-' + i })
  if (!b.questions.length) break
  sessions += 1
  b.questions.forEach((q) => { seen[q.itemId] = (seen[q.itemId] || 0) + 1 })
  round = b.round
  if (round.completedAt) break
}
const pool = content.items.filter((i) => i.unitId === unit1.id && i.testable && !i.archived && i.sectionId === 'vocab')
check('一轮覆盖全部不同词', Object.keys(seen).length === pool.length, Object.keys(seen).length + '/' + pool.length)
check('一次 session ≤4 题', sessions > 0 && sessions * 4 >= pool.length)
check('一轮内不重复词', Object.keys(seen).every((k) => seen[k] === 1))
check('round 完成标记', !!(round && round.completedAt))
const normal = W.buildSession(content, fresh, { unitId: unit1.id, scope: 'all', limit: 4, audioAvailable: false, seed: 'opts' })
check('普通盲测无选项', normal.questions.every((q) => !q.options))
check('综合盲测不含拼写/易混题', normal.questions.every((q) => q.type !== 'spell-word' && q.type !== 'pitfall-choice'))
const pit = W.buildSession(content, fresh, { unitId: unit1.id, scope: 'pitfalls', limit: 4, audioAvailable: false, seed: 'pit' })
check('易混易错出选择题', pit.questions.length > 0 && pit.questions.some((q) => q.options))
check('易混题显示选项含 ≥2 个站外项', pit.questions.every((q) => q.options && q.externalTerms.filter((t) => q.options.includes(t)).length >= 2))
const spellable = testableNoSub.filter((i) => i.kind === 'word' || i.kind === 'phrase').slice(0, 10)
const sp = W.newProgress()
spellable.forEach((i) => W.setSpell(sp, i, true))
const spellSess = W.buildSession(content, sp, { unitId: unit1.id, scope: 'spelling', limit: 4, audioAvailable: false, seed: 'spell' })
check('拼写板块只出 spell-word + 中文提示 + 无选项', spellSess.questions.length > 0 && spellSess.questions.every((q) => q.type === 'spell-word' && q.stem && !q.options && !q.reveal.sentence))
const vocabSess = W.buildSession(content, fresh, { unitId: unit1.id, scope: 'section', sectionId: 'vocab', limit: 4, audioAvailable: false, seed: 'vocab' })
check('词汇板块不混拼写题', vocabSess.questions.length > 0 && vocabSess.questions.every((q) => q.type === 'word-cloze'))
const ra = W.buildSession(content, fresh, { unitId: unit1.id, scope: 'all', limit: 1, audioAvailable: false, seed: 'rand-a' })
const rb = W.buildSession(content, fresh, { unitId: unit1.id, scope: 'all', limit: 1, audioAvailable: false, seed: 'rand-b' })
check('轮顺序按 seed 加权随机', ra.round.keys.join('|') !== rb.round.keys.join('|'))

console.log('\n④ 进度格式 / 迁移 / 导入导出')
const portable = JSON.parse(W.exportPortable(fresh, '2026-10-21.1'))
check('导出 format v1 / schema 5 / contentVersion', portable.format === W.FORMAT && portable.formatVersion === 1 && portable.schemaVersion === 5 && portable.contentVersion === '2026-10-21.1')
const imported = W.importProgress(JSON.stringify(portable))
check('导出再导入成功', imported.ok && imported.progress.schemaVersion === 5)
const future = W.importProgress(JSON.stringify({ format: W.FORMAT, formatVersion: 2, progress: {} }))
check('未来 formatVersion 拒绝', !future.ok)
const old4 = clone(fresh); old4.schemaVersion = 4; old4.items = {}; old4.items[itemA.id] = { self: { level: 2, updatedAt: '2026-10-01T00:00:00Z' }, e2c: { level: 1 }, c2e: { level: 3 }, selfCheck: false }
const m4 = W.ensureProgress(old4)
check('4→5 迁移：self 优先、dailyCap 删除', m4.schemaVersion === 5 && m4.items[itemA.id].familiarity === 2 && !('dailyCap' in m4.settings))
const old3 = clone(fresh); old3.schemaVersion = 3; old3.settings.dailyCap = 12; old3.items = {}; old3.items[itemA.id] = { e2c: { level: 2, right: 1, wrong: 0 }, c2e: { level: 3, right: 1, wrong: 0 } }
const m3 = W.ensureProgress(old3)
check('3→5 迁移：旧等级转熟悉度', m3.schemaVersion === 5 && m3.items[itemA.id].familiarity === 3)
const aliasItem = content.items.find((i) => (i.aliases || []).length)
check('合并条目带 aliases', !!aliasItem, '无 aliases')
const ap = W.newProgress(); ap.items[aliasItem.aliases[0]] = { familiarity: 3, familiarityAt: '2026-10-01T00:00:00Z', seen: true }
const an = W.normalizeAliasProgress(ap, content)
check('别名进度归并到 canonical', W.familiarityOf(an, aliasItem.id) === 3 && !an.items[aliasItem.aliases[0]])

console.log('\n⑤ HTML / 模板 / 投递')
const template = readFileSync(TEMPLATE, 'utf8')
const app = readFileSync(APP, 'utf8')
const candSrc = app.slice(app.indexOf('function cardCandidates('), app.indexOf('function copyFlips('))
check('v5.8 卡片池不看 seen、不排除到期词', !/p\.seen/.test(candSrc) && !/isDueReview/.test(candSrc) && /FAM_TOP/.test(candSrc))

const startForgetSrc = app.slice(app.indexOf('function startForget('), app.indexOf('function startForget(') + 2200)
check('v5.8 遗忘回看＝卡片流（不生成题目、不拼写）', /sectionId: 'forget', scope: 'forget'/.test(startForgetSrc) && !/buildSession/.test(startForgetSrc) && !/state\.session\s*=/.test(startForgetSrc))
const built = buildHtml(content, template, app)
check('HTML 构建成功', built.ok, built.ok ? '' : built.errors.slice(0, 3).join(' | '))
const html = built.ok ? built.html : ''
check('单文件含内联数据', html.includes('window.__WORD_REVIEW__=') || html.includes('window.__WORD_REVIEW__ ='))
check('无外部脚本/样式请求', !/<script[^>]+src=|<link[^>]+href=/.test(html))
check('五档熟悉度在模板', /非常熟悉/.test(html) && /熟练/.test(html))
check('遗忘选择状态初始化', /state\.forget = \{ unitId: unit\.id/.test(app))
check('遗忘旧会话只在板块一致时续用', /oldWant === want/.test(app))
check('遗忘卡无结束词按钮/完成页不重启', !/forget-pass/.test(app) && /本轮遗忘回看结束/.test(app))
check('遗忘轮未完成时合并新到期词', /merged\.push\(i\.id\)/.test(app) && /old\.order\.slice\(\)/.test(app))
check('遗忘评低留在遗忘池/滑动按当前档记录', /forgetRemain/.test(app) && /setForgetFamiliarity/.test(app) && /autoForgetOnAdvance/.test(app))
check('遗忘回单元/返回也记录当前卡', /state\.screen === 'cards' && state\.cards && state\.cards\.scope === 'forget'/.test(app) && /a === 'unit'/.test(app))
check('遗忘滑动也走记录（commitCardNav 内）', /function commitCardNav[\s\S]{0,220}autoForgetOnAdvance/.test(app))
check('3D 翻面 / 固定卡高在模板', /v5-card-inner/.test(html) && /rotateY\(180deg\)/.test(html) && /clamp\(320px,52vh,430px\)/.test(html))
check('完全掌握：横向滑块/确认/徽标', /famSlider\(/.test(app) && /mastery-confirm/.test(app) && /mastered-badge/.test(html) && /fam-slider\.horizontal/.test(html))
check('词库与板块标题收敛', /\+\s*'板块<\/h2>/.test(app) && /词库 · 全部词条/.test(app) && !/已掌握复习/.test(app))
check('卡片断点/mark 保存到 ui.cards', /ui\.cards|persistCards/.test(app) && /order:\s*c\.order\.slice\(\)/.test(app))
check('卡片正反两向翻转且可打断（无 flipAnim 锁）', /setCardFlipped\(cc, ci\.id, !flippedNow\)/.test(app) && /classList\.toggle\('flipped', !flippedNow\)/.test(app) && !/flipAnim|v5flip/.test(app + html))
check('卡片换张使用离场/入场动画', /card-leaving-next/.test(html) && /card-enter-next/.test(html) && /card-enter-prev/.test(html) && /navLock/.test(app))
check('拼写状态不再用卡内 chip，上滑仍可加入拼写本', !/card-spell-chip/.test(app) && /addCardSpell/.test(app))
check('上滑成功用固定 toast，不再有依附卡片的 stamp', !/spell-stamp/.test(app) && /toast\(already/.test(app))
check('上滑回弹有 settling 过渡', /settling/.test(template) && /function commitCardSpell[\s\S]*?settling/.test(app))
check('评分不再弹“已记下”', !/已记下/.test(app))
check('选项讲解渲染', /opt-note/.test(app) && /optionNote\(q, opt, i\)/.test(app))
check('拼写题显示中文提示', /看中文，拼写英文/.test(app) && /scope === 'spelling'/.test(app))
check('阅读页不再带盲测 quick 按钮', !/data-action="quick" data-unit/.test(app.slice(app.indexOf('function renderReading'), app.indexOf('function renderSettings'))))
check('高级替换分步：先想再揭 + 滑块评分', /sub-reveal/.test(app) && /renderSubstitution/.test(app) && /famSlider\(familiarityOf\(state\.progress, item\.id, 'substitutions'\)/.test(app))
check('高级替换的评分使用 effective item', /setFamiliarity\(state\.progress, su/.test(app))
check('易混板块先到总览，卡片/选择题两个入口', /d\.section === 'pitfalls'/.test(app) && /data-action="confusable-cards"/.test(app) && /data-action="pitfalls"/.test(app) && !/d\.section === 'pitfalls'.*scope: 'pitfalls'/.test(app))
check('大阅读多文章 + 长难句卡', /read-chips/.test(app) && /read-article/.test(app) && /hard-note/.test(app) && /renderReadText/.test(app))
check('大阅读不出现 90 秒复述', !/90\s*秒|复述/.test(html))
check('卡片可左右滑动切卡（跟手/门槛/离场）', /onCardPointerDown/.test(app) && /onCardPointerMove/.test(app) && /onCardPointerUp/.test(app) && /cardShouldCommitH/.test(app) && /commitCardNav/.test(app))
check('熟悉度条按 0–3 填 1–4 段', /lv \+ 1/.test(app) && /i < 4; i \+= 1/.test(app))
check('条目页可直接自评、不再有打开生词卡按钮', /state\.screen === 'item'/.test(app) && !/打开生词卡/.test(app))
check('长难句标注不再有荧光底、关闭有过渡', !/read-note\{display:inline;background:var\(--accent-weak\)/.test(html) && /modal-backdrop\.closing/.test(html) && /closeModal/.test(app))
check('模态层与知识卡分离：开关确认框不重绘卡片', /ov-card-slot/.test(app) && /ov-modal-slot/.test(app) && /modalSlot\.innerHTML/.test(app))
check('完全掌握框居中 + 滑块越界位移跟手', /\.modal-backdrop\{[^}]*align-items:center/.test(html) && /--fam-pull/.test(html) && /--fam-pull/.test(app))
check('滑块越界连续跟手 + 弹性回位', /22 \* \(1 - Math\.exp\(-overPx \/ 24\)\)/.test(app) && /cubic-bezier\(\.16,\.9,\.24,1\.2\)/.test(html))
check('易混题选项池可显示 3–5 个', /OPTION_MIN|optionCount/.test(app) && /optionPool/.test(app))
check('无 8MB/4MB 上限文案', !/8\s*MB|4\s*MB/.test(html))
check('板块标题（含熟词生义）', ['词汇', '短语与搭配', '高级替换', '句式与金句', '语境', '易混易错', '熟词生义', '文化与方法'].every((t) => html.includes(t)))
check('HTML 字节只报告不拦截', Buffer.byteLength(html, 'utf8') > 0)
check('卡片页锁滚动、其他页保留滚动', /cards-lock/.test(app) && /classList\.toggle\('cards-screen'/.test(app) && /height:calc\(100dvh - 61px/.test(html) && /overflow:hidden/.test(html))
check('卡片页无底部栏/页脚', (() => {
  const m = app.match(/function renderCards\(\)[\s\S]*?\n  function readingContexts/);
  const fn = m ? m[0] : '';
  return fn.length > 200 && !/bottombar|footer\(/.test(fn) && /cards-hint/.test(fn);
})())
check('右手竖向滑块：5 tick + 拖动/吸附/ARIA', /famSlider/.test(app) && /onFamDown/.test(app) && /onFamUp/.test(app) && /role="slider"/.test(app) && /aria-valuemax/.test(app) && /fam-thumb/.test(html) && /fam-tick/.test(html) && /snapping/.test(app))
check('卡背两段：释义区 + 例句区 + 独立滑块列（v5.9 取代四象限）', /v5-back-grid/.test(app) && /v5-defs/.test(app) && /v5-examples/.test(app) && /v5-back-ctl/.test(app) && !/v5-senses/.test(app) && !/v5-senses/.test(html))
check('flips 写入/恢复 ui.cards', /flips:\s*copyFlips\(c\.flips\)/.test(app) && /copyFlips\(c\.flips\)/.test(app) && /flips:\s*\{\}/.test(app))
check('卡片翻面用 CSS 过渡而非重建', /transition:transform \.48s/.test(html) && /classList\.toggle\('flipped'/.test(app))
check('上滑加入拼写：跟手/55% 门槛/过半取消', /cardPullProgress/.test(app) && /cardShouldCommitV/.test(app) && /paintCardPull/.test(app) && /spell-pull-underlay/.test(html) && /addCardSpell/.test(app))
check('卡片页手势不依赖页面滚动', /touch-action:none/.test(html) && /overscroll-behavior:none/.test(html) && /onCardPointerMove/.test(app))
check('短屏适配与减少动效', /max-height:700px/.test(html) && /prefers-reduced-motion/.test(html))

const profiles = ['desktop', 'web'].map((name) => join(DSH_HOME, 'profiles', name, 'cordis.patch.yml'))
for (const f of profiles) {
  const y = existsSync(f) ? readFileSync(f, 'utf8') : ''
  check(f.includes('profiles') && f.includes('.yml') && y.includes('单词复习站'), 'persona 文件存在且含单词站：' + f)
  const idx = y.indexOf('# 单词复习站')
  const sec = idx >= 0 ? y.slice(idx, idx + 9000) : ''
  check('persona 提到 v5/卡片/轮/非常熟悉', /v5|卡片|一轮|非常熟悉/.test(sec), f)
  check('persona 分板块/相关词/遗忘入口', /分板块状态/.test(sec) && /sections\.pitfalls/.test(sec) && /相关词/.test(sec) && /遗忘复习/.test(sec), f)
  check('persona 池互斥/卡片池/nextDue=null', /卡片池/.test(sec) && /遗忘回看池/.test(sec) && /nextDue=null/.test(sec), f)
  check('persona v5.13：熟词生义/易混卡片/拼写过关/tags/vi-vt', /v5\.13/.test(sec) && /熟词生义/.test(sec) && /易混卡片/.test(sec) && /拼写本/.test(sec) && /vi\./.test(sec) && /vt\./.test(sec) && /tags/.test(sec), f)
  check('persona v5.14：笔记入库分类预览/判定树/硬拒绝', /v5\.14/.test(sec) && /分类预览表/.test(sec) && /判定树/.test(sec) && /word.*含空格|含空格/.test(sec) && /golden/.test(sec) && /phrase/.test(sec), f)
}
const core = readFileSync(join(PKG, 'companion-core.js'), 'utf8')
check('companion-core 注入单词站状态', core.includes('WORD_REVIEW_DATA_NAME') && core.includes('wordReviewBlock'))
check('companion-core 不冒充熟悉度', /不是学员的熟悉度|熟悉度.*localStorage/.test(core))

console.log('\n⑤.9 v5.9 卡背重排 / 遗忘卡 / 翻面上滑')
const cbItem = content.items.find((i) => i.kind === 'word' && i.sentence && (i.senses || []).filter((s) => !s.dropped).length >= 2)
const cbHtml = cbItem ? W.cardBackHtml(cbItem, { ctl: '' }) : ''
const keptSenses = cbItem ? cbItem.senses.filter((s) => !s.dropped) : []
check('v5.9 卡背不再出现本单元语境句', !!cbItem && cbHtml.length > 0 && !cbHtml.includes(cbItem.sentence))
check('v5.9 卡背释义逐条编号、例句一一对应',
  !!cbItem && (cbHtml.split('<ol class="sense-defs">')[1] || '').split('</ol>')[0].split('<li>').length - 1 === keptSenses.length
  && (cbHtml.split('<ol class="sense-examples">')[1] || '').split('</ol>')[0].split('<li').length - 1 === keptSenses.length)
const ipaItem = content.items.find((i) => i.kind === 'word' && i.ipa && (i.senses || []).length)
const ipaHtml = ipaItem ? W.cardBackHtml(ipaItem, { ctl: '' }) : ''
check('v5.9 音标在释义区、例句用 sense-ex',
  !!ipaItem && ipaHtml.indexOf(ipaItem.ipa) >= 0 && ipaHtml.indexOf(ipaItem.ipa) < ipaHtml.indexOf('sense-examples')
  && /class="sense-ex"/.test(cbHtml))
const droppedItem = content.items.find((i) => (i.senses || []).some((s) => s.dropped))
check('v5.9 标了 dropped 的义项不上卡背', !droppedItem || !W.cardBackHtml(droppedItem, { ctl: '' }).includes(droppedItem.senses.filter((s) => s.dropped)[0].definition))
const hlPhrase = W.highlightTerm("I'm grateful to my teacher for explaining it so clearly.", { term: 'be grateful to sb for sth', surface: 'be grateful to sb for sth' })
check('v5.9 短语条目也能在例句里标出目标词', /class="hit">grateful</.test(hlPhrase) && !/class="hit">(to|for|be)</.test(hlPhrase))
const rcSrc = app.slice(app.indexOf('function renderCards()'), app.indexOf('function readingContexts'))
const frontSrc = rcSrc.slice(rcSrc.indexOf('if (isForget) {'), rcSrc.indexOf('} else if (onlySheng) {'))
check('v5.9 忘记录卡正面只剩一条提示', frontSrc.length > 50 && !/class="card-hint"[^]*class="card-hint"/.test(frontSrc))
check('v5.9 翻面后可上滑（卡背列表自己滚，滚到底转上拉）',
  W.canStartCardGesture({ mode: 'v' }) === true
  && W.canStartCardGesture({ flipped: true, mode: 'v', inScroll: true, sensesScrollTop: 40 }) === true
  && W.canStartCardGesture({ isForget: true, mode: 'v' }) === false
  && W.canStartCardGesture({ isForget: true, mode: 'h' }) === true
  && /scrollHostCanScroll/.test(app) && !/t\.closest\('\.v5-senses'\)/.test(app))

check('v5.9.1 例句/释义块原生滚动，不再跟卡片上拉抢手势',
  /\.sense-examples\{[^}]*touch-action:pan-y/.test(html) && /\.sense-defs\{[^}]*touch-action:pan-y/.test(html)
  && /scrollHostCanScroll\(scrollEl\)\) return/.test(app) && !/startScroll/.test(app))
check('v5.9.1 滑块升档有动画（弹一下 + 文字渐显）', /level-up/.test(app) && /famLevelUp/.test(html) && /famValUp/.test(html) && /align-self:start/.test(html))
check('v5.9.2 上冲动画不再被 3.98 门槛废掉（raw 不夹 0–3）',
  /famRawAt/.test(app) && /raw >= 3 \? famOverAt/.test(app) && !/3\.98/.test(app) && /clamp\(Number\(pullPx\) \|\| 0, 0, 22\)/.test(app))

console.log('\n⑤.10 v5.10 专题（与单元平行）')
const topicUnit = content.units.find((u) => u.kind === 'topic')
check('v5.10 专题不占 current、单独成组', !!topicUnit && topicUnit.current === false
  && content.units.filter((u) => u.current).length === 1
  && content.units.filter((u) => u.kind === 'topic').every((u) => !u.reading)
  && /kind === 'topic'/.test(app) && /专题 · 题目汇总/.test(app))

console.log('\n⑤.11 v5.13 词性/标记/易混卡片/熟词生义/拼写本/随时复习')
const POS_TOKEN = /^(n\.|vt\.|vi\.|adj\.|adv\.|prep\.|conj\.|pron\.|num\.|phr\.)$/
const posOk = (p) => typeof p === 'string' && p.split('/').length > 0 && p.split('/').every((t) => POS_TOKEN.test(t))
const contentWordsPhrases = content.items.filter((i) => i.kind === 'word' || i.kind === 'phrase')
check('所有 word/phrase pos 合法；短语必须是 phr.', contentWordsPhrases.every((i) => posOk(i.pos) && (i.kind !== 'phrase' || i.pos === 'phr.')))
check('所有义项 pos 合法', contentWordsPhrases.every((i) => i.senses.every((s) => posOk(s.pos))))
check('phrase 全带 collocation，非短语不带；tags 只含白名单', contentWordsPhrases.every((i) => {
  const tags = i.tags || []
  return tags.every((t) => ['write', 'proper', 'sheng', 'collocation'].includes(t))
    && (i.kind === 'phrase') === tags.includes('collocation')
}))

const cfg = content.confusableGroups || []
check('易混卡片 22 组、每组 ≥2 词且逐词有讲解', cfg.length === 22 && cfg.every((g) =>
  g.terms.length >= 2 && g.terms.every((t) => t.term && t.note) && g.terms.some((t) => t.term === g.targetTerm)))
check('易混卡片只来自易混词、不生成题目', cfg.every((g) => content.items.find((i) => i.id === g.targetItemId).kind === 'word')
  && !content.questions.some((q) => q.type === 'confusable-card'))
const mergedItem = content.items.find((i) => (i.aliases || []).includes('i-u1-chinese-culture-an-overwhelming-feeling-of'))
check('重复条目已合并：phrase、别名可归并', !!mergedItem && mergedItem.kind === 'phrase' && mergedItem.pos === 'phr.' && mergedItem.id === 'i-u1-chinese-culture-an-overwhelming-feeling-of-2')
check('迁移后短语共 102 条、99 个空', content.items.filter((i) => i.kind === 'phrase').length === 102
  && content.items.filter((i) => i.kind === 'phrase').reduce((n, i) => n + ((i.phrase.blanks) || []).length, 0) === 99)

const spP = W.newProgress()
const anyWord = content.items.find((i) => i.kind === 'word' && i.testable)
const sq = content.questions.find((q) => q.type === 'spell-word' && q.itemId === anyWord.id)
check('拼写三态：write 标签默认进本、手动可移出', W.spellActive(anyWord, null) === false
  && W.spellActive(Object.assign({}, anyWord, { tags: ['write'] }), null) === true
  && (W.setSpell(spP, anyWord, false), W.spellActive(anyWord, W.stateOf(spP, anyWord.id)) === false)
  && (W.setSpell(spP, anyWord, true), W.spellActive(anyWord, W.stateOf(spP, anyWord.id)) === true))
W.recordTest(spP, anyWord, true, sq, today)
check('拼写答对即过关、记录次数', spP.items[anyWord.id].spellPassed === true && spP.items[anyWord.id].spellAttempts === 1 && spP.items[anyWord.id].spellPassedAt === today)
const spSess = W.buildSession(content, spP, { unitId: anyWord.unitId, scope: 'spelling', limit: 20, audioAvailable: false, seed: 'spell-after-pass' })
check('过关后不再进拼写轮', !spSess.questions.some((q) => q.itemId === anyWord.id))

const fakeSheng = { id: 'x', kind: 'word', term: 'test', senses: [
  { pos: 'n.', definition: '普通义', example: 'A ordinary sentence.', translation: '普通', source: 'OLD:x' },
  { pos: 'n.', definition: '生僻义', example: 'A rare sentence.', translation: '生僻', source: 'OLD:x', sheng: true }
] }
const shengBack = W.cardBackHtml(fakeSheng, { ctl: '', onlySheng: true })
check('熟词生义卡背只渲染 sheng 义项', shengBack.includes('生僻义') && !shengBack.includes('普通义'))
check('熟词生义板块存在且已入 1 条（observe）', content.sections.find((s) => s.id === 'sheng').order === 7
  && content.meta.sectionCounts.sheng === 1
  && content.items.filter((i) => i.sectionId === 'sheng').every((i) => W.hasSheng(i) && i.senses.every((s) => s.sheng === true)))
check('熟词生义条目与常用义分开记（同 term 但不同 key、不同板块）', (() => {
  const sh = content.items.filter((i) => i.sectionId === 'sheng')
  return sh.every((i) => content.items.some((o) => o.unitId === i.unitId && o.term === i.term && o.id !== i.id && o.sectionId !== 'sheng'))
})(), '熟词生义与常用义同 key')

check('随时复习 UI 与状态：范围/张数/继续', /随时复习/.test(app) && /startRandomCards/.test(app) && /random-scope/.test(app)
  && /random-count/.test(app) && /activeRandomSaved/.test(app) && /__random__/.test(app))
check('易混卡片屏：正面一词一行、背面逐词讲解', /function renderConfusable/.test(app) && /cfg-front-term/.test(html) && /cfg-note/.test(html) && /confusable-groups|confusableGroups/.test(app))
check('拼写本屏：待过关/已过关/重新练/移出', /function renderSpelling/.test(app) && /待过关/.test(app) && /已过关/.test(app) && /spell-reset/.test(app) && /spell-toggle/.test(app))
check('拼写池不再看熟悉度（非常熟悉/完全掌握也要拼）', /spellActive\(i, p\) && !\(p && p\.spellPassed\)/.test(app) && !/familiarityOf\(progress, i\.id\) !== 3/.test(app))
check('卡片/条目显示词性+标记', /tagBadges\(item\)/.test(app) && /sense-pos/.test(app))
check('词汇卡不混句式/金句', /kind === 'word'/.test(app.slice(app.indexOf('function cardItems('), app.indexOf('function copyFlips('))))

console.log('\n⑤.12 v5.14 笔记分类（word/phrase/golden 硬边界）')
const unitKind = new Map(raw.units.map((u) => [u.id, u.kind || 'unit']))
const nonTrWords = content.items.filter((i) => i.kind === 'word' && unitKind.get(i.unitId) !== 'translation')
check('非翻译 word 不含多词 / 整句 / phr.', nonTrWords.every((i) => !/\s/.test(String(i.term).trim()) && i.pos !== 'phr.' && !/[.!?]$/.test(String(i.term).trim())))
const trWords = content.items.filter((i) => i.kind === 'word' && unitKind.get(i.unitId) === 'translation')
check('翻译专项保留 word 卡片（87 条，其中 81 条多词）', trWords.length === 87 && trWords.filter((i) => /\s/.test(i.term)).length === 81)
check('迁移后 superior to / substitute A for B 是 phrase', ['superior to', 'substitute A for B'].every((t) => content.items.some((i) => i.kind === 'phrase' && i.term === t)))
check('revise / revision 已拆成两个 word', content.items.some((i) => i.kind === 'word' && i.term === 'revise' && i.id === 'i-u0-first-week-revise-revision')
  && content.items.some((i) => i.kind === 'word' && i.term === 'revision' && i.id === 'i-u0-first-week-revision'))
check('旧混排 term 已不存在', !content.items.some((i) => ['superior … to', 'substitute (sth for sth)', 'revise / revision'].includes(i.term)))
const bad1 = clone(raw)
const bw1 = bad1.items.find((i) => i.kind === 'word' && unitKind.get(i.unitId) !== 'translation')
bw1.term = 'two words'
if ('surface' in bw1) bw1.surface = 'two words'
const bad1r = compileContent(bad1, { dataDir: EN, bookPath: BOOK, buildTime: '2026-10-20T00:00:00+08:00' })
check('构建器硬拒绝：word 含空格', !bad1r.ok && bad1r.errors.some((e) => e.includes('kind=word 但 term 含空格')))
const bad2 = clone(raw)
const bw2 = bad2.items.find((i) => i.kind === 'word' && unitKind.get(i.unitId) !== 'translation')
bw2.pos = 'phr.'
const bad2r = compileContent(bad2, { dataDir: EN, bookPath: BOOK, buildTime: '2026-10-20T00:00:00+08:00' })
check('构建器硬拒绝：word 用 phr.', !bad2r.ok && bad2r.errors.some((e) => e.includes('kind=word 不能用 phr.')))
check('迁移短语带 hint / answer / 选项讲解', content.items.filter((i) => i.kind === 'phrase').every((i) => i.phrase.hint
  && (i.phrase.blanks || []).every((b) => b.answer && (!b.options || (b.optionNotes && b.options.includes(b.answer))))))

console.log('\n⑥ 改站包装器')
const wrapper = readFileSync(join(PKG, 'tools', 'word-review-change.mjs'), 'utf8')
check('包装器默认只读，--write/--build 才写', wrapper.includes("args.write === true") && wrapper.includes("args.build === true"))
check('包装器支持 --data-only', wrapper.includes("args['data-only']"))
check('包装器报告 reading / cluster / blind', wrapper.includes('无选项盲测缺口') && wrapper.includes('reading'))

console.log(`\n通过 ${pass} 条 / ${fail} 失败`)
if (fail) process.exit(1)


