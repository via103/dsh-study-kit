// 生成静态预览（v5.9 一次性验收工具）：真实 CSS + 真实 cardBackHtml，无头浏览器截图
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const built = readFileSync('ST/英语/单词复习站.html', 'utf8')
const css = built.slice(built.indexOf('<style>') + 7, built.indexOf('</style>'))

await import(pathToFileURL('<study-plugins>/templates/word-review-app.js').href)
const W = globalThis.WordReview
const { compileContent } = await import(pathToFileURL('<study-plugins>/tools/build-word-review.mjs').href)
const raw = JSON.parse(readFileSync('ST/英语/单词复习数据.json', 'utf8'))
const content = compileContent(raw, {
  dataDir: 'ST/英语',
  bookPath: 'ST/英语/词汇情景本.md',
  buildTime: '2026-10-23T00:00:00+08:00'
}).content

const pick = (t) => content.items.find((i) => i.term === t)
const slider = '<div class="fam-slider compact" role="slider" aria-valuemin="0" aria-valuemax="4" aria-valuenow="1" aria-valuetext="1 模糊" tabindex="0"><div class="fam-track"><div class="fam-tick" style="bottom:0%"></div><div class="fam-tick" style="bottom:33.3%"></div><div class="fam-tick" style="bottom:66.6%"></div><div class="fam-tick" style="bottom:100%"></div><div class="fam-thumb" style="--fam-fill:33%"></div></div><div class="fam-val">模糊</div></div>'

function frame(label, inner, kind) {
  return `<div class="pv-cell">
  <div class="pv-label">${label}</div>
  <div class="screen cards-screen pv-${kind}">
    <div class="q-top"><span class="q-count">1 / 29</span><span class="meta">${kind === 'forget' ? '遗忘回看 · 例句 → 释义' : '英→中 卡片'}</span></div>
    <div class="progress"><i style="width:3%"></i></div>
    <div class="meta cards-unit">Unit 1</div>
    <div class="cards-stage"><div class="study-card v5-card"><div class="v5-card-inner">${inner}</div></div></div>
  </div>
</div>`
}

const it = pick('interpret')
const alt = W.altSenseOf(it)
const front = frame('遗忘回看 · 正面',
  `<div class="v5-face v5-front is-forget"><div class="card-sentence">${W.highlightTerm((alt && alt.example) || it.sentence, it, alt)}</div><div class="card-hint">标出的词在这句里是什么意思？点卡片翻面</div></div>`, 'forget')

const back = (item, opts) => `<div class="v5-face v5-back">${W.cardBackHtml(item, Object.assign({ ctl: slider }, opts || {}))}</div>`
const cells = [
  ...['Propriety', 'interpret', 'senior', 'sacrifice'].map(pick).filter(Boolean)
    .map((c) => frame('卡背 · ' + c.term + '（' + c.senses.filter((s) => !s.dropped).length + ' 义项）', back(c), 'back'))
]

writeFileSync('ST/英语/_preview-v59.html', `<!doctype html><html><head><meta charset="utf-8">
<style>${css}
body{background:var(--bg);margin:0;padding:10px;display:flex;flex-wrap:wrap;gap:14px;align-items:flex-start}
.pv-cell{width:376px}
.pv-label{font:600 12px/1.4 system-ui;color:var(--muted);margin:2px 0 6px}
.screen{padding:0!important;max-width:none!important}
.study-card.v5-card{height:440px!important}
.pv-forget .v5-back,.pv-back .v5-front{display:none}
.pv-forget .v5-card-inner,.pv-back .v5-card-inner{transform:none}
.pv-back .v5-back{transform:none}
.cards-stage{height:auto}
.cards-screen{height:auto!important;min-height:0!important}
.cards-screen .v5-card{max-height:none!important}
.pv-cell{display:block}
</style></head><body>
${cells.join('\n')}
</body></html>`, 'utf8')
console.log('写出 _preview-v59.html')
