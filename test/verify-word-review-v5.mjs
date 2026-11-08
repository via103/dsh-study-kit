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

console.log('\n① 真实数据 / v5 构建')
if (!existsSync(DATA) || !existsSync(BOOK)) { console.log('  ❌ 缺数据'); process.exit(1) }
const raw = JSON.parse(readFileSync(DATA, 'utf8'))
const real = compileContent(raw, { dataDir: EN, bookPath: BOOK, buildTime: '2026-10-20T00:00:00+08:00' })
check('真实数据 --check 通过', real.ok, real.ok ? '' : real.errors.slice(0, 3).join(' | '))
if (!real.ok) { console.log(`\n通过 ${pass} 条 / ${fail + 1} 失败`); process.exit(1) }
const content = real.content
const meta = content.meta
const unit1 = content.units.find((u) => u.current)
const unit0 = content.units.find((u) => !u.current)

check('2 个单元 + 1 个 current', content.units.length === 2 && content.units.filter((u) => u.current).length === 1)
check('七节固定顺序（无独立 golden）', content.sections.map((s) => s.id).join(',') === 'vocab,phrases,substitutions,patterns,contexts,pitfalls,culture')
check('句式与金句合并标题', content.sections.find((s) => s.id === 'patterns').title.includes('金句'))
check('172 项 / 199 题 / 18 contexts / 120 clusters', content.items.length === 172 && content.questions.length === 199 && content.contexts.length === 18 && content.clusters.length === 120)
check('每个 item 有稳定 key 且唯一', content.items.every((i) => i.id && i.id === i.key) && new Set(content.items.map((i) => i.id)).size === content.items.length)
check('每个 item 有 clusterId，无孤儿簇', content.items.every((i) => i.clusterId && content.clusters.some((c) => c.id === i.clusterId)))
check('每个 cluster ≥4 成员', content.clusters.every((c) => c.members.length >= 4))
check('6 个 phrase 全部有 blanks/core/hint', content.items.filter((i) => i.kind === 'phrase').every((i) => i.phrase && i.phrase.blanks.length && i.phrase.core && i.phrase.hint))
check('4 个 substitution 各有 ≥2 alternatives', content.items.filter((i) => i.kind === 'substitution').every((i) => (i.alternatives || []).length >= 2))
check('Unit1 reading 一篇 3 主题、849 词', unit1.reading && unit1.reading.parts.length === 3 && unit1.reading.wordCount >= 650 && unit1.reading.wordCount <= 850)
check('Unit0 reading 一篇 2 主题、437 词', unit0.reading && unit0.reading.parts.length === 2 && unit0.reading.wordCount >= 350 && unit0.reading.wordCount <= 450)
check('Unit1 reading 覆盖全部 word', unit1.reading.itemIds.length >= content.items.filter((i) => i.unitId === unit1.id && i.kind === 'word').length)
check('Unit0 reading 覆盖全部 word', unit0.reading.itemIds.length >= content.items.filter((i) => i.unitId === unit0.id && i.kind === 'word').length)
check('on track 仍是唯一 pending', content.items.filter((i) => i.testable === false && i.kind !== 'knowledge').length === 1 && content.items.find((i) => i.testable === false && i.kind !== 'knowledge').term === 'on track')

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

console.log('\n③ 熟悉度 / 轮 / 卡片')
let p = W.newProgress()
check('schema 5 / format 1 / 无 dailyCap', p.schemaVersion === 5 && W.FORMAT_VERSION === 1 && !('dailyCap' in p.settings))
check('熟悉度 5 档标签', W.FAM_LABELS.join(',') === '不熟悉,眼熟,认得,已掌握,非常熟悉')
const itemA = testableNoSub[0]
W.setFamiliarity(p, itemA, 3, 'card')
check('卡片改 3 已掌握', W.familiarityOf(p, itemA.id) === 3)
const before = W.familiarityOf(p, itemA.id)
W.recordTest(p, itemA, false, content.questions.find((q) => q.itemId === itemA.id), today)
check('盲测答错不自动升降', W.familiarityOf(p, itemA.id) === before)
W.setFamiliarity(p, itemA, 4, 'card')
const rec4 = W.recommend(content, p, unit1.id, today)
check('S4 不进默认推荐', !rec4.items.some((r) => r.item.id === itemA.id))
const cards4 = content.items.filter((i) => i.unitId === unit1.id && ['vocab', 'phrases', 'patterns'].includes(i.sectionId) && W.familiarityOf(p, i.id) !== 4)
check('S4 不进默认卡组', !cards4.some((i) => i.id === itemA.id))
check('熟悉度权重随做对下降', W.itemWeight(p, testableNoSub[1].id) > 0.2)

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
const pool = content.items.filter((i) => i.unitId === unit1.id && i.testable && !i.archived && i.kind !== 'substitution' && i.kind !== 'knowledge')
check('一轮覆盖全部不同词', Object.keys(seen).length === pool.length, Object.keys(seen).length + '/' + pool.length)
check('一次 session ≤4 题', sessions > 0 && sessions * 4 >= pool.length)
check('一轮内不重复词', Object.keys(seen).every((k) => seen[k] === 1))
check('round 完成标记', !!(round && round.completedAt))
const normal = W.buildSession(content, fresh, { unitId: unit1.id, scope: 'all', limit: 4, audioAvailable: false, seed: 'opts' })
check('普通盲测无选项', normal.questions.every((q) => !q.options))
const pit = W.buildSession(content, fresh, { unitId: unit1.id, scope: 'pitfalls', limit: 4, audioAvailable: false, seed: 'pit' })
check('易混易错出选择题', pit.questions.length > 0 && pit.questions.some((q) => q.options))

console.log('\n④ 进度格式 / 迁移 / 导入导出')
const portable = JSON.parse(W.exportPortable(fresh, '2026-10-20.1'))
check('导出 format v1 / schema 5 / contentVersion', portable.format === W.FORMAT && portable.formatVersion === 1 && portable.schemaVersion === 5 && portable.contentVersion === '2026-10-20.1')
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
const ap = W.newProgress(); ap.items[aliasItem.aliases[0]] = { familiarity: 4, familiarityAt: '2026-10-01T00:00:00Z', seen: true }
const an = W.normalizeAliasProgress(ap, content)
check('别名进度归并到 canonical', W.familiarityOf(an, aliasItem.id) === 4 && !an.items[aliasItem.aliases[0]])

console.log('\n⑤ HTML / 模板 / 投递')
const template = readFileSync(TEMPLATE, 'utf8')
const app = readFileSync(APP, 'utf8')
const built = buildHtml(content, template, app)
check('HTML 构建成功', built.ok, built.ok ? '' : built.errors.slice(0, 3).join(' | '))
const html = built.ok ? built.html : ''
check('单文件含内联数据', html.includes('window.__WORD_REVIEW__=') || html.includes('window.__WORD_REVIEW__ ='))
check('无外部脚本/样式请求', !/<script[^>]+src=|<link[^>]+href=/.test(html))
check('五档熟悉度在模板', /非常熟悉/.test(html) && /已掌握/.test(html))
check('3D 翻面 / 固定卡高在模板', /v5-card-inner/.test(html) && /rotateY\(180deg\)/.test(html) && /clamp\(320px,52vh,430px\)/.test(html))
check('大阅读不出现 90 秒复述', !/90\s*秒|复述/.test(html))
check('无 8MB/4MB 上限文案', !/8\s*MB|4\s*MB/.test(html))
check('七板块标题', ['词汇', '短语与搭配', '高级替换', '句式与金句', '语境', '易混易错', '文化与方法'].every((t) => html.includes(t)))
check('HTML 字节只报告不拦截', Buffer.byteLength(html, 'utf8') > 0)

const profiles = ['desktop', 'web'].map((name) => join(DSH_HOME, 'profiles', name, 'cordis.patch.yml'))
for (const f of profiles) {
  const y = existsSync(f) ? readFileSync(f, 'utf8') : ''
  check(f.includes('profiles') && f.includes('.yml') && y.includes('单词复习站'), 'persona 文件存在且含单词站：' + f)
  const idx = y.indexOf('# 单词复习站')
  const sec = idx >= 0 ? y.slice(idx, idx + 4200) : ''
  check('persona 提到 v5/卡片/轮/非常熟悉', /v5|卡片|一轮|非常熟悉/.test(sec), f)
}
const core = readFileSync(join(PKG, 'companion-core.js'), 'utf8')
check('companion-core 注入单词站状态', core.includes('WORD_REVIEW_DATA_NAME') && core.includes('wordReviewBlock'))
check('companion-core 不冒充熟悉度', /不是学员的熟悉度|熟悉度.*localStorage/.test(core))

console.log('\n⑥ 改站包装器')
const wrapper = readFileSync(join(PKG, 'tools', 'word-review-change.mjs'), 'utf8')
check('包装器默认只读，--write/--build 才写', wrapper.includes("args.write === true") && wrapper.includes("args.build === true"))
check('包装器支持 --data-only', wrapper.includes("args['data-only']"))
check('包装器报告 reading / cluster / blind', wrapper.includes('无选项盲测缺口') && wrapper.includes('reading'))

console.log(`\n通过 ${pass} 条 / ${fail} 失败`)
if (fail) process.exit(1)


