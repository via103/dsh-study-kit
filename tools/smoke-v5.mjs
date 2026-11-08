import fs from 'node:fs';
import vm from 'node:vm';
import { compileContent } from './build-word-review.mjs';
const raw = JSON.parse(fs.readFileSync('ST/英语/单词复习数据.v5-draft.json', 'utf8'));
const c = compileContent(raw, { dataDir: 'ST/英语', bookPath: 'ST/英语/词汇情景本.md', skipSourceCheck: true });
if (!c.ok) { console.error(c.errors); process.exit(1); }
const appSrc = fs.readFileSync('<study-plugins>/templates/word-review-app.js', 'utf8');
vm.runInThisContext(appSrc);
const W = globalThis.WordReview;
if (!W) { console.error('no api'); process.exit(1); }
let p = W.newProgress();
const unit = c.content.units.find(u => u.current);
let round = null, sessions = 0, seen = {};
for (let i = 0; i < 80; i++) {
  const b = W.buildSession(c.content, p, { unitId: unit.id, scope: 'all', limit: 4, audioAvailable: false, round, seed: 't' + i });
  if (!b.questions.length) break;
  sessions++;
  b.questions.forEach(q => { seen[q.itemId] = (seen[q.itemId] || 0) + 1; if (!q.options) {} else console.error('option in blind', q.type); });
  if (b.questions.length < 1) break;
  round = b.round;
  if (round.completedAt) break;
}
console.log('sessions', sessions, 'questions', c.content.questions.length, 'seen', Object.keys(seen).length, 'items', c.content.items.filter(i => i.testable && i.kind !== 'substitution' && i.kind !== 'knowledge').length);
console.log('round keys', round && round.keys.length, 'cursor', round && round.cursor, 'completed', !!(round && round.completedAt));
// pitfall options
const pit = W.buildSession(c.content, p, { unitId: unit.id, scope: 'pitfalls', limit: 4, audioAvailable: false, seed: 'pit' });
console.log('pitfall q', pit.questions.length, 'with options', pit.questions.filter(q => q.options).length);
// migration
const old = { schemaVersion: 3, items: { [unit.id]: { self: { level: 2, updatedAt: '2026-10-01T00:00:00Z' } } }, settings: { dailyCap: 12 }, history: [], units: {} };
const mp = W.ensureProgress(old);
console.log('migrate', mp && mp.schemaVersion, mp && Object.values(mp.items)[0] && Object.values(mp.items)[0].familiarity, mp && mp.settings.dailyCap);
