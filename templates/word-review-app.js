/* word-review-app.js — 英语单词复习站运行时（单文件内联；浏览器 + Node 纯函数两用）
 *
 * 浏览器：读取 window.__WORD_REVIEW__（构建器嵌入的 content），渲染 UI。
 * Node：不启动 DOM，只把纯函数挂到 globalThis.WordReview，供测试导入。
 *
 * 设计原则（见 单词复习站规范.md）：
 * - 一个 HTML 装全部 unit；首页列单元，点哪个复习哪个。
 * - 两种模式：e2c（英→中，认读） / c2e（中→英，产出）；mixed 只是交替。
 * - 每项两个独立 F 等级；升级必须有连续正确 + 对应难度证据。
 * - TTS 是增强；无 TTS 时 Q1 变文字题，audioOnly 题过滤。
 * - 依据：数据每题都有 basis；UI 只在代表性题内联显示，其余折叠。
 */
(function (root) {
  'use strict';

  var SCHEMA = 5;
  var FAM_SCALE = 4;
  var FAM_TOP = 3; // v5.8：最高档＝「非常熟悉」，排期从这里才开始
  var FORMAT_VERSION = 1;
  var FORMAT = 'dsh-word-review-progress';
  var KEY = 'dsh-word-review:v1';
  var FAM_LABELS = ['忘记', '模糊', '认识', '非常熟悉'];
  var FAM_NAMES = ['未评', '忘记', '模糊', '认识', '非常熟悉'];
  var DIFF_LABEL = { D1: 'D1 认读', D2: 'D2 语境', D3: 'D3 产出', D4: 'D4 辨析' };
  var MODE_LABEL = { e2c: '英→中', c2e: '中→英', mixed: '混合' };
  var SESSION_SIZE = 4;
  var SECTIONS = [
    { id: 'vocab', title: '词汇', order: 1 },
    { id: 'phrases', title: '短语与搭配', order: 2 },
    { id: 'substitutions', title: '高级替换', order: 3 },
    { id: 'patterns', title: '句式与金句', order: 4 },
    { id: 'contexts', title: '语境', order: 5 },
    { id: 'pitfalls', title: '易混易错', order: 6 },
    { id: 'sheng', title: '熟词生义', order: 7 },
    { id: 'culture', title: '文化与方法', order: 8 }
  ];

  // ───────────────────────── 基础工具 ─────────────────────────
  function pad(n) { return String(n).padStart(2, '0'); }
  function fmtDate(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function studyDate(now) {
    var d = now ? new Date(now) : new Date();
    if (d.getHours() < 4) d.setDate(d.getDate() - 1);
    return fmtDate(d);
  }
  function addDays(dateStr, n) {
    var d = new Date(dateStr + 'T12:00:00');
    d.setDate(d.getDate() + n);
    return fmtDate(d);
  }
  function daysBetween(a, b) {
    var x = new Date(a + 'T12:00:00').getTime();
    var y = new Date(b + 'T12:00:00').getTime();
    return Math.round((y - x) / 86400000);
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function normalizeAnswer(s) {
    return String(s == null ? '' : s)
      .toLowerCase()
      .replace(/[\s\u3000]+/g, '')
      .replace(/[^\w\u4e00-\u9fff]/g, '');
  }
  function splitAnswers(s) {
    if (Array.isArray(s)) return s.map(String).filter(Boolean);
    return String(s == null ? '' : s).split(/[；;、/|]/).map(function (x) { return x.trim(); }).filter(Boolean);
  }
  function answerMatches(input, answers) {
    var u = normalizeAnswer(input);
    if (!u) return false;
    var list = (Array.isArray(answers) ? answers : [answers]).filter(Boolean);
    for (var i = 0; i < list.length; i += 1) {
      var n = normalizeAnswer(list[i]);
      if (!n) continue;
      if (u === n) return true;
      if (u.length >= 2 && n.length >= 2 && (u.indexOf(n) >= 0 || n.indexOf(u) >= 0)) return true;
    }
    return false;
  }
  function hash(s) {
    var h = 2166136261;
    var str = String(s == null ? '' : s);
    for (var i = 0; i < str.length; i += 1) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }
  function seededShuffle(arr, seed) {
    var out = arr.slice();
    var x = hash(seed) || 1;
    for (var i = out.length - 1; i > 0; i -= 1) {
      x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
      var j = x % (i + 1);
      var t = out[i]; out[i] = out[j]; out[j] = t;
    }
    return out;
  }
  function weightedShuffle(rows, seed) {
    var pool = rows.slice();
    var out = [];
    var x = hash(seed) || 1;
    while (pool.length) {
      var total = pool.reduce(function (s, r) { return s + Math.max(0.05, Number(r.weight) || 1); }, 0);
      x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
      var pick = (x / 4294967296) * total;
      var acc = 0;
      var idx = 0;
      for (var i = 0; i < pool.length; i += 1) {
        acc += Math.max(0.05, Number(pool[i].weight) || 1);
        if (pick <= acc) { idx = i; break; }
      }
      out.push(pool.splice(idx, 1)[0]);
    }
    return out;
  }
  function unique(arr) { return Array.from(new Set(arr.filter(function (x) { return x !== undefined && x !== null && x !== ''; }))); }
  function uniq(arr) { return unique(arr); }
  function arr(x) { return Array.isArray(x) ? x : []; }
  function levelRank(d) { var n = Number(String(d || '').replace(/^D/, '')); return Number.isFinite(n) ? n : 1; }
  function clamp(n, a, b) { return Math.max(a, Math.min(b, Number(n) || 0)); }
  function fmtLevel(n) { return familiarityLabel(n); }
  function modeLabel(m) { return MODE_LABEL[m] || m; }

  // ───────────────────────── 熟悉度引擎（v5 唯一状态） ─────────────────────────
  function newItemProgress() {
    return {
      familiarity: null,
      familiaritySource: null,
      familiarityAt: null,
      spell: false,
      // v5.13：拼写本过关与三态（undefined=跟标签；true=手动加入；false=手动移出）。
      spellUserSet: null,
      spellPassed: false,
      spellPassedAt: null,
      spellAttempts: 0,
      mastered: false,
      seen: false,
      forgetRemain: false,
      lastTestAt: null,
      lastResult: null,
      lastReviewAt: null,
      nextDue: null,
      reviewInterval: null,
      reviewStreak: 0,
      lapses: 0,
      lastQuestionId: null,
      recentResults: [],
      evidence: [],
      legacy: { self: null, e2c: null, c2e: null }
    };
  }
  function clampFam(n) {
    if (n === null || n === undefined || n === '') return null;
    var v = Number(n);
    if (!Number.isFinite(v)) return null;
    return Math.max(0, Math.min(3, Math.round(v)));
  }
  function migrateItemProgress(ip, itemId) {
    var p = Object.assign(newItemProgress(), ip || {});
    if (p.familiarity === undefined || p.familiarity === null) {
      var legacy = p.legacy || {};
      var self = legacy.self || p.self;
      var e2c = legacy.e2c || p.e2c;
      var c2e = legacy.c2e || p.c2e;
      var fam = null;
      var seen = false;
      if (self && self.updatedAt) {
        fam = clampFam(self.level);
        seen = true;
      } else {
        var maxLevel = Math.max(Number(e2c && e2c.level) || 0, Number(c2e && c2e.level) || 0);
        var attempts = ((e2c && (e2c.right + e2c.wrong)) || 0) + ((c2e && (c2e.right + c2e.wrong)) || 0);
        if (maxLevel > 0) { fam = Math.min(3, maxLevel); seen = true; }
        else if (attempts > 0) { fam = 0; seen = true; }
      }
      p.familiarity = fam;
      p.familiaritySource = fam === null ? null : 'migrate';
      p.familiarityAt = fam === null ? null : new Date().toISOString();
      p.seen = seen || !!p.seen;
      p.legacy = { self: self || null, e2c: e2c || null, c2e: c2e || null };
    }
    p.familiarity = clampFam(p.familiarity);
    p.spell = p.spell === true;
    p.spellUserSet = (p.spellUserSet === true || p.spellUserSet === false) ? p.spellUserSet : null;
    p.spellPassed = p.spellPassed === true;
    p.spellPassedAt = p.spellPassedAt || null;
    p.spellAttempts = Number(p.spellAttempts) > 0 ? Math.floor(Number(p.spellAttempts)) : 0;
    p.mastered = p.mastered === true;
    p.seen = p.seen === true;
    p.recentResults = Array.isArray(p.recentResults) ? p.recentResults.slice(-5) : [];
    p.evidence = Array.isArray(p.evidence) ? p.evidence.slice(-40) : [];
    p.lastTestAt = p.lastTestAt || null;
    p.lastResult = p.lastResult || null;
    p.lastReviewAt = p.lastReviewAt || null;
    p.nextDue = p.nextDue || null;
    p.reviewInterval = Number(p.reviewInterval) > 0 ? Number(p.reviewInterval) : null;
    p.reviewStreak = Number(p.reviewStreak) > 0 ? Math.min(4, Math.floor(Number(p.reviewStreak))) : 0;
    p.lapses = Number(p.lapses) > 0 ? Math.floor(Number(p.lapses)) : 0;
    p.lastQuestionId = p.lastQuestionId || null;
    return p;
  }
  function ensureItemProgress(progress, itemId) {
    if (!progress.items) progress.items = {};
    if (!progress.items[itemId]) progress.items[itemId] = newItemProgress();
    progress.items[itemId] = migrateItemProgress(progress.items[itemId], itemId);
    return progress.items[itemId];
  }
  function ensureSections(progress) {
    if (!progress.sections) progress.sections = {};
    return progress.sections;
  }
  function ensureSectionItem(progress, sectionId, itemId) {
    var sections = ensureSections(progress);
    if (!sections[sectionId]) sections[sectionId] = { items: {} };
    if (!sections[sectionId].items) sections[sectionId].items = {};
    if (!sections[sectionId].items[itemId]) sections[sectionId].items[itemId] = newItemProgress();
    sections[sectionId].items[itemId] = migrateItemProgress(sections[sectionId].items[itemId], itemId);
    return sections[sectionId].items[itemId];
  }
  // 主板块（词汇/短语/句式/替换/文化）仍用 items；易混、熟词生义是同一 item 的第二技能，独立存。
  function isScopedSection(sectionId) { return sectionId === 'pitfalls' || sectionId === 'sheng'; }
  function stateFor(progress, item, sectionId) {
    if (isScopedSection(sectionId)) return ensureSectionItem(progress, sectionId, item.id);
    return ensureItemProgress(progress, item.id);
  }
  function stateOf(progress, itemId, sectionId) {
    if (isScopedSection(sectionId)) {
      var s = progress.sections && progress.sections[sectionId];
      var p = s && s.items && s.items[itemId];
      return p ? migrateItemProgress(p, itemId) : null;
    }
    var q = progress.items && progress.items[itemId];
    return q ? migrateItemProgress(q, itemId) : null;
  }
  function familiarityOf(progress, itemId, sectionId) {
    var p = stateOf(progress, itemId, sectionId);
    return p ? clampFam(p.familiarity) : null;
  }
  // v5.18 间隔阶梯：非常熟悉第一次回看 3 天，之后 7 / 15 / 30 / 60 天逐级拉长。
  // 旧版是一次性 30 天、之后 ×1.5（30→45→67→90），学员反馈“隔太久才复习”，改阶梯。
  var REVIEW_LADDER = [3, 7, 15, 30, 60];
  var REVIEW_BASE_DAYS = [1, 3, 7, 3];
  function baseInterval(fam) {
    var f = clampFam(fam);
    return REVIEW_BASE_DAYS[f === null ? 0 : f];
  }
  function reviewDueOf(p, today) {
    var f = p ? clampFam(p.familiarity) : null;
    if (p && p.mastered) return { state: 'mastered', due: false, overdueDays: 0, overdueRatio: 0, suggestedFamiliarity: null };
    var due = !p || !p.nextDue || p.nextDue <= today;
    var overdueDays = p && p.nextDue ? Math.max(0, daysBetween(p.nextDue, today)) : 0;
    var interval = p && Number(p.reviewInterval) > 0 ? Number(p.reviewInterval) : baseInterval(f);
    var ratio = overdueDays / Math.max(1, interval);
    var state = (!p || f === null) ? 'new' : (!p.nextDue || p.nextDue <= today ? (overdueDays > 0 ? 'overdue' : 'due') : 'scheduled');
    var suggestion = null;
    if (f !== null && f >= 1 && ratio >= 2) suggestion = Math.max(0, f - 1);
    return { state: state, due: due, overdueDays: overdueDays, overdueRatio: ratio, suggestedFamiliarity: suggestion };
  }
  function isDueReview(progress, item, sectionId) {
    var p = stateOf(progress, item.id, sectionId || item.sectionId);
    if (!p || p.mastered || p.familiarity === null || p.familiarity === undefined) return false;
    // 在遗忘回看里被评低的词，即使当前不到“非常熟悉”，也要留在遗忘池，
    // 直到它重新被评为“非常熟悉”。
    if (p.forgetRemain) return true;
    // v5.8：只有评到「非常熟悉」才开始计时；低于它的词留在卡片池，永不进遗忘池。
    if (clampFam(p.familiarity) !== FAM_TOP) return false;
    return !p.nextDue || p.nextDue <= studyDate();
  }
  function forgetDueSections(unitId) {
    var defs = [
      { id: 'vocab', title: '词汇' },
      { id: 'phrases', title: '短语与搭配' },
      { id: 'patterns', title: '句式与金句' },
      { id: 'pitfalls', title: '易混易错' },
      { id: 'sheng', title: '熟词生义' }
    ];
    return defs.map(function (d) {
      var items = state.content.items.filter(function (i) {
        if (i.unitId !== unitId || !i.testable || i.archived) return false;
        if (d.id === 'pitfalls') return i.kind === 'word' && (arr(i.confusables).length > 0 || !!i.error);
        if (d.id === 'sheng') return i.kind === 'word' && arr(i.senses).some(function (s) { return s.sheng === true && !s.dropped; });
        return i.sectionId === d.id;
      }).filter(function (i) { return isDueReview(state.progress, i, d.id); });
      return { id: d.id, title: d.title, count: items.length };
    });
  }

  function scheduleReview(p, level, today, opts) {
    var f = clampFam(level);
    var o = opts || {};
    var prevF = clampFam(prevFOf(p));
    var wasDue = !!p.nextDue && p.nextDue <= today;
    p.familiarity = f;
    p.familiaritySource = o.source || 'card';
    p.familiarityAt = new Date().toISOString();
    p.seen = true;
    p.lastReviewAt = today;
    if (f < FAM_TOP) {
      // 没到「非常熟悉」不计时 —— 留在卡片池继续练；评低也回到卡片池。
      p.nextDue = null;
      p.reviewInterval = null;
      p.reviewStreak = 0;
    } else if (wasDue && prevF === FAM_TOP) {
      // 到期回看仍评「非常熟悉」：沿阶梯升一级（3 → 7 → 15 → 30 → 60）。
      var streak = Math.min(REVIEW_LADDER.length - 1, (Number(p.reviewStreak) || 0) + 1);
      p.reviewStreak = streak;
      p.reviewInterval = REVIEW_LADDER[streak];
      p.nextDue = addDays(today, p.reviewInterval);
    } else if (p.nextDue) {
      // 未到期时再自评，不算一次成功回看：保留原排期，不提前也不延后。
      p.reviewInterval = Number(p.reviewInterval) > 0 ? Number(p.reviewInterval) : REVIEW_LADDER[Math.min(4, Number(p.reviewStreak) || 0)];
    } else {
      // 第一次评到「非常熟悉」：3 天后第一次回看。
      p.reviewStreak = 0;
      p.reviewInterval = REVIEW_LADDER[0];
      p.nextDue = addDays(today, p.reviewInterval);
    }
    if (o.wrong) p.lapses = (Number(p.lapses) || 0) + 1;
    return p;
  }
  function prevFOf(p) {
    // 迁移可能把 familiarity 存成字符串；比较前统一成数字。
    return p && p.familiarity !== null && p.familiarity !== undefined ? Number(p.familiarity) : null;
  }
  function scheduleTest(p, correct, today) {
    var todayStr = today || studyDate();
    // v5.8：盲测只记证据，不写排期 —— 否则答错一次就把词从卡片池踢进遗忘池。
    p.lastReviewAt = todayStr;
    if (!correct) p.lapses = (Number(p.lapses) || 0) + 1;
    return p;
  }
  function familiarityLabel(f) {
    if (f === null || f === undefined) return '未评';
    return FAM_NAMES[Math.max(0, Math.min(5, Number(f) + 1))] || '未评';
  }
  function setFamiliarity(progress, item, level, source, sectionId) {
    var p = stateFor(progress, item, sectionId);
    p.mastered = false;
    scheduleReview(p, level, studyDate(), { source: source || 'card' });
    if (clampFam(level) === FAM_TOP) p.forgetRemain = false;
    if (progress.meta) progress.meta.updatedAt = new Date().toISOString();
    return p;
  }
  // 遗忘回看专用：只有回到「非常熟悉」才算这一轮结束；评低则留在遗忘池。
  function setForgetFamiliarity(progress, item, level, sectionId, source) {
    var p = stateFor(progress, item, sectionId);
    p.mastered = false;
    scheduleReview(p, level, studyDate(), { source: source || 'forget' });
    p.forgetRemain = clampFam(level) < FAM_TOP;
    if (progress.meta) progress.meta.updatedAt = new Date().toISOString();
    return p;
  }
  function setMastered(progress, item, sectionId, on) {
    var p = stateFor(progress, item, sectionId);
    p.mastered = on !== false;
    p.forgetRemain = false;
    if (p.mastered) {
      p.familiarity = 3;
      p.familiaritySource = 'mastered';
      p.familiarityAt = new Date().toISOString();
      p.seen = true;
      p.lastReviewAt = studyDate();
      p.nextDue = null;
      p.reviewInterval = null;
    } else {
      scheduleReview(p, p.familiarity === null ? 3 : p.familiarity, studyDate(), { source: 'mastered-off' });
    }
    if (progress.meta) progress.meta.updatedAt = new Date().toISOString();
    return p;
  }
  function isMastered(progress, item, sectionId) {
    var p = stateOf(progress, item.id, sectionId || item.sectionId);
    return !!(p && p.mastered);
  }
  function setSpell(progress, item, on) {
    var p = ensureItemProgress(progress, item.id);
    // v5.13：三态 —— true=手动加入、false=手动移出、null=跟随 write 标签。
    p.spellUserSet = !!on;
    p.spell = !!on;
    p.seen = true;
    if (progress.meta) progress.meta.updatedAt = new Date().toISOString();
    return p;
  }
  function itemTags(item) { return arr(item && item.tags); }
  function hasTag(item, tag) { return itemTags(item).indexOf(tag) >= 0; }
  // 是否该出现在拼写本：手动设置优先，否则跟随“写作中掌握”标签。
  function spellActive(item, p) {
    if (p && p.spellUserSet === true) return true;
    if (p && p.spellUserSet === false) return false;
    return hasTag(item, 'write');
  }
  function shengSenses(item) {
    return arr(item && item.senses).filter(function (s) { return s.sheng === true && !s.dropped; });
  }
  function hasSheng(item) { return shengSenses(item).length > 0; }
  function posLabel(item) { return String((item && item.pos) || '').trim(); }
  function tagBadges(item) {
    var known = { write: '写', proper: '专', sheng: '生', collocation: '搭' };
    return itemTags(item).filter(function (t) { return known[t]; }).map(function (t) { return known[t]; });
  }
  function recordTest(progress, item, correct, question, today, sectionId) {
    var p = stateFor(progress, item, sectionId);
    var day = today || studyDate();
    p.seen = true;
    p.lastTestAt = day;
    p.lastQuestionId = question && question.id || p.lastQuestionId;
    p.lastResult = correct ? 'good' : 'again';
    p.recentResults.push({ at: p.lastTestAt, correct: !!correct, type: question && question.type || '', itemId: item.id, sectionId: sectionId || '' });
    if (p.recentResults.length > 5) p.recentResults.shift();
    p.evidence.push({
      at: p.lastTestAt,
      type: question && question.type || '',
      correct: !!correct,
      difficulty: question && question.difficulty || '',
      questionId: question && question.id || '',
      sectionId: sectionId || ''
    });
    if (p.evidence.length > 40) p.evidence.shift();
    if (question && question.type === 'spell-word') {
      p.spellAttempts = (Number(p.spellAttempts) || 0) + 1;
      if (correct) {
        p.spellPassed = true;
        p.spellPassedAt = day;
      }
    }
    scheduleTest(p, correct, day);
    if (progress.meta) progress.meta.updatedAt = new Date().toISOString();
    return p;
  }
  function recentCorrectCount(p) {
    return (p.recentResults || []).slice(-3).filter(function (r) { return r.correct; }).length;
  }
  function itemWeight(progress, itemId, sectionId) {
    var p = stateOf(progress, itemId, sectionId);
    var f = p ? clampFam(p.familiarity) : null;
    var base = f === null ? 3 : (f === 0 ? 3 : f === 1 ? 2.5 : f === 2 ? 2 : f === 3 ? 1 : 0);
    if (!p) return base;
    var w = base * Math.pow(0.55, recentCorrectCount(p));
    if (p.lastResult === 'again') w *= 1.6;
    if (p.nextDue && p.nextDue <= studyDate()) w *= 1.8;
    return Math.max(0.05, w);
  }
  function recommend(content, progress, unitId, today, opts) {
    var o = opts || {};
    var sectionId = o.sectionId || null;
    var items = content.items.filter(function (i) { return i.unitId === unitId && i.testable && !i.archived; });
    if (sectionId && sectionId !== 'pitfalls') items = items.filter(function (i) { return i.sectionId === sectionId; });
    if (sectionId === 'pitfalls') items = items.filter(function (i) { return i.kind === 'word' && ((i.confusables && i.confusables.length) || i.error); });
    var rows = [];
    var counts = { due: 0, weak: 0, new: 0, review: 0, mastered: 0, masteredTotal: 0, perfect: 0, forget: 0 };
    items.forEach(function (item) {
      var p = stateOf(progress, item.id, sectionId);
      var f = p ? clampFam(p.familiarity) : null;
      var due = reviewDueOf(p, today);
      if (p && p.mastered) { counts.perfect += 1; counts.masteredTotal += 1; return; }
      if (p && p.familiarity !== null && p.familiarity !== undefined && due.due) {
        counts.forget += 1;
        return;
      }
      if (f === 3) {
        counts.masteredTotal += 1;
        return;
      }
      var reason = (!p || !p.seen) ? 'new' : (p.lastResult === 'again' ? 'weak' : 'due');
      counts[reason] += 1;
      rows.push({ item: item, reason: reason, familiarity: f, weight: itemWeight(progress, item.id, sectionId), seen: !!(p && p.seen), due: due });
    });
    rows.sort(function (a, b) { return b.weight - a.weight || a.item.id.localeCompare(b.item.id); });
    return { items: rows, counts: counts, total: rows.length, sectionId: sectionId };
  }

  function questionFitsScope(q, scope, sectionId) {
    if (!q) return false;
    if (scope === 'spelling') return q.type === 'spell-word';
    if (scope === 'pitfalls') return q.type === 'pitfall-choice';
    if (scope === 'section') {
      if (sectionId === 'vocab') return q.type === 'word-cloze';
      if (sectionId === 'phrases') return q.type.indexOf('phrase-') === 0;
      if (sectionId === 'patterns') return q.type === 'recite-full';
      if (sectionId === 'pitfalls') return q.type === 'pitfall-choice';
      return false;
    }
    // 综合盲测只做基础盲测；拼写/易混是各自板块的专用题，不混入。
    return q.type !== 'spell-word' && q.type !== 'pitfall-choice';
  }
  function questionsFor(content, itemId, audioAvailable, allowOptions, scope, sectionId) {
    return content.questions.filter(function (q) {
      if (q.itemId !== itemId) return false;
      if (!questionFitsScope(q, scope, sectionId)) return false;
      if (q.audioOnly && !audioAvailable) return false;
      if (q.options && !allowOptions) return false;
      return true;
    });
  }
  function prepareQuestion(q, seed) {
    if (!q || !q.options || !q.options.length) return q;
    var pool = uniq((q.optionPool || q.options).slice());
    var correct = q.correctTerm || q.options[q.answer];
    if (!correct || pool.indexOf(correct) < 0) return q;
    var external = uniq(arr(q.externalTerms).filter(function (x) { return pool.indexOf(x) >= 0; }));
    var required = uniq(arr(q.requiredOptions).concat([q.targetTerm || '']).filter(function (x) { return x && x !== correct; }));
    required = required.filter(function (x) { return pool.indexOf(x) >= 0; });
    var n = Math.max(3, Math.min(5, Number(q.optionCount) || 4));
    n = Math.max(n, 1 + required.length);
    n = Math.min(5, Math.max(3, Math.min(n, pool.length)));
    var wrongs = required.slice();
    function addWrong(x) { if (x && x !== correct && wrongs.indexOf(x) < 0) wrongs.push(x); }
    // 至少两个站外项（correct 本身是站外时算一个）。
    var extInCorrect = external.indexOf(correct) >= 0 ? 1 : 0;
    var extWrongs = seededShuffle(external.filter(function (x) { return x !== correct; }), seed + '|ext');
    extWrongs.forEach(function (x) { if (wrongs.length < n - 1 && extInCorrect + wrongs.filter(function (y) { return external.indexOf(y) >= 0; }).length < 2) addWrong(x); });
    var filler = seededShuffle(pool.filter(function (x) { return x !== correct && wrongs.indexOf(x) < 0; }), seed + '|wrong');
    filler.forEach(function (x) { if (wrongs.length < n - 1) addWrong(x); });
    var opts2 = seededShuffle(uniq([correct].concat(wrongs)), seed + '|opts');
    return Object.assign({}, q, { options: opts2, answer: opts2.indexOf(correct), optionCount: opts2.length, optionPool: opts2.slice() });
  }
  function pickQuestion(content, progress, item, audioAvailable, allowOptions, seed, scope, sectionId) {
    var qs = questionsFor(content, item.id, audioAvailable, allowOptions, scope, sectionId);
    if (allowOptions) {
      var withOptions = qs.filter(function (q) { return q.options; });
      if (withOptions.length) qs = withOptions;
    }
    if (!qs.length) return null;
    var p = stateOf(progress, item.id, sectionId);
    var last = p && p.lastQuestionId;
    var fresh = qs.filter(function (q) { return q.id !== last; });
    var pool = fresh.length ? fresh : qs;
    var ordered = seededShuffle(pool, seed + '|' + item.id);
    return prepareQuestion(ordered[0], seed + '|' + item.id + '|' + (ordered[0] && ordered[0].id));
  }
  function roundPool(content, progress, opts) {
    var scope = opts.scope || 'all';
    var sectionId = opts.sectionId || null;
    var stateSection = scope === 'pitfalls' ? 'pitfalls' : sectionId;
    var today = studyDate();
    var items = content.items.filter(function (i) {
      return i.unitId === opts.unitId && i.testable && !i.archived && i.kind !== 'knowledge' && i.kind !== 'substitution';
    });
    if (scope === 'section') items = items.filter(function (i) { return i.sectionId === sectionId; });
    else if (scope === 'pitfalls') items = items.filter(function (i) { return i.kind === 'word' && ((i.confusables && i.confusables.length) || i.error); });
    else if (scope === 'item') items = items.filter(function (i) { return i.id === opts.itemId; });
    else if (scope === 'mastered') items = items.filter(function (i) { return familiarityOf(progress, i.id, stateSection) === 3; });
    else if (scope === 'spelling') items = items.filter(function (i) {
      if (i.kind !== 'word' && i.kind !== 'phrase') return false;
      var p = progress.items && progress.items[i.id];
      return spellActive(i, p) && !(p && p.spellPassed);
    });
    else {
      // 综合入口不再跨板块；只保留词汇，避免与拼写/易混/阅读混题。
      items = items.filter(function (i) { return i.sectionId === 'vocab'; });
    }
    if (scope !== 'spelling' && scope !== 'item') {
      items = items.filter(function (i) {
        if (opts.onlyDue) return isDueReview(progress, i, stateSection);
        if (isDueReview(progress, i, stateSection)) return false;
        var p = stateOf(progress, i.id, stateSection);
        if (p && p.mastered) return false;
        var f = p ? clampFam(p.familiarity) : null;
        var due = reviewDueOf(p, today).due;
        if (f === 3) return false;
        return due || !p || !p.seen;
      });
    }
    var allowOptions = scope === 'pitfalls' || (scope === 'section' && (sectionId === 'phrases' || sectionId === 'pitfalls'));
    items = items.filter(function (i) { return questionsFor(content, i.id, opts.audioAvailable !== false, allowOptions, scope, sectionId).length > 0; });
    var seen = {};
    items = items.filter(function (i) { if (seen[i.id]) return false; seen[i.id] = 1; return true; });
    if (scope === 'item' || scope === 'spelling') return items;
    items.sort(function (a, b) {
      return itemWeight(progress, b.id, stateSection) - itemWeight(progress, a.id, stateSection) || a.id.localeCompare(b.id);
    });
    return items;
  }
  function buildSession(content, progress, opts) {
    var o = opts || {};
    var unitId = o.unitId;
    var scope = o.scope || 'all';
    var limit = Math.max(1, Number(o.limit) || SESSION_SIZE);
    var seed = String(o.seed || (Date.now() + ':' + Math.random()));
    var audioAvailable = o.audioAvailable !== false;
    var pool = roundPool(content, progress, {
      unitId: unitId, scope: scope, sectionId: o.sectionId, itemId: o.itemId,
      includeMastered: o.includeMastered === true, audioAvailable: audioAvailable,
      onlyDue: o.onlyDue === true
    });
    var stateSection = scope === 'pitfalls' ? 'pitfalls' : (o.sectionId || null);
    var round = o.round && o.round.unitId === unitId && o.round.scope === scope && o.round.sectionId === (o.sectionId || '') ? o.round : null;
    if (!round || !Array.isArray(round.keys) || !round.keys.length) {
      var keyRows = pool.map(function (i) { return { id: i.id, weight: itemWeight(progress, i.id, stateSection) }; });
      // 全量轮：每个词恰好一次；权重只影响随机顺序，不删词。
      round = { id: 'r-' + Date.now().toString(36), unitId: unitId, scope: scope, sectionId: o.sectionId || '', keys: weightedShuffle(keyRows, seed + ':round').map(function (r) { return r.id; }), cursor: 0 };
    }
    var byId = {};
    pool.forEach(function (i) { byId[i.id] = i; });
    var start = Math.max(0, Number(round.cursor) || 0);
    var remaining = round.keys.slice(start).filter(function (id) { return !!byId[id]; });
    var keys = remaining.slice(0, limit);
    var selected = [];
    var cursor = start;
    keys.forEach(function (id) {
      var item = byId[id];
      if (!item) return;
      var allowOptions = scope === 'pitfalls' || (scope === 'section' && (o.sectionId === 'phrases' || o.sectionId === 'pitfalls'));
      var q = pickQuestion(content, progress, item, audioAvailable, allowOptions, seed + '|' + cursor, scope, o.sectionId);
      if (!q) return;
      q.sectionId = o.sectionId || (scope === 'pitfalls' ? 'pitfalls' : (item.sectionId || 'vocab'));
      selected.push({ item: item, question: q });
      cursor += 1;
    });
    var nextRound = { id: round.id, unitId: round.unitId, scope: round.scope, sectionId: round.sectionId, keys: round.keys.slice(), cursor: cursor };
    if (cursor >= round.keys.length) nextRound.completedAt = new Date().toISOString();
    var basisCounts = { due: 0, weak: 0, pitfall: 0, new: 0, other: 0 };
    selected.forEach(function (s) {
      var p = stateOf(progress, s.item.id, stateSection);
      var f = p ? clampFam(p.familiarity) : null;
      var r = (!p || !p.seen) ? 'new' : (p.lastResult === 'again' ? 'weak' : (f === 3 ? 'pitfall' : 'due'));
      if (basisCounts[r] != null) basisCounts[r] += 1; else basisCounts.other += 1;
    });
    return {
      questions: selected.map(function (s) { return s.question; }),
      selections: selected,
      round: nextRound,
      basisCounts: basisCounts
    };
  }

  // ───────────────────────── 汇总 / 进度 ─────────────────────────
  function sectionStat(content, progress, unitId, sectionId) {
    var all = content.items.filter(function (i) { return i.unitId === unitId && !i.archived; });
    if (sectionId === 'contexts') {
      var unit = content.units.filter(function (u) { return u.id === unitId; })[0];
      var rd = unit && unit.reading;
      var cs = rd && rd.parts ? rd.parts.length : content.contexts.filter(function (c) { return c.unitId === unitId; }).length;
      var rp = progress.sections && progress.sections.contexts && progress.sections.contexts.items && progress.sections.contexts.items[unitId];
      return { id: sectionId, count: cs, testable: 0, pct: 0, avg: 0, due: (!rp || !rp.nextDue || rp.nextDue <= studyDate()) ? 1 : 0 };
    }
    var today = studyDate();
    var list = all.filter(function (i) { return i.testable; });
    if (sectionId === 'pitfalls') list = list.filter(function (i) { return (i.confusables && i.confusables.length) || i.error; });
    else if (sectionId === 'sheng') list = all.filter(function (i) { return i.kind === 'word' && hasSheng(i); });
    else if (sectionId === 'culture') list = all.filter(function (i) { return i.kind === 'knowledge'; });
    else list = list.filter(function (i) { return i.sectionId === sectionId; });
    var sum = 0;
    var due = 0;
    list.forEach(function (i) {
      var p = stateOf(progress, i.id, sectionId);
      sum += (p && p.familiarity !== null && p.familiarity !== undefined ? p.familiarity : 0);
      if (reviewDueOf(p, today).due) due += 1;
    });
    var n = list.length || 1;
    return { id: sectionId, count: list.length, testable: list.length, avg: sum / n, pct: Math.round(100 * (sum / n) / 3), due: due };
  }
  function aggregateUnit(content, progress, unitId, today) {
    var items = content.items.filter(function (i) { return i.unitId === unitId && i.testable && !i.archived; });
    var dist = [0, 0, 0, 0, 0];
    var sum = 0;
    items.forEach(function (i) {
      var f = familiarityOf(progress, i.id);
      if (f === null) dist[0] += 1; else { dist[f + 1] += 1; sum += f; }
    });
    var n = items.length || 1;
    var sections = (content.sections || SECTIONS).map(function (s) { return sectionStat(content, progress, unitId, s.id); });
    return {
      itemCount: items.length,
      avg: sum / n,
      dist: dist,
      mastered: dist[4],
      retired: 0,
      sections: sections
    };
  }
  function newProgress() {
    return {
      schemaVersion: SCHEMA,
      famScale: FAM_SCALE,
      items: {},
      sections: {},
      units: {},
      history: [],
      settings: { ttsRate: 0.9, newPerDay: 6, lastMode: 'e2c', audio: 'auto', theme: 'auto', cardFace: true },
      meta: { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      orphans: {},
      ui: { sections: {}, session: null, cards: null, substitution: null, round: null }
    };
  }
  function migrateProgress(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, reason: '进度不是对象' };
    var p;
    try { p = JSON.parse(JSON.stringify(obj)); } catch (e) { return { ok: false, reason: '进度无法复制' }; }
    if (p.schemaVersion === 3) p.schemaVersion = 4;
    if (p.schemaVersion === 4) {
      p.schemaVersion = 5;
      p.settings = p.settings || {};
      delete p.settings.dailyCap;
      p.settings.theme = p.settings.theme || 'auto';
      p.settings.cardFace = p.settings.cardFace !== false;
      p.ui = p.ui && typeof p.ui === 'object' ? p.ui : {};
      p.orphans = p.orphans && typeof p.orphans === 'object' ? p.orphans : {};
    }
    if (p.schemaVersion !== SCHEMA) return { ok: false, reason: '进度版本不是 ' + SCHEMA + '（收到 ' + p.schemaVersion + '）' };
    if (!p.items || typeof p.items !== 'object') return { ok: false, reason: '进度缺 items' };
    return { ok: true, progress: p };
  }
  function ensureProgress(obj) {
    var m = migrateProgress(obj);
    if (!m.ok) return null;
    var p = m.progress;
    // v5.7: old 5-level familiarity -> 4-level. 0->0, 1/2->1, 3->2, 4->3.
    if (p.famScale !== FAM_SCALE) {
      var legacyMap = [0, 1, 1, 2, 3];
      function mapFam(ip) {
        if (!ip || ip.familiarity === null || ip.familiarity === undefined) return;
        var old = Number(ip.familiarity);
        if (!Number.isFinite(old)) return;
        ip.familiarity = legacyMap[Math.max(0, Math.min(4, Math.round(old)))];
        ip.familiaritySource = ip.familiaritySource || 'migrate-v57';
      }
      Object.keys(p.items || {}).forEach(function (id) { mapFam(p.items[id]); });
      Object.keys(p.sections || {}).forEach(function (sid) {
        var s = p.sections[sid];
        if (s && s.items) Object.keys(s.items).forEach(function (id) { mapFam(s.items[id]); });
      });
      p.famScale = FAM_SCALE;
    }
    // v5.8：排期只在「非常熟悉」才开始。旧进度里 0–2 分也写了 nextDue，导致这些词既不在卡池、又躺在遗忘池。
    if (p.poolModel !== 2) {
      var clearDue = function (ip) {
        if (!ip || ip.mastered) return;
        var lf = ip.familiarity;
        if (lf === null || lf === undefined) return;
        if (Number(lf) < FAM_TOP) { ip.nextDue = null; ip.reviewInterval = null; }
      };
      Object.keys(p.items || {}).forEach(function (id) { clearDue(p.items[id]); });
      Object.keys(p.sections || {}).forEach(function (sid) {
        var s0 = p.sections[sid];
        if (s0 && s0.items) Object.keys(s0.items).forEach(function (id) { clearDue(s0.items[id]); });
      });
      p.poolModel = 2;
    }
    // v5.18：旧排期（30 天起步、×1.5、最长 90）压回阶梯。非常熟悉一律从 7 天级重排，
    // 避免老进度继续“半个月/一个月才回看”；低档词照旧不排期、留在卡片池。
    if (p.scheduleModel !== 3) {
      var replan = function (ip) {
        if (!ip || ip.mastered) return;
        var lf = ip.familiarity;
        if (lf === null || lf === undefined) return;
        if (Number(lf) < FAM_TOP) { ip.nextDue = null; ip.reviewInterval = null; ip.reviewStreak = 0; return; }
        var streak = Number(ip.reviewStreak);
        if (!Number.isFinite(streak) || streak <= 0) streak = 1;
        ip.reviewStreak = Math.min(1, Math.max(0, Math.floor(streak)));
        ip.reviewInterval = REVIEW_LADDER[ip.reviewStreak];
        var anchor = ip.lastReviewAt || null;
        if (anchor) {
          var due = addDays(anchor, ip.reviewInterval);
          ip.nextDue = due < studyDate() ? studyDate() : due;
        } else {
          var existing = ip.nextDue || studyDate();
          var cap = addDays(studyDate(), ip.reviewInterval);
          ip.nextDue = existing > cap ? cap : existing;
          if (ip.nextDue < studyDate()) ip.nextDue = studyDate();
        }
      };
      Object.keys(p.items || {}).forEach(function (id) { replan(p.items[id]); });
      Object.keys(p.sections || {}).forEach(function (sid) {
        var s1 = p.sections[sid];
        if (s1 && s1.items) Object.keys(s1.items).forEach(function (id) { replan(s1.items[id]); });
      });
      p.scheduleModel = 3;
    }
    p.units = p.units && typeof p.units === 'object' ? p.units : {};
    p.history = Array.isArray(p.history) ? p.history : [];
    p.settings = Object.assign({ ttsRate: 0.9, newPerDay: 6, lastMode: 'e2c', audio: 'auto', theme: 'auto', cardFace: true }, p.settings || {});
    delete p.settings.dailyCap;
    p.meta = Object.assign({ createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, p.meta || {});
    p.sections = p.sections && typeof p.sections === 'object' ? p.sections : {};
    Object.keys(p.sections).forEach(function (sid) {
      var s = p.sections[sid];
      if (!s || typeof s !== 'object') { p.sections[sid] = { items: {} }; return; }
      if (!s.items || typeof s.items !== 'object') s.items = {};
      Object.keys(s.items).forEach(function (id) { s.items[id] = migrateItemProgress(s.items[id], id); });
    });
    p.ui = p.ui && typeof p.ui === 'object' ? p.ui : {};
    p.ui.sections = p.ui.sections && typeof p.ui.sections === 'object' ? p.ui.sections : {};
    p.ui.session = p.ui.session || null;
    p.ui.cards = p.ui.cards || null;
    p.ui.substitution = p.ui.substitution || null;
    p.ui.round = p.ui.round || null;
    p.orphans = p.orphans && typeof p.orphans === 'object' ? p.orphans : {};
    Object.keys(p.items).forEach(function (id) {
      p.items[id] = migrateItemProgress(p.items[id], id);
      var ip = p.items[id];
      // v5.8：只有「非常熟悉」才补到期日；低于它的词不排期，留在卡片池。
      if (ip && ip.seen && Number(ip.familiarity) === FAM_TOP && !ip.nextDue) ip.nextDue = studyDate();
    });
    Object.keys(p.sections || {}).forEach(function (sid) {
      var s = p.sections[sid];
      if (!s || !s.items) return;
      Object.keys(s.items).forEach(function (id) {
        var ip = s.items[id];
        if (ip && ip.seen && Number(ip.familiarity) === FAM_TOP && !ip.nextDue) ip.nextDue = studyDate();
      });
    });
    return p;
  }
  function exportProgress(progress) { return JSON.stringify(progress, null, 2); }
  function exportPortable(progress, contentVersion) {
    return JSON.stringify({
      format: FORMAT,
      formatVersion: FORMAT_VERSION,
      schemaVersion: SCHEMA,
      exportedAt: new Date().toISOString(),
      contentVersion: contentVersion || '',
      progress: progress
    }, null, 2);
  }
  function importProgress(text) {
    try {
      var s = String(text == null ? '' : text).replace(/^\uFEFF/, '');
      var obj = JSON.parse(s);
      var p;
      var sourceFormat = 'raw';
      var sourceVersion = 0;
      var sourceContentVersion = '';
      if (obj && obj.format === FORMAT) {
        sourceFormat = obj.format;
        sourceVersion = Number(obj.formatVersion) || 0;
        sourceContentVersion = obj.contentVersion || '';
        if (sourceVersion > FORMAT_VERSION) {
          return { ok: false, reason: '进度文件版本 ' + sourceVersion + ' 高于本页支持的 ' + FORMAT_VERSION + '，请用新版复习站导入' };
        }
        p = obj.progress;
      } else {
        p = obj;
      }
      var m = migrateProgress(p);
      if (!m.ok) return { ok: false, reason: m.reason };
      var payload = {
        ok: true,
        progress: ensureProgress(m.progress),
        sourceFormat: sourceFormat,
        sourceVersion: sourceVersion,
        sourceContentVersion: sourceContentVersion
      };
      if (!payload.progress) return { ok: false, reason: '进度迁移失败' };
      return payload;
    } catch (e) {
      return { ok: false, reason: '不是合法 JSON：' + (e && e.message ? e.message : '') };
    }
  }
  function progressStamp(p) {
    return (p && (p.familiarityAt || p.lastTestAt || p.lastReviewAt || p.readAt || p.lastReadAt)) || '';
  }
  function mergeProgress(current, incoming) {
    var base = ensureProgress(current) || newProgress();
    var inc = ensureProgress(incoming) || newProgress();
    var out = ensureProgress(JSON.parse(JSON.stringify(base))) || newProgress();
    var stats = { added: 0, updated: 0, orphans: 0 };
    Object.keys(inc.items || {}).forEach(function (id) {
      var a = out.items[id];
      var b = inc.items[id];
      if (!a) {
        out.items[id] = migrateItemProgress(JSON.parse(JSON.stringify(b)), id);
        stats.added += 1;
        return;
      }
      if (progressStamp(b) && (!progressStamp(a) || progressStamp(b) >= progressStamp(a))) {
        a.familiarity = b.familiarity;
        a.familiaritySource = b.familiaritySource;
        a.familiarityAt = b.familiarityAt;
        a.spell = b.spell;
        a.lastTestAt = b.lastTestAt;
        a.lastResult = b.lastResult;
        stats.updated += 1;
      }
      a.seen = a.seen || b.seen;
      var seen = {};
      (a.evidence || []).concat(b.evidence || []).forEach(function (e) { var k = e && (e.questionId || e.at + e.type); if (k) seen[k] = e; });
      a.evidence = Object.keys(seen).map(function (k) { return seen[k]; }).slice(-40);
      var rr = (a.recentResults || []).concat(b.recentResults || []);
      a.recentResults = rr.slice(-5);
    });
    Object.keys(inc.sections || {}).forEach(function (sid) {
      var isec = inc.sections[sid] || {};
      if (!out.sections[sid]) out.sections[sid] = { items: {} };
      var osec = out.sections[sid];
      if (!osec.items) osec.items = {};
      Object.keys(isec.items || {}).forEach(function (id) {
        var b = isec.items[id];
        var a = osec.items[id];
        if (!a) { osec.items[id] = JSON.parse(JSON.stringify(b)); stats.added += 1; return; }
        if (progressStamp(b) && (!progressStamp(a) || progressStamp(b) >= progressStamp(a))) {
          osec.items[id] = JSON.parse(JSON.stringify(b));
          stats.updated += 1;
        }
      });
      ['lastReadAt', 'nextDue', 'readCount'].forEach(function (k) {
        if (isec[k] && (!osec[k] || String(isec[k]) >= String(osec[k]))) osec[k] = isec[k];
      });
    });
    ['units', 'orphans'].forEach(function (k) {
      Object.keys(inc[k] || {}).forEach(function (id) {
        if (!out[k][id]) { out[k][id] = JSON.parse(JSON.stringify(inc[k][id])); if (k === 'orphans') stats.orphans += 1; }
      });
    });
    var hist = (out.history || []).concat(inc.history || []);
    var hseen = {};
    out.history = hist.filter(function (h) {
      var k = h && (h.at || '') + '|' + (h.unitId || '') + '|' + (h.mode || '') + '|' + (h.questions || '');
      if (hseen[k]) return false; hseen[k] = 1; return true;
    }).slice(-500);
    out.settings = Object.assign({}, out.settings, inc.settings || {});
    delete out.settings.dailyCap;
    out.meta = Object.assign({}, out.meta, { updatedAt: new Date().toISOString() });
    out.meta.createdAt = out.meta.createdAt || inc.meta.createdAt || new Date().toISOString();
    return { progress: ensureProgress(out) || out, stats: stats };
  }
  function replaceProgress(incoming) {
    var inc = ensureProgress(incoming) || newProgress();
    return ensureProgress(JSON.parse(JSON.stringify(inc))) || inc;
  }
  function buildReport(content, progress, unitId, today) {
    var unit = content.units.filter(function (u) { return u.id === unitId; })[0] || {};
    var hist = (progress.history || []).filter(function (h) { return h.unitId === unitId; }).slice(-7);
    var totalQ = 0, totalC = 0;
    hist.forEach(function (h) { totalQ += h.questions || 0; totalC += h.correct || 0; });
    var wrongs = [];
    Object.keys(progress.items || {}).forEach(function (id) {
      var p = progress.items[id];
      var item = content.items.filter(function (x) { return x.id === id; })[0];
      if (!item || item.unitId !== unitId) return;
      var wrong = (p.evidence || []).filter(function (e) { return !e.correct; }).length;
      if (wrong > 0) wrongs.push({ title: item.term || item.title || item.text, wrong: wrong });
    });
    wrongs.sort(function (a, b) { return b.wrong - a.wrong; });
    var lines = [];
    lines.push('【单词复习站周报】' + (unit.title || unitId));
    lines.push('本周做题 ' + hist.length + ' 次 / ' + totalQ + ' 题 / 正确 ' + totalC + (totalQ ? '（' + Math.round(100 * totalC / totalQ) + '%）' : ''));
    lines.push('最常错：' + (wrongs.slice(0, 3).map(function (w) { return w.title + '（' + w.wrong + '）'; }).join('、') || '无'));
    var counts = [0, 0, 0, 0, 0];
    Object.keys(progress.items || {}).forEach(function (id) {
      var ip = progress.items[id];
      var item = content.items.filter(function (x) { return x.id === id; })[0];
      if (!item || item.unitId !== unitId) return;
      counts[ip.familiarity === null || ip.familiarity === undefined ? 0 : ip.familiarity + 1] += 1;
    });
    lines.push('熟悉度：未评 ' + counts[0] + ' · 忘记 ' + counts[1] + ' · 模糊 ' + counts[2] + ' · 认识 ' + counts[3] + ' · 非常熟悉 ' + counts[4]);
    return lines.join('\n');
  }

  // ───────────────────────── UI ─────────────────────────
  var state = {
    content: null,
    progress: null,
    screen: 'home',
    params: {},
    mode: 'mixed',
    audioAvailable: false,
    storageOk: true,
    storageWarned: false,
    audioNotice: true,
    showBasis: {},
    session: null,
    lastSummary: null,
    forget: null,
    dictCard: null,
    dictMode: 'small',
    dictSection: 'vocab',
    dictAnchor: null,
    dictFlip: false,
    dictClosing: false,
    dictFlipping: false,
    themeVeil: null,
    cards: null,
    substitution: null,
    reading: null,
    modal: null,
    modalClosing: false,
    scrollY: 0
  };
  var refs = {};
  var lastRenderKey = '';
  var screenAnimTimer = null;
  var dictCloseTimer = null;
  var cardGesture = null;
  var suppressCardClick = false;
  var famDrag = null;
  var spellFxTimer = null;

  function contentSections() { return (state.content && state.content.sections) || SECTIONS; }
  function unitById(id) {
    return (state.content.units || []).filter(function (u) { return u.id === id; })[0] || null;
  }
  function currentUnit() {
    var units = state.content.units || [];
    return units.filter(function (u) { return u.current; })[0] || units[0] || null;
  }
  function itemById(id) {
    return (state.content.items || []).filter(function (i) { return i.id === id; })[0] || null;
  }
  function contextById(id) {
    return (state.content.contexts || []).filter(function (c) { return c.id === id; })[0] || null;
  }
  function sectionById(id) {
    return contentSections().filter(function (s) { return s.id === id; })[0] || { id: id, title: id };
  }
  function sectionTitleOf(id) { return sectionById(id).title; }
  function unitSections(unitId) {
    return contentSections();
  }
  function itemTitle(item) {
    if (!item) return '';
    if (item.kind === 'golden' && item.text) return item.text;
    return item.term || item.title || item.text || item.base || item.id;
  }
  function itemSub(item) {
    if (!item) return '';
    if (item.kind === 'golden') return item.translation || item.meaning || '';
    if (item.kind === 'knowledge') return item.summary || item.title || '';
    return item.meaning || item.translation || item.summary || (item.useCase && item.useCase.join(' / ')) || '';
  }
  function itemSenses(item) {
    if (!item || !Array.isArray(item.senses)) return [];
    return item.senses.filter(function (s) { return s && s.definition && !s.dropped; });
  }
  function senseListHtml(item) {
    var senses = itemSenses(item);
    if (!senses.length) {
      var fb = '';
      if (item.sentence) fb += '<div class="sense-fallback">' + highlight(item.sentence, item.surface || item.term || '') + '</div>';
      if (item.cue) fb += '<div class="sense-fallback-cue">' + esc(item.cue) + '</div>';
      return fb || '<div class="sense-empty">这个词的义项还在补充中。</div>';
    }
    return senses.map(function (s, i) {
      return '<div class="sense">'
        + '<div class="sense-def"><span class="sense-pos">' + esc(s.pos || '') + '</span>' + esc(s.definition || '') + '</div>'
        + (s.example ? '<div class="sense-ex">' + esc(s.example) + '</div>' : '')
        + (s.translation ? '<div class="sense-tr">' + esc(s.translation) + '</div>' : '')
        + '</div>';
    }).join('');
  }
  // v5.8：遗忘回看用「另一条例句」——优先靠后的义项（熟词僻义），且必须与卡片上的本单元语境句不同。
  function altSenseOf(item) {
    if (!item) return null;
    var pool = itemSenses(item).filter(function (s) { return s && s.example; });
    if (!pool.length) return null;
    var base = String(item.sentence || '').replace(/\s+/g, ' ').trim().toLowerCase();
    var alt = pool.filter(function (s) { return String(s.example).replace(/\s+/g, ' ').trim().toLowerCase() !== base; });
    if (!alt.length) return null;
    return alt.length > 1 ? alt[alt.length - 1] : alt[0];
  }
  // v5.9 卡背：上＝单词+音标+①②③释义（固定区，填不满留白）；下＝同序号例句+译文。不再放本单元语境句。
  function cardBackHtml(item, o) {
    o = o || {};
    var isForget = !!o.isForget;
    var senses = isForget ? (o.alt ? [o.alt] : []) : (o.onlySheng ? shengSenses(item) : itemSenses(item));
    var head = '<div class="v5-defs-head">'
      + '<div class="card-term">' + esc(itemTitle(item)) + '</div>'
      + (item.ipa ? '<div class="ref-ipa">' + esc(item.ipa) + '</div>' : '')
      + (!senses.length && !isForget && itemSub(item) ? '<div class="card-meaning">' + esc(itemSub(item)) + '</div>' : '')
      + '</div>';
    var defs;
    if (senses.length) {
      defs = '<ol class="sense-defs">' + senses.map(function (s) {
        return '<li><span class="sense-pos">' + esc(s.pos || '') + '</span>'
          + '<span class="sense-def-text">' + esc(s.definition || '') + '</span></li>';
      }).join('') + '</ol>';
    } else {
      defs = '<div class="sense-empty">' + (isForget ? '这条义项缺释义。' : '义项还在补充中。') + '</div>';
    }
    var examples;
    if (senses.length) {
      examples = '<ol class="sense-examples">' + senses.map(function (s) {
        if (!s.example) return '<li class="is-empty" aria-hidden="true"></li>';
        return '<li><div class="sense-ex">' + highlightTerm(s.example, item, s) + '</div>'
          + (s.translation ? '<div class="sense-tr">' + esc(s.translation) + '</div>' : '') + '</li>';
      }).join('') + '</ol>';
    } else if (item.sentence) {
      examples = '<div class="sense-examples-label">本单元语境</div>'
        + '<div class="sense-ex">' + highlightTerm(item.sentence, item) + '</div>';
    } else {
      examples = '<div class="sense-empty">暂无例句。</div>';
    }
    return '<div class="v5-back-grid">'
      + '<div class="v5-defs">' + head + defs + '</div>'
      + '<div class="v5-back-ctl">' + (o.ctl || '') + '</div>'
      + '<div class="v5-examples">' + examples + '</div>'
      + '</div>';
  }
  function cardSectionOf(c, item) {
    if (c && c.scope === 'forget') return (item && item.sectionId) || 'vocab';
    return (c && c.sectionId) || 'vocab';
  }
  function isForgetScope() { return !!(state.cards && state.cards.scope === 'forget'); }
  function fmtAvg(avg) { return (Math.round(avg * 10) / 10).toFixed(1) + ' / 3'; }
  function pct(n) { return Math.round(Number(n) || 0) + '%'; }

  // ── term index / 可点词 ────────────────────────────────────
  function termIndex() {
    if (state.content._termIndex) return state.content._termIndex;
    var map = new Map();
    (state.content.items || []).forEach(function (item) {
      var list = [item.term, item.base, item.surface].concat(item.alternatives ? item.alternatives.map(function (a) { return a.term; }) : []);
      list.forEach(function (t) {
        var s = String(t || '').trim();
        if (s.length < 2 || /[\u4e00-\u9fff]/.test(s)) return;
        var k = s.toLowerCase();
        if (!map.has(k)) map.set(k, item);
      });
    });
    state.content._termIndex = map;
    return map;
  }
  function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function linkTerms(text, opts) {
    var o = opts || {};
    var raw = String(text == null ? '' : text);
    if (!raw) return '';
    var map = termIndex();
    var terms = Array.from(map.keys()).sort(function (a, b) { return b.length - a.length; });
    var exclude = o.exclude ? String(o.exclude).toLowerCase() : '';
    if (exclude) terms = terms.filter(function (t) { return t !== exclude; });
    if (!terms.length) return esc(raw);
    var re = new RegExp('(' + terms.map(escapeRe).join('|') + ')', 'gi');
    var out = '';
    var last = 0;
    var m;
    while ((m = re.exec(raw)) !== null) {
      if (!m[0]) break;
      var hit = map.get(m[0].toLowerCase());
      if (!hit) continue;
      out += esc(raw.slice(last, m.index));
      out += '<button type="button" class="term" data-action="word" data-item="' + esc(hit.id) + '">' + esc(m[0]) + '</button>';
      last = m.index + m[0].length;
    }
    out += esc(raw.slice(last));
    return out;
  }
  function openCard(itemId, anchorEl) {
    var it = itemById(itemId);
    if (!it) return;
    clearTimeout(dictCloseTimer);
    state.dictCard = itemId;
    state.dictMode = 'small';
    state.dictReadOnly = false;
    state.dictSection = it.sectionId || 'vocab';
    state.dictAnchor = anchorEl && anchorEl.getBoundingClientRect ? anchorEl.getBoundingClientRect() : null;
    state.dictFlip = false;
    state.dictClosing = false;
    state.dictFlipping = false;
    renderOverlay();
  }
  function closeCard() {
    if (!state.dictCard || state.dictClosing) return;
    state.dictClosing = true;
    var layer = document.querySelector('.word-pop-layer') || document.querySelector('.dict-backdrop');
    var card = document.querySelector('.word-pop') || document.querySelector('.dict-card');
    if (layer) layer.classList.add('closing');
    if (card) card.classList.add('closing');
    clearTimeout(dictCloseTimer);
    dictCloseTimer = setTimeout(function () {
      state.dictCard = null;
      state.dictAnchor = null;
      state.dictFlip = false;
      state.dictFlipping = false;
      state.dictClosing = false;
      state.dictMode = 'small';
      renderOverlay();
    }, 155);
  }
  function closeModal() {
    if (!state.modal || state.modalClosing) return;
    state.modalClosing = true;
    renderOverlay();
    setTimeout(function () {
      state.modal = null;
      state.modalClosing = false;
      renderOverlay();
    }, 170);
  }
  function selfLabel(n) { return n === null || n === undefined ? '未评' : FAM_LABELS[Math.max(0, Math.min(3, Number(n)))]; }
  function selfButtons(self, sectionId) {
    return '<div class="self-grid four">' + [0, 1, 2, 3].map(function (n) {
      return '<button class="self-btn ' + (self === n ? 'on' : '') + '" data-action="card-self" data-level="' + n + '" data-section="' + esc(sectionId || '') + '">' + esc(selfLabel(n)) + '</button>';
    }).join('') + '</div>';
  }
  function renderWordPop() {
    var item = state.dictCard ? itemById(state.dictCard) : null;
    if (!item) return '';
    var sec = state.dictSection || item.sectionId || 'vocab';
    var self = familiarityOf(state.progress, item.id, sec);
    var mastered = isMastered(state.progress, item, sec);
    var html = '<div class="word-pop-layer' + (state.dictClosing ? ' closing' : '') + '" data-action="close-card"><div class="word-pop' + (state.dictClosing ? ' closing' : '') + '" data-action="card-inner">';
    html += '<div class="wp-head"><span class="wp-term">' + esc(itemTitle(item)) + '</span><button class="dict-x" data-action="close-card" aria-label="关闭">×</button></div>';
    html += '<div class="wp-meaning">' + esc(itemSub(item) || '（暂无释义）') + '</div>';
    html += '<div class="wp-self-label">熟悉度 <span class="meta self-current">' + esc(mastered ? '完全掌握' : selfLabel(self)) + '</span></div>';
    if (mastered) {
      html += '<div class="mastered-badge">完全掌握 · 不再进入遗忘复习</div>'
        + '<button class="btn ghost small" data-action="mastery-off" data-item="' + esc(item.id) + '" data-section="' + esc(sec) + '">取消完全掌握</button>';
    } else {
      html += famSlider(self, item.id, sec, { horizontal: true });
    }
    html += '</div></div>';
    return html;
  }
  function positionWordPop() {
    var el = document.querySelector('.word-pop');
    if (!el) return;
    var vw = window.innerWidth || 390;
    var vh = window.innerHeight || 700;
    var w = el.offsetWidth || 280;
    var h = el.offsetHeight || 170;
    var a = state.dictAnchor;
    var left, top;
    if (!a) {
      left = Math.max(8, (vw - w) / 2);
      top = Math.max(12, (vh - h) / 2);
    } else {
      left = clamp(a.left + a.width / 2 - w / 2, 8, Math.max(8, vw - w - 8));
      top = a.bottom + 10;
      if (top + h > vh - 12) top = a.top - h - 10;
      top = clamp(top, 12, Math.max(12, vh - h - 12));
    }
    el.style.left = Math.round(left) + 'px';
    el.style.top = Math.round(top) + 'px';
    requestAnimationFrame(function () { el.classList.add('show'); });
  }
  function renderDictCard() {
    var item = state.dictCard ? itemById(state.dictCard) : null;
    if (!item) return '';
    var sec = state.dictSection || item.sectionId || 'vocab';
    var self = familiarityOf(state.progress, item.id, sec);
    var mastered = isMastered(state.progress, item, sec);
    var html = '<div class="dict-backdrop medium' + (state.dictClosing ? ' closing' : '') + '" data-action="close-card"><div class="dict-card medium' + (state.dictClosing ? ' closing' : '') + '" data-action="card-inner">';
    html += '<div class="row between"><span class="tag">生词卡</span><button class="dict-x" data-action="close-card" aria-label="关闭">×</button></div>';
    html += '<div class="dict-term">' + esc(itemTitle(item)) + '</div>';
    if (item.ipa) html += '<div class="meta">' + esc(item.ipa) + '</div>';
    if (itemSub(item)) html += '<div class="dict-meaning">' + esc(itemSub(item)) + '</div>';
    if (itemSenses(item).length) html += '<div class="dict-senses">' + senseListHtml(item) + '</div>';
    else if (item.sentence) html += '<div class="context-box" style="margin-top:12px"><div class="cb-label">本单元语境</div><div class="cb-text">' + highlight(item.sentence, item.surface || item.term || '') + '</div></div>';
    if (!itemSenses(item).length && item.cue) html += '<div class="kv"><span class="k">画面</span><span class="v">' + esc(item.cue) + '</span></div>';
    if (!itemSenses(item).length && item.hook) html += '<div class="kv"><span class="k">钩子</span><span class="v">' + esc(item.hook) + '</span></div>';
    html += '<div class="row between" style="margin-top:14px"><h3 style="font-size:15px">熟悉度</h3><span class="meta self-current">' + esc(mastered ? '完全掌握' : selfLabel(self)) + '</span></div>';
    if (mastered) {
      html += '<div class="mastered-badge">完全掌握 · 不再进入遗忘复习</div>'
        + '<button class="btn ghost small" data-action="mastery-off" data-item="' + esc(item.id) + '" data-section="' + esc(sec) + '">取消完全掌握</button>';
    } else {
      html += famSlider(self, item.id, sec, { horizontal: true });
    }
    html += '</div></div>';
    return html;
  }
  function expandCard() {
    if (!state.dictCard) return;
    var fromEl = document.querySelector('.word-pop');
    var from = fromEl ? fromEl.getBoundingClientRect() : null;
    state.dictMode = 'detail';
    renderOverlay();
    if (!from || reducedMotion()) return;
    var card = document.querySelector('.dict-card.medium');
    if (!card) return;
    var to = card.getBoundingClientRect();
    if (!to.width || !to.height) return;
    var sx = from.width / to.width;
    var sy = from.height / to.height;
    var dx = from.left - to.left;
    var dy = from.top - to.top;
    try {
      card.animate([
        { transformOrigin: 'top left', transform: 'translate(' + dx + 'px,' + dy + 'px) scale(' + sx + ',' + sy + ')', opacity: .72 },
        { transformOrigin: 'top left', transform: 'none', opacity: 1 }
      ], { duration: 300, easing: 'cubic-bezier(.2,.7,.2,1)' });
    } catch (e) { /* visual only */ }
  }

  function levelBar(level, label, text) {
    var lv = level === null || level === undefined ? -1 : clamp(level, 0, 3);
    var filled = lv < 0 ? 0 : lv + 1;
    var segs = '';
    for (var i = 0; i < 4; i += 1) segs += '<i class="seg' + (i < filled ? ' on' : '') + '"></i>';
    return '<div class="levelbar"><span class="lb-label">' + esc(label || '') + '</span>'
      + '<div class="lb-track">' + segs + '</div>'
      + '<span class="lb-val">' + esc(text || '') + '</span></div>';
  }
  function levelPairFor(itemId, sectionId) {
    var f = familiarityOf(state.progress, itemId, sectionId);
    return '<div class="levelpair">'
      + '<div class="lp-row"><span class="lp-name">熟悉度</span>' + levelBar(f, '', '') + '<span class="lp-text">' + esc(fmtLevel(f)) + '</span></div>'
      + '</div>';
  }
  function miniBars(itemId, sectionId) {
    var f = familiarityOf(state.progress, itemId, sectionId);
    var filled = f === null ? 0 : f + 1;
    var s = '';
    for (var i = 0; i < 4; i += 1) s += '<i class="seg' + (i < filled ? ' on' : '') + '"></i>';
    return '<div class="ir-bars"><div class="levelbar thin"><div class="lb-track">' + s + '</div></div></div>';
  }
  function avgBar(label, avg) {
    var lv = Math.round(clamp(avg, 0, 3));
    var filled = avg <= 0 ? 0 : Math.min(4, lv + 1);
    var segs = '';
    for (var i = 0; i < 4; i += 1) segs += '<i class="seg' + (i < filled ? ' on' : '') + '"></i>';
    return '<div class="levelbar"><span class="lb-label">' + esc(label) + '</span>'
      + '<div class="lb-track">' + segs + '</div>'
      + '<span class="lb-val">' + esc(fmtAvg(avg)) + '</span></div>';
  }
  function sectionIcon(id) {
    var p = {
      vocab: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v16H6.5A2.5 2.5 0 0 0 4 21.5z"/><path d="M4 5.5v16"/>',
      phrases: '<path d="M9 15l6-6"/><path d="M10.5 7.5l1-1a3.5 3.5 0 0 1 5 5l-1 1"/><path d="M13.5 16.5l-1 1a3.5 3.5 0 0 1-5-5l1-1"/>',
      substitutions: '<path d="M4 8h13"/><path d="M14 5l3 3-3 3"/><path d="M20 16H7"/><path d="M10 13l-3 3 3 3"/>',
      patterns: '<path d="M12 3l8 4-8 4-8-4z"/><path d="M4 12l8 4 8-4"/><path d="M4 17l8 4 8-4"/>',
      golden: '<path d="M8 11H5a3 3 0 0 1 3-6h1v9a4 4 0 0 1-4 4"/><path d="M19 11h-3a3 3 0 0 1 3-6h1v9a4 4 0 0 1-4 4"/>',
      contexts: '<path d="M4 6h16"/><path d="M4 10h16"/><path d="M4 14h10"/><path d="M4 18h7"/>',
      pitfalls: '<path d="M12 3l9 16H3z"/><path d="M12 9v4"/><path d="M12 16h.01"/>',
      culture: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>'
    };
    return '<svg viewBox="0 0 24 24" aria-hidden="true">' + (p[id] || p.vocab) + '</svg>';
  }

  // ── chrome / router ─────────────────────────────────────────
  function setChrome(title, showBack) {
    if (refs.title) refs.title.textContent = title || '单词复习站';
    if (refs.back) {
      refs.back.style.visibility = showBack ? 'visible' : 'hidden';
      refs.back.setAttribute('aria-hidden', showBack ? 'false' : 'true');
    }
    var onSettings = state.screen === 'settings';
    if (refs.settings) refs.settings.hidden = onSettings;
    if (refs.theme) {
      refs.theme.hidden = !onSettings;
      if (onSettings) updateThemeToggle();
    }
  }
  function themeIconMarkup(theme) {
    if (theme === 'dark') {
      return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12.8A8.5 8.5 0 1 1 11.2 3a6.8 6.8 0 0 0 9.8 9.8z"/></svg>';
    }
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.66 6.34l1.41-1.41"/></svg>';
  }
  function updateThemeToggle() {
    if (!refs.theme) return;
    var current = resolvedTheme(state.progress.settings.theme || 'auto');
    refs.theme.innerHTML = themeIconMarkup(current);
    refs.theme.setAttribute('aria-label', current === 'dark' ? '切换到浅色' : '切换到深色');
    refs.theme.setAttribute('title', current === 'dark' ? '切换到浅色' : '切换到深色');
  }
  function rememberScroll() {
    state.scrollY = (() => { try { return window.scrollY || window.pageYOffset || 0; } catch (e) { return 0; } })();
    try {
      var st = history.state && typeof history.state === 'object' ? history.state : {};
      st.scrollY = state.scrollY;
      history.replaceState(st, '', location.href);
    } catch (e) { /* ignore */ }
  }
  function navigate(screen, params, push, opts) {
    var o = opts || {};
    rememberScroll();
    state.screen = screen;
    state.params = params || {};
    state.modal = null;
    state.modalClosing = false;
    state.dictCard = null;
    if (push !== false) {
      try { history.pushState({ screen: screen, params: state.params, scrollY: 0 }, '', location.href); } catch (e) { /* ignore */ }
    } else {
      try { history.replaceState({ screen: screen, params: state.params, scrollY: state.scrollY }, '', location.href); } catch (e) { /* ignore */ }
    }
    render();
    if (o.restore !== false) {
      try { window.scrollTo(0, 0); } catch (e) { /* ignore */ }
    }
  }
  function back() {
    if (state.dictCard) { closeCard(); return; }
    if (state.modal) { closeModal(); return; }
    if (state.screen === 'test' && state.session) {
      if (window.confirm('退出本次复习？已答的题已经保存。')) {
        state.session = null;
        try { history.back(); } catch (e) { navigate('unit', { unitId: state.params.unitId || (currentUnit() && currentUnit().id) }, false); }
      }
      return;
    }
    if (state.screen === 'cards' && state.cards && state.cards.scope === 'forget' && !state.cards.completed) {
      autoForgetOnAdvance();
    }
    if (state.screen === 'forget') {
      navigate('unit', { unitId: state.params.unitId || (currentUnit() && currentUnit().id) }, false);
      return;
    }
    if (state.screen === 'spelling' || state.screen === 'confusable') {
      navigate('unit', { unitId: state.params.unitId || (currentUnit() && currentUnit().id) }, false);
      return;
    }
    if (state.screen === 'summary') {
      var su = state.lastSummary && state.lastSummary.unitId || state.params.unitId || (currentUnit() && currentUnit().id);
      navigate('unit', { unitId: su }, false);
      return;
    }
    if (state.screen === 'home') {
      try { history.back(); } catch (e) { /* ignore */ }
      return;
    }
    try { history.back(); } catch (e) {
      navigate('unit', { unitId: state.params.unitId || (currentUnit() && currentUnit().id) }, false);
    }
  }

  // ── storage / audio ────────────────────────────────────────
  function loadProgress() {
    try {
      var raw = root.localStorage.getItem(KEY);
      if (!raw) return newProgress();
      var p = ensureProgress(JSON.parse(raw));
      if (!p) {
        try { root.localStorage.setItem(KEY + ':backup', raw); } catch (e) { /* ignore */ }
        return newProgress();
      }
      state.storageOk = true;
      return p;
    } catch (e) {
      state.storageOk = false;
      return newProgress();
    }
  }
  function saveProgress() {
    try {
      state.progress.meta.updatedAt = new Date().toISOString();
      root.localStorage.setItem(KEY, JSON.stringify(state.progress));
      state.storageOk = true;
      return true;
    } catch (e) {
      state.storageOk = false;
      if (!state.storageWarned) {
        state.storageWarned = true;
        toast('浏览器不允许本地存储：进度只在本次内存，结束前请导出');
      }
      return false;
    }
  }
  function contentVersion() {
    return (state.content && state.content.meta && state.content.meta.contentVersion) || '';
  }
  function backupKey(ts) { return KEY + ':backup:' + ts; }
  function saveBackup(progress, note) {
    try {
      var ts = new Date().toISOString().replace(/[:.]/g, '-');
      var payload = { at: new Date().toISOString(), note: note || '', contentVersion: contentVersion(), progress: progress };
      root.localStorage.setItem(backupKey(ts), JSON.stringify(payload));
      var keys = listBackupKeys();
      keys.slice(3).forEach(function (k) { try { root.localStorage.removeItem(k); } catch (e) { /* ignore */ } });
      return ts;
    } catch (e) { return ''; }
  }
  function listBackupKeys() {
    var out = [];
    try {
      for (var i = 0; i < root.localStorage.length; i += 1) {
        var k = root.localStorage.key(i);
        if (k && k.indexOf(KEY + ':backup:') === 0) out.push(k);
      }
    } catch (e) { /* ignore */ }
    return out.sort().reverse();
  }
  function listBackups() {
    return listBackupKeys().map(function (k) {
      try {
        var o = JSON.parse(root.localStorage.getItem(k));
        return { key: k, at: o.at || '', note: o.note || '', items: o.progress && o.progress.items ? Object.keys(o.progress.items).length : 0, contentVersion: o.contentVersion || '' };
      } catch (e) { return { key: k, at: '', note: '（损坏）', items: 0 }; }
    });
  }
  function restoreBackup(key) {
    try {
      var o = JSON.parse(root.localStorage.getItem(key));
      var p = ensureProgress(o.progress);
      if (!p) { toast('备份损坏，无法恢复'); return; }
      saveBackup(state.progress, '恢复前自动备份');
      state.progress = p;
      saveProgress();
      applyThemeAttrOnly();
      state.modal = null;
      render();
      toast('已恢复备份');
    } catch (e) { toast('恢复失败'); }
  }
  function applyThemeAttrOnly() {
    try { setThemeAttr(state.progress.settings.theme || 'auto'); } catch (e) { /* ignore */ }
  }
  function reducedMotion() {
    try { return !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { return false; }
  }
  function resolvedTheme(theme) {
    if (theme === 'light' || theme === 'dark') return theme;
    try { return root.matchMedia && root.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; } catch (e) { return 'light'; }
  }
  function setThemeAttr(theme) {
    var r = resolvedTheme(theme);
    try {
      document.documentElement.setAttribute('data-theme', r);
      document.documentElement.setAttribute('data-theme-setting', theme || 'auto');
    } catch (e) { /* ignore */ }
  }
  function themeAutoOn() { return (state.progress.settings.theme || 'auto') === 'auto'; }
  function updateThemeAutoSwitch() {
    var el = document.getElementById('theme-auto-switch');
    if (!el) return;
    var on = themeAutoOn();
    el.classList.toggle('on', on);
    el.setAttribute('aria-checked', on ? 'true' : 'false');
  }
  function applyTheme(theme, animate) {
    var oldResolved = resolvedTheme(state.progress.settings.theme || 'auto');
    state.progress.settings.theme = theme;
    var commit = function () {
      setThemeAttr(theme);
      updateThemeToggle();
      updateThemeAutoSwitch();
      setTimeout(saveProgress, 0);
    };
    var newResolved = resolvedTheme(theme);
    if (animate && oldResolved !== newResolved && !reducedMotion()) {
      var veil = document.createElement('div');
      veil.className = 'theme-veil';
      try {
        var bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
        if (bg) veil.style.background = bg;
      } catch (e) { /* visual only */ }
      if (state.themeVeil) state.themeVeil.remove();
      state.themeVeil = veil;
      document.body.appendChild(veil);
      void veil.offsetWidth;
      commit();
      setTimeout(function () { veil.classList.add('out'); }, 24);
      setTimeout(function () {
        veil.remove();
        if (state.themeVeil === veil) state.themeVeil = null;
      }, 380);
      return;
    }
    commit();
  }
  function quickTheme() {
    var current = resolvedTheme(state.progress.settings.theme || 'auto');
    if (refs.theme) {
      try {
        refs.theme.classList.remove('spin');
        void refs.theme.offsetWidth;
        refs.theme.classList.add('spin');
        setTimeout(function () { if (refs.theme) refs.theme.classList.remove('spin'); }, 460);
      } catch (e) { /* visual only */ }
    }
    applyTheme(current === 'dark' ? 'light' : 'dark', true);
  }

  function hasEnglishVoice() {
    try {
      var vs = root.speechSynthesis.getVoices() || [];
      return vs.some(function (v) { return /^en([-_]|$)/i.test(String(v.lang || '')); });
    } catch (e) { return false; }
  }
  function audioEnabled() {
    return state.audioAvailable && state.progress.settings.audio !== 'off';
  }
  function pickVoice() {
    try {
      var vs = root.speechSynthesis.getVoices() || [];
      return vs.filter(function (v) { return /^en[-_]US/i.test(String(v.lang || '')); })[0]
        || vs.filter(function (v) { return /^en/i.test(String(v.lang || '')); })[0]
        || null;
    } catch (e) { return null; }
  }
  function speak(text) {
    if (!audioEnabled() || !text) return;
    try {
      root.speechSynthesis.cancel();
      var u = new root.SpeechSynthesisUtterance(String(text));
      var v = pickVoice();
      if (v) u.voice = v;
      u.lang = (v && v.lang) || 'en-US';
      u.rate = Number(state.progress.settings.ttsRate) || 0.9;
      root.speechSynthesis.speak(u);
    } catch (e) { /* TTS is optional */ }
  }
  function initAudio() {
    if (!root.speechSynthesis) { state.audioAvailable = false; return; }
    state.audioAvailable = hasEnglishVoice();
    try {
      root.speechSynthesis.addEventListener('voiceschanged', function () {
        state.audioAvailable = hasEnglishVoice();
      });
    } catch (e) {
      try { root.speechSynthesis.onvoiceschanged = function () { state.audioAvailable = hasEnglishVoice(); }; } catch (e2) { /* ignore */ }
    }
  }

  // ── toast / misc ────────────────────────────────────────────
  var toastTimer = null;
  function toast(msg) {
    if (!refs.toast) return;
    refs.toast.textContent = msg;
    refs.toast.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { refs.toast.hidden = true; }, 2400);
  }
  function highlight(text, term) {
    var t = esc(text || '');
    var needle = esc(term || '');
    if (!needle) return t;
    var i = t.toLowerCase().indexOf(needle.toLowerCase());
    if (i < 0) return t;
    return t.slice(0, i) + '<span class="hit">' + t.slice(i, i + needle.length) + '</span>' + t.slice(i + needle.length);
  }
  // v5.9：短语条目（be grateful to sb for sth）带占位符，整串在例句里永远匹配不到 →
  // 先试整串，再退回「去掉占位符/虚词后最长的那个词」；命中多处则逐个包 hit。
  var HIGHLIGHT_STOP = {
    be: 1, to: 1, for: 1, the: 1, a: 1, an: 1, of: 1, in: 1, on: 1, at: 1, and: 1, or: 1,
    is: 1, are: 1, was: 1, were: 1, it: 1, that: 1, this: 1, with: 1, as: 1, by: 1, from: 1,
    one: 1, ones: 1, sth: 1, sb: 1, somebody: 1, something: 1, oneself: 1
  };
  function stripPhPlaceholders(s) {
    return String(s == null ? '' : s)
      .replace(/[（(][^)）]*[)）]/g, ' ')
      .replace(/\b(sb's|sb|sth's|sth|somebody's|somebody|something|one's|oneself)\b/gi, ' ');
  }
  function wrapHitRange(raw, start, len) {
    return esc(raw.slice(0, start)) + '<span class="hit">' + esc(raw.slice(start, start + len)) + '</span>' + esc(raw.slice(start + len));
  }
  function highlightTerm(text, item, sense) {
    var raw = String(text == null ? '' : text);
    if (!raw) return '';
    var cands = [];
    if (sense && sense.headword) cands.push(String(sense.headword));
    if (item) {
      ['surface', 'base', 'term'].forEach(function (k) { if (item[k]) cands.push(String(item[k])); });
    }
    cands = cands.map(function (c) { return c.replace(/[\u4e00-\u9fff]/g, '').trim(); }).filter(Boolean);
    if (!cands.length) return esc(raw);
    var ordered = cands.slice().sort(function (a, b) { return b.length - a.length; });
    for (var i = 0; i < ordered.length; i += 1) {
      var needle = stripPhPlaceholders(ordered[i]).replace(/\s+/g, ' ').trim();
      if (needle.length < 2) continue;
      var at = raw.toLowerCase().indexOf(needle.toLowerCase());
      if (at >= 0) return wrapHitRange(raw, at, needle.length);
    }
    var words = {};
    ordered.forEach(function (c) {
      stripPhPlaceholders(c).split(/[^A-Za-z'-]+/).forEach(function (w) {
        if (w.length >= 4 && !HIGHLIGHT_STOP[w.toLowerCase()]) words[w.toLowerCase()] = 1;
      });
    });
    var ranges = [];
    Object.keys(words).forEach(function (w) {
      var re = new RegExp('\\b' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'gi');
      var m;
      while ((m = re.exec(raw)) !== null) {
        ranges.push([m.index, m.index + m[0].length]);
        if (re.lastIndex <= m.index) re.lastIndex = m.index + 1;
      }
    });
    if (!ranges.length) return esc(raw);
    ranges.sort(function (a, b) { return a[0] - b[0]; });
    var merged = [ranges[0]];
    ranges.slice(1).forEach(function (r) {
      var last = merged[merged.length - 1];
      if (r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
      else merged.push(r);
    });
    var out = '', pos = 0;
    merged.forEach(function (r) {
      out += esc(raw.slice(pos, r[0])) + '<span class="hit">' + esc(raw.slice(r[0], r[1])) + '</span>';
      pos = r[1];
    });
    return out + esc(raw.slice(pos));
  }
  function tag(text, cls) { return '<span class="tag ' + (cls || '') + '">' + esc(text) + '</span>'; }
  function emptyState(text, action, label) {
    return '<div class="empty">' + esc(text) + (action ? '<div><button class="btn secondary small" data-action="' + action + '">' + esc(label || '返回') + '</button></div>' : '') + '</div>';
  }
  function footer() {
    var m = state.content.meta || {};
    return '<div class="footer">' + esc(m.contentVersion || '') + ' · 构建 ' + esc((m.buildTime || '').slice(0, 10))
      + ' · ' + (m.unitCount || state.content.units.length) + ' 单元 / ' + (m.itemCount || state.content.items.length) + ' 项'
      + '<br>熟悉度 0 忘记 · 1 模糊 · 2 认识 · 3 非常熟悉</div>';
  }
  function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { toast('已复制'); }, function () { fallbackCopy(text); });
      } else fallbackCopy(text);
    } catch (e) { fallbackCopy(text); }
  }
  function fallbackCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
      toast('已复制');
    } catch (e) { toast('复制失败，请手动选择文本'); }
  }

  // ── render ─────────────────────────────────────────────────
  function renderOverlay(forceCard) {
    if (!refs.overlay) return;
    var cardSlot = refs.overlay.querySelector('.ov-card-slot');
    if (!cardSlot) {
      refs.overlay.innerHTML = '<div class="ov-card-slot"></div><div class="ov-modal-slot"></div>';
      cardSlot = refs.overlay.querySelector('.ov-card-slot');
    }
    var modalSlot = refs.overlay.querySelector('.ov-modal-slot');
    var cardKey = state.dictCard ? (state.dictMode + '|' + state.dictCard + '|' + (state.dictClosing ? '1' : '0')) : '';
    if (forceCard || cardSlot.getAttribute('data-key') !== cardKey) {
      cardSlot.innerHTML = state.dictCard ? (state.dictMode === 'detail' ? renderDictCard() : renderWordPop()) : '';
      cardSlot.setAttribute('data-key', cardKey);
      if (state.dictCard && state.dictMode === 'small') requestAnimationFrame(positionWordPop);
    }
    // 模态层单独重建：开/关确认框绝不再重绘后面的知识卡，避免卡片闪一下。
    modalSlot.innerHTML = state.modal ? renderModal() : '';
  }
  function render() {
    if (!state.content || !state.progress) return;
    var screen = state.screen;
    var title = '单词复习站';
    var showBack = screen !== 'home';
    if (screen === 'unit') {
      var u = unitById(state.params.unitId);
      title = u ? u.title : '单元';
    } else if (screen === 'section') {
      title = sectionById(state.params.sectionId).title;
    } else if (screen === 'item') {
      var it = itemById(state.params.itemId);
      title = it ? itemTitle(it) : '条目';
    } else if (screen === 'test') {
      title = '复习';
    } else if (screen === 'summary') {
      title = '本次结果';
    } else if (screen === 'settings') {
      title = '设置';
    } else if (screen === 'forget') {
      title = '遗忘复习';
    } else if (screen === 'cards') {
      title = '卡片';
    } else if (screen === 'reading') {
      title = '大情景阅读';
    } else if (screen === 'substitution') {
      title = '高级替换';
    } else if (screen === 'spelling') {
      title = '拼写本';
    } else if (screen === 'confusable') {
      title = '易混卡片';
    }
    setChrome(title, showBack);
    var lockCards = screen === 'cards' && state.cards && !state.cards.completed;
    document.body.classList.toggle('cards-lock', !!lockCards);
    refs.screen.classList.toggle('cards-screen', !!lockCards);
    if (screen === 'test' && (!state.session || !state.session.questions || !state.session.questions.length)) {
      var uu = state.params.unitId || (currentUnit() && currentUnit().id);
      state.screen = uu ? 'unit' : 'home';
      state.params = uu ? { unitId: uu } : {};
      setChrome(state.screen === 'unit' ? '单元' : '单词复习站', state.screen !== 'home');
      return render();
    }
    var html = '';
    if (screen === 'home') html = renderHome();
    else if (screen === 'unit') html = renderUnit();
    else if (screen === 'section') html = renderSection();
    else if (screen === 'item') html = renderItem();
    else if (screen === 'test') html = renderTest();
    else if (screen === 'summary') html = renderSummary();
    else if (screen === 'forget') html = renderForget();
    else if (screen === 'settings') html = renderSettings();
    else if (screen === 'cards') html = renderCards();
    else if (screen === 'reading') html = renderReading();
    else if (screen === 'substitution') html = renderSubstitution();
    else if (screen === 'spelling') html = renderSpelling();
    else if (screen === 'confusable') html = renderConfusable();
    refs.screen.innerHTML = html;
    // 新卡入场用 Web Animations 明确从侧边进入；部分 Android WebView 对
    // “元素插入时已带 animation 类”不启动，故不再只依赖 CSS 类。
    if (screen === 'cards' && state.cards && state.cards.navEnter) {
      var enterEl = refs.screen.querySelector('.v5-card');
      var enterDir = state.cards.navEnter;
      if (enterEl && enterEl.animate) {
        enterEl.animate([
          { transform: enterDir === 'next' ? 'translateX(26%) scale(.985)' : 'translateX(-26%) scale(.985)', opacity: 0.25 },
          { transform: 'none', opacity: 1 }
        ], { duration: 340, easing: 'cubic-bezier(.2,.7,.2,1)' });
      } else if (enterEl) {
        enterEl.classList.add('card-enter-' + enterDir);
      }
    }
    updateThemeAutoSwitch();
    renderOverlay();
    var renderKey = screen + '|' + (state.params.unitId || '') + '|' + (state.params.sectionId || '') + '|' + (state.params.itemId || '') + '|' + (state.params.theme || '');
    if (renderKey !== lastRenderKey) {
      lastRenderKey = renderKey;
      refs.screen.classList.remove('screen-enter');
      void refs.screen.offsetWidth;
      refs.screen.classList.add('screen-enter');
      clearTimeout(screenAnimTimer);
      screenAnimTimer = setTimeout(function () { refs.screen.classList.remove('screen-enter'); }, 220);
    }
  }

  function renderHome() {
    var allUnits = (state.content.units || []);
    var topics = allUnits.filter(function (u) { return u.kind === 'topic'; });
    var transUnits = allUnits.filter(function (u) { return u.kind === 'translation'; });
    var units = allUnits.filter(function (u) { return u.kind !== 'topic' && u.kind !== 'translation'; }).sort(function (a, b) {
      return (b.current ? 1 : 0) - (a.current ? 1 : 0) || (a.order || 0) - (b.order || 0);
    });
    var today = studyDate();
    var html = '';
    if (!state.storageOk) {
      html += '<div class="notice">浏览器不允许本地存储：本次进度只在内存，结束前请到设置里导出。'
        + '<button class="btn ghost small" data-action="settings">去导出</button></div>';
    } else if (state.audioNotice && !state.audioAvailable && state.progress.settings.audio !== 'off') {
      html += '<div class="notice">没有检测到英语语音，已用文字模式；不影响做题。'
        + '<button class="btn ghost small" data-action="dismiss-audio">知道了</button></div>';
    }
    units.forEach(function (unit) {
      var agg = aggregateUnit(state.content, state.progress, unit.id, today);
      var rec = recommend(state.content, state.progress, unit.id, today, { sectionId: 'vocab' });
      var vocabCount = state.content.items.filter(function (i) { return i.unitId === unit.id && i.sectionId === 'vocab' && i.testable && !i.archived; }).length;
      var mastered = rec.counts.masteredTotal;
      var ft = forgetTotal(unit.id);
      html += '<div class="card unit-card" style="margin-top:12px">'
        + '<button class="card flat" data-action="unit" data-unit="' + esc(unit.id) + '" style="width:100%;text-align:left;padding:0">'
        + '<div class="uc-top"><div class="grow"><div class="uc-title">' + esc(unit.title) + '</div>'
        + '<div class="uc-theme">' + esc(unit.context && unit.context.theme || unit.theme || '') + '</div></div>'
        + (unit.current ? '<span class="current-pill">当前</span>' : '') + '</div>'
        + '<div class="uc-foot">' + tag((unit.status || ''), 'ok') + '<span class="uc-stat">词汇 ' + vocabCount + ' · 完全掌握 ' + mastered + '</span></div>'
        + '</button>'
        + '<div style="margin-top:10px">' + avgBar('词汇', sectionStat(state.content, state.progress, unit.id, 'vocab').avg) + '</div>'
        + '<div class="uc-foot" style="margin-top:10px"><div class="row wrap grow"><span class="meta">词汇待复习 ' + rec.total + ' · 遗忘 ' + ft + ' · 新词 ' + rec.counts.new + '</span></div>'
        + (function () { var cc = activeCardSession(unit.id, 'vocab'); return '<button class="btn primary small" data-action="cards" data-unit="' + esc(unit.id) + '" data-section="vocab">' + (cc ? '继续词汇卡' : '词汇卡片') + '</button>'; })()
        + '<button class="btn ghost small" data-action="forget" data-unit="' + esc(unit.id) + '">遗忘复习 ' + ft + '</button>'
        + '</div></div>';
    });
    // v5.10：专题（题目汇总）与单元平行，单独一组，不占「当前单元」。
    if (topics.length) {
      html += '<div class="meta" style="margin-top:18px;letter-spacing:.06em">专题 · 题目汇总</div>';
      topics.forEach(function (t) {
        var rec = recommend(state.content, state.progress, t.id, today, { sectionId: 'vocab' });
        var n = state.content.items.filter(function (i) { return i.unitId === t.id && !i.archived; }).length;
        var ft = forgetTotal(t.id);
        var cc = activeCardSession(t.id, 'vocab');
        html += '<div class="card unit-card" style="margin-top:12px">'
          + '<button class="card flat" data-action="unit" data-unit="' + esc(t.id) + '" style="width:100%;text-align:left;padding:0">'
          + '<div class="uc-top"><div class="grow"><div class="uc-title">' + esc(t.title) + '</div>'
          + '<div class="uc-theme">' + esc(t.theme || '') + '</div></div><span class="tag">专题</span></div>'
          + '<div class="uc-foot"><span class="uc-stat">' + n + ' 条 · 完全掌握 ' + rec.counts.masteredTotal + ' · 新词 ' + rec.counts.new + '</span></div>'
          + '</button>'
          + '<div class="uc-foot" style="margin-top:10px"><div class="row wrap grow"><span class="meta">待复习 ' + rec.total + ' · 遗忘 ' + ft + '</span></div>'
          + '<button class="btn primary small" data-action="cards" data-unit="' + esc(t.id) + '" data-section="vocab">' + (cc ? '继续卡片' : '卡片') + '</button>'
          + '<button class="btn ghost small" data-action="forget" data-unit="' + esc(t.id) + '">遗忘复习 ' + ft + '</button>'
          + '</div></div>';
      });
    }
    // v5.12：翻译专项（资料书的主题词汇）单独一组，卡片默认中→英。
    if (transUnits.length) {
      html += '<div class="meta" style="margin-top:18px;letter-spacing:.06em">翻译专项 · 中→英</div>';
      transUnits.forEach(function (t) {
        var rec = recommend(state.content, state.progress, t.id, today, { sectionId: 'vocab' });
        var n = state.content.items.filter(function (i) { return i.unitId === t.id && !i.archived; }).length;
        var ft = forgetTotal(t.id);
        var cc = activeCardSession(t.id, 'vocab');
        html += '<div class="card unit-card" style="margin-top:12px">'
          + '<button class="card flat" data-action="unit" data-unit="' + esc(t.id) + '" style="width:100%;text-align:left;padding:0">'
          + '<div class="uc-top"><div class="grow"><div class="uc-title">' + esc(t.title) + '</div>'
          + '<div class="uc-theme">' + esc(t.theme || '') + '</div></div><span class="tag">翻译</span></div>'
          + '<div class="uc-foot"><span class="uc-stat">' + n + ' 条 · 完全掌握 ' + rec.counts.masteredTotal + ' · 新词 ' + rec.counts.new + '</span></div>'
          + '</button>'
          + '<div class="uc-foot" style="margin-top:10px"><div class="row wrap grow"><span class="meta">待复习 ' + rec.total + ' · 遗忘 ' + ft + '</span></div>'
          + '<button class="btn primary small" data-action="cards" data-unit="' + esc(t.id) + '" data-section="vocab">' + (cc ? '继续中→英' : '中→英 卡片') + '</button>'
          + '<button class="btn ghost small" data-action="forget" data-unit="' + esc(t.id) + '">遗忘复习 ' + ft + '</button>'
          + '</div></div>';
      });
    }
    // v5.13：随时复习 —— 随机抽 n 张单词卡，不看到期。
    var rcfg = randomCfg();
    var rSaved = activeRandomSaved();
    var scopeUnits = allUnits.filter(function (u) { return randomUnitPool(u.id).length > 0; });
    html += '<div class="card" style="margin-top:16px"><h3>随时复习</h3>'
      + '<p class="meta">从单词里随机抽若干张卡片，不按到期；翻面看释义与例句，评熟悉度。</p>'
      + '<div class="row wrap" style="margin-top:10px">'
      + '<button class="' + (rcfg.scope === 'all' ? 'btn primary small' : 'btn ghost small') + '" data-action="random-scope" data-scope="all">全部单词</button>';
    scopeUnits.forEach(function (u) {
      html += '<button class="' + (rcfg.scope === u.id ? 'btn primary small' : 'btn ghost small') + '" data-action="random-scope" data-scope="' + esc(u.id) + '">' + esc(u.title) + '</button>';
    });
    html += '</div><div class="row wrap" style="margin-top:8px">';
    [10, 20, 30, 50].forEach(function (n) {
      html += '<button class="' + (rcfg.n === n ? 'btn primary small' : 'btn ghost small') + '" data-action="random-count" data-n="' + n + '">' + n + ' 张</button>';
    });
    html += '</div><div class="row between" style="margin-top:10px"><span class="meta">'
      + (rSaved ? '上次 ' + rSaved.order.length + ' 张，进行到第 ' + (Number(rSaved.index) + 1) + ' 张' : '将随机 ' + Math.min(rcfg.n, randomUnitPool(rcfg.scope).length) + ' 张')
      + '</span>'
      + (rSaved ? '<button class="btn primary small" data-action="random-continue">继续</button>' : '<button class="btn primary small" data-action="random-start">开始</button>')
      + '</div></div>';
    html += footer();
    return html;
  }

  function forgetTotal(unitId) {
    return forgetDueSections(unitId).reduce(function (n, s) { return n + s.count; }, 0);
  }

  function renderForget() {
    var unit = unitById(state.params.unitId) || currentUnit();
    if (!unit) return emptyState('没有单元。', 'home', '回首页');
    var secs = forgetDueSections(unit.id);
    var stored = state.forget && state.forget.unitId === unit.id && Array.isArray(state.forget.sections);
    var chosen = stored ? state.forget.sections.slice() : secs.filter(function (s) { return s.count > 0; }).map(function (s) { return s.id; });
    chosen = chosen.filter(function (id) { return secs.some(function (s) { return s.id === id && s.count > 0; }); });
    // v5.9.1：首次进入时把默认勾选写进 state；否则 forget-toggle 会因 state.forget 不存在而直接 return。
    if (!stored) state.forget = { unitId: unit.id, sections: chosen.slice() };
    else state.forget.sections = chosen.slice();
    var total = secs.reduce(function (n, s) { return n + s.count; }, 0);
    var html = '<div class="card"><h3>遗忘回看</h3>'
      + '<p class="meta">只放<b>已经评到「非常熟悉」</b>的词。第一次 3 天后回看，之后 7 / 15 / 30 / 60 天逐级拉长；回看时用一个你没见过的例句考同一个词的另一个义项，不用拼写。</p></div>';
    if (!total) {
      html += '<div class="card center"><div class="summary-big">0</div><p>还没有词评到「非常熟悉」，所以暂时没有该回看的词。</p>'
        + '<p class="meta">先在词汇卡片里把词练到「非常熟悉」，它们才会开始计时。</p>'
        + '<button class="btn primary" data-action="unit" data-unit="' + esc(unit.id) + '">回单元</button></div>';
      html += footer();
      return html;
    }
    html += '<div class="card"><div class="row between"><h3>选择板块</h3><span class="meta">到期 ' + total + ' 项</span></div>';
    secs.forEach(function (s) {
      if (!s.count) return;
      var on = chosen.indexOf(s.id) >= 0;
      html += '<label class="forget-row"><input type="checkbox" data-action="forget-toggle" data-section="' + esc(s.id) + '"' + (on ? ' checked' : '') + '>'
        + '<span class="grow"><b>' + esc(s.title) + '</b><span class="meta">到期 ' + s.count + ' 项</span></span></label>';
    });
    html += '<div class="row between" style="margin-top:10px"><button class="btn ghost small" data-action="forget-all">全选</button>'
      + '<button class="btn ghost small" data-action="forget-none">清空</button></div></div>';
    html += '<button class="btn primary block" data-action="start-forget" style="margin-top:12px">开始回看（' + total + ' 张卡）</button>';
    html += '<div class="meta" style="margin-top:10px">回看只是卡片：正面例句、背面释义。评到「非常熟悉」就结束这个词；评低会留在遗忘复习，直到再次评到「非常熟悉」。阅读到期仍回阅读板块。</div>';
    html += footer();
    return html;
  }

  function forgetCardItems(unitId, sections) {
    var pick = {};
    (sections && sections.length ? sections : ['vocab', 'phrases', 'patterns', 'pitfalls']).forEach(function (sid) { pick[sid] = 1; });
    return state.content.items.filter(function (i) {
      if (i.unitId !== unitId || !i.testable || i.archived) return false;
      if (!pick[i.sectionId]) return false;
      return isDueReview(state.progress, i, i.sectionId);
    });
  }
  // v5.8：遗忘回看 = 卡片流（正面另例句、背面释义），不再生成题目、不拼写。
  function startForget(unitId, sections) {
    var old = savedCardSession(unitId, 'forget');
    var want = (sections || []).slice().sort().join('|');
    var oldWant = old && Array.isArray(old.sectionIds) ? old.sectionIds.slice().sort().join('|') : '';
    // 只有同一组板块才续上旧卡片；改了勾选就按新选择重建，不能继续拿旧 order。
    if (old && !old.completed && oldWant === want && Array.isArray(old.order) && old.order.length) {
      // 未完成的一轮保留原来的顺序/断点；期间新到期的词追加在队尾，
      // 旧词仍是到期状态就留在原位置，不会因为新词进来被冲掉。
      var merged = old.order.slice();
      var seen = {};
      merged.forEach(function (id) { seen[id] = 1; });
      forgetCardItems(unitId, sections).forEach(function (i) {
        if (!seen[i.id]) { merged.push(i.id); seen[i.id] = 1; }
      });
      var still = merged.filter(function (id) {
        var it = itemById(id);
        return !!it && isDueReview(state.progress, it, it.sectionId);
      });
      if (still.length) {
        state.cards = {
          unitId: unitId, sectionId: 'forget', scope: 'forget',
          sectionIds: (old.sectionIds || sections || []).slice(),
          order: still, index: Math.min(Number(old.index) || 0, still.length - 1), completed: false,
          roundNo: Number(old.roundNo) || 1, startedAt: old.startedAt || new Date().toISOString(),
          flips: copyFlips(old.flips), navLock: false, navEnter: null
        };
        persistCards();
        navigate('cards', { unitId: unitId, sectionId: 'forget' }, true);
        return;
      }
    }
    var items = forgetCardItems(unitId, sections);
    if (!items.length) { toast('这些板块暂时没有到期词'); return; }
    var order = seededShuffle(items.map(function (i) { return i.id; }), 'forget-' + Date.now());
    state.cards = {
      unitId: unitId, sectionId: 'forget', scope: 'forget', sectionIds: (sections || []).slice(),
      order: order, index: 0, completed: false, roundNo: 1,
      startedAt: new Date().toISOString(), flips: {}, navLock: false, navEnter: null
    };
    persistCards();
    navigate('cards', { unitId: unitId, sectionId: 'forget' }, true);
  }

  function renderUnit() {
    var unit = unitById(state.params.unitId) || currentUnit();
    if (!unit) return emptyState('还没有单元数据。', 'home', '回首页');
    var today = studyDate();
    var agg = aggregateUnit(state.content, state.progress, unit.id, today);
    var rec = recommend(state.content, state.progress, unit.id, today, { sectionId: 'vocab' });
    var c = rec.counts;
    var dist = agg.dist;
    var vocabItems = state.content.items.filter(function (i) { return i.unitId === unit.id && i.sectionId === 'vocab' && i.testable && !i.archived; });
    var vocabCount = vocabItems.length;
    var vdist = [0, 0, 0, 0, 0];
    var vsum = 0;
    vocabItems.forEach(function (i) { var vf = familiarityOf(state.progress, i.id, 'vocab'); if (vf === null) vdist[0] += 1; else { vdist[vf + 1] += 1; vsum += vf; } });
    var vavg = vocabCount ? vsum / vocabCount : 0;
    var mastered = c.masteredTotal;
    var ft = forgetTotal(unit.id);
    var html = '';
    html += '<div class="row between" style="margin-top:2px"><div class="grow"><div class="meta">' + esc(unit.context && unit.context.setting || '') + '</div></div>'
      + '<span class="current-pill">' + esc(unit.status || '') + '</span></div>';
    html += '<div class="card unit-hero">'
      + '<div class="uh-head"><div><div class="uh-title">词汇卡片</div><div class="uh-sub">只练单词 · 不混句式/金句</div></div></div>'
      + '<div class="uh-copy">正面只看词或释义，翻面看例句与画面，再评熟悉度。</div>'
      + '<div class="uh-stats">'
      + '<div class="uh-stat"><b>' + c.new + '</b><span>新词</span></div>'
      + '<div class="uh-stat"><b>' + (vdist[1] + vdist[2] + vdist[3]) + '</b><span>待练到 3 分</span></div>'
      + '<div class="uh-stat"><b>' + ft + '</b><span>待回看</span></div>'
      + '<div class="uh-stat"><b>' + mastered + '</b><span>完全掌握</span></div>'
      + '</div>'
      + '<button class="btn primary block uh-main" data-action="cards" data-unit="' + esc(unit.id) + '" data-section="vocab">' + (function () { var cc = activeCardSession(unit.id, 'vocab'); return cc ? '继续词汇卡 · 第 ' + (Number(cc.index) + 1) + ' / ' + cc.order.length + ' 张' : '开始词汇卡片'; })() + '</button>'
      + '<div class="uh-actions">'
      + '<button class="uh-action" data-action="quick" data-unit="' + esc(unit.id) + '">词汇盲测<span>4 题</span></button>'
      + '<button class="uh-action" data-action="spelling" data-unit="' + esc(unit.id) + '">拼写</button>'
      + (unit.reading ? '<button class="uh-action" data-action="reading" data-unit="' + esc(unit.id) + '">大阅读</button>' : '')
      + '</div>'
      + '<button class="uh-forget" data-action="forget" data-unit="' + esc(unit.id) + '"><span>遗忘复习 · ' + ft + ' 项到期</span><em>去复习 ›</em></button>'
      + '</div>';
    html += '<div class="card unit-fam"><div class="row between"><h3>词汇熟悉度</h3><span class="meta">' + vocabCount + ' 词</span></div>'
      + '<div class="uh-avg">' + avgBar('词汇', vavg) + '</div>'
      + '<div class="meta uh-dist">' + [0, 1, 2, 3, 4].map(function (n) { return (n === 0 ? '未评' : selfLabel(n - 1)) + ' ' + vdist[n]; }).join(' · ') + '</div>'
      + '<div class="row end" style="margin-top:10px"><button class="btn ghost small" data-action="section" data-unit="' + esc(unit.id) + '" data-section="vocab">词库 · 全部词条 ›</button></div></div>';
    html += '<div class="section-title"><h2>' + (unitSections(unit.id).filter(function (s) { return s.id !== 'vocab'; }).length) + '板块</h2><span class="meta">点板块进练习</span></div>';
    html += '<div class="section-grid">';
    unitSections(unit.id).filter(function (s) { return s.id !== 'vocab'; }).forEach(function (s) {
      var st = agg.sections.filter(function (x) { return x.id === s.id; })[0] || { count: 0, pct: 0 };
      var opened = sectionOpened(unit.id, s.id);
      var entryLabel = opened ? '总览' : (s.id === 'pitfalls' ? '卡片/辨析' : s.id === 'contexts' ? '阅读' : s.id === 'substitutions' ? '替换' : s.id === 'culture' ? '已读' : s.id === 'sheng' ? '生义' : '卡片');
      html += '<button class="section-card ' + (st.count ? '' : 'empty') + '" data-action="section" data-unit="' + esc(unit.id) + '" data-section="' + esc(s.id) + '">'
        + '<div class="sc-top"><span class="sc-icon">' + sectionIcon(s.id) + '</span><span class="sc-title">' + esc(s.title) + '</span></div>'
        + '<div class="sc-count">' + st.count + ' 项 · 到期 ' + (s.id === 'culture' ? '按已读' : st.due) + ' · ' + entryLabel + '</div>'
        + '<div class="sc-progress"><i style="width:' + clamp(st.pct, 0, 100) + '%"></i></div>'
        + '</button>';
    });
    html += '</div>';
    var us = state.progress.units && state.progress.units[unit.id];
    html += '<div class="card" style="margin-top:14px"><div class="row between"><span class="meta">最近测试：' + esc(us && us.lastTested || '—') + '</span>'
      + '<button class="btn ghost small" data-action="settings">设置 / 进度</button></div></div>';
    html += footer();
    return html;
  }

  function sectionOpened(unitId, sectionId) {
    var ui = state.progress.ui && state.progress.ui.sections;
    return !!(ui && ui[unitId] && ui[unitId][sectionId] && ui[unitId][sectionId].openedAt);
  }
  function markSectionOpened(unitId, sectionId) {
    if (!state.progress.ui) state.progress.ui = { sections: {} };
    if (!state.progress.ui.sections) state.progress.ui.sections = {};
    if (!state.progress.ui.sections[unitId]) state.progress.ui.sections[unitId] = {};
    var row = state.progress.ui.sections[unitId][sectionId] || {};
    if (!row.openedAt) row.openedAt = new Date().toISOString();
    state.progress.ui.sections[unitId][sectionId] = row;
    saveProgress();
  }

  function sectionItems(unitId, sectionId) {
    var items = state.content.items.filter(function (i) { return i.unitId === unitId && !i.archived; });
    if (sectionId === 'pitfalls') return items.filter(function (i) { return (i.confusables && i.confusables.length) || i.error; });
    if (sectionId === 'sheng') return items.filter(function (i) { return i.kind === 'word' && hasSheng(i); });
    if (sectionId === 'culture') return items.filter(function (i) { return i.sectionId === 'culture'; });
    return items.filter(function (i) { return i.sectionId === sectionId; });
  }
  function renderItemRow(item, sectionId) {
    var tags = '';
    if (!item.testable) tags += tag('待补语境', 'warn');
    else if (item.confusables && item.confusables.length) tags += tag('易混', 'warn');
    else if (item.error) tags += tag('易错', 'warn');
    var badges = tagBadges(item).map(function (b) { return tag(b, 'warn'); }).join('');
    var posHtml = item.pos ? ' <span class="sense-pos">' + esc(item.pos) + '</span>' : '';
    return '<button class="item-row" data-action="item" data-unit="' + esc(item.unitId) + '" data-item="' + esc(item.id) + '" data-section="' + esc(sectionId || '') + '">'
      + '<div class="ir-main"><div class="ir-term">' + esc(itemTitle(item)) + posHtml + (badges ? ' ' + badges : '') + '</div>'
      + '<div class="ir-sub">' + esc(itemSub(item)) + (tags ? ' ' + tags : '') + '</div></div>'
      + miniBars(item.id, sectionId)
      + '<span class="ir-arrow">›</span></button>';
  }
  function renderSection() {
    var unit = unitById(state.params.unitId) || currentUnit();
    if (!unit) return emptyState('还没有单元数据。', 'home', '回首页');
    var section = sectionById(state.params.sectionId);
    if (section.id === 'contexts') return renderReading();
    var isBank = section.id === 'vocab';
    var sectionTitle = isBank ? '词库' : section.title;
    var items = sectionItems(unit.id, section.id);
    var testable = items.filter(function (i) { return i.testable; });
    var st = sectionStat(state.content, state.progress, unit.id, section.id);
    var today = studyDate();
    var due = items.filter(function (i) { return reviewDueOf(stateOf(state.progress, i.id, section.id), today).due; }).length;
    var forget = items.filter(function (i) { return isDueReview(state.progress, i, section.id); }).length;
    var html = '<div class="meta" style="margin-top:2px">' + esc(unit.title) + ' · ' + esc(sectionTitle) + '</div>';
    html += '<div class="row between" style="margin-top:10px"><span class="meta">' + items.length + ' 项 · ' + testable.length + ' 可测 · 到期 ' + (section.id === 'culture' ? '按已读' : due) + (forget ? ' · 遗忘 ' + forget : '') + '</span>'
      + (!isBank && testable.length && section.id !== 'culture' ? '<div class="row">' + sectionButtons(unit.id, section.id)
        + (forget ? '<button class="btn ghost small" data-action="forget" data-unit="' + esc(unit.id) + '">遗忘复习</button>' : '') + '</div>' : '') + '</div>';
    if (isBank) html += '<p class="meta" style="margin-top:6px">词库只用来查看和修改熟悉度，不再单独做练习；练习走上面的词汇卡片。</p>';
    if (!items.length) {
      html += emptyState('这一节还没有条目。');
    } else {
      html += '<div class="list" style="margin-top:10px">' + items.map(function (i) { return renderItemRow(i, section.id); }).join('') + '</div>';
    }
    if (section.id === 'pitfalls') html += '<p class="meta" style="margin-top:10px">易混卡片：一组词逐词看释义与辨析，只读、不评分。易混选择题：选项含相关词与站外词，作答后逐项讲解。</p>';
    if (section.id === 'sheng') html += '<p class="meta" style="margin-top:10px">熟词生义：正面只给词，背面只看这个词的“生义”（由英语会话入库时标记）。熟悉度独立记录，不占词汇卡。</p>';
    if (section.id === 'culture') {
      html += '<p class="meta" style="margin-top:10px">文化卡只读：勾“已读”不生成题；有真实例句的会放进对应节。</p>';
      html += '<button class="btn ghost block" style="margin-top:8px" data-action="culture-read" data-unit="' + esc(unit.id) + '">标记本节已读</button>';
    }
    if (section.id === 'substitutions') html += '<p class="meta" style="margin-top:10px">高级替换按“低级表达→先自己想→参考替换”走，不套词汇卡。</p>';
    if (section.id === 'patterns') html += '<p class="meta" style="margin-top:10px">句式与金句只做默写/背诵，不给选项。</p>';
    html += footer();
    return html;
  }
  function sectionButtons(unitId, sectionId) {
    if (sectionId === 'vocab') return '<button class="btn primary small" data-action="cards" data-unit="' + esc(unitId) + '" data-section="vocab">卡片</button>'
      + '<button class="btn ghost small" data-action="start-section" data-unit="' + esc(unitId) + '" data-section="vocab">盲测</button>';
    if (sectionId === 'phrases') return '<button class="btn primary small" data-action="cards" data-unit="' + esc(unitId) + '" data-section="phrases">短语卡</button>'
      + '<button class="btn ghost small" data-action="start-section" data-unit="' + esc(unitId) + '" data-section="phrases">介词/核心词</button>';
    if (sectionId === 'substitutions') return '<button class="btn primary small" data-action="substitution" data-unit="' + esc(unitId) + '">开始替换</button>';
    if (sectionId === 'patterns') return '<button class="btn primary small" data-action="start-section" data-unit="' + esc(unitId) + '" data-section="patterns">开始默写</button>';
    if (sectionId === 'pitfalls') return '<button class="btn primary small" data-action="confusable-cards" data-unit="' + esc(unitId) + '">易混卡片</button>'
      + '<button class="btn ghost small" data-action="pitfalls" data-unit="' + esc(unitId) + '">易混选择题</button>';
    if (sectionId === 'sheng') return '<button class="btn primary small" data-action="sheng-cards" data-unit="' + esc(unitId) + '">熟词生义卡片</button>';
    if (sectionId === 'culture') return '';
    return '';
  }

  function renderItem() {
    var item = itemById(state.params.itemId);
    if (!item) return emptyState('条目不存在。', 'home', '回首页');
    var sectionId = state.params.sectionId || item.sectionId;
    var ctx = contextById(item.contextId);
    var p = stateOf(state.progress, item.id, sectionId);
    var due = reviewDueOf(p, studyDate());
    var html = '<div class="card">';
    html += '<div class="detail-term">' + esc(itemTitle(item)) + (item.pos ? ' <span class="sense-pos">' + esc(item.pos) + '</span>' : '') + '</div>';
    var itemBadges = tagBadges(item).map(function (b) { return tag(b, 'warn'); }).join('');
    if (itemBadges) html += '<div class="tagline" style="margin-top:6px">' + itemBadges + '</div>';
    if (item.ipa) html += '<div class="detail-ipa">' + esc(item.ipa) + (item.pos ? ' · ' + esc(item.pos) : '') + '</div>';
    if (item.meaning || item.translation) html += '<div class="detail-meaning">' + esc(item.meaning || item.translation) + '</div>';
    if (item.kind === 'knowledge' && item.summary) html += '<div class="detail-meaning">' + esc(item.summary) + '</div>';
    if (item.text && item.kind !== 'golden') html += '<div class="context-box"><div class="cb-label">金句</div><div class="cb-text">' + highlight(item.text, '') + '</div></div>';
    if (item.sentence) html += '<div class="context-box"><div class="cb-label">本单元语境句</div><div class="cb-text">' + highlight(item.sentence, item.surface || item.term || '') + '</div></div>';
    if (item.cue) html += '<div class="kv"><span class="k">画面</span><span class="v">' + esc(item.cue) + '</span></div>';
    if (item.hook) html += '<div class="kv"><span class="k">钩子</span><span class="v">' + esc(item.hook) + '</span></div>';
    if (item.confusables && item.confusables.length) html += '<div class="kv"><span class="k">易混</span><span class="v">' + esc(item.confusables.join(' / ')) + '</span></div>';
    if (item.error) html += '<div class="kv"><span class="k">易错</span><span class="v">' + esc(item.error.stem || '') + '<br>' + esc(item.error.why || '') + '</span></div>';
    if (item.alternatives && item.alternatives.length) html += '<div class="kv"><span class="k">替换</span><span class="v">' + esc(item.base || '') + ' → ' + item.alternatives.map(function (a) { return esc(a.term) + (a.register ? '（' + esc(a.register) + '）' : '') + (a.nuance ? '：' + esc(a.nuance) : ''); }).join('<br>') + '</span></div>';
    if (item.useCase && item.useCase.length) html += '<div class="kv"><span class="k">用法</span><span class="v">' + esc(item.useCase.join(' / ')) + '</span></div>';
    if (item.keyPhrases && item.keyPhrases.length) html += '<div class="kv"><span class="k">关键词</span><span class="v">' + esc(item.keyPhrases.join(' / ')) + '</span></div>';
    if (item.bullets && item.bullets.length) html += '<div class="kv"><span class="k">要点</span><span class="v">' + item.bullets.map(esc).join('<br>') + '</span></div>';
    if (ctx) html += '<div class="kv"><span class="k">语境</span><span class="v">' + esc(ctx.title) + ' · ' + esc(ctx.kind) + '</span></div>';
    if (item.sourceRefs && item.sourceRefs.length) html += '<div class="kv"><span class="k">来源</span><span class="v">' + esc(item.sourceRefs.join('；')) + '</span></div>';
    html += '<div class="divider"></div>';
    html += '<div class="row between"><h3>熟悉度</h3><span class="meta">' + (item.testable ? '可测' : '待补语境') + ' · ' + esc(sectionTitleOf(sectionId)) + '</span></div>';
    html += '<div class="meta" style="margin-top:6px">' + (due.state === 'new' ? '还没复习过' : due.state === 'scheduled' ? '下次 ' + esc((p && p.nextDue) || '') : '已到期' + (due.overdueDays ? ' ' + due.overdueDays + ' 天' : '')) + '</div>';
    if (isMastered(state.progress, item, sectionId)) {
      html += '<div class="mastered-badge">完全掌握 · 不再进入遗忘复习</div>'
        + '<button class="btn ghost small" data-action="mastery-off" data-item="' + esc(item.id) + '" data-section="' + esc(sectionId) + '">取消完全掌握</button>';
    } else {
      html += '<div style="margin-top:10px">' + famSlider(familiarityOf(state.progress, item.id, sectionId), item.id, sectionId, { horizontal: true }) + '</div>';
    }
    if (p && p.evidence && p.evidence.length) {
      html += '<div class="meta" style="margin-top:8px">最近证据：' + p.evidence.slice(-3).reverse().map(function (e) {
        return esc((e.at || '') + ' ' + (e.type || '') + ' ' + (e.difficulty || '') + ' ' + (e.correct ? '对' : '错'));
      }).join('；') + '</div>';
    }
    if (!item.testable) html += '<div class="notice" style="margin-top:14px">待补语境：先在英语会话里补一句本单元语境句，再构建。没有语境的条目不生成题。</div>';
    html += '<button class="btn ghost block" style="margin-top:8px" data-action="edit-item" data-item="' + esc(item.id) + '">生成修改请求（复制给英语会话）</button>';
    html += '</div>';
    html += footer();
    return html;
  }

  function optionNote(q, opt, index) {
    var n = q && q.optionNotes;
    if (!n) return '';
    if (Array.isArray(n)) return n[index] || '';
    return n[opt] || '';
  }
  function renderTest() {
    var s = state.session;
    if (!s || !s.questions.length) return emptyState('这次没有可出的题。', 'home', '回首页');
    var q = s.questions[s.index];
    var answered = s.answered[q.id] || null;
    var revealed = s.revealed && s.revealed[q.id];
    var idx = s.index;
    var total = s.questions.length;
    var item = itemById(q.itemId);
    var isPitfall = !!(s.scope === 'pitfalls' || s.sectionId === 'pitfalls' || (item && item.sectionId === 'pitfalls'));
    var showOptions = !!(q.options && q.options.length && (isPitfall || q.type === 'phrase-prep-choice'));
    var html = '<div class="q-top"><span class="q-count">第 ' + (idx + 1) + ' / ' + total + ' 题</span><span class="meta">' + esc(MODE_LABEL[s.mode]) + '</span></div>';
    html += '<div class="progress"><i style="width:' + Math.round(100 * idx / total) + '%"></i></div>';
    var testUnit = unitById(s.unitId);
    if (testUnit) {
      html += '<div class="meta" style="margin:-6px 0 10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'
        + esc(testUnit.title + (testUnit.context && testUnit.context.setting ? ' · ' + testUnit.context.setting : ''))
        + (s.scope === 'forget' ? ' · 遗忘复习 · ' + esc(sectionTitleOf(q.sectionId || 'vocab')) : '') + '</div>';
    }
    html += '<div class="card q-card">';
    html += '<div class="q-type">' + tag(DIFF_LABEL[q.difficulty] || q.difficulty) + tag(q.skill === 'e2c' ? '英→中' : '中→英') + (isPitfall ? tag('易混易错', 'warn') : tag('盲测')) + (q.audioOnly ? tag('音频') : '') + '</div>';
    var isSpellWord = q.type === 'spell-word';
    if (s.scope === 'spelling' || isSpellWord) {
      html += '<div class="q-prompt">' + esc(q.prompt || '看中文，拼写英文') + '</div>';
      html += '<div class="q-sub">' + esc(q.stem || (item && (item.meaning || item.translation || item.title)) || '（没有中文提示）') + '</div>';
    } else {
      html += '<div class="q-prompt">' + esc(q.prompt || '') + '</div>';
    }
    var showStem = !isSpellWord && q.stem && (!audioEnabled() || answered || !q.audioText || q.audioText !== q.stem);
    if (q.audioText && audioEnabled() && !answered && q.type === 'e2c-scene') {
      html += '<div class="audio-row"><button class="audio-btn" data-action="play" data-text="' + esc(q.audioText) + '">▶ 播放句子</button><span class="meta">先听，再答</span></div>';
    }
    if (showStem) html += '<div class="q-sentence">' + linkTerms(q.stem, { exclude: q.hit || (item && (item.surface || item.term)) || '' }) + '</div>';
    if (q.sub) html += '<div class="q-sub">' + esc(q.sub) + '</div>';
    if (showStem) html += '<div class="meta" style="margin-top:6px">句中带下划线的词可点开生词卡</div>';

    if (showOptions) {
      html += '<div class="options">';
      q.options.forEach(function (opt, i) {
        var cls = 'option';
        if (answered) {
          if (i === q.answer) cls += ' correct';
          else if (answered.userIndex === i) cls += ' wrong';
        }
        var optNote = optionNote(q, opt, i);
        html += '<button class="' + cls + '" data-action="option" data-index="' + i + '"' + (answered ? ' disabled' : '') + '>'
          + '<span class="opt-mark">' + String.fromCharCode(65 + i) + '</span><span class="opt-body"><span class="opt-text">' + esc(opt) + '</span>'
          + (answered && optNote ? '<span class="opt-note">' + esc(optNote) + '</span>' : '')
          + '</span></button>';
      });
      html += '</div>';
      if (!answered) html += '<div style="margin-top:10px"><button class="btn ghost small" data-action="give-up">不会，看答案</button></div>';
    } else if (q.selfCheck) {
      if (!answered) {
        if (!revealed) {
          html += '<div style="margin-top:14px"><textarea id="produce-input" class="answer-input produce-input" rows="3" placeholder="先用英语写一句，或口头说完再自评" aria-label="你的句子"></textarea></div>';
          html += '<div class="btn-row" style="margin-top:10px"><button class="btn primary" data-action="self" data-good="1">我写/说完了</button><button class="btn secondary" data-action="self" data-good="0">没答对</button></div>';
          html += '<div style="margin-top:8px"><button class="btn ghost small" data-action="show-answer">先看答案</button></div>';
        } else {
          html += '<div class="feedback"><div class="fb-head">参考答案</div><div class="fb-reveal">' + esc((q.reveal && q.reveal.sentence) || (q.answers && q.answers[0]) || '') + '</div></div>';
          html += '<div class="btn-row" style="margin-top:10px"><button class="btn primary" data-action="self" data-good="1">我写/说出来了</button><button class="btn secondary" data-action="self" data-good="0">没答对</button></div>';
        }
      }
    } else if (q.answers && q.answers.length) {
      if (!answered) {
        html += '<div style="margin-top:14px"><input id="answer-input" class="answer-input" type="text" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" placeholder="输入答案，回车提交" aria-label="答案"><div class="input-hint">' + esc(q.hint || '') + '</div></div>';
        html += '<div style="margin-top:8px"><button class="btn ghost small" data-action="give-up">不会，看答案</button></div>';
      }
    }

    if (answered) {
      var good = answered.correct;
      html += '<div class="feedback ' + (good ? 'good' : 'bad') + '">';
      html += '<div class="fb-head ' + (good ? 'good' : 'bad') + '">' + (good ? '✓ 对了' : '✗ 没答对') + '</div>';
      if (q.why) html += '<div class="fb-why">' + esc(q.why) + '</div>';
      if (q.reveal && q.reveal.sentence) html += '<div class="fb-reveal">' + highlight(q.reveal.sentence, q.reveal.term || '') + '</div>';
      if (q.reveal && (q.reveal.meaning || q.reveal.ipa)) html += '<div class="fb-meta">' + esc([q.reveal.ipa, q.reveal.meaning].filter(Boolean).join(' · ')) + '</div>';
      if (q.reveal && q.reveal.hook) html += '<div class="fb-meta">' + esc(q.reveal.hook) + '</div>';
      html += renderBasis(q);
      html += '</div>';
    }
    html += '</div>';
    var bottom = '';
    if (answered) {
      bottom = '<button class="btn primary" data-action="next">' + (idx + 1 >= total ? '查看结果' : '下一题') + '</button>';
    } else if (!showOptions) {
      if (q.answers && q.answers.length && !q.selfCheck) bottom = '<button class="btn primary" data-action="submit-typed">提交</button>';
      else if (!q.selfCheck) bottom = '<button class="btn primary" data-action="self" data-good="1">我说/写完了</button>';
    }
    if (bottom) html += '<div class="bottombar">' + bottom + '</div>';
    return html;
  }

  function renderBasis(q) {
    if (!q.basis) return '';
    var inline = q.basisDisplay === 'inline';
    var expanded = state.showBasis[q.id];
    var text = (q.basis.note || '') + (q.basis.ref ? '（' + q.basis.ref + '）' : '');
    if (inline) return '<div class="basis">依据：' + esc(text) + '</div>';
    if (expanded) return '<div class="basis"><button class="basis-btn" data-action="basis" data-qid="' + esc(q.id) + '">收起依据</button><div class="basis-expanded">' + esc(text) + '</div></div>';
    return '<div class="basis"><button class="basis-btn" data-action="basis" data-qid="' + esc(q.id) + '">依据</button></div>';
  }

  function renderSummary() {
    var s = state.session || state.lastSummary;
    if (!s) return emptyState('没有本次结果。', 'unit', '回单元');
    var total = s.questions.length;
    var results = s.results || [];
    var summarySection = s.sectionId || (s.scope === 'pitfalls' ? 'pitfalls' : 'vocab');
    var correct = results.filter(function (r) { return r.correct; }).length;
    var wrongs = [];
    var seen = {};
    results.forEach(function (r) {
      if (r.correct || seen[r.q.itemId]) return;
      seen[r.q.itemId] = true;
      var item = itemById(r.q.itemId);
      if (item) wrongs.push({ item: item, r: r });
    });
    var round = s.round || (state.progress.ui && state.progress.ui.round);
    var roundTotal = round && round.keys ? round.keys.length : 0;
    var roundDone = round && round.cursor ? round.cursor : 0;
    var report = buildReport(state.content, state.progress, s.unitId, studyDate());
    state.lastSummary = {
      report: report, unitId: s.unitId, mode: s.mode, scope: s.scope, limit: s.limit,
      sectionId: summarySection, sections: (s.sections || []).slice(), questions: s.questions.slice(), results: results.slice(),
      correct: correct, total: total
    };
    var html = '<div class="card center"><div class="summary-big">' + correct + ' / ' + total + '</div>'
      + '<div class="summary-sub">' + esc(unitById(s.unitId) ? unitById(s.unitId).title : '')
      + (s.scope === 'forget' ? ' · 遗忘复习' : ' · 这一轮') + '</div></div>';
    if (s.scope !== 'forget') {
      html += '<div class="card"><h3>这一轮覆盖</h3><div class="meta">' + roundDone + ' / ' + roundTotal + ' 个词已出题；每次 3–4 个词，直到全单元覆盖一遍。'
        + (round && round.completedAt ? '这一轮已完成，下次开始新一轮。' : '') + '</div></div>';
    }
    if (wrongs.length) {
      html += '<div class="card"><h3>这次没答对</h3>';
      wrongs.slice(0, 6).forEach(function (w) {
        var item = w.item;
        var wsec = w.r.q.sectionId || summarySection;
        var ip = stateOf(state.progress, item.id, wsec);
        var rr = (ip && ip.recentResults || []).slice(-2);
        var twice = rr.length === 2 && rr.every(function (r) { return !r.correct; });
        var f = familiarityOf(state.progress, item.id, wsec);
        html += '<div class="row between" style="margin-top:8px"><span>' + esc(itemTitle(item)) + '<span class="meta"> · ' + esc(selfLabel(f)) + '</span></span>'
          + (twice && f !== null && f > 0 ? '<button class="btn ghost small" data-action="lower" data-item="' + esc(item.id) + '">下调到 ' + esc(selfLabel(f - 1)) + '</button>' : '') + '</div>';
      });
      html += '</div>';
    }
    html += '<div class="card"><div class="row between"><h3>本周报告</h3><button class="btn ghost small" data-action="copy-report">复制</button></div><pre class="report-pre">' + esc(report) + '</pre></div>';
    html += '<div class="bottombar"><button class="btn secondary" data-action="summary-home">回单元</button><button class="btn primary" data-action="retry">继续下一组</button></div>';
    html += footer();
    return html;
  }

  function renderModal() {
    var m = state.modal;
    if (!m) return '';
    var html = '<div class="modal-backdrop' + (state.modalClosing ? ' closing' : '') + '" data-action="modal-close"><div class="modal-card" data-action="modal-inner">';
    if (m.type === 'mastery') {
      html += '<div class="row between"><h3>设为完全掌握？</h3><button class="dict-x" data-action="mastery-cancel">×</button></div>';
      html += '<p class="lead">“' + esc(m.term || '') + '”将不再出现在词汇卡、盲测和遗忘复习中；仍可在词库中查看或取消。</p>';
      html += '<div class="btn-row" style="margin-top:14px"><button class="btn secondary" data-action="mastery-cancel">取消</button><button class="btn primary" data-action="mastery-confirm">确定完全掌握</button></div>';
    } else if (m.type === 'export') {
      html += '<div class="row between"><h3>导出进度</h3><button class="dict-x" data-action="modal-close">×</button></div>';
      html += '<p class="meta">格式 v' + FORMAT_VERSION + ' · schema ' + SCHEMA + ' · ' + esc(contentVersion()) + '</p>';
      html += '<p class="meta">手机上推荐先“复制”，再粘到 PC/笔记/网盘；下载 .json 是可选路径。</p>';
      html += '<textarea id="export-json" class="json-area" readonly>' + esc(m.json || '') + '</textarea>';
      html += '<div class="btn-row" style="margin-top:10px"><button class="btn secondary" data-action="copy-export">复制 JSON</button><button class="btn ghost" data-action="download-export">下载 .json</button></div>';
    } else if (m.type === 'import') {
      html += '<div class="row between"><h3>导入进度</h3><button class="dict-x" data-action="modal-close">×</button></div>';
      html += '<p class="meta">格式 v' + FORMAT_VERSION + ' · 支持旧 schema 3；导入前会自动备份当前进度。</p>';
      html += '<textarea id="import-json" class="json-area" placeholder="在这里粘贴进度 JSON，或点下面选文件">' + esc(m.text || '') + '</textarea>';
      html += '<div class="btn-row" style="margin-top:10px"><button class="btn ghost" data-action="import-file">选文件</button><button class="btn ghost" data-action="import-preview">预览</button></div>';
      if (m.error) html += '<div class="notice" style="margin-top:10px">' + esc(m.error) + '</div>';
      if (m.preview) {
        html += '<div class="preview-box" style="margin-top:10px">'
          + '<div class="kv"><span class="k">文件</span><span class="v">' + esc(m.preview.from || 'raw') + ' · ' + esc(m.preview.fromVersion) + '</span></div>'
          + '<div class="kv"><span class="k">匹配</span><span class="v">' + m.preview.matched + ' 项</span></div>'
          + '<div class="kv"><span class="k">文件有/本站无</span><span class="v">' + m.preview.unknown + ' 项（会进孤儿区）</span></div>'
          + '<div class="kv"><span class="k">本站有/文件无</span><span class="v">' + m.preview.missing + ' 项（保留当前）</span></div>'
          + '<div class="kv"><span class="k">contentVersion</span><span class="v">' + esc(m.preview.fromContent || '—') + '</span></div>'
          + '</div>';
        html += '<div class="seg-control" style="margin-top:10px">'
          + '<button class="' + (m.mode !== 'replace' ? 'on' : '') + '" data-action="import-mode" data-mode="merge">合并（推荐）</button>'
          + '<button class="' + (m.mode === 'replace' ? 'on' : '') + '" data-action="import-mode" data-mode="replace">替换</button></div>';
        html += '<button class="btn primary block" style="margin-top:10px" data-action="import-run">确认导入</button>';
      }
    } else if (m.type === 'hard') {
      html += '<div class="row between"><h3>' + esc(m.title || '长难句') + '</h3><button class="dict-x" data-action="modal-close">×</button></div>';
      html += '<div class="hard-sentence">' + esc((m.note && m.note.sentence) || '') + '</div>';
      if (m.note && m.note.note) html += '<div class="hard-note">' + esc(m.note.note) + '</div>';
      if (m.note && m.note.translation) html += '<div class="hard-trans">' + esc(m.note.translation) + '</div>';
    } else if (m.type === 'edit') {
      html += '<div class="row between"><h3>修改请求</h3><button class="dict-x" data-action="modal-close">×</button></div>';
      html += '<p class="meta">页内只导出请求，不直接改数据；把下面 JSON 粘回英语会话，由预设改数据并重建。key 不要改。</p>';
      html += '<textarea id="edit-json" class="json-area">' + esc(m.json || '') + '</textarea>';
      html += '<div class="btn-row" style="margin-top:10px"><button class="btn primary" data-action="copy-edit">复制请求</button></div>';
    } else if (m.type === 'backup') {
      html += '<div class="row between"><h3>恢复备份</h3><button class="dict-x" data-action="modal-close">×</button></div>';
      var list = listBackups();
      if (!list.length) html += emptyState('还没有备份；导入/恢复前会自动生成。');
      list.forEach(function (b) {
        html += '<div class="backup-row"><div class="grow"><div class="ir-term">' + esc(b.at || b.key) + '</div>'
          + '<div class="meta">' + esc(b.note || '') + ' · ' + b.items + ' 项 · ' + esc(b.contentVersion || '') + '</div></div>'
          + '<button class="btn secondary small" data-action="backup-restore" data-key="' + esc(b.key) + '">恢复</button></div>';
      });
    }
    html += '</div></div>';
    return html;
  }

  function openMasteryConfirm(item, sectionId) {
    if (!item) return;
    state.modalClosing = false;
    state.modal = { type: 'mastery', itemId: item.id, sectionId: sectionId || item.sectionId || 'vocab', term: itemTitle(item) };
    renderOverlay();
  }
  function openExportModal() {
    state.modalClosing = false;
    state.modal = { type: 'export', json: exportPortable(state.progress, contentVersion()) };
    renderOverlay();
  }
  function openEditRequest(item) {
    if (!item) return;
    state.modalClosing = false;
    state.modal = {
      type: 'edit',
      json: JSON.stringify({
        action: 'update-item',
        key: item.id,
        unitId: item.unitId,
        fields: {
          term: item.term || item.text || '',
          meaning: item.meaning || '',
          sentence: item.sentence || '',
          cue: item.cue || '',
          hook: item.hook || ''
        }
      }, null, 2)
    };
    renderOverlay();
  }
  function openImportModal() {
    state.modalClosing = false;
    state.modal = { type: 'import', text: '', mode: 'merge', preview: null, error: '' };
    renderOverlay();
  }
  function openBackupModal() {
    state.modalClosing = false;
    state.modal = { type: 'backup' };
    renderOverlay();
  }
  function previewImport() {
    var el = document.getElementById('import-json');
    var text = el ? el.value : (state.modal && state.modal.text) || '';
    state.modal.text = text;
    var r = importProgress(text);
    if (!r.ok) { state.modal.error = '导入失败：' + r.reason; state.modal.preview = null; renderOverlay(); return; }
    var current = state.progress.items || {};
    var incoming = r.progress.items || {};
    var contentIds = {};
    (state.content.items || []).forEach(function (i) { contentIds[i.id] = 1; });
    var matched = 0, unknown = 0, missing = 0;
    Object.keys(incoming).forEach(function (id) { if (contentIds[id]) matched += 1; else unknown += 1; });
    Object.keys(contentIds).forEach(function (id) { if (!incoming[id]) missing += 1; });
    state.modal.preview = {
      progress: r.progress,
      from: r.sourceFormat,
      fromVersion: 'format ' + (r.sourceVersion || 'raw') + ' / schema ' + (r.progress.schemaVersion || '?'),
      matched: matched, unknown: unknown, missing: missing,
      fromContent: r.sourceContentVersion || '—'
    };
    state.modal.error = '';
    renderOverlay();
  }
  function runImport() {
    var m = state.modal;
    if (!m || !m.preview) { toast('先预览'); return; }
    var current = state.progress;
    saveBackup(current, '导入前自动备份');
    var next = m.mode === 'replace' ? replaceProgress(m.preview.progress) : mergeProgress(current, m.preview.progress).progress;
    next = normalizeAliasProgress(next, state.content);
    var known = {};
    (state.content.items || []).forEach(function (i) { known[i.id] = 1; });
    next.orphans = next.orphans && typeof next.orphans === 'object' ? next.orphans : {};
    Object.keys(next.items || {}).forEach(function (id) {
      if (!known[id]) {
        next.orphans[id] = next.items[id];
        delete next.items[id];
      }
    });
    state.progress = next;
    state.mode = next.settings.lastMode === 'c2e' ? 'c2e' : 'e2c';
    saveProgress();
    applyThemeAttrOnly();
    state.modal = null;
    render();
    toast('导入成功');
  }
  function downloadExport() {
    try {
      var m = state.modal;
      var blob = new Blob([m.json || ''], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = '单词复习进度-' + studyDate() + '.json';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
      toast('已下载；若手机没保存，用“复制 JSON”');
    } catch (e) { toast('下载失败；请用复制 JSON'); }
  }

  function renderSettings() {
    var p = state.progress;
    var m = state.content.meta || {};
    var html = '<div class="card"><h3>外观</h3>'
      + '<div class="field"><div><label>自动主题</label><div class="field-sub">跟随系统；关闭后用右上角太阳/月亮切深浅</div></div>'
      + '<button id="theme-auto-switch" class="switch' + (themeAutoOn() ? ' on' : '') + '" type="button" role="switch" aria-checked="' + (themeAutoOn() ? 'true' : 'false') + '" aria-label="自动主题" data-action="theme-auto"></button></div>'
      + '</div>';
    html += '<div class="card"><h3>语音</h3>'
      + '<div class="field"><div><label>使用语音</label><div class="field-sub">' + (state.audioAvailable ? '检测到英语语音' : '未检测到英语语音；文字模式不影响') + '</div></div>'
      + '<div class="seg-control">' + ['auto', 'on', 'off'].map(function (v) {
        var label = v === 'auto' ? '自动' : v === 'on' ? '开' : '关';
        return '<button class="' + (p.settings.audio === v ? 'on' : '') + '" data-action="audio-setting" data-value="' + v + '">' + label + '</button>';
      }).join('') + '</div></div>'
      + '<div class="field"><div><label>声音测试</label><div class="field-sub">播放一句英文例句</div></div><button class="btn secondary small" data-action="audio-test">测试</button></div>'
      + '</div>';
    html += '<div class="card"><h3>复习</h3>'
      + '<p class="meta">背单词是主路径：正面只看一个词，翻面看例句/画面，再选熟悉度。非常熟悉会退役。</p>'
      + '<p class="meta">盲测每次 3–4 个词，按轮覆盖全单元；选项随机，不靠固定翻译记忆。</p>'
      + '</div>';
    html += '<div class="card"><h3>进度与备份</h3>'
      + '<div class="field"><div><label>导出进度</label><div class="field-sub">格式 v' + FORMAT_VERSION + '；手机推荐复制 JSON</div></div><button class="btn secondary small" data-action="export">导出</button></div>'
      + '<div class="field"><div><label>导入进度</label><div class="field-sub">预览 + 合并/替换；导入前自动备份</div></div><button class="btn secondary small" data-action="import">导入</button></div>'
      + '<div class="field"><div><label>恢复备份</label><div class="field-sub">最近 3 份自动备份</div></div><button class="btn ghost small" data-action="backup">查看</button></div>'
      + '<div class="field"><div><label>重置</label><div class="field-sub">清空本机所有单元的进度；会先备份</div></div><button class="btn danger small" data-action="reset">重置</button></div>'
      + '</div>';
    html += '<div class="card"><h3>关于</h3>'
      + '<div class="kv"><span class="k">版本</span><span class="v">' + esc(m.contentVersion || '') + ' · 构建 ' + esc(m.buildTime || '') + '</span></div>'
      + '<div class="kv"><span class="k">进度格式</span><span class="v">v' + FORMAT_VERSION + ' · schema ' + SCHEMA + '</span></div>'
      + '<div class="kv"><span class="k">规模</span><span class="v">' + (m.unitCount || state.content.units.length) + ' 单元 / ' + (m.itemCount || state.content.items.length) + ' 项 / ' + (m.questionCount || state.content.questions.length) + ' 题</span></div>'
      + '<p class="meta" style="margin-top:8px">熟悉度 0 忘记 · 1 模糊 · 2 认识 · 3 非常熟悉；滑到顶再向外拉可设“完全掌握”。卡片自评与盲测证据写进同一个熟悉度；盲测不自动降级。</p>'
      + '<p class="meta">进度只存在本机浏览器；导出 JSON 才能换设备。每周把「本周报告」粘回英语会话，才会更新复习提纲。</p>'
      + '</div>';
    html += footer();
    return html;
  }

  function cardItems(unitId, sectionId) {
    var sec = sectionId || 'vocab';
    if (sec === 'sheng') {
      return state.content.items.filter(function (i) {
        return i.unitId === unitId && !i.archived && i.kind === 'word' && hasSheng(i);
      });
    }
    return state.content.items.filter(function (i) {
      if (i.unitId !== unitId || !i.testable || i.archived) return false;
      if (i.sectionId !== sec) return false;
      if (sec === 'vocab') return i.kind === 'word';
      if (sec === 'phrases') return i.kind === 'phrase';
      if (sec === 'patterns') return i.kind === 'pattern' || i.kind === 'golden';
      return true;
    });
  }
  // v5.8：卡片池只看熟悉度 —— 没到「非常熟悉」就一直留在卡池，与看不看过、到不到期无关。
  function cardCandidates(unitId, sectionId, includeMastered) {
    return cardItems(unitId, sectionId).filter(function (i) {
      var p = stateOf(state.progress, i.id, sectionId || 'vocab');
      if (p && p.mastered) return false;
      var f = p ? clampFam(p.familiarity) : null;
      return f === null || f < FAM_TOP;
    });
  }
  function copyFlips(src) {
    var out = {};
    if (src && typeof src === 'object') {
      Object.keys(src).forEach(function (k) { if (src[k]) out[k] = 1; });
    }
    return out;
  }
  function cardFlipped(c, itemId) {
    return !!(c && c.flips && c.flips[itemId]);
  }
  function setCardFlipped(c, itemId, on) {
    if (!c) return;
    if (!c.flips) c.flips = {};
    if (on) c.flips[itemId] = 1;
    else delete c.flips[itemId];
  }
  function savedCardSession(unitId, sectionId) {
    var c = state.progress.ui && state.progress.ui.cards;
    if (!c || c.unitId !== unitId || (c.sectionId || '') !== (sectionId || '')) return null;
    return c;
  }
  function activeCardSession(unitId, sectionId) {
    var c = state.progress.ui && state.progress.ui.cards;
    return c && c.unitId === unitId && (c.sectionId || 'vocab') === (sectionId || 'vocab') && !c.completed && Array.isArray(c.order) && c.order.length ? c : null;
  }
  function resumeCardSession(c) {
    var scope = c.scope || '';
    var allowed = cardCandidates(c.unitId, c.sectionId, false);
    if (scope === 'random' || scope === 'sheng-cards') {
      allowed = (c.order || []).map(itemById).filter(Boolean).filter(function (it) {
        if (scope === 'sheng-cards') return hasSheng(it);
        return it.kind === 'word' && !it.archived;
      });
    }
    var allowedIds = {};
    allowed.forEach(function (i) { allowedIds[i.id] = 1; });
    var order = (c.order || []).filter(function (id) {
      if (!allowedIds[id]) return false;
      var it = state.content.items.filter(function (i) { return i.id === id; })[0];
      return !!it && (scope === 'random' || scope === 'sheng-cards' || !isDueReview(state.progress, it, c.sectionId || 'vocab'));
    });
    if (!order.length) return null;
    var index = Math.max(0, Math.min(order.length - 1, Number(c.index) || 0));
    return {
      unitId: c.unitId, sectionId: c.sectionId || '', scope: scope, scopeLabel: c.scopeLabel || '',
      order: order, index: index,
      completed: false, roundNo: Number(c.roundNo) || 1, startedAt: c.startedAt || new Date().toISOString(),
      flips: copyFlips(c.flips), navLock: false, navEnter: null
    };
  }
  function persistCards() {
    var c = state.cards;
    if (!c) return;
    if (!state.progress.ui) state.progress.ui = { sections: {}, session: null, cards: null, substitution: null, round: null };
    state.progress.ui.cards = {
      unitId: c.unitId, sectionId: c.sectionId || '', scope: c.scope || '', scopeLabel: c.scopeLabel || '', sectionIds: (c.sectionIds || []).slice(),
      order: c.order.slice(), index: c.index,
      completed: !!c.completed, roundNo: Number(c.roundNo) || 1,
      flips: copyFlips(c.flips),
      startedAt: c.startedAt || new Date().toISOString(), updatedAt: new Date().toISOString()
    };
    saveProgress();
  }
  function startCards(unitId, sectionId, forceNew) {
    // v5.12：翻译专项是「中→英」产出型，进入时强制切到 c2e，免得先看到英文。
    // v5.14：这一句只在「进入翻译专项」时生效，离开时要把方向**还原**——否则普通单元也会变成中→英（实测 bug）。
    var unitForDir = unitById(unitId);
    var isTrans = !!(unitForDir && unitForDir.kind === 'translation');
    state.mode = isTrans ? 'c2e' : (state.progress.settings.lastMode === 'c2e' ? 'c2e' : 'e2c');
    var old = savedCardSession(unitId, sectionId);
    if (old && !old.completed && !forceNew) {
      var resumed = resumeCardSession(old);
      if (resumed) {
        state.cards = resumed;
        persistCards();
        navigate('cards', { unitId: unitId, sectionId: sectionId || '' }, true);
        return;
      }
    }
    var ids = cardCandidates(unitId, sectionId, false).map(function (i) { return i.id; });
    if (!ids.length) {
      var any = cardCandidates(unitId, sectionId, true).length;
      var anyDue = cardItems(unitId, sectionId).filter(function (i) { return isDueReview(state.progress, i, sectionId); }).length;
      toast(anyDue ? '这一节都到「非常熟悉」了，去遗忘回看' : (any ? '这一节的词都已安排；可在词库查看' : '这一节还没有卡片'));
      return;
    }
    // 完成一轮后的新轮随机打乱；第一次按内容顺序。
    if (old && (old.completed || forceNew)) ids = seededShuffle(ids, 'cards|' + Date.now() + '|' + Math.random());
    state.cards = {
      unitId: unitId, sectionId: sectionId || '', order: ids, index: 0, completed: false,
      roundNo: old && old.unitId === unitId ? (Number(old.roundNo) || 0) + 1 : 1,
      startedAt: new Date().toISOString(), flips: {}, navLock: false, navEnter: null
    };
    persistCards();
    navigate('cards', { unitId: unitId, sectionId: sectionId || '' }, true);
  }
  function renderCardComplete() {
    var c = state.cards;
    var n = c.order.length;
    var isForget = c.scope === 'forget';
    var html = '<div class="card center" style="margin-top:18px"><div class="summary-big">✓</div>'
      + '<div class="summary-sub">' + (isForget ? '本轮遗忘回看结束 ' : '这一轮已走完 ') + n + ' 张卡</div></div>';
    if (isForget) {
      html += '<div class="card"><h3>遗忘回看</h3><p class="meta">评到「非常熟悉」的词已经结束回看；评低的词会留在「遗忘复习」入口，下一轮还会出现。要再抽查，可回单元重新进入。</p>'
        + '<div style="margin-top:12px"><button class="btn primary block" data-action="unit" data-unit="' + esc(c.unitId) + '">回单元</button></div></div>';
    } else {
      var isRandom = c.scope === 'random';
      html += '<div class="card"><h3>' + (isRandom ? '再抽一组' : '下一轮') + '</h3><p class="meta">非常熟悉不会进普通卡组，只在到期复习里出现。新轮会重新打乱顺序。</p>'
        + '<div class="btn-row" style="margin-top:12px">'
        + (isRandom
          ? '<button class="btn primary" data-action="random-start">再抽 ' + c.order.length + ' 张</button>'
          : '<button class="btn primary" data-action="card-restart" data-unit="' + esc(c.unitId) + '" data-section="' + esc(c.sectionId) + '">随机打乱再来一轮</button>')
        + '</div>'
        + '<div style="margin-top:10px"><button class="btn ghost block" data-action="' + (isRandom ? 'home' : 'unit') + '"' + (isRandom ? '' : ' data-unit="' + esc(c.unitId) + '"') + '>' + (isRandom ? '回首页' : '回单元') + '</button></div></div>';
    }
    html += footer();
    return html;
  }
  function substitutionItems(unitId) {
    return state.content.items.filter(function (i) {
      return i.unitId === unitId && i.kind === 'substitution' && i.testable && !i.archived;
    });
  }
  function startSubstitution(unitId) {
    var list = substitutionItems(unitId);
    if (!list.length) { toast('这一单元还没有高级替换条目'); return; }
    var old = state.progress.ui && state.progress.ui.substitution;
    var index = 0;
    if (old && old.unitId === unitId) index = Math.max(0, Math.min(list.length - 1, Number(old.index) || 0));
    state.substitution = { unitId: unitId, order: list.map(function (i) { return i.id; }), index: index, revealed: false };
    navigate('substitution', { unitId: unitId }, true);
  }
  function persistSubstitution() {
    var s = state.substitution;
    if (!s) return;
    if (!state.progress.ui) state.progress.ui = { sections: {}, session: null, cards: null, substitution: null, round: null };
    state.progress.ui.substitution = { unitId: s.unitId, index: s.index, revealed: !!s.revealed, updatedAt: new Date().toISOString() };
    saveProgress();
  }
  function substitutedSentence(item) {
    var base = String(item.base || '');
    if (!base) return item.sentence || '';
    try {
      var re = new RegExp('\\b' + base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
      return String(item.sentence || '').replace(re, item.best || base);
    } catch (e) { return item.sentence || ''; }
  }
  function renderSubstitution() {
    var s = state.substitution;
    if (!s || !s.order || !s.order.length) return emptyState('还没有高级替换练习。', 'home', '回首页');
    var item = itemById(s.order[s.index]);
    var u = unitById(s.unitId);
    if (!item || !u) return emptyState('这条替换条目不存在。', 'home', '回首页');
    var html = '<div class="q-top"><span class="q-count">' + (s.index + 1) + ' / ' + s.order.length + '</span><span class="meta">高级替换</span></div>'
      + '<div class="progress"><i style="width:' + Math.round(100 * (s.index + 1) / s.order.length) + '%"></i></div>'
      + '<div class="meta" style="margin:-6px 0 10px">' + esc(u.title) + '</div>';
    html += '<div class="card sub-card">';
    html += '<div class="tagline"><span class="tag">低级表达</span><span class="tag">先想再揭</span></div>';
    html += '<h2 class="sub-prompt">' + esc(item.cue || '这句话里的低级表达，可以换成什么更合适的词？') + '</h2>';
    html += '<div class="sub-base-sentence">' + highlight(item.sentence || '', item.base || '') + '</div>';
    if (!s.revealed) {
      html += '<p class="meta">先自己说/写一个替换，再点开参考。不是背唯一的词，重点看语域和搭配。</p>';
      html += '<button class="btn primary block" data-action="sub-reveal">想好了，看参考</button>';
    } else {
      html += '<div class="sub-reveal"><h3>参考替换</h3>';
      (item.alternatives || []).forEach(function (a) {
        html += '<div class="sub-alt' + (a.term === item.best ? ' best' : '') + '">'
          + '<div class="sub-alt-head"><b>' + esc(a.term || '') + '</b><span class="tag">' + esc(a.register || '') + '</span></div>'
          + '<div class="meta">' + esc(a.nuance || '') + '</div>'
          + (a.term === item.best ? '<div class="sub-best">最稳的选择</div>' : '') + '</div>';
      });
      html += '<div class="sub-after"><div class="meta">替换后参考句</div><div class="sub-base-sentence">' + highlight(substitutedSentence(item), item.best || '') + '</div></div>';
      html += '<div class="sub-rate"><div class="row between"><b>这个词你现在多熟？</b><span class="meta">自评</span></div>'
        + famSlider(familiarityOf(state.progress, item.id, 'substitutions'), item.id, 'substitutions', { horizontal: true }) + '</div>';
      html += '<p class="meta">这里只看你有没有想清楚为什么；不计入盲测轮。</p>';
    }
    html += '</div>';
    html += '<div class="bottombar"><button class="btn ghost" data-action="sub-prev"' + (s.index ? '' : ' disabled') + '>上一张</button>'
      + '<button class="btn primary" data-action="sub-next">' + (s.index + 1 >= s.order.length ? '完成' : '下一张') + '</button></div>';
    return html;
  }

  function famSlider(level, itemId, sectionId, opts) {
    var o = opts || {};
    var horizontal = o.horizontal === true;
    var v = level == null ? null : clamp(level, 0, 3);
    var fill = v == null ? 0 : (v / 3) * 100;
    var label = v == null ? '未评' : selfLabel(v);
    var html = '<div class="fam-slider' + (horizontal ? ' horizontal' : '') + (o.compact ? ' compact' : '') + (v == null ? ' is-unset' : '') + '"'
      + ' data-item="' + esc(itemId) + '" data-section="' + esc(sectionId || 'vocab') + '"'
      + ' data-orientation="' + (horizontal ? 'h' : 'v') + '" role="slider" tabindex="0"'
      + ' aria-label="熟悉度" aria-orientation="' + (horizontal ? 'horizontal' : 'vertical') + '" aria-valuemin="0" aria-valuemax="3" aria-valuenow="' + (v == null ? 0 : v) + '"'
      + ' aria-valuetext="' + esc(label) + '" style="--fam-fill:' + fill + '%">';
    html += '<div class="fam-track">';
    for (var n = 0; n < 4; n++) {
      html += '<i class="fam-tick' + (v === n ? ' on' : '') + '" data-level="' + n + '" style="' + (horizontal ? 'left:' : 'bottom:') + (n / 3) * 100 + '%"></i>';
    }
    html += '<div class="fam-thumb"></div></div>';
    html += '<div class="fam-val">' + esc(label) + '</div>';
    html += '</div>';
    return html;
  }

  // ── v5.13 随时复习 / 易混卡片 / 拼写本 ──────────────────────
  function randomUnitPool(scopeId) {
    return state.content.items.filter(function (i) {
      if (i.kind !== 'word' || !i.testable || i.archived) return false;
      if (scopeId !== 'all' && i.unitId !== scopeId) return false;
      return !isMastered(state.progress, i, 'vocab');
    });
  }
  function randomCfg() {
    if (!state.randomCfg) state.randomCfg = { scope: 'all', n: 20 };
    return state.randomCfg;
  }
  function activeRandomSaved() {
    var c = state.progress.ui && state.progress.ui.cards;
    return c && c.scope === 'random' && !c.completed && c.order && c.order.length ? c : null;
  }
  function startRandomCards(scopeId, n) {
    var cfg = randomCfg();
    var scope = scopeId || cfg.scope || 'all';
    var count = clamp(Number(n) || cfg.n || 20, 5, 100);
    var pool = randomUnitPool(scope);
    if (!pool.length) { toast('这个范围还没有单词'); return; }
    var take = Math.min(count, pool.length);
    var ids = seededShuffle(pool.map(function (i) { return i.id; }), 'random|' + Date.now() + '|' + Math.random()).slice(0, take);
    var label = scope === 'all' ? '全部单词' : ((unitById(scope) && unitById(scope).title) || '');
    state.mode = 'e2c';
    state.cards = {
      unitId: '__random__', sectionId: '', scope: 'random', scopeLabel: '随时复习 · ' + label,
      order: ids, index: 0, completed: false, roundNo: 1,
      startedAt: new Date().toISOString(), flips: {}, navLock: false, navEnter: null
    };
    persistCards();
    navigate('cards', { unitId: '__random__' }, true);
  }
  function continueRandom() {
    var saved = activeRandomSaved();
    if (!saved) { startRandomCards(); return; }
    var resumed = resumeCardSession(saved);
    if (!resumed) { startRandomCards(); return; }
    state.cards = resumed;
    persistCards();
    navigate('cards', { unitId: '__random__' }, true);
  }
  function confusableGroupsOf(unitId) {
    return (state.content.confusableGroups || []).filter(function (g) { return !unitId || g.unitId === unitId; });
  }
  function startConfusable(unitId) {
    var groups = confusableGroupsOf(unitId);
    if (!groups.length) { toast('这个单元还没有易混卡片'); return; }
    state.confusable = { unitId: unitId, order: groups.map(function (g) { return g.id; }), index: 0, flipped: false };
    navigate('confusable', { unitId: unitId }, true);
  }
  function confusableGroupById(id) {
    return (state.content.confusableGroups || []).filter(function (g) { return g.id === id; })[0] || null;
  }
  function renderConfusable() {
    var cf = state.confusable;
    if (!cf || !cf.order || !cf.order.length) return emptyState('这个单元还没有易混卡片。', 'unit', '回单元');
    var g = confusableGroupById(cf.order[cf.index]);
    if (!g) return emptyState('这组卡片不存在。', 'unit', '回单元');
    var html = '<div class="q-top"><span class="q-count">' + (cf.index + 1) + ' / ' + cf.order.length + '</span><span class="meta">易混卡片 · 只读</span></div>';
    html += '<div class="progress"><i style="width:' + Math.round(100 * (cf.index + 1) / cf.order.length) + '%"></i></div>';
    html += '<div class="meta cards-unit">' + esc((unitById(cf.unitId) && unitById(cf.unitId).title) || '易混词') + '</div>';
    html += '<div class="study-card v5-card cfg-card' + (cf.flipped ? ' flipped' : '') + '" data-action="confusable-flip" style="margin-top:10px">';
    html += '<div class="v5-card-inner">';
    html += '<div class="v5-face v5-front"><div class="card-hint" style="margin-bottom:6px">这组词容易混，先自己区分</div>';
    g.terms.forEach(function (t) {
      html += '<div class="cfg-front-term"><b>' + esc(t.term) + '</b>' + (t.pos ? ' <span class="sense-pos">' + esc(t.pos) + '</span>' : '') + '</div>';
    });
    html += '<div class="card-hint" style="margin-top:10px">点卡片看释义与辨析</div></div>';
    html += '<div class="v5-face v5-back"><div class="cfg-back">';
    g.terms.forEach(function (t) {
      html += '<div class="cfg-row"><div class="cfg-row-head"><b>' + esc(t.term) + '</b>' + (t.pos ? ' <span class="sense-pos">' + esc(t.pos) + '</span>' : '') + '</div>'
        + (t.meaning ? '<div class="meta">' + esc(t.meaning) + '</div>' : '')
        + (t.note ? '<div class="cfg-note">' + esc(t.note) + '</div>' : '') + '</div>';
    });
    if (g.distinction) html += '<div class="cfg-distinct">' + esc(g.distinction) + '</div>';
    html += '</div></div></div></div>';
    html += '<div class="bottombar"><button class="btn ghost" data-action="confusable-prev"' + (cf.index ? '' : ' disabled') + '>上一组</button>'
      + '<button class="btn primary" data-action="confusable-next">' + (cf.index + 1 >= cf.order.length ? '回板块' : '下一组') + '</button></div>';
    return html;
  }
  function spellingRows(unitId) {
    return state.content.items.filter(function (i) {
      return i.unitId === unitId && (i.kind === 'word' || i.kind === 'phrase') && !i.archived;
    }).map(function (i) {
      var p = ensureItemProgress(state.progress, i.id);
      return { item: i, p: p, active: spellActive(i, p), passed: !!p.spellPassed };
    });
  }
  function renderSpelling() {
    var unit = unitById(state.params.unitId) || currentUnit();
    if (!unit) return emptyState('没有单元。', 'home', '回首页');
    var rows = spellingRows(unit.id);
    var active = rows.filter(function (r) { return r.active && !r.passed; });
    var passed = rows.filter(function (r) { return r.passed; });
    var html = '<div class="card"><h3>拼写本</h3>'
      + '<p class="meta">标了「写作中掌握」的词会自动进来；也可在卡片上滑加入。拼写过的词在这里过关，过关后不再出现，可随时重新练。</p>'
      + '<div class="uh-stats" style="margin-top:10px"><div class="uh-stat"><b>' + active.length + '</b><span>待过关</span></div>'
      + '<div class="uh-stat"><b>' + passed.length + '</b><span>已过关</span></div></div>'
      + '<button class="btn primary block" data-action="spell-start" data-unit="' + esc(unit.id) + '"' + (active.length ? '' : ' disabled') + '>开始拼写（' + active.length + ' 词）</button>'
      + '<p class="meta" style="margin-top:8px">只看中文提示，拼出英文；拼对即过关。</p></div>';
    function row(r, kind) {
      return '<div class="spell-book-row"><div class="grow"><b>' + esc(itemTitle(r.item)) + '</b>'
        + '<div class="meta">' + esc(itemSub(r.item) || '') + (r.item.pos ? ' · ' + esc(r.item.pos) : '') + '</div></div>'
        + '<button class="btn ghost small" data-action="spell-toggle" data-item="' + esc(r.item.id) + '">' + (r.active ? '移出' : '加入') + '</button>'
        + (r.passed ? '<button class="btn ghost small" data-action="spell-reset" data-item="' + esc(r.item.id) + '">重新练</button>' : '')
        + '</div>';
    }
    html += '<div class="card" style="margin-top:12px"><h3>待过关</h3>';
    html += active.length ? active.map(function (r) { return row(r); }).join('') : '<p class="meta">没有待过关的词。</p>';
    html += '</div>';
    html += '<div class="card" style="margin-top:12px"><h3>已过关</h3>';
    html += passed.length ? passed.map(function (r) { return row(r); }).join('') : '<p class="meta">还没有过关的词。</p>';
    html += '</div>';
    html += footer();
    return html;
  }
  function startSpellingTest(unitId) {
    var rows = spellingRows(unitId).filter(function (r) { return r.active && !r.passed; });
    if (!rows.length) { toast('拼写本里没有待过关的词'); return; }
    startTest({ unitId: unitId, mode: 'c2e', scope: 'spelling', limit: Math.min(rows.length, SESSION_SIZE) });
  }

  function renderCards() {
    var c = state.cards;
    if (!c || !c.order || !c.order.length) return emptyState('这次没有可看的卡片。', 'home', '回首页');
    if (c.completed) return renderCardComplete();
    if (c.index < 0) c.index = 0;
    if (c.index >= c.order.length) c.index = c.order.length - 1;
    var item = itemById(c.order[c.index]);
    if (!item) return emptyState('卡片条目不存在。', 'home', '回首页');
    var dir = state.mode === 'c2e' ? 'c2e' : 'e2c';
    var flipped = cardFlipped(c, item.id);
    var isForget = c.scope === 'forget';
    var onlySheng = c.sectionId === 'sheng';
    var cardUnit = unitById(c.unitId);
    var secOf = cardSectionOf(c, item);
    var f = familiarityOf(state.progress, item.id, secOf);
    var alt = isForget ? altSenseOf(item) : null;
    var cardClass = 'study-card v5-card' + (flipped ? ' flipped' : '');
    var html = '<div class="q-top"><span class="q-count">' + (c.index + 1) + ' / ' + c.order.length + '</span><span class="meta">' + esc(isForget ? '遗忘回看 · 例句 → 释义' : (dir === 'c2e' ? '中→英 卡片' : '英→中 卡片')) + '</span></div>';
    html += '<div class="progress"><i style="width:' + Math.round(100 * (c.index + 1) / c.order.length) + '%"></i></div>';
    html += '<div class="meta cards-unit">' + esc(cardUnit ? cardUnit.title : (c.scopeLabel || '随时复习')) + '</div>';
    html += '<div class="cards-stage">';
    if (!isForget) html += '<div class="spell-pull-underlay" aria-hidden="true"><div class="spell-pull-copy">↑ 加入拼写本</div><div class="spell-pull-bar"><i></i></div></div>';
    html += '<div class="' + cardClass + '" data-action="card-flip">';
    html += '<div class="v5-card-inner">';
    // 正面：只显示一个侧别；点整张卡翻面。
    html += '<div class="v5-face v5-front' + (isForget ? ' is-forget' : '') + '">';
    if (isForget) {
      // v5.9：遗忘卡正面 = 一条另一个义项的例句，目标词高亮；底部只留一条提示（旧版两条 .card-hint 会叠字）。
      html += '<div class="card-sentence">'
        + highlightTerm((alt && alt.example) || item.sentence || '', item, alt) + '</div>';
      html += '<div class="card-hint">标出的词在这句里是什么意思？点卡片翻面</div>';
    } else if (onlySheng) {
      html += '<div class="card-term large">' + esc(itemTitle(item)) + '</div>';
      html += '<div class="tagline" style="margin-top:8px">' + tag('熟词生义', 'warn') + '</div>';
      html += '<div class="card-hint">点卡片翻面看生义</div>';
    } else if (dir === 'c2e') {
      html += '<div class="card-meaning large">' + esc(itemSub(item) || '（无中文提示）') + '</div>';
      html += '<div class="card-hint">点卡片翻面</div>';
    } else {
      html += '<div class="card-term large">' + esc(itemTitle(item)) + '</div>';
      html += '<div class="card-hint">点卡片翻面</div>';
    }
    html += '</div>';
    // 背面：上＝词+音标+①②③释义（42%–58% 自适应，填不满留白）；右侧独立滑块列；下＝同序号例句。
    var ctlHtml = '';
    if (isMastered(state.progress, item, secOf)) {
      ctlHtml = '<div class="mastered-badge">完全掌握</div>'
        + '<button class="btn ghost small" data-action="mastery-off" data-item="' + esc(item.id) + '" data-section="' + esc(secOf) + '">取消</button>';
    } else {
      ctlHtml = famSlider(f, item.id, secOf, { compact: true });
    }
    html += '<div class="v5-face v5-back">';
    html += cardBackHtml(item, { isForget: isForget, alt: alt, ctl: ctlHtml, onlySheng: onlySheng });
    html += '</div>';
    html += '</div></div></div>';
    html += '<div class="cards-hint">' + (isForget
      ? '<span>← 左滑下一张</span><span>右滑上一张 →</span><span>评低会留在遗忘复习</span>'
      : '<span>← 左滑下一张</span><span>右滑上一张 →</span><span>↑ 加入拼写</span>') + '</div>';
    return html;
  }
  function readingContexts(unitId) {
    return state.content.contexts.filter(function (c) { return c.unitId === unitId; });
  }
  function readingThemes(unitId) {
    var unit = unitById(unitId);
    var parts = unit && unit.reading && Array.isArray(unit.reading.parts) ? unit.reading.parts : [];
    var seen = {}, out = [];
    parts.forEach(function (p) {
      var th = p.theme || '本单元';
      if (!seen[th]) { seen[th] = 1; out.push({ id: th, label: th }); }
    });
    if (!out.length) readingContexts(unitId).forEach(function (c) {
      var th = c.theme || '本单元';
      if (!seen[th]) { seen[th] = 1; out.push({ id: th, label: th }); }
    });
    return out;
  }
  function markReadingRead(unitId) {
    var sections = ensureSections(state.progress);
    if (!sections.contexts) sections.contexts = { items: {} };
    if (!sections.contexts.items) sections.contexts.items = {};
    var today = studyDate();
    var prev = sections.contexts.items[unitId] || {};
    var count = (Number(prev.readCount) || 0) + 1;
    sections.contexts.items[unitId] = { lastReadAt: today, readCount: count, nextDue: addDays(today, count <= 1 ? 3 : count === 2 ? 7 : 21) };
    if (state.progress.meta) state.progress.meta.updatedAt = new Date().toISOString();
    saveProgress();
  }
  function startReading(unitId, theme) {
    state.reading = { unitId: unitId, theme: theme || '全部' };
    markReadingRead(unitId);
    navigate('reading', { unitId: unitId }, true);
  }
  function markCultureRead(unitId) {
    var items = state.content.items.filter(function (i) { return i.unitId === unitId && i.kind === 'knowledge'; });
    var sections = ensureSections(state.progress);
    if (!sections.culture) sections.culture = { items: {} };
    if (!sections.culture.items) sections.culture.items = {};
    var today = studyDate();
    items.forEach(function (i) { sections.culture.items[i.id] = { readAt: today, seen: true }; });
    if (state.progress.meta) state.progress.meta.updatedAt = new Date().toISOString();
    saveProgress();
    render();
    toast('已标记本节已读');
  }
  function renderReadText(text, notes, partIndex) {
    var raw = String(text == null ? '' : text);
    if (!raw) return '';
    var list = (notes || []).map(function (n, i) { return { n: n, i: i, pos: raw.indexOf(n.sentence) }; })
      .filter(function (x) { return x.pos >= 0 && x.n.sentence; })
      .sort(function (a, b) { return a.pos - b.pos; });
    if (!list.length) return linkTerms(raw);
    var out = '', last = 0;
    list.forEach(function (x) {
      if (x.pos < last) return;
      out += linkTerms(raw.slice(last, x.pos));
      out += '<span class="read-note" role="button" tabindex="0" data-action="hard-note" data-part="' + partIndex + '" data-note="' + x.i + '">' + esc(x.n.sentence) + '</span>';
      last = x.pos + x.n.sentence.length;
    });
    out += linkTerms(raw.slice(last));
    return out;
  }
  function renderReading() {
    var unit = unitById(state.params.unitId) || (state.reading && unitById(state.reading.unitId)) || currentUnit();
    if (!unit) return emptyState('还没有单元数据。', 'home', '回首页');
    if (!state.reading || state.reading.unitId !== unit.id) state.reading = { unitId: unit.id, theme: '全部' };
    var reading = unit.reading || null;
    var parts = reading && Array.isArray(reading.parts) ? reading.parts : null;
    var ctxs = readingContexts(unit.id);
    var fallbackText = ctxs.map(function (c) { return c.text || ''; }).join('\n\n');
    if (!parts && !fallbackText) return emptyState('这一单元还没有阅读。', 'unit', '回单元');
    var words = state.content.items.filter(function (i) { return i.unitId === unit.id && i.sectionId === 'vocab' && !i.archived; });
    var covered = {};
    ((reading && reading.itemIds) || []).forEach(function (id) { covered[id] = 1; });
    parts && parts.forEach(function (p) { (p.itemTerms || []).forEach(function (term) { covered['term:' + term] = 1; }); });
    ctxs.forEach(function (c) { (c.itemIds || []).forEach(function (id) { covered[id] = 1; }); });
    var coveredCount = words.filter(function (i) { return covered[i.id] || covered['term:' + (i.term || '')]; }).length;
    var themes = readingThemes(unit.id);
    var theme = state.reading.theme || '全部';
    if (theme !== '全部' && !themes.some(function (t) { return t.id === theme; })) theme = '全部';
    state.reading.theme = theme;
    var visible = (parts || []).map(function (p, i) { return { p: p, i: i }; }).filter(function (x) { return theme === '全部' || (x.p.theme || '') === theme; });
    var html = '<div class="meta" style="margin-top:2px">' + esc(unit.title) + ' · 词覆盖 ' + coveredCount + ' / ' + words.length + '</div>';
    html += '<div class="read-chips">';
    html += '<button class="chip ' + (theme === '全部' ? 'on' : '') + '" data-action="reading-theme" data-theme="全部">全部</button>';
    themes.forEach(function (t) {
      html += '<button class="chip ' + (theme === t.id ? 'on' : '') + '" data-action="reading-theme" data-theme="' + esc(t.id) + '">' + esc(t.label) + '</button>';
    });
    html += '</div>';
    if (parts && visible.length) {
      visible.forEach(function (x) {
        var part = x.p;
        var pwords = words.filter(function (i) { return (part.itemTerms || []).indexOf(i.term) >= 0; }).length;
        html += '<article class="card read-article">'
          + '<div class="row between"><h3>' + esc(part.title || part.theme || '主题阅读') + '</h3><span class="meta">词覆盖 ' + pwords + ' / ' + words.length + '</span></div>'
          + '<div class="meta" style="margin-top:5px">' + esc(part.theme || '') + ' · CET-4 主题阅读；点划线词看卡片，点虚线句看长难句。</div>';
        (part.paragraphs || []).forEach(function (p) {
          var t = typeof p === 'string' ? p : (p && p.text) || '';
          if (t) html += '<div class="q-sentence read-para">' + renderReadText(t, part.notes, x.i) + '</div>';
        });
        if (part.notes && part.notes.length) html += '<div class="read-foot">长难句 ' + part.notes.length + ' 处 · 点虚线句看结构</div>';
        html += '</article>';
      });
    } else if (fallbackText) {
      html += '<article class="card read-article">' + fallbackText.split(/\n{2,}/).filter(function (p) { return p.trim(); }).map(function (p) {
        return '<div class="q-sentence read-para">' + linkTerms(p) + '</div>';
      }).join('') + '</article>';
    } else {
      html += emptyState('这个主题还没有文章。', 'reading', '看全部');
    }
    html += '<div class="bottombar"><button class="btn primary" data-action="unit" data-unit="' + esc(unit.id) + '">回单元</button></div>';
    html += footer();
    return html;
  }
  function openHardNote(partIndex, noteIndex) {
    var unit = state.reading && unitById(state.reading.unitId);
    var part = unit && unit.reading && unit.reading.parts && unit.reading.parts[partIndex];
    var note = part && part.notes && part.notes[noteIndex];
    if (!note) return;
    state.modalClosing = false;
    state.modal = { type: 'hard', title: part.title || part.theme || '长难句', note: note };
    renderOverlay();
  }

  // ── actions ────────────────────────────────────────────────
  function startTest(opts) {
    var o = opts || {};
    var unitId = o.unitId || (currentUnit() && currentUnit().id);
    if (!unitId) { toast('没有单元'); return; }
    var mode = 'c2e';
    var limit = Math.max(1, Number(o.limit) || SESSION_SIZE);
    var scope = o.scope || 'all';
    var sectionId = o.sectionId || (scope === 'pitfalls' ? 'pitfalls' : '');
    var round = state.progress.ui && state.progress.ui.round;
    if (round && round.completedAt) { round = null; if (state.progress.ui) state.progress.ui.round = null; }
    var built = buildSession(state.content, state.progress, {
      unitId: unitId, mode: mode, scope: scope, sectionId: sectionId, itemId: o.itemId,
      limit: limit, today: studyDate(), audioAvailable: audioEnabled(),
      round: round, includeMastered: o.includeMastered === true
    });
    if (!built.questions.length) { toast('这次没有可出的题；到期词在「遗忘复习」'); return; }
    if (state.progress.ui) state.progress.ui.round = built.round;
    state.session = {
      unitId: unitId, mode: mode, scope: scope, sectionId: sectionId, itemId: o.itemId,
      limit: limit, questions: built.questions, selections: built.selections, round: built.round,
      index: 0, answered: {}, revealed: {}, results: [], startedAt: Date.now()
    };
    state.progress.ui.session = state.session;
    saveProgress();
    navigate('test', { unitId: unitId, sectionId: sectionId }, true);
  }

  function recordAnswer(correct, userIndex, userText) {
    var s = state.session;
    if (!s) return;
    var q = s.questions[s.index];
    if (s.answered[q.id]) return;
    var item = itemById(q.itemId);
    if (!item) return;
    var recSection = q.sectionId || (s.scope === 'pitfalls' ? 'pitfalls' : (s.sectionId || item.sectionId));
    var rec = recordTest(state.progress, item, !!correct, q, studyDate(), recSection);
    s.answered[q.id] = { correct: !!correct, rec: rec, userIndex: userIndex, userText: userText || '' };
    s.results.push({ q: q, correct: !!correct, itemId: item.id, userIndex: userIndex, userText: userText || '' });
    state.progress.ui.session = s;
    saveProgress();
    render();
  }
  function submitChoice(index) {
    var s = state.session; if (!s) return;
    var q = s.questions[s.index];
    if (s.answered[q.id]) return;
    recordAnswer(index === q.answer, index);
  }
  function submitTyped() {
    var s = state.session; if (!s) return;
    var q = s.questions[s.index];
    if (s.answered[q.id]) return;
    var input = document.getElementById('answer-input');
    var value = input ? input.value : '';
    var correct = answerMatches(value, q.answers || []);
    recordAnswer(correct, null, value);
  }
  function submitSelf(good) {
    var s = state.session; if (!s) return;
    var q = s.questions[s.index];
    if (s.answered[q.id]) return;
    var el = document.getElementById('produce-input');
    recordAnswer(!!good, null, el ? el.value : 'self');
  }
  function nextQuestion() {
    var s = state.session; if (!s) return;
    if (s.index + 1 >= s.questions.length) {
      finishSession();
      return;
    }
    s.index += 1;
    state.progress.ui.session = s;
    saveProgress();
    render();
    try { window.scrollTo(0, 0); } catch (e) { /* ignore */ }
  }
  function finishSession() {
    var s = state.session; if (!s) return;
    var correct = s.results.filter(function (r) { return r.correct; }).length;
    var u = state.progress.units[s.unitId] || {};
    u.tests = (u.tests || 0) + 1;
    u.lastTested = studyDate();
    state.progress.units[s.unitId] = u;
    state.progress.history.push({ at: new Date().toISOString(), date: studyDate(), unitId: s.unitId, sectionId: s.sectionId || '', mode: s.mode, scope: s.scope, roundId: s.round && s.round.id, questions: s.questions.length, correct: correct });
    if (state.progress.history.length > 500) state.progress.history.shift();
    state.progress.ui.session = null;
    state.lastSummary = {
      report: buildReport(state.content, state.progress, s.unitId, studyDate()),
      unitId: s.unitId, mode: s.mode, scope: s.scope, sectionId: s.sectionId || (s.scope === 'pitfalls' ? 'pitfalls' : 'vocab'),
      sections: (s.sections || []).slice(), limit: s.limit, questions: s.questions.slice(), results: s.results.slice(),
      correct: correct, total: s.questions.length
    };
    saveProgress();
    state.screen = 'summary';
    state.params = { unitId: s.unitId, sectionId: s.sectionId || '' };
    try { history.replaceState({ screen: 'summary', params: state.params, scrollY: 0 }, '', location.href); } catch (e) { /* ignore */ }
    render();
    try { window.scrollTo(0, 0); } catch (e) { /* ignore */ }
  }

  function currentCardItem() {
    var c = state.cards;
    return c && c.order && c.order[c.index] ? itemById(c.order[c.index]) : null;
  }
  function cardSpellOf(itemId) {
    return !!(state.progress.items && state.progress.items[itemId] && state.progress.items[itemId].spell);
  }
  function updateCardSpellChip() { /* v5.7: 卡内不再放拼写 chip */ }
  function playSpellFx(added, already, skipFly) {
    var card = document.querySelector('#screen .v5-card');
    if (!card) return;
    card.classList.remove('spell-fly', 'spell-bump');
    void card.offsetWidth;
    if (!skipFly) card.classList.add(added ? 'spell-fly' : 'spell-bump');
    toast(already ? '已在拼写本' : (added ? '已加入拼写本' : '已移出拼写本'));
    clearTimeout(spellFxTimer);
    spellFxTimer = setTimeout(function () {
      card.classList.remove('spell-fly', 'spell-bump');
    }, 680);
  }
  function addCardSpell(skipFly) {
    var item = currentCardItem();
    if (!item) return;
    if (cardSpellOf(item.id)) { playSpellFx(false, true, skipFly); return; }
    setSpell(state.progress, item, true);
    saveProgress();
    updateCardSpellChip();
    playSpellFx(true, false, skipFly);
  }
  function removeCardSpell() {
    var item = currentCardItem();
    if (!item || !cardSpellOf(item.id)) return;
    setSpell(state.progress, item, false);
    saveProgress();
    updateCardSpellChip();
    playSpellFx(false, false);
  }
  function toggleCardSpell() {
    var item = currentCardItem();
    if (!item) return;
    if (cardSpellOf(item.id)) removeCardSpell();
    else addCardSpell();
  }

  // v5.9.2：原始值不夹在 0–3——「拖过头」要靠 >3 的那部分才触发上冲动画。
  // 旧实现把值 clamp 到 3，而越界门槛写得比 3 还高 → 永远不成立，动画等于废掉。
  function famRawAt(el, clientX, clientY) {
    var track = el && el.querySelector('.fam-track');
    if (!track) return 0;
    var r = track.getBoundingClientRect();
    if (!r.height && !r.width) return 0;
    if (el.getAttribute('data-orientation') === 'h') return ((clientX - r.left) / Math.max(1, r.width)) * 3;
    return ((r.bottom - clientY) / Math.max(1, r.height)) * 3;
  }
  function famValueAt(el, clientX, clientY) {
    return clamp(famRawAt(el, clientX, clientY), 0, 3);
  }
  function famOverAt(el, clientX, clientY) {
    var track = el && el.querySelector('.fam-track');
    if (!track) return 0;
    var r = track.getBoundingClientRect();
    if (el.getAttribute('data-orientation') === 'h') return Math.max(0, (clientX - r.right) / Math.max(1, r.width));
    return Math.max(0, (r.top - clientY) / Math.max(1, r.height));
  }
  function paintFam(el, value, pullPx) {
    if (!el) return;
    var v = clamp(value, 0, 3);
    var rounded = Math.round(v);
    el.classList.remove('is-unset');
    el.style.setProperty('--fam-fill', (v / 3) * 100 + '%');
    el.style.setProperty('--fam-pull', clamp(Number(pullPx) || 0, 0, 22) + 'px');
    var ticks = el.querySelectorAll('.fam-tick');
    for (var i = 0; i < ticks.length; i++) ticks[i].classList.toggle('on', Math.abs(Number(ticks[i].getAttribute('data-level')) - v) < 0.5);
    var label = el.querySelector('.fam-val');
    if (label) label.textContent = selfLabel(rounded);
    el.setAttribute('aria-valuenow', String(rounded));
    el.setAttribute('aria-valuetext', selfLabel(rounded));
  }
  function onFamDown(e) {
    var el = e.target && e.target.closest ? e.target.closest('.fam-slider') : null;
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    famDrag = {
      id: e.pointerId, el: el, itemId: el.getAttribute('data-item'),
      section: el.getAttribute('data-section') || (state.cards && state.cards.sectionId) || 'vocab',
      over: false, startLevel: Number(el.getAttribute('aria-valuenow')) || 0
    };
    el.classList.add('dragging');
    try { el.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    paintFam(el, famValueAt(el, e.clientX, e.clientY));
  }
  function onFamMove(e) {
    if (!famDrag) return;
    e.preventDefault();
    var el = famDrag.el;
    var raw = famRawAt(el, e.clientX, e.clientY);
    var value = clamp(raw, 0, 3);
    var overRatio = raw >= 3 ? famOverAt(el, e.clientX, e.clientY) : 0;
    famDrag.over = overRatio >= 0.08;
    var track = el.querySelector('.fam-track');
    var trackLen = track ? (el.getAttribute('data-orientation') === 'h' ? track.getBoundingClientRect().width : track.getBoundingClientRect().height) : 0;
    // 从贴边那一刻就连续跟手；阻力曲线让越拖越沉，且不会在 8% 门槛处瞬跳。
    var overPx = overRatio * trackLen;
    var pull = 22 * (1 - Math.exp(-overPx / 24));
    paintFam(el, value, pull);
    el.classList.toggle('over', !!famDrag.over);
  }
  function onFamUp(e) {
    if (!famDrag) return;
    e.preventDefault();
    e.stopPropagation();
    var drag = famDrag;
    famDrag = null;
    if (e.type === 'pointercancel') {
      drag.el.classList.remove('dragging', 'over');
      paintFam(drag.el, Number(drag.el.getAttribute('aria-valuenow')) || 0, 0);
      return;
    }
    var item = itemById(drag.itemId);
    var level = Math.round(famValueAt(drag.el, e.clientX, e.clientY));
    var over = level >= 3 && (drag.over || famOverAt(drag.el, e.clientX, e.clientY) >= 0.08);
    drag.el.classList.remove('dragging', 'over');
    drag.el.classList.add('snapping');
    paintFam(drag.el, level);
    if (item) {
      if (state.screen === 'cards' && state.cards && state.cards.scope === 'forget') {
        setForgetFamiliarity(state.progress, item, level, drag.section, 'forget-slider');
      } else {
        setFamiliarity(state.progress, item, level, 'card-slider', drag.section);
      }
      saveProgress();
      var cur = document.querySelector('.word-pop .self-current, .dict-card .self-current');
      if (cur) cur.textContent = selfLabel(level);
      // v5.9.1：往更熟悉的方向拖并停在更高一档时，滑块弹一下，让「升级」看得见。
      if (level > drag.startLevel) {
        var upEl = drag.el;
        upEl.classList.add('level-up');
        setTimeout(function () { upEl.classList.remove('level-up'); }, 460);
      }
      if (over) openMasteryConfirm(item, drag.section);
    }
    setTimeout(function () { drag.el.classList.remove('snapping'); }, 300);
  }
  function onFamKey(e) {
    var el = e.target && e.target.closest ? e.target.closest('.fam-slider') : null;
    if (!el) return;
    var now = Number(el.getAttribute('aria-valuenow'));
    var next = now;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') next = Math.min(3, now + 1);
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') next = Math.max(0, now - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = 3;
    else return;
    e.preventDefault();
    var item = itemById(el.getAttribute('data-item'));
    if (!item) return;
    paintFam(el, next);
    var ksec = el.getAttribute('data-section') || (state.cards && state.cards.sectionId) || 'vocab';
    if (state.screen === 'cards' && state.cards && state.cards.scope === 'forget') {
      setForgetFamiliarity(state.progress, item, next, ksec, 'forget-key');
    } else {
      setFamiliarity(state.progress, item, next, 'card-slider', ksec);
    }
    saveProgress();
  }

  function cardGestureMode(dx, dy) {
    var ax = Math.abs(dx), ay = Math.abs(dy);
    if (ax < 8 && ay < 8) return 'pending';
    if (ax > ay * 1.2) return 'h';
    if (dy < 0 && ay > ax * 1.1) return 'v';
    return 'pending';
  }
  function cardPullProgress(dy, height) {
    if (!height || dy >= 0) return 0;
    return Math.max(0, Math.min(1, (-dy) / height));
  }
  function cardShouldCommitH(dx, width) {
    return Math.abs(dx) >= Math.min(72, Math.max(1, width) * 0.28);
  }
  function cardShouldCommitV(progress) {
    return progress >= 0.55;
  }
  function cardUnderlay() {
    return refs.screen.querySelector('.spell-pull-underlay');
  }
  function paintCardPull(progress) {
    var u = cardUnderlay();
    if (!u) return;
    var ready = progress >= 0.55;
    u.classList.toggle('show', progress > 0.02);
    u.classList.toggle('ready', ready);
    u.classList.remove('commit');
    u.style.setProperty('--pull', Math.round(Math.min(1, progress / 0.55) * 100) + '%');
    var copy = u.querySelector('.spell-pull-copy');
    if (copy) copy.textContent = ready ? '松手加入拼写本' : '↑ 加入拼写本';
  }
  function clearCardMotion(card, snap) {
    if (!card) return;
    var fromTransform = 'none';
    try {
      var cs = getComputedStyle(card);
      if (cs && cs.transform && cs.transform !== 'none') fromTransform = cs.transform;
    } catch (e) { /* ignore */ }
    card.classList.remove('drag-h', 'drag-v');
    card.classList.add('settling');
    card.style.setProperty('--drag-x', '0px');
    card.style.setProperty('--drag-rot', '0deg');
    card.style.setProperty('--pull-y', '0px');
    if (fromTransform !== 'none') {
      card.style.transform = fromTransform;
      void card.offsetWidth;
      card.style.transform = '';
    }
    var u = cardUnderlay();
    if (u) {
      u.classList.remove('show', 'ready');
      u.style.removeProperty('--pull');
    }
    setTimeout(function () {
      card.classList.remove('settling');
      card.style.removeProperty('--drag-x');
      card.style.removeProperty('--drag-rot');
      card.style.removeProperty('--pull-y');
      card.style.removeProperty('transform');
    }, 360);
  }
  function commitCardSpell(card) {
    var item = currentCardItem();
    if (!item) return;
    // 从当前被上拉的位置平滑落回；不要先 remove 再依赖 CSS，否则会瞬移。
    var fromTransform = '';
    try {
      var cs = getComputedStyle(card);
      if (cs && cs.transform && cs.transform !== 'none') fromTransform = cs.transform;
    } catch (e) { /* ignore */ }
    card.classList.remove('drag-h', 'drag-v');
    card.style.setProperty('--drag-x', '0px');
    card.style.setProperty('--drag-rot', '0deg');
    card.style.setProperty('--pull-y', '0px');
    if (fromTransform) {
      card.style.transform = fromTransform;
      card.classList.add('settling');
      void card.offsetWidth;
      card.style.transform = '';
    } else {
      card.classList.add('settling');
    }
    setTimeout(function () {
      card.classList.remove('settling');
      card.style.removeProperty('--drag-x');
      card.style.removeProperty('--drag-rot');
      card.style.removeProperty('--pull-y');
      card.style.removeProperty('transform');
    }, 380);
    var u = cardUnderlay();
    if (u) {
      // 成功提示只走卡上的 stamp；卡下提示立即隐藏，避免“完成态”二次出现。
      u.classList.remove('show', 'ready');
      u.classList.add('commit');
      u.style.removeProperty('--pull');
      setTimeout(function () {
        u.classList.remove('commit');
      }, 80);
    }
    addCardSpell(true);
  }
  function commitCardNav(delta, card) {
    var c = state.cards;
    if (!c || c.completed || c.navLock) return false;
    if (delta > 0) autoForgetOnAdvance();
    var dir = delta > 0 ? 'next' : 'prev';
    if (delta < 0 && c.index <= 0) { clearCardMotion(card, true); return false; }
    c.navLock = true;
    if (card) {
      var fromTransform = 'translateX(0)';
      try {
        var cs = getComputedStyle(card);
        if (cs && cs.transform && cs.transform !== 'none') fromTransform = cs.transform;
      } catch (e) { /* ignore */ }
      card.classList.remove('drag-h', 'drag-v');
      if (card.animate) {
        card.animate([
          { transform: fromTransform, opacity: 1 },
          { transform: dir === 'next' ? 'translateX(-110%) rotate(-5deg)' : 'translateX(110%) rotate(5deg)', opacity: 0.25 }
        ], { duration: 220, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'forwards' });
      } else {
        card.classList.add('card-leaving-' + dir);
      }
    }
    if (delta > 0 && c.index + 1 >= c.order.length) {
      setTimeout(function () {
        if (state.cards !== c) return;
        c.completed = true;
        c.navLock = false;
        persistCards();
        render();
        try { window.scrollTo(0, 0); } catch (e) { /* ignore */ }
      }, 220);
      return true;
    }
    setTimeout(function () {
      if (state.cards !== c) return;
      c.index += delta;
      c.navEnter = dir;
      persistCards();
      render();
      try { window.scrollTo(0, 0); } catch (e) { /* ignore */ }
      setTimeout(function () {
        if (state.cards !== c) return;
        c.navEnter = null;
        c.navLock = false;
      }, 360);
    }, 220);
    return true;
  }
  function autoForgetOnAdvance() {
    if (state.screen !== 'cards' || !state.cards || state.cards.scope !== 'forget' || state.cards.completed) return;
    var item = currentCardItem();
    if (!item) return;
    var sec = cardSectionOf(state.cards, item);
    var p = stateOf(state.progress, item.id, sec);
    if (!p || clampFam(p.familiarity) !== FAM_TOP) return; // 评低的已标记为留在遗忘池
    setForgetFamiliarity(state.progress, item, FAM_TOP, sec, 'forget-view');
    saveProgress();
  }
  function advanceCard(delta) {
    var card = refs.screen.querySelector('.v5-card');
    return commitCardNav(delta, card);
  }
  // v5.9：卡背的释义/例句区由我们自己滚（touch-action:none），所以任何位置都能起手上拉；
  // 唯一例外是遗忘卡——它不写拼写本，竖向手势直接拦掉。
  function scrollHostCanScroll(el) {
    return !!(el && el.scrollHeight - el.clientHeight > 2);
  }
  function canStartCardGesture(o) {
    o = o || {};
    if (o.isForget && o.mode === 'v') return false;
    return true;
  }
  function onCardPointerDown(e) {
    if (state.screen !== 'cards' || !state.cards || state.cards.completed || state.cards.navLock) return;
    if (e.button != null && e.button !== 0) return;
    var t = e.target;
    if (!t || !t.closest || !t.closest('.v5-card')) return;
    if (t.closest('.fam-slider, button, input, textarea, select, .self-btn, .card-spell')) return;
    var card = t.closest('.v5-card');
    if (card.classList.contains('card-leaving-next') || card.classList.contains('card-leaving-prev')) return;
    // v5.9.1：卡背的释义/例句区如果本身能滚，就交给浏览器原生滚动（不抢手势），
    // 否则拉卡片会跟滚动打架——上一版就是这样把手势吃掉、例句块再也滑不动。
    var scrollEl = t.closest('.sense-defs, .sense-examples');
    if (scrollHostCanScroll(scrollEl)) return;
    cardGesture = {
      id: e.pointerId, x: e.clientX, y: e.clientY, dx: 0, dy: 0, mode: 'pending', card: card, progress: 0
    };
    try { card.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
  }
  function onCardPointerMove(e) {
    if (!cardGesture || e.pointerId !== cardGesture.id) return;
    var g = cardGesture;
    g.dx = e.clientX - g.x;
    g.dy = e.clientY - g.y;
    if (g.mode === 'pending') {
      g.mode = cardGestureMode(g.dx, g.dy);
      if (!canStartCardGesture({ isForget: isForgetScope(), mode: g.mode })) { g.mode = 'blocked'; clearCardMotion(g.card, true); return; }
      if (g.mode === 'pending') return;
      g.card.classList.add(g.mode === 'h' ? 'drag-h' : 'drag-v');
    }
    try { e.preventDefault(); } catch (err) { /* ignore */ }
    if (g.mode === 'h') {
      var x = g.dx * 0.85;
      g.card.style.setProperty('--drag-x', Math.round(x) + 'px');
      g.card.style.setProperty('--drag-rot', (x / 40).toFixed(2) + 'deg');
    } else {
      var h = g.card.getBoundingClientRect().height || 1;
      g.progress = cardPullProgress(g.dy, h);
      g.card.style.setProperty('--pull-y', Math.round(g.dy * 0.8) + 'px');
      paintCardPull(g.progress);
    }
  }
  function onCardPointerUp(e) {
    if (!cardGesture || e.pointerId !== cardGesture.id) return;
    var g = cardGesture;
    cardGesture = null;
    if (g.mode === 'pending') {
      if (Math.abs(g.dx) > 8 || Math.abs(g.dy) > 8) suppressCardClick = true;
      return;
    }
    if (g.mode === 'blocked') { clearCardMotion(g.card, true); return; }
    suppressCardClick = true;
    setTimeout(function () { suppressCardClick = false; }, 1000);
    if (g.mode === 'h') {
      var w = g.card.getBoundingClientRect().width || 1;
      if (cardShouldCommitH(g.dx, w)) commitCardNav(g.dx < 0 ? 1 : -1, g.card);
      else clearCardMotion(g.card, true);
    } else if (g.mode === 'v') {
      if (cardShouldCommitV(g.progress)) commitCardSpell(g.card);
      else clearCardMotion(g.card, true);
    }
  }
  function onCardPointerCancel() {
    if (cardGesture && cardGesture.card) clearCardMotion(cardGesture.card, true);
    cardGesture = null;
  }

  function onClick(e) {
    if (e.target && e.target.closest && e.target.closest('.fam-slider')) return;
    if (suppressCardClick) {
      suppressCardClick = false;
      if (e.target && e.target.closest && e.target.closest('.v5-card')) return;
    }
    var el = e.target.closest ? e.target.closest('[data-action]') : null;
    if (!el) return;
    var a = el.getAttribute('data-action');
    var d = el.dataset || {};
    if (a === 'card-inner' || a === 'modal-inner') return;
    if (a === 'close-card') { closeCard(); return; }
    if (a === 'modal-close') { closeModal(); return; }
    if (a === 'mastery-confirm') {
      var mm = state.modal || {};
      var mi = itemById(mm.itemId);
      if (mi) { setMastered(state.progress, mi, mm.sectionId, true); saveProgress(); }
      state.modal = null;
      state.modalClosing = false;
      renderOverlay(true);
      if (state.screen === 'item' || state.screen === 'substitution' || state.screen === 'cards') render();
      return;
    }
    if (a === 'mastery-cancel') {
      state.modal = null;
      state.modalClosing = false;
      renderOverlay();
      return;
    }
    if (a === 'mastery-off') {
      var mo = itemById(d.item);
      if (mo) { setMastered(state.progress, mo, d.section || mo.sectionId || 'vocab', false); saveProgress(); }
      if (state.screen === 'item' || state.screen === 'substitution' || state.screen === 'cards') render();
      else renderOverlay(true);
      return;
    }
    if (a === 'word') {
      if (el.closest && el.closest('.dict-card, .word-pop')) return;
      openCard(d.item, el);
      return;
    }
    if (a === 'home') { navigate('home', {}); return; }
    if (a === 'unit') {
      if (state.screen === 'cards' && state.cards && state.cards.scope === 'forget' && !state.cards.completed) autoForgetOnAdvance();
      navigate('unit', { unitId: d.unit });
      return;
    }
    if (a === 'section') {
      if (d.section === 'contexts') { startReading(d.unit, '全部'); return; }
      if (d.section === 'substitutions') { startSubstitution(d.unit); return; }
      markSectionOpened(d.unit, d.section);
      navigate('section', { unitId: d.unit, sectionId: d.section });
      return;
    }
    if (a === 'culture-read') { markCultureRead(d.unit); return; }
    if (a === 'sections') { navigate('section', { unitId: d.unit, sectionId: 'vocab' }); return; }
    if (a === 'item') { navigate('item', { unitId: d.unit, itemId: d.item, sectionId: d.section || '' }); return; }
    if (a === 'edit-item') { openEditRequest(itemById(d.item)); return; }
    if (a === 'cards') { startCards(d.unit, d.section || 'vocab'); return; }
    if (a === 'forget') {
      var fu = d.unit || state.params.unitId || (currentUnit() && currentUnit().id);
      var fsecs = forgetDueSections(fu);
      state.forget = { unitId: fu, sections: fsecs.filter(function (s) { return s.count > 0; }).map(function (s) { return s.id; }) };
      navigate('forget', { unitId: fu }, true);
      return;
    }
    if (a === 'forget-toggle') {
      if (!state.forget) return;
      var fsid = d.section;
      var arr = state.forget.sections || [];
      var ix = arr.indexOf(fsid);
      if (ix >= 0) arr.splice(ix, 1); else arr.push(fsid);
      state.forget.sections = arr;
      render();
      return;
    }
    if (a === 'forget-all' || a === 'forget-none') {
      var fs = forgetDueSections(state.params.unitId || (currentUnit() && currentUnit().id));
      state.forget = { unitId: state.params.unitId, sections: a === 'forget-all' ? fs.filter(function (s) { return s.count > 0; }).map(function (s) { return s.id; }) : [] };
      render();
      return;
    }
    if (a === 'start-forget') {
      var fsu = state.params.unitId || (state.forget && state.forget.unitId) || (currentUnit() && currentUnit().id);
      var fss = state.forget && state.forget.sections || [];
      if (!fss.length) { toast('先选一个板块'); return; }
      startForget(fsu, fss);
      return;
    }
    if (a === 'card-restart') {
      var cc = state.cards;
      if (cc && cc.scope === 'forget') { startForget(d.unit, cc.sectionIds || []); return; }
      startCards(d.unit, d.section || '', true); return;
    }
    if (a === 'reading') { startReading(d.unit, '全部'); return; }
    if (a === 'reading-theme') {
      if (!state.reading) state.reading = { unitId: state.params.unitId || (currentUnit() && currentUnit().id), theme: '全部' };
      state.reading.theme = d.theme;
      render();
      return;
    }
    if (a === 'hard-note') {
      openHardNote(Number(d.part), Number(d.note));
      return;
    }
    if (a === 'settings') { navigate('settings', { unitId: state.params.unitId || (currentUnit() && currentUnit().id) }); return; }
    if (a === 'back') { back(); return; }
    if (a === 'mode') {
      state.mode = d.mode;
      state.progress.settings.lastMode = d.mode;
      saveProgress();
      render();
      return;
    }
    if (a === 'theme') { applyTheme(d.value, true, e); return; }
    if (a === 'theme-auto') {
      applyTheme(themeAutoOn() ? resolvedTheme('auto') : 'auto', true, e);
      return;
    }
    if (a === 'start') { startCards(d.unit, d.section || 'vocab'); return; }
    if (a === 'continue') {
      var cs = state.progress.ui.session;
      if (cs && cs.unitId === d.unit && cs.questions && cs.questions.length) {
        state.session = JSON.parse(JSON.stringify(cs));
        navigate('test', { unitId: d.unit }, true);
      } else toast('上次的题已失效，重新开始');
      return;
    }
    if (a === 'quick') { startTest({ unitId: d.unit, mode: state.mode, scope: 'section', sectionId: 'vocab', limit: SESSION_SIZE }); return; }
    if (a === 'spelling') { navigate('spelling', { unitId: d.unit || state.params.unitId || (currentUnit() && currentUnit().id) }); return; }
    if (a === 'mastered') { startTest({ unitId: d.unit, mode: state.mode, scope: 'mastered', sectionId: 'vocab', limit: SESSION_SIZE, includeMastered: true }); return; }
    if (a === 'start-section') {
      var scope = d.section === 'pitfalls' ? 'pitfalls' : 'section';
      startTest({ unitId: d.unit, mode: state.mode, scope: scope, sectionId: d.section, limit: SESSION_SIZE });
      return;
    }
    if (a === 'pitfalls') { startTest({ unitId: d.unit, mode: state.mode, scope: 'pitfalls', limit: SESSION_SIZE }); return; }
    if (a === 'sheng-cards') { startCards(d.unit, 'sheng'); return; }
    if (a === 'confusable-cards') { startConfusable(d.unit); return; }
    if (a === 'confusable-flip') {
      if (state.confusable) { state.confusable.flipped = !state.confusable.flipped; render(); }
      return;
    }
    if (a === 'confusable-prev' || a === 'confusable-next') {
      var cf = state.confusable;
      if (!cf) return;
      if (a === 'confusable-next' && cf.index + 1 >= cf.order.length) {
        navigate('section', { unitId: cf.unitId, sectionId: 'pitfalls' }, false);
        return;
      }
      cf.index = Math.max(0, Math.min(cf.order.length - 1, cf.index + (a === 'confusable-next' ? 1 : -1)));
      cf.flipped = false;
      render();
      try { window.scrollTo(0, 0); } catch (e) { /* ignore */ }
      return;
    }
    if (a === 'spell-toggle') {
      var stItem = itemById(d.item);
      if (stItem) {
        var stP = ensureItemProgress(state.progress, stItem.id);
        setSpell(state.progress, stItem, !spellActive(stItem, stP));
        saveProgress();
        render();
      }
      return;
    }
    if (a === 'spell-reset') {
      var srItem = itemById(d.item);
      if (srItem) {
        var srP = ensureItemProgress(state.progress, srItem.id);
        srP.spellPassed = false;
        srP.spellPassedAt = null;
        srP.spellAttempts = 0;
        saveProgress();
        render();
      }
      return;
    }
    if (a === 'spell-start') { startSpellingTest(d.unit || state.params.unitId || (currentUnit() && currentUnit().id)); return; }
    if (a === 'random-scope') { randomCfg().scope = d.scope || 'all'; render(); return; }
    if (a === 'random-count') { randomCfg().n = Number(d.n) || 20; render(); return; }
    if (a === 'random-start') { startRandomCards(d.scope || randomCfg().scope, randomCfg().n); return; }
    if (a === 'random-continue') { continueRandom(); return; }
    if (a === 'start-item') { openCard(d.item); return; }
    if (a === 'option') { submitChoice(Number(d.index)); return; }
    if (a === 'submit-typed') { submitTyped(); return; }
    if (a === 'self') { submitSelf(d.good === '1'); return; }
    if (a === 'give-up') {
      var s = state.session;
      if (s) { var q = s.questions[s.index]; if (!s.answered[q.id]) { s.revealed = s.revealed || {}; s.revealed[q.id] = true; recordAnswer(false, null, 'give-up'); } }
      return;
    }
    if (a === 'show-answer') {
      var ss = state.session;
      if (ss) { var qq = ss.questions[ss.index]; ss.revealed = ss.revealed || {}; ss.revealed[qq.id] = true; render(); }
      return;
    }
    if (a === 'next') { nextQuestion(); return; }
    if (a === 'card-next') { advanceCard(1); return; }
    if (a === 'card-prev') { advanceCard(-1); return; }
    if (a === 'sub-reveal') {
      if (state.substitution) { state.substitution.revealed = true; persistSubstitution(); render(); }
      return;
    }
    if (a === 'sub-self') {
      var su = itemById(d.item);
      if (su) { setFamiliarity(state.progress, su, Number(d.level) || 0, 'substitution', 'substitutions'); saveProgress(); render(); }
      return;
    }
    if (a === 'sub-prev' || a === 'sub-next') {
      var sub = state.substitution;
      if (!sub) return;
      var sd = a === 'sub-next' ? 1 : -1;
      var ni = Math.max(0, Math.min(sub.order.length - 1, sub.index + sd));
      if (a === 'sub-next' && sub.index + 1 >= sub.order.length) { toast('这一单元的替换已走完'); return; }
      sub.index = ni;
      sub.revealed = false;
      persistSubstitution();
      render();
      try { window.scrollTo(0, 0); } catch (e) { /* ignore */ }
      return;
    }
    if (a === 'lower') {
      var li = itemById(d.item);
      if (li) {
        var lsec = state.session && state.session.scope === 'pitfalls' ? 'pitfalls' : (state.session && state.session.sectionId || li.sectionId);
        var lf = familiarityOf(state.progress, li.id, lsec);
        if (lf !== null && lf > 0) { setFamiliarity(state.progress, li, lf - 1, 'test-suggest', lsec); saveProgress(); render(); toast('已下调到 ' + selfLabel(lf - 1)); }
      }
      return;
    }
    if (a === 'card-spell') {
      toggleCardSpell();
      return;
    }
    if (a === 'card-detail') { expandCard(); return; }
    if (a === 'card-flip') {
      var cc = state.cards;
      if (!cc || cc.completed) return;
      var cardEl = refs.screen.querySelector('.v5-card');
      if (!cardEl || cardEl.classList.contains('card-leaving-next') || cardEl.classList.contains('card-leaving-prev')) return;
      var ci = currentCardItem();
      if (!ci) return;
      var flippedNow = cardFlipped(cc, ci.id);
      setCardFlipped(cc, ci.id, !flippedNow);
      cardEl.classList.toggle('flipped', !flippedNow);
      persistCards();
      return;
    }
    if (a === 'card-self') {
      var level = Number(d.level) || 0;
      if (state.dictCard) {
        var di = itemById(state.dictCard);
        if (di) {
          var dsec = d.section || 'vocab';
          setFamiliarity(state.progress, di, level, 'card', dsec);
          saveProgress();
          var root = document.querySelector('.word-pop') || document.querySelector('.dict-card');
          if (root) {
            Array.prototype.forEach.call(root.querySelectorAll('[data-action="card-self"]'), function (b) {
              b.classList.toggle('on', Number(b.getAttribute('data-level')) === level);
            });
            var cur = root.querySelector('.self-current');
            if (cur) cur.textContent = selfLabel(level);
          }
          if (state.screen === 'item' && state.params.itemId === di.id) render();
          else renderOverlay();
        }
      } else if (state.cards) {
        var ci = itemById(state.cards.order[state.cards.index]);
        if (ci) {
          setFamiliarity(state.progress, ci, level, 'card', state.cards.sectionId || 'vocab');
          persistCards();
          render();
        }
      } else if (state.screen === 'item') {
        var ii = itemById(state.params.itemId);
        if (ii) {
          var isec = state.params.sectionId || ii.sectionId || 'vocab';
          setFamiliarity(state.progress, ii, level, 'manage', isec);
          saveProgress();
          render();
        }
      }
      return;
    }
    if (a === 'basis') {
      state.showBasis[d.qid] = !state.showBasis[d.qid];
      render();
      return;
    }
    if (a === 'play') { speak(d.text); return; }
    if (a === 'dismiss-audio') { state.audioNotice = false; render(); return; }
    if (a === 'audio-setting') {
      state.progress.settings.audio = d.value;
      saveProgress();
      if (d.value === 'on' && !state.audioAvailable) toast('未检测到英语语音；仍然不能播放');
      render();
      return;
    }
    if (a === 'audio-test') {
      if (!state.audioAvailable) { toast('未检测到英语语音'); return; }
      var sample = 'The morale of the class went up after the teacher praised us.';
      speak(sample);
      return;
    }
    if (a === 'copy-report') {
      var rep = state.lastSummary && state.lastSummary.report;
      if (!rep) rep = buildReport(state.content, state.progress, state.params.unitId || (currentUnit() && currentUnit().id), studyDate());
      copyText(rep);
      return;
    }
    if (a === 'retry') {
      if (state.lastSummary && state.lastSummary.scope === 'forget') {
        startForget(state.lastSummary.unitId, state.lastSummary.sections || []);
      } else if (state.lastSummary) {
        startTest({
          unitId: state.lastSummary.unitId, mode: state.lastSummary.mode, scope: state.lastSummary.scope,
          sectionId: state.lastSummary.sectionId, limit: state.lastSummary.limit
        });
      }
      return;
    }
    if (a === 'summary-home') {
      var sh = state.lastSummary && state.lastSummary.unitId || state.params.unitId || (currentUnit() && currentUnit().id);
      navigate('unit', { unitId: sh }, false);
      return;
    }
    if (a === 'export') { openExportModal(); return; }
    if (a === 'import') { openImportModal(); return; }
    if (a === 'backup') { openBackupModal(); return; }
    if (a === 'copy-export') {
      var ta = document.getElementById('export-json');
      copyText(ta ? ta.value : (state.modal && state.modal.json) || '');
      return;
    }
    if (a === 'copy-edit') {
      var te = document.getElementById('edit-json');
      copyText(te ? te.value : (state.modal && state.modal.json) || '');
      return;
    }
    if (a === 'download-export') { downloadExport(); return; }
    if (a === 'import-file') {
      try {
        var input = document.createElement('input');
        input.type = 'file'; input.accept = '.json,application/json';
        input.onchange = function () {
          var f = input.files && input.files[0];
          if (!f) return;
          var reader = new FileReader();
          reader.onload = function () {
            if (!state.modal || state.modal.type !== 'import') return;
            state.modal.text = String(reader.result || '');
            var ta2 = document.getElementById('import-json');
            if (ta2) ta2.value = state.modal.text;
            previewImport();
          };
          reader.readAsText(f, 'utf-8');
        };
        input.click();
      } catch (e) { toast('选文件失败；可直接粘贴 JSON'); }
      return;
    }
    if (a === 'import-preview') { previewImport(); return; }
    if (a === 'import-mode') {
      if (!state.modal) return;
      state.modal.mode = d.mode;
      render();
      return;
    }
    if (a === 'import-run') { runImport(); return; }
    if (a === 'backup-restore') { restoreBackup(d.key); return; }
    if (a === 'reset') {
      if (!window.confirm('重置会清空本机所有单元的进度。会先自动备份。确定？')) return;
      saveBackup(state.progress, '重置前自动备份');
      state.progress = newProgress();
      try { root.localStorage.removeItem(KEY); } catch (e) { /* ignore */ }
      saveProgress();
      applyThemeAttrOnly();
      render();
      toast('已重置');
      return;
    }
  }

  function onKeyDown(e) {
    var focused = e.target;
    if (focused && focused.closest && focused.closest('.fam-slider')) {
      onFamKey(e);
      return;
    }
    if (e.key !== 'Enter') return;
    var t = e.target;
    if (t && t.id === 'answer-input') {
      e.preventDefault();
      submitTyped();
      return;
    }
    if ((e.key === 'Enter' || e.key === ' ') && t && t.getAttribute && t.getAttribute('data-action') === 'hard-note') {
      e.preventDefault();
      t.click();
    }
  }
  function onChange(e) { /* reserved */ }

  function normalizeAliasProgress(progress, content) {
    var p = ensureProgress(progress) || newProgress();
    (content.items || []).forEach(function (item) {
      (item.aliases || []).forEach(function (alias) {
        if (!alias || alias === item.id || !p.items[alias]) return;
        var old = p.items[alias];
        var cur = p.items[item.id];
        if (!cur || (progressStamp(old) && (!progressStamp(cur) || progressStamp(old) >= progressStamp(cur)))) {
          p.items[item.id] = migrateItemProgress(old, item.id);
        }
        delete p.items[alias];
      });
    });
    return p;
  }

  function boot() {
    state.content = root.__WORD_REVIEW__ || null;
    if (!state.content || !state.content.items) {
      document.body.innerHTML = '<main style="padding:24px;font-family:sans-serif">复习站数据没有嵌入；请重新构建 HTML。</main>';
      return;
    }
    refs.screen = document.getElementById('screen');
    refs.overlay = document.getElementById('overlay');
    refs.title = document.getElementById('nav-title');
    refs.back = document.getElementById('nav-back');
    refs.settings = document.getElementById('nav-settings');
    refs.theme = document.getElementById('theme-toggle');
    refs.toast = document.getElementById('toast');
    state.progress = normalizeAliasProgress(loadProgress(), state.content);
    state.mode = state.progress.settings.lastMode === 'c2e' ? 'c2e' : 'e2c';
    setThemeAttr(state.progress.settings.theme || 'auto');
    initAudio();
    if (refs.back) refs.back.addEventListener('click', back);
    if (refs.settings) refs.settings.addEventListener('click', function () { navigate('settings', { unitId: state.params.unitId || (currentUnit() && currentUnit().id) }); });
    if (refs.theme) refs.theme.addEventListener('click', quickTheme);
    try {
      var mq = root.matchMedia && root.matchMedia('(prefers-color-scheme: dark)');
      var onScheme = function () {
        if (!themeAutoOn()) return;
        setThemeAttr('auto');
        updateThemeToggle();
        updateThemeAutoSwitch();
      };
      if (mq && mq.addEventListener) mq.addEventListener('change', onScheme);
      else if (mq && mq.addListener) mq.addListener(onScheme);
    } catch (e) { /* media listener is optional */ }
    if (refs.screen) {
      refs.screen.addEventListener('click', onClick);
      refs.screen.addEventListener('keydown', onKeyDown);
      refs.screen.addEventListener('change', onChange);
      refs.screen.addEventListener('pointerdown', onFamDown, true);
      refs.screen.addEventListener('pointerdown', onCardPointerDown);
      refs.screen.addEventListener('pointermove', onCardPointerMove, { passive: false });
      refs.screen.addEventListener('pointerup', onCardPointerUp);
      refs.screen.addEventListener('pointercancel', onCardPointerCancel);
    }
    document.addEventListener('pointermove', onFamMove, { passive: false });
    document.addEventListener('pointerup', onFamUp);
    document.addEventListener('pointercancel', onFamUp);
    if (refs.overlay) {
      refs.overlay.addEventListener('pointerdown', onFamDown, true);
      refs.overlay.addEventListener('click', onClick);
      refs.overlay.addEventListener('keydown', onKeyDown);
    }
    try { history.replaceState({ screen: 'home', params: {}, scrollY: 0 }, '', location.href); } catch (e) { /* ignore */ }
    root.addEventListener('popstate', function (ev) {
      var st = ev.state;
      state.dictCard = null;
      state.modal = null;
      if (st && st.screen) {
        if (st.screen === 'test' && !state.session) {
          state.screen = 'unit';
          state.params = { unitId: state.params.unitId || (currentUnit() && currentUnit().id) };
          render();
          try { window.scrollTo(0, 0); } catch (e) { /* ignore */ }
          return;
        }
        if (st.screen !== 'test') state.session = null;
        state.screen = st.screen;
        state.params = st.params || {};
        render();
        try { window.scrollTo(0, Number(st.scrollY) || 0); } catch (e) { /* ignore */ }
      } else {
        state.screen = 'home'; state.params = {}; state.session = null; render();
      }
    });
    render();
  }

  var api = {
    SCHEMA: SCHEMA,
    FORMAT: FORMAT,
    FORMAT_VERSION: FORMAT_VERSION,
    KEY: KEY,
    FAM_LABELS: FAM_LABELS,
    FAM_NAMES: FAM_NAMES,
    LEVEL_NAMES: FAM_NAMES,
    fmtLevel: fmtLevel,
    SECTIONS: SECTIONS,
    studyDate: studyDate,
    addDays: addDays,
    daysBetween: daysBetween,
    normalizeAnswer: normalizeAnswer,
    answerMatches: answerMatches,
    familiarityOf: familiarityOf,
    stateOf: stateOf,
    isDueReview: isDueReview,
    reviewDueOf: reviewDueOf,
    baseInterval: baseInterval,
    familiarityLabel: familiarityLabel,
    setFamiliarity: setFamiliarity,
    setMastered: setMastered,
    isMastered: isMastered,
    setSpell: setSpell,
    spellActive: spellActive,
    hasTag: hasTag,
    itemTags: itemTags,
    shengSenses: shengSenses,
    hasSheng: hasSheng,
    tagBadges: tagBadges,
    recordTest: recordTest,
    itemWeight: itemWeight,
    newItemProgress: newItemProgress,
    migrateItemProgress: migrateItemProgress,
    newProgress: newProgress,
    ensureProgress: ensureProgress,
    migrateProgress: migrateProgress,
    normalizeAliasProgress: normalizeAliasProgress,
    cardFlipped: cardFlipped,
    setCardFlipped: setCardFlipped,
    cardGestureMode: cardGestureMode,
    cardPullProgress: cardPullProgress,
    cardShouldCommitH: cardShouldCommitH,
    cardShouldCommitV: cardShouldCommitV,
    altSenseOf: altSenseOf,
    cardBackHtml: cardBackHtml,
    highlightTerm: highlightTerm,
    canStartCardGesture: canStartCardGesture,
    recommend: recommend,
    buildSession: buildSession,
    aggregateUnit: aggregateUnit,
    sectionStat: sectionStat,
    exportProgress: exportProgress,
    exportPortable: exportPortable,
    importProgress: importProgress,
    mergeProgress: mergeProgress,
    replaceProgress: replaceProgress,
    buildReport: buildReport
  };
  root.WordReview = api;

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);


