#!/usr/bin/env node
/**
 * build-word-review.mjs — 英语单词复习站：校验 + 编译 + 内联 + 原子写出。
 *
 * 用法（英语工作区）：
 *   node <study-plugins>\tools\build-word-review.mjs --check --data 单词复习数据.json --book 词汇情景本.md --out 单词复习站.html
 *   node <study-plugins>\tools\build-word-review.mjs --data 单词复习数据.json --book 词汇情景本.md --out 单词复习站.html
 *
 * 设计见 ST\英语\单词复习站规范.md。
 * 本文件零第三方依赖；测试可直接 import 编译函数。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCHEMA_VERSION = 3;
export const SECTION_DEFS = [
  { id: 'vocab', title: '词汇', order: 1 },
  { id: 'phrases', title: '短语与搭配', order: 2 },
  { id: 'substitutions', title: '高级替换', order: 3 },
  { id: 'patterns', title: '句式与金句', order: 4 },
  { id: 'contexts', title: '语境', order: 5 },
  { id: 'pitfalls', title: '易混易错', order: 6 },
  { id: 'sheng', title: '熟词生义', order: 7 },
  { id: 'culture', title: '文化与方法', order: 8 }
];
// v5.13：词性白名单与顺序（禁止裸 v. / 短语 / phrase）。
export const POS_ORDER = ['n.', 'vt.', 'vi.', 'adj.', 'adv.', 'prep.', 'conj.', 'pron.', 'num.', 'phr.'];
// v5.13：标记白名单。写 = 写作中掌握；专 = 专有名词；生 = 熟词生义；搭 = 固定搭配。
export const TAG_DEFS = { write: '写', proper: '专', sheng: '生', collocation: '搭' };
export const ALLOWED_TAGS = Object.keys(TAG_DEFS);
const KIND_SECTION = {
  word: 'vocab',
  phrase: 'phrases',
  substitution: 'substitutions',
  pattern: 'patterns',
  golden: 'patterns',
  knowledge: 'culture'
};
const ALLOWED_KINDS = Object.keys(KIND_SECTION);
const ALLOWED_CONTEXT_KINDS = ['passage', 'summary', 'micro'];
const ALLOWED_EXAMPLE_KINDS = ['context', 'unit-micro', 'handout'];
const DEFAULT_TEMPLATE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates', 'word-review.template.html');
const DEFAULT_APP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates', 'word-review-app.js');
export const OPTION_MIN = 3;
export const OPTION_MAX = 5;
export const OPTION_POOL_MIN = 4;
export const OPTION_POOL_MAX = 8;

function isNonEmptyString(v) { return typeof v === 'string' && v.trim().length > 0; }
function arr(v) { return Array.isArray(v) ? v : []; }
function uniq(list) { return Array.from(new Set(list.filter(function (x) { return x !== undefined && x !== null && x !== ''; }))); }
function norm(s) {
  return String(s == null ? '' : s)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[–—]/g, '-')
    .trim();
}
function splitAnswers(s) {
  if (Array.isArray(s)) return s.map(String).map(function (x) { return x.trim(); }).filter(Boolean);
  return String(s == null ? '' : s).split(/[；;、/|]/).map(function (x) { return x.trim(); }).filter(Boolean);
}
// v5.13：词性校验（顺序固定、不重复、token 必须在白名单）。
function posTokens(pos) {
  return String(pos == null ? '' : pos).split('/').map(function (t) { return t.trim(); }).filter(Boolean);
}
export function isValidPos(pos) {
  var tokens = posTokens(pos);
  if (!tokens.length) return false;
  var last = -1;
  for (var i = 0; i < tokens.length; i += 1) {
    var idx = POS_ORDER.indexOf(tokens[i]);
    if (idx < 0 || idx <= last) return false;
    last = idx;
  }
  return true;
}
export function isValidTags(tags) {
  return Array.isArray(tags) && tags.every(function (t) { return ALLOWED_TAGS.indexOf(t) >= 0; });
}
function hashStr(s) {
  var h = 2166136261;
  var str = String(s == null ? '' : s);
  for (var i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function seededShuffle(list, seed) {
  var out = list.slice();
  var x = hashStr(seed) || 1;
  for (var i = out.length - 1; i > 0; i -= 1) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    var j = x % (i + 1);
    var t = out[i]; out[i] = out[j]; out[j] = t;
  }
  return out;
}
function slugify(s, fallback) {
  var base = String(s == null ? '' : s)
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 42);
  if (!base) base = 'item-' + hashStr(s).toString(36);
  return fallback ? base + '-' + fallback : base;
}
function parseSource(source) {
  var s = String(source == null ? '' : source).trim();
  var at = s.lastIndexOf('@');
  if (at <= 0 || at >= s.length - 1) return null;
  return { file: s.slice(0, at).trim(), anchor: s.slice(at + 1).trim(), raw: s };
}
function sourceList(source) {
  if (Array.isArray(source)) return source.map(String).filter(Boolean);
  if (isNonEmptyString(source)) return [source.trim()];
  return [];
}
function primarySource(item) { return sourceList(item.source)[0] || ''; }

function targetFor(item) {
  if (item.kind === 'golden') return item.text || '';
  return item.surface || item.term || item.base || item.title || '';
}
function targetCandidates(item) {
  if (item.kind === 'golden') return [item.text || ''].filter(Boolean);
  if (item.kind === 'substitution') {
    return uniq([item.surface, item.term, item.base, item.best]
      .concat(arr(item.alternatives).map(function (a) { return a && a.term; }))
      .filter(Boolean));
  }
  return uniq([item.surface, item.term].filter(Boolean));
}
function headFor(term) {
  var stop = new Set(['a', 'an', 'the', 'be', 'to', 'for', 'of', 'from', 'with', 'in', 'on', 'at', 'by', 'sb', 'sth', 'somebody', 'something', 'one', 'ones', "one's"]);
  var parts = String(term || '').split(/[\s/]+/).map(function (x) { return x.replace(/[^A-Za-z'-]/g, ''); }).filter(Boolean);
  for (var i = 0; i < parts.length; i += 1) {
    if (!stop.has(parts[i].toLowerCase())) return parts[i];
  }
  return parts[0] || '';
}
function contains(haystack, needle) {
  if (!needle) return false;
  return norm(haystack).toLowerCase().includes(norm(needle).toLowerCase());
}
function replaceFirst(haystack, needle, replacement) {
  var i = haystack.toLowerCase().indexOf(String(needle).toLowerCase());
  if (i < 0) return null;
  return haystack.slice(0, i) + replacement + haystack.slice(i + String(needle).length);
}
function err(errors, msg) { errors.push(msg); }
function warn(warnings, msg) { warnings.push(msg); }

export function compileContent(raw, opts) {
  opts = opts || {};
  var errors = [];
  var warnings = [];
  var dataDir = path.resolve(opts.dataDir || process.cwd());
  var bookPath = opts.bookPath ? path.resolve(opts.bookPath) : path.join(dataDir, '词汇情景本.md');
  var buildTime = opts.buildTime || new Date().toISOString();
  var fileCache = new Map();

  function readText(filePath) {
    if (fileCache.has(filePath)) return fileCache.get(filePath);
    var text = fs.readFileSync(filePath, 'utf8');
    fileCache.set(filePath, text);
    return text;
  }
  function checkSource(source, where, kind) {
    var list = sourceList(source);
    if (!list.length) { err(errors, where + ' 缺 source（必须 文件名@锚点，金句可 自创）'); return []; }
    var refs = [];
    list.forEach(function (one) {
      if (one === '自创') {
        if (kind !== 'golden') err(errors, where + ' source=自创 只允许 golden');
        refs.push(one);
        return;
      }
      var parsed = parseSource(one);
      if (!parsed) { err(errors, where + ' source 不是 文件名@锚点: ' + one); return; }
      if (opts.skipSourceCheck) { refs.push(one); return; }
      var filePath = path.resolve(dataDir, parsed.file);
      if (!fs.existsSync(filePath) && path.basename(filePath) === path.basename(bookPath)) filePath = bookPath;
      if (!fs.existsSync(filePath)) { err(errors, where + ' source 文件不存在: ' + parsed.file); return; }
      var text;
      try { text = readText(filePath); } catch (e) { err(errors, where + ' source 文件读不了: ' + parsed.file); return; }
      if (!contains(text, parsed.anchor)) { err(errors, where + ' source 锚点找不到: ' + one); return; }
      refs.push(one);
    });
    return refs;
  }

  // ── 1. 顶层 ─────────────────────────────────────────────
  if (!raw || typeof raw !== 'object') {
    return { ok: false, errors: ['数据不是对象'], warnings: warnings, content: null };
  }
  if (raw.schemaVersion !== SCHEMA_VERSION) err(errors, 'schemaVersion 必须是 ' + SCHEMA_VERSION);
  if (!isNonEmptyString(raw.contentVersion)) err(errors, '缺 contentVersion');
  if (!Array.isArray(raw.units) || !raw.units.length) err(errors, 'units 必须是非空数组');
  if (!Array.isArray(raw.contexts) || !raw.contexts.length) err(errors, 'contexts 必须是非空数组');
  if (!Array.isArray(raw.items) || !raw.items.length) err(errors, 'items 必须是非空数组');
  if (errors.length) return { ok: false, errors: errors, warnings: warnings, content: null };

  // ── 2. units ────────────────────────────────────────────
  var units = [];
  var unitIds = new Set();
  raw.units.forEach(function (u, i) {
    var where = 'units[' + i + ']';
    if (!isNonEmptyString(u.id)) { err(errors, where + ' 缺 id'); return; }
    if (unitIds.has(u.id)) { err(errors, where + ' id 重复: ' + u.id); return; }
    unitIds.add(u.id);
    if (!isNonEmptyString(u.title)) err(errors, where + ' 缺 title');
    if (!Number.isFinite(Number(u.order))) err(errors, where + ' order 必须是数字');
    var sourceAnchors = arr(u.sourceAnchors);
    sourceAnchors.forEach(function (s, j) {
      checkSource(s, where + '.sourceAnchors[' + j + ']', 'unit');
    });
    units.push({
      id: u.id,
      order: Number(u.order),
      kind: u.kind === 'topic' ? 'topic' : (u.kind === 'translation' ? 'translation' : 'unit'),
      title: u.title || u.id,
      theme: u.theme || '',
      setting: u.setting || '',
      textbookRef: u.textbookRef || '待记',
      timeframe: u.timeframe || '',
      status: u.status || '',
      current: u.current === true,
      lessonDates: arr(u.lessonDates),
      sourceAnchors: sourceAnchors,
      _raw: u,
      reading: null,
      context: {
        theme: u.theme || '',
        setting: u.setting || '',
        textbookRef: u.textbookRef || '待记',
        timeframe: u.timeframe || ''
      }
    });
  });
  if (!units.length) return { ok: false, errors: errors.length ? errors : ['没有有效 units'], warnings: warnings, content: null };
  var currentUnits = units.filter(function (u) { return u.current; });
  if (currentUnits.length !== 1) err(errors, 'units 必须恰好一个 current:true，现在是 ' + currentUnits.length);
  var orders = units.map(function (u) { return u.order; });
  if (new Set(orders).size !== orders.length) err(errors, 'units.order 有重复');
  var unitMap = new Map(units.map(function (u) { return [u.id, u]; }));

  // ── 2b. clusters（v5 近义/易混小词库） ──────────────────
  var clusters = [];
  var clusterMap = new Map();
  if (raw.clusters !== undefined) {
    if (!Array.isArray(raw.clusters)) err(errors, 'clusters 必须是数组');
    else raw.clusters.forEach(function (c, i) {
      var where = 'clusters[' + i + ']';
      if (!c || typeof c !== 'object') { err(errors, where + ' 不是对象'); return; }
      if (!isNonEmptyString(c.id)) { err(errors, where + ' 缺 id'); return; }
      if (clusterMap.has(c.id)) { err(errors, where + ' id 重复: ' + c.id); return; }
      if (!Array.isArray(c.members) || c.members.length < OPTION_POOL_MIN) {
        err(errors, where + ' members 至少 ' + OPTION_POOL_MIN + ' 个');
        return;
      }
      var seen = {};
      var members = [];
      c.members.forEach(function (m, j) {
        if (!m || !isNonEmptyString(m.term)) { err(errors, where + '.members[' + j + '] 缺 term'); return; }
        var t = m.term.trim();
        if (seen[t]) { err(errors, where + '.members 重复 term: ' + t); return; }
        seen[t] = 1;
        members.push({ term: t, meaning: m.meaning || '', pos: m.pos || '' });
      });
      if (members.length < OPTION_POOL_MIN) return;
      var cluster = { id: c.id, members: members };
      clusters.push(cluster);
      clusterMap.set(c.id, cluster);
    });
  }

  // ── 3. items（基础） ─────────────────────────────────────
  var items = [];
  var usedIds = new Set();
  raw.items.forEach(function (r, i) {
    var where = 'items[' + i + ']';
    if (!r || typeof r !== 'object') { err(errors, where + ' 不是对象'); return; }
    if (!isNonEmptyString(r.unitId)) { err(errors, where + ' 缺 unitId'); return; }
    if (!unitMap.has(r.unitId)) { err(errors, where + ' unitId 不存在: ' + r.unitId); return; }
    if (!ALLOWED_KINDS.includes(r.kind)) { err(errors, where + ' kind 非法: ' + r.kind); return; }
    var kind = r.kind;
    var term = r.term || r.title || r.text || r.base || '';
    var explicitKey = isNonEmptyString(r.key) ? String(r.key).trim() : '';
    if (explicitKey && !/^[a-z0-9\u4e00-\u9fff][a-z0-9\u4e00-\u9fff-]*$/.test(explicitKey)) {
      err(errors, where + ' key 非法（只允许小写字母/数字/汉字/连字符）: ' + explicitKey);
    }
    var baseId = explicitKey || ('i-' + r.unitId + '-' + slugify(term || kind));
    var id = baseId;
    var n = 2;
    if (explicitKey && usedIds.has(id)) {
      err(errors, where + ' key 重复: ' + explicitKey);
    }
    while (usedIds.has(id)) { id = baseId + '-' + n; n += 1; }
    usedIds.add(id);
    if (!explicitKey) warn(warnings, where + ' 缺 key，暂用派生 id；长期进度应显式分配 key: ' + id);
    var sourceRefs = checkSource(r.source, where, kind);
    var senses = [];
    if (r.senses !== undefined) {
      if (!Array.isArray(r.senses) || r.senses.length < 1 || r.senses.length > 4) {
        err(errors, where + ' senses 必须是 1–4 条数组');
      } else {
        var seenDefs = new Set();
        r.senses.forEach(function (s, si) {
          var sw = where + '.senses[' + si + ']';
          if (!s || typeof s !== 'object') { err(errors, sw + ' 不是对象'); return; }
          ['pos', 'definition', 'example', 'translation', 'source'].forEach(function (k) {
            if (!isNonEmptyString(s[k])) err(errors, sw + ' 缺 ' + k);
          });
          if (!/^(OLD|CAM|ODE):/.test(String(s.source || ''))) err(errors, sw + ' source 必须以 OLD/CAM/ODE: 开头');
          var def = String(s.definition || '').trim();
          if (seenDefs.has(def)) err(errors, sw + ' 同词义项重复: ' + def);
          seenDefs.add(def);
        });
        senses = r.senses.map(function (s) {
          var out = {
            pos: String(s.pos || '').trim(),
            definition: String(s.definition || '').trim(),
            example: String(s.example || '').trim(),
            translation: String(s.translation || '').trim(),
            source: String(s.source || '').trim()
          };
          // v5.9：义项可标 dropped（偏僻义项），渲染时跳过，但数据保留、可回滚。
          if (s.dropped === true) {
            out.dropped = true
            out.dropReason = String(s.dropReason || '').trim()
          }
          // v5.13：熟词生义义项标记。
          if (s.sheng === true) out.sheng = true
          return out
        });
      }
    }
    var item = Object.assign({}, r, {
      id: id,
      key: id,
      unitId: r.unitId,
      kind: kind,
      // v5.15：熟词生义单独成条时保留 sectionId='sheng'（不与常用义共用熟悉度，也不进词汇卡片）
      sectionId: r.sectionId === 'sheng' ? 'sheng' : KIND_SECTION[kind],
      term: r.term || '',
      title: r.title || '',
      text: r.text || '',
      base: r.base || '',
      senses: senses,
      sourceRefs: sourceRefs,
      verified: r.verified !== false,
      archived: r.archived === true,
      testable: false,
      basis: null,
      clusterId: isNonEmptyString(r.clusterId) ? String(r.clusterId).trim() : '',
      aliases: arr(r.aliases).map(String).filter(Boolean),
      phrase: r.phrase && typeof r.phrase === 'object' ? r.phrase : null,
      confusables: arr(r.confusables).map(String).filter(Boolean),
      distractors: arr(r.distractors).map(String).filter(Boolean),
      _reading: r.reading || null,
      _raw: r,
      _where: where
    });
    // v5.13：词性 / 标记（写/专/生/搭）。短语自动带“搭”；义项标 sheng 自动带“生”。
    item.pos = String(r.pos || '').trim();
    var tags = uniq(arr(r.tags).map(function (x) { return String(x || '').trim(); }).filter(Boolean));
    if (kind === 'phrase') tags = uniq(tags.concat(['collocation']));
    if (senses.some(function (s) { return s.sheng === true; })) tags = uniq(tags.concat(['sheng']));
    item.tags = tags;
    if (clusters.length && !item.clusterId) err(errors, where + ' 缺 clusterId（v5 每个可测项都要有近义/易混组）');
    if (item.clusterId && !clusterMap.has(item.clusterId)) err(errors, where + ' clusterId 不存在: ' + item.clusterId);
    items.push(item);
  });
  if (errors.length) return { ok: false, errors: errors, warnings: warnings, content: null };

  // v5：同一 unit 的 word/phrase 不得同 term（否则卡片/测试重复出现）
  // v5.15：例外——「熟词生义」条目可以与其常用义同 term，因为两者的熟悉度必须分开记（学员要求）。
  var reviewTermSeen = new Map();
  items.forEach(function (item) {
    if (!item.testable && item.kind !== 'knowledge') return;
    if (item.kind !== 'word' && item.kind !== 'phrase') return;
    if (item.sectionId === 'sheng') return;
    var key = item.unitId + '|' + norm(item.term || '').toLowerCase();
    if (!item.term) return;
    if (reviewTermSeen.has(key)) {
      err(errors, item._where + ' 与 ' + reviewTermSeen.get(key) + ' 同 term，v5 要求合并或标 aliases: ' + item.term);
    } else {
      reviewTermSeen.set(key, item._where);
    }
  });
  if (errors.length) return { ok: false, errors: errors, warnings: warnings, content: null };

  // item 解析索引（term/text/title/base）
  var itemIndex = new Map();
  items.forEach(function (item) {
    [item.term, item.text, item.title, item.base, item.id].concat(arr(item.aliases)).forEach(function (key) {
      if (!isNonEmptyString(key)) return;
      if (!itemIndex.has(key)) itemIndex.set(key, []);
      itemIndex.get(key).push(item);
    });
  });
  function resolveTerm(term) {
    var list = itemIndex.get(String(term || '').trim()) || [];
    if (!list.length) return null;
    // word / phrase 可能同 term（如 in terms of、embark on）；itemTerms 解析到同单元的所有条目。
    return { items: list };
  }

  // ── 4. contexts ─────────────────────────────────────────
  var contexts = [];
  var contextIds = new Set();
  raw.contexts.forEach(function (c, i) {
    var where = 'contexts[' + i + ']';
    if (!isNonEmptyString(c.id)) { err(errors, where + ' 缺 id'); return; }
    if (contextIds.has(c.id)) { err(errors, where + ' id 重复: ' + c.id); return; }
    contextIds.add(c.id);
    if (!unitMap.has(c.unitId)) { err(errors, where + ' unitId 不存在: ' + c.unitId); return; }
    if (!ALLOWED_CONTEXT_KINDS.includes(c.kind)) err(errors, where + ' kind 非法: ' + c.kind);
    if (!isNonEmptyString(c.title)) err(errors, where + ' 缺 title');
    if (!isNonEmptyString(c.text)) err(errors, where + ' 缺 text');
    if (!isNonEmptyString(c.cue)) err(errors, where + ' 缺 cue');
    var itemTerms = arr(c.itemTerms).map(String).filter(Boolean);
    if (!itemTerms.length) err(errors, where + ' itemTerms 不能为空');
    var itemIds = [];
    itemTerms.forEach(function (t) {
      var hit = resolveTerm(t);
      if (!hit) { err(errors, where + ' itemTerms 解析不到: ' + t); return; }
      var inUnit = hit.items.filter(function (x) { return x.unitId === c.unitId; });
      if (!inUnit.length) { err(errors, where + ' itemTerms 跨单元: ' + t); return; }
      inUnit.forEach(function (x) { itemIds.push(x.id); });
    });
    var sourceAnchor = c.sourceAnchor || '';
    if (sourceAnchor) checkSource(sourceAnchor, where + '.sourceAnchor', 'context');
    var ctxSource = c.source || '';
    if (ctxSource && ctxSource !== '自创') checkSource(ctxSource, where + '.source', 'context');
    contexts.push({
      id: c.id,
      unitId: c.unitId,
      kind: c.kind,
      title: c.title,
      text: c.text,
      cue: c.cue,
      itemTerms: itemTerms,
      itemIds: uniq(itemIds),
      recallPrompts: arr(c.recallPrompts),
      sourceAnchor: sourceAnchor,
      source: ctxSource,
      authored: c.authored === true,
      theme: c.theme || '本单元'
    });
  });
  if (errors.length) return { ok: false, errors: errors, warnings: warnings, content: null };

  // ── 4b. 大阅读（v5：一篇、2–3 主题、覆盖全部 word） ─────
  units.forEach(function (u) {
    var rawReading = u._raw && u._raw.reading;
    if (!rawReading) {
      warn(warnings, '单元 ' + u.id + ' 没有 reading（v5 应有一篇多主题长文）');
      return;
    }
    var where = 'units[' + u.id + '].reading';
    if (!isNonEmptyString(rawReading.title)) err(errors, where + ' 缺 title');
    if (!isNonEmptyString(rawReading.level)) err(errors, where + ' 缺 level');
    if (!Array.isArray(rawReading.parts) || rawReading.parts.length < 2) {
      err(errors, where + '.parts 至少 2 个主题');
      return;
    }
    if (rawReading.parts.length > 3) warn(warnings, where + '.parts 建议 2–3 个主题');
    if (rawReading.source && rawReading.source !== '自创') checkSource(rawReading.source, where + '.source', 'reading');
    var parts = [];
    var allIds = [];
    var allText = [];
    rawReading.parts.forEach(function (part, pi) {
      var pw = where + '.parts[' + pi + ']';
      if (!isNonEmptyString(part.theme)) err(errors, pw + ' 缺 theme');
      if (!isNonEmptyString(part.title)) err(errors, pw + ' 缺 title（v5.1 每个主题独立文章标题）');
      if (!Array.isArray(part.paragraphs) || !part.paragraphs.length) { err(errors, pw + ' paragraphs 为空'); return; }
      var paras = [];
      var partTerms = [];
      var partText = '';
      part.paragraphs.forEach(function (p, pj) {
        if (!isNonEmptyString(p.text)) { err(errors, pw + '.paragraphs[' + pj + '] 缺 text'); return; }
        var terms = arr(p.itemTerms).map(String).filter(Boolean);
        if (!terms.length) { err(errors, pw + '.paragraphs[' + pj + '] 缺 itemTerms'); return; }
        partTerms = partTerms.concat(terms);
        var ids = [];
        terms.forEach(function (t) {
          var hit = resolveTerm(t);
          if (!hit) { err(errors, pw + '.paragraphs[' + pj + '] itemTerms 解析不到: ' + t); return; }
          var inUnit = hit.items.filter(function (x) { return x.unitId === u.id; });
          if (!inUnit.length) { err(errors, pw + '.paragraphs[' + pj + '] itemTerms 跨单元: ' + t); return; }
          // 让 term 在正文里真实出现（大小写不敏感、整词近似）
          if (!contains(p.text, t) && !contains(p.text, norm(t))) err(errors, pw + '.paragraphs[' + pj + '] 正文未出现 term: ' + t);
          inUnit.forEach(function (x) { ids.push(x.id); allIds.push(x.id); });
        });
        paras.push({ text: p.text, itemTerms: terms, itemIds: uniq(ids) });
        partText += '\n' + p.text;
        allText.push(p.text);
      });
      var noteList = arr(part.notes).map(function (n) {
        var note = { sentence: String(n && n.sentence || ''), note: String(n && n.note || ''), translation: String(n && n.translation || '') };
        if (!note.sentence || !note.note || !note.translation) err(errors, pw + '.notes 每条需 sentence/note/translation');
        else if (partText.indexOf(note.sentence) < 0) err(errors, pw + '.notes 句子未出现在本 part 正文: ' + note.sentence.slice(0, 60));
        return note;
      });
      if (!noteList.length) err(errors, pw + ' 缺 notes（v5.1 每个主题至少 1 个长难句卡）');
      if (noteList.length > 2) warn(warnings, pw + ' notes 为 ' + noteList.length + ' 条，建议 1–2 条');
      parts.push({ theme: part.theme, title: part.title, paragraphs: paras, notes: noteList, itemTerms: uniq(partTerms) });
    });
    if (errors.length) return;
    var wordItems = items.filter(function (i) { return i.unitId === u.id && i.kind === 'word' && !i.archived; });
    var covered = new Set(allIds);
    var missing = wordItems.filter(function (i) { return !covered.has(i.id); }).map(function (i) { return i.term || i.id; });
    if (missing.length) err(errors, where + ' 未覆盖 word: ' + missing.slice(0, 12).join(', ') + (missing.length > 12 ? ' …(' + missing.length + ')' : ''));
    var textAll = allText.join(' ');
    var words = textAll.split(/\s+/).filter(Boolean);
    var sentences = textAll.split(/(?<=[.!?])\s+/).map(function (s) { return s.trim(); }).filter(Boolean);
    var lens = sentences.map(function (s) { return s.split(/\s+/).filter(Boolean).length; });
    var avg = lens.length ? lens.reduce(function (a, b) { return a + b; }, 0) / lens.length : 0;
    var max = lens.length ? Math.max.apply(null, lens) : 0;
    var longCount = lens.filter(function (n) { return n >= 25; }).length;
    var wordRange = u.id === 'u1-chinese-culture' ? [600, 900] : [280, 520];
    if (words.length < wordRange[0] || words.length > wordRange[1]) warn(warnings, where + ' 词数 ' + words.length + ' 不在建议区间 ' + wordRange.join('–'));
    if (parts.length < 2) err(errors, where + ' 少于 2 个主题');
    if (longCount < 4) warn(warnings, where + ' ≥25 词长句只有 ' + longCount + ' 句（建议 ≥4）');
    if (max > 55) warn(warnings, where + ' 最长句 ' + max + ' 词（建议 ≤55）');
    if (avg < 14 || avg > 26) warn(warnings, where + ' 平均句长 ' + (Math.round(avg * 10) / 10) + ' 词（建议 16–22）');
    u.reading = {
      title: rawReading.title,
      level: rawReading.level,
      source: rawReading.source || '自创',
      parts: parts,
      wordCount: words.length,
      sentenceCount: sentences.length,
      avgSentence: Math.round(avg * 10) / 10,
      maxSentence: max,
      longSentenceCount: longCount,
      itemIds: uniq(allIds),
      themes: parts.map(function (p) { return p.theme; })
    };
  });

  // 每单元至少一个 summary|passage 且 itemTerms≥8
  units.forEach(function (u) {
    var hasBig = contexts.some(function (c) {
      return c.unitId === u.id && (c.kind === 'summary' || c.kind === 'passage') && c.itemTerms.length >= 8;
    });
    if (!hasBig) err(errors, '单元 ' + u.id + ' 缺一个 itemTerms≥8 的 summary|passage 总段');
  });

  // ── 5. items（上下文 / 可测性 / 校验） ──────────────────
  items.forEach(function (item) {
    var raw = item._raw;
    var where = item._where;
    var kind = item.kind;
    // v5.13：词性 / 标记强校验（word / phrase 必须有合法 pos；短语必须是 phr.）
    if (kind === 'word' || kind === 'phrase') {
      if (!isValidPos(item.pos)) err(errors, where + ' pos 非法（需 n./vt./vi./adj./adv./prep./conj./pron./num./phr.，按序、不重复；禁止裸 v./短语/phrase）: ' + (item.pos || '(空)'));
      if (kind === 'phrase' && item.pos !== 'phr.') err(errors, where + ' phrase 的 pos 必须是 phr.: ' + (item.pos || '(空)'));
      if (!isValidTags(item.tags)) err(errors, where + ' tags 非法（只允许 write/proper/sheng/collocation）: ' + JSON.stringify(item.tags));
      if (kind !== 'phrase' && item.tags.indexOf('collocation') >= 0) err(errors, where + ' 只有 phrase 能带 collocation 标记');
      arr(item.senses).forEach(function (s, si) {
        if (!isValidPos(s.pos)) err(errors, where + '.senses[' + si + '].pos 非法: ' + (s.pos || '(空)'));
      });
    }
    // v5.14：笔记分类硬约束——word 只能装单个词；多词/整句必须归 phrase/pattern/golden。
    // 翻译专项（units[].kind='translation'）是唯一例外：中→英卡片沿用 kind=word。
    if (kind === 'word') {
      var wordUnit = unitMap.get(item.unitId) || {};
      var translationUnit = wordUnit.kind === 'translation';
      if (!translationUnit) {
        var wordTerm = String(item.term || '').trim();
        if (/\s/.test(wordTerm)) err(errors, where + ' kind=word 但 term 含空格（多词条目必须改 phrase，或 pattern/golden）: ' + wordTerm);
        if (item.pos === 'phr.') err(errors, where + ' kind=word 不能用 phr.（短语必须改 kind=phrase）: ' + wordTerm);
        if (/[.!?]$/.test(wordTerm)) err(errors, where + ' kind=word 的 term 不能是整句: ' + wordTerm);
      }
    }
    if (kind === 'phrase' && !/\s/.test(String(item.term || '').trim())) {
      warn(warnings, where + ' kind=phrase 但 term 只有一个词，确认不是 word: ' + item.term);
    }
    var ctx = item.contextId ? contexts.filter(function (c) { return c.id === item.contextId; })[0] : null;
    var sentence = kind === 'golden' ? (item.text || '') : (item.sentence || '');
    var candidates = targetCandidates(item);
    var target = candidates[0] || targetFor(item);
    var head = headFor(target);
    var matchTarget = '';
    for (var ci = 0; ci < candidates.length; ci += 1) {
      if (sentence && contains(sentence, candidates[ci])) { matchTarget = candidates[ci]; break; }
    }
    if (!matchTarget && sentence && head && contains(sentence, head)) matchTarget = head;

    // 基础字段
    if (kind === 'golden') {
      if (!isNonEmptyString(item.text)) err(errors, where + ' golden 缺 text');
      if (!isNonEmptyString(item.translation)) err(errors, where + ' golden 缺 translation');
      if (!arr(item.useCase).length) err(errors, where + ' golden 缺 useCase');
      if (!arr(item.keyPhrases).length) err(errors, where + ' golden 缺 keyPhrases');
    } else if (kind === 'knowledge') {
      if (!isNonEmptyString(item.title)) err(errors, where + ' knowledge 缺 title');
      if (!isNonEmptyString(item.summary) && !arr(item.bullets).length) err(errors, where + ' knowledge 缺 summary/bullets');
    } else {
      if (!isNonEmptyString(item.meaning)) err(errors, where + ' 缺 meaning');
      if (!isNonEmptyString(item.cue)) err(errors, where + ' 缺 cue');
      if (!isNonEmptyString(item.hook)) err(errors, where + ' 缺 hook');
      if (!isNonEmptyString(item.sentence)) err(errors, where + ' 缺 sentence');
      if (!matchTarget && !(item.cloze && isNonEmptyString(item.cloze.stem))) {
        err(errors, where + ' sentence 不含 surface/term（短语可用 cloze 覆盖）: ' + (target || '(空)'));
      }
      if (item.cue && (candidates.some(function (t) { return contains(item.cue, t); }) || (head && contains(item.cue, head)))) {
        err(errors, where + ' cue 不能包含目标英文词: ' + (head || target));
      }
      if (kind === 'phrase') {
        if (!item.phrase || typeof item.phrase !== 'object') {
          err(errors, where + ' phrase 缺 phrase 对象（hint；blanks 可空，空时必须 testable:false）');
        } else {
          if (!isNonEmptyString(item.phrase.hint)) err(errors, where + '.phrase 缺 hint');
          var blanks = arr(item.phrase.blanks);
          if (item.phrase.core !== undefined && !isNonEmptyString(item.phrase.core)) {
            err(errors, where + '.phrase.core 必须是非空字符串或省略');
          }
          if (!blanks.length) {
            if (raw.testable !== false) err(errors, where + ' phrase 无 blanks 时必须 testable:false（card-only）');
          } else {
            blanks.forEach(function (b, j) {
              if (!isNonEmptyString(b.answer)) err(errors, where + '.phrase.blanks[' + j + '] 缺 answer');
              if (b.options !== undefined && (!Array.isArray(b.options) || b.options.length < 2)) err(errors, where + '.phrase.blanks[' + j + '].options 至少 2 个');
              if (Array.isArray(b.options) && !b.options.map(String).includes(String(b.answer))) err(errors, where + '.phrase.blanks[' + j + '].options 不含 answer');
              if (b.options !== undefined && (!b.optionNotes || typeof b.optionNotes !== 'object')) err(errors, where + '.phrase.blanks[' + j + '].optionNotes 缺（选项讲解）');
            });
          }
        }
      }
      if (item.error) {
        if (!isNonEmptyString(item.error.stem)) err(errors, where + '.error 缺 stem');
        if (!Array.isArray(item.error.options) || item.error.options.length < 2) err(errors, where + '.error.options 至少 2 个');
        if (!Number.isInteger(item.error.answer) || item.error.answer < 0 || item.error.answer >= arr(item.error.options).length) {
          err(errors, where + '.error.answer 越界');
        }
        if (!isNonEmptyString(item.error.why)) err(errors, where + '.error 缺 why');
      }
      if (item.confusables && (!Array.isArray(item.confusables) || item.confusables.some(function (x) { return !isNonEmptyString(x); }))) {
        err(errors, where + '.confusables 必须是字符串数组');
      }
      if (item.cloze) {
        if (!isNonEmptyString(item.cloze.stem)) err(errors, where + '.cloze 缺 stem');
        if (!arr(item.cloze.answers).length) err(errors, where + '.cloze 缺 answers');
      }
    }

    if (kind === 'substitution') {
      var alts = arr(item.alternatives);
      if (!isNonEmptyString(item.base)) err(errors, where + ' substitution 缺 base');
      if (alts.length < 2) err(errors, where + ' substitution 至少 2 个 alternatives');
      alts.forEach(function (a, j) {
        if (!a || !isNonEmptyString(a.term)) err(errors, where + '.alternatives[' + j + '] 缺 term');
        if (!isNonEmptyString(a.register)) err(errors, where + '.alternatives[' + j + '] 缺 register');
        if (!isNonEmptyString(a.nuance)) err(errors, where + '.alternatives[' + j + '] 缺 nuance');
      });
      if (item.best && !alts.some(function (a) { return a.term === item.best; })) {
        err(errors, where + '.best 不在 alternatives 里: ' + item.best);
      }
      if (!item.best && alts[0]) item.best = alts[0].term;
    }

    // contextId / exampleKind
    if (item.archived) {
      item.testable = false;
    } else if (kind === 'knowledge') {
      item.testable = false;
      if (item.contextId && !ctx) err(errors, where + ' contextId 不存在: ' + item.contextId);
    } else {
      var explicitTestable = raw.testable;
      var basicOk = kind === 'golden'
        ? (isNonEmptyString(item.text) && isNonEmptyString(item.translation) && arr(item.useCase).length && arr(item.keyPhrases).length && item.sourceRefs.length)
        : (isNonEmptyString(item.sentence) && isNonEmptyString(item.cue));
      if (kind === 'substitution') basicOk = basicOk && arr(item.alternatives).length >= 2;
      var testable;
      if (explicitTestable === false) testable = false;
      else if (explicitTestable === true && !basicOk) { err(errors, where + ' 显式 testable:true 但缺必要字段'); testable = false; }
      else testable = basicOk;
      if (item.verified === false) testable = false;
      item.testable = testable;
      if (testable) {
        if (!item.contextId) err(errors, where + ' 可测项缺 contextId');
        else if (!ctx) err(errors, where + ' contextId 不存在: ' + item.contextId);
        else if (ctx.unitId !== item.unitId) err(errors, where + ' contextId 不属于本单元');
        else {
          var ek = item.exampleKind;
          if (!ek) {
            ek = contains(ctx.text, sentence) ? 'context' : (item.sourceRefs.length ? 'handout' : '');
            if (!ek) err(errors, where + ' exampleKind 推断失败：句子不在 context，且无 source');
          }
          if (ek && !ALLOWED_EXAMPLE_KINDS.includes(ek)) err(errors, where + ' exampleKind 非法: ' + ek);
          if (ek === 'context' && !contains(ctx.text, sentence)) err(errors, where + ' exampleKind=context 但句子不在 context 文本里');
          if (ek === 'unit-micro' && (ctx.kind !== 'micro' || !contains(ctx.text, sentence) || !ctx.itemIds.includes(item.id))) {
            err(errors, where + ' exampleKind=unit-micro 但不在 micro context / 不在 itemTerms');
          }
          if (ek === 'handout' && !item.sourceRefs.length) err(errors, where + ' exampleKind=handout 但缺 source');
          item.exampleKind = ek;
        }
      } else if (item.contextId && !ctx) {
        err(errors, where + ' contextId 不存在: ' + item.contextId);
      }
      var cardOnlyPhrase = kind === 'phrase' && item.phrase && !arr(item.phrase.blanks).length;
      if (!item.testable && !cardOnlyPhrase) warn(warnings, where + ' 不可测（待补语境/待核）: ' + (item.term || item.title || item.id));
    }

    item.basis = {
      type: 'source',
      ref: primarySource(item),
      note: item.hook || item.meaning || item.title || item.text || ''
    };
  });

  if (errors.length) return { ok: false, errors: errors, warnings: warnings, content: null };

  // ── 6. 生成题库（v5：一题多选项池；语音/题型不在构建期定死） ──
  var questions = [];
  function qid(item, suffix) { return 'q-' + item.id + '-' + suffix; }
  function targetOf(item) { return item.term || item.base || item.text || item.title || ''; }
  function contextTitle(item) {
    var c = contexts.filter(function (x) { return x.id === item.contextId; })[0];
    return c ? c.title : '';
  }
  function reveal(item) {
    return {
      sentence: item.kind === 'golden' ? item.text : item.sentence,
      term: item.term || item.title || '',
      meaning: item.meaning || item.translation || '',
      hook: item.hook || '',
      ipa: item.ipa || '',
      translation: item.translation || '',
      contextTitle: contextTitle(item)
    };
  }
  function sourceBasis(item) {
    return { type: 'source', ref: primarySource(item), note: item.hook || item.meaning || item.title || '' };
  }
  function confusableBasis(item) {
    return { type: 'confusable', ref: arr(item.confusables).join('/'), note: item.hook || '易混辨析' };
  }
  function errorBasis(item) {
    return { type: 'error', ref: primarySource(item), note: (item.error && item.error.why) || item.hook || '错句改正' };
  }
  function mk(item, fields) {
    var q = {
      id: qid(item, fields.suffix),
      itemId: item.id,
      unitId: item.unitId,
      mode: fields.mode || 'c2e',
      skill: fields.skill || 'c2e',
      difficulty: fields.difficulty || 'D2',
      type: fields.type,
      prompt: fields.prompt,
      stem: fields.stem || '',
      audioText: fields.audioText || '',
      audioOnly: fields.audioOnly === true,
      options: fields.options || null,
      answer: Number.isInteger(fields.answer) ? fields.answer : undefined,
      correctTerm: fields.correctTerm || '',
      targetTerm: fields.targetTerm || '',
      requiredOptions: fields.requiredOptions || null,
      related: fields.related === true,
      optionPool: fields.optionPool || null,
      optionCount: Number.isInteger(fields.optionCount) ? fields.optionCount : undefined,
      optionNotes: fields.optionNotes || null,
      externalTerms: fields.externalTerms || null,
      answers: fields.answers || null,
      why: fields.why || item.hook || item.meaning || '本单元语境。',
      selfCheck: fields.selfCheck === true,
      basis: fields.basis || sourceBasis(item),
      basisDisplay: 'fold',
      reveal: fields.reveal || reveal(item),
      hit: fields.hit || '',
      sub: fields.sub || '',
      hint: fields.hint || ''
    };
    if (q.difficulty === 'D4' || ['confusable', 'error', 'substitution-register'].includes(q.basis.type)) q.basisDisplay = 'inline';
    if (!q.prompt) throw new Error('题目缺 prompt: ' + q.id);
    if (q.options) {
      if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > OPTION_POOL_MAX) throw new Error('题目 options 数量越界: ' + q.id);
      if (!Number.isInteger(q.answer) || q.answer < 0 || q.answer >= q.options.length) throw new Error('题目 answer 越界: ' + q.id);
      if (!q.correctTerm) q.correctTerm = q.options[q.answer];
      if (!q.optionPool) q.optionPool = q.options.slice();
      if (!q.optionCount) q.optionCount = Math.max(OPTION_MIN, Math.min(OPTION_MAX, q.options.length));
    }
    if (!q.options && !q.selfCheck && !arr(q.answers).length) throw new Error('题目既无 options 也无 answers: ' + q.id);
    if (q.audioOnly && !q.audioText) throw new Error('audioOnly 但缺 audioText: ' + q.id);
    return q;
  }

  function clusterOf(item) { return clusterMap.get(item.clusterId) || null; }
  function optionPoolFor(item, extra) {
    // v5.1：干扰项来自 confusables + 本单元外 distractors；不再把整个 cluster 当选项池。
    var pool = arr(item.confusables).concat(arr(item.distractors));
    if (extra) pool = pool.concat(extra);
    var target = targetOf(item);
    pool = uniq(pool.map(function (x) { return String(x || '').trim(); }).filter(function (x) { return x && x.toLowerCase() !== target.toLowerCase(); }));
    return pool;
  }
  function optionNotesFor(item) {
    return item.optionNotes && typeof item.optionNotes === 'object' ? item.optionNotes : {};
  }
  function poolQuestion(item, correct, pool, seed, fields) {
    var opts = uniq([correct].concat(pool));
    if (opts.length < OPTION_MIN) return null;
    // 构建期保留完整候选池；app 在会话开始时抽 3–5 个并重排。
    var shuffled = seededShuffle(opts, seed);
    var notes = {};
    var srcNotes = fields.optionNotes || optionNotesFor(item);
    Object.keys(srcNotes || {}).forEach(function (k) { if (shuffled.indexOf(k) >= 0) notes[k] = srcNotes[k]; });
    return mk(item, Object.assign({}, fields, {
      options: shuffled,
      answer: shuffled.indexOf(correct),
      correctTerm: correct,
      optionPool: shuffled.slice(),
      optionCount: Math.max(OPTION_MIN, Math.min(OPTION_MAX, fields.optionCount || 4)),
      optionNotes: notes,
      externalTerms: arr(item.distractors)
    }));
  }
  function blankInfo(sentence, item) {
    if (!sentence) return null;
    var cands = targetCandidates(item).concat([targetOf(item), item.surface, item.term].filter(Boolean));
    var patterns = [];
    function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
    function addPattern(body) {
      body = String(body || '').trim();
      if (body && patterns.indexOf(body) < 0) patterns.push(body);
    }
    function verbVariants(word) {
      var w = String(word || '');
      var out = [w, w + 's', w + 'es', w + 'ed', w + 'd', w + 'ing'];
      var irr = { speak: ['spoke', 'spoken', 'speaking'], be: ['is', 'are', 'was', 'were', 'being', 'been'], revise: ['revised', 'revising'], listen: ['listened', 'listening'], forge: ['forged', 'forging'], cater: ['caters', 'catered', 'catering'], resume: ['resumed', 'resuming'] };
      if (irr[w.toLowerCase()]) out = out.concat(irr[w.toLowerCase()]);
      return uniq(out);
    }
    cands.forEach(function (cand) {
      String(cand || '').split(/\s*\/\s*/).forEach(function (piece) {
        var p = piece.trim();
        if (!p) return;
        p = p.replace(/\((?:s|sth|sb|somebody|something)[^)]*\)/gi, function (m) { return /^\(s\)$/i.test(m) ? 's' : ''; });
        p = p.replace(/\s*(?:…|\.\.\.)\s*/g, ' __WILD__ ').replace(/\b(sb|sth|somebody|something)\b/gi, ' __WILD__ ');
        p = p.replace(/\s+/g, ' ').trim();
        var hasEndEllipsis = /__WILD__$/.test(p);
        if (hasEndEllipsis) p = p.replace(/\s*__WILD__$/, '');
        if (!p) return;
        var words = p.split(' ');
        var first = words[0];
        var body = escapeRe(p).replace(/__WILD__/g, '.*?');
        if (/^be$/i.test(first)) {
          body = body.replace(escapeRe(first), '(?:be|is|are|was|were|being|been)');
        } else if (first) {
          var vv = verbVariants(first).map(escapeRe).join('|');
          body = body.replace(escapeRe(first), '(?:' + vv + ')');
        }
        addPattern(body);
      });
    });
    patterns.sort(function (a, b) { return b.length - a.length; });
    for (var i = 0; i < patterns.length; i += 1) {
      var re;
      try { re = new RegExp('\\b(?:' + patterns[i] + ')\\b', 'i'); } catch (e) { continue; }
      var m = sentence.match(re);
      if (m && m.index != null) {
        var matched = m[0];
        var stem = sentence.slice(0, m.index) + '____' + sentence.slice(m.index + matched.length);
        var answers = uniq([matched, item.surface, item.term, item.base, targetOf(item)].filter(Boolean));
        return { stem: stem, matched: matched, answers: answers };
      }
    }
    return null;
  }
  function blankInfo(sentence, item) {
    if (!sentence) return null;
    var cands = targetCandidates(item).concat([targetOf(item), item.surface, item.term].filter(Boolean));
    var patterns = [];
    function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
    function addPattern(body) {
      body = String(body || '').trim();
      if (body && patterns.indexOf(body) < 0) patterns.push(body);
    }
    function verbVariants(word) {
      var w = String(word || '');
      var out = [w, w + 's', w + 'es', w + 'ed', w + 'd', w + 'ing'];
      var irr = { speak: ['spoke', 'spoken', 'speaking'], be: ['is', 'are', 'was', 'were', 'being', 'been'], revise: ['revised', 'revising'], listen: ['listened', 'listening'], forge: ['forged', 'forging'], cater: ['caters', 'catered', 'catering'], resume: ['resumed', 'resuming'] };
      if (irr[w.toLowerCase()]) out = out.concat(irr[w.toLowerCase()]);
      return uniq(out);
    }
    cands.forEach(function (cand) {
      String(cand || '').split(/\s*\/\s*/).forEach(function (piece) {
        var p = piece.trim();
        if (!p) return;
        p = p.replace(/\((?:s|sth|sb|somebody|something)[^)]*\)/gi, function (m) { return /^\(s\)$/i.test(m) ? 's' : ''; });
        p = p.replace(/\s*(?:…|\.\.\.)\s*/g, ' __WILD__ ').replace(/\b(sb|sth|somebody|something)\b/gi, ' __WILD__ ');
        p = p.replace(/\s+/g, ' ').trim();
        var hasEndEllipsis = /__WILD__$/.test(p);
        if (hasEndEllipsis) p = p.replace(/\s*__WILD__$/, '');
        if (!p) return;
        var words = p.split(' ');
        var first = words[0];
        var body = escapeRe(p).replace(/ __WILD__ /g, '(?: .*?)?').replace(/__WILD__/g, '.*?');
        if (/^be$/i.test(first)) {
          body = body.replace(escapeRe(first), '(?:be|is|are|was|were|being|been)');
        } else if (first) {
          var vv = verbVariants(first).map(escapeRe).join('|');
          body = body.replace(escapeRe(first), '(?:' + vv + ')');
        }
        addPattern(body);
      });
    });
    patterns.sort(function (a, b) { return b.length - a.length; });
    for (var i = 0; i < patterns.length; i += 1) {
      var re;
      try { re = new RegExp('(?:' + patterns[i] + ')', 'i'); } catch (e) { continue; }
      var m = sentence.match(re);
      if (m && m.index != null) {
        var matched = m[0];
        var stem = sentence.slice(0, m.index) + '____' + sentence.slice(m.index + matched.length);
        var answers = uniq([matched, item.surface, item.term, item.base, targetOf(item)].filter(Boolean));
        return { stem: stem, matched: matched, answers: answers };
      }
    }
    return null;
  }
  function blankTarget(sentence, item) { var b = blankInfo(sentence, item); return b ? b.stem : null; }


  function addPitfall(item) {
    // 易混题只考“在语境里选词/短语”，不考整句改错/改写。
    var pool = optionPoolFor(item);
    if (pool.length < OPTION_MIN - 1) return;
    var bi = blankInfo(item.sentence, item);
    if (!bi) return;
    // 4 个“选最合适”变体 + 1 个“最不适合”，选项池跨单元/站外。
    for (var v = 0; v < 4; v += 1) {
      var q = poolQuestion(item, targetOf(item), pool, 'pit-' + item.id + '-' + v, {
        suffix: 'pitfall-' + v, mode: 'c2e', skill: 'c2e', difficulty: 'D4', type: 'pitfall-choice',
        prompt: '选最合适的词补全句子。', stem: bi.stem,
        why: item.hook || '看搭配、词性、语域或程度，不是只看中文。', basis: confusableBasis(item),
        optionNotes: optionNotesFor(item)
      });
      if (q) questions.push(q);
    }
    var leastTerms = arr(item.distractors).filter(function (x) {
      return x && String(x).toLowerCase() !== targetOf(item).toLowerCase();
    });
    if (leastTerms.length) {
      var least = leastTerms[0];
      var leastQ = poolQuestion(item, least, pool, 'pit-least-' + item.id, {
        suffix: 'pitfall-least', mode: 'c2e', skill: 'c2e', difficulty: 'D4', type: 'pitfall-choice',
        prompt: '哪一个词最不适合填在这里？', stem: bi.stem,
        why: '最不适合：' + ((item.optionNotes && item.optionNotes[least]) || '它与这里的搭配/语域不合') + '；其余选项更贴合。',
        basis: confusableBasis(item), optionNotes: optionNotesFor(item)
      });
      if (leastQ) questions.push(leastQ);
    }
    // v5.6：相关词题只进易混板块；正确答案可以是相关词，但选项必须含原单元词。
    var target = targetOf(item);
    arr(item.relatedTests).forEach(function (rt, ri) {
      var opts = uniq(arr(rt.options).map(function (x) { return String(x || '').trim(); }).filter(Boolean));
      var correct = String(rt.correct || rt.term || '').trim();
      if (!correct || opts.indexOf(correct) < 0 || opts.indexOf(target) < 0) return;
      if (correct.toLowerCase() === target.toLowerCase()) return;
      var notes = rt.optionNotes && typeof rt.optionNotes === 'object' ? rt.optionNotes : {};
      var q = mk(item, {
        suffix: 'pitfall-related-' + ri, mode: 'c2e', skill: 'c2e', difficulty: 'D4', type: 'pitfall-choice',
        prompt: rt.prompt || '选最合适的词补全句子。',
        stem: String(rt.sentence || '').replace(/_{3,}/g, '______'),
        options: opts, answer: opts.indexOf(correct), correctTerm: correct,
        targetTerm: target, requiredOptions: [target], optionPool: opts.slice(), related: true,
        optionCount: Math.max(OPTION_MIN, Math.min(OPTION_MAX, opts.length)),
        optionNotes: notes, externalTerms: arr(rt.externalTerms),
        why: (rt.meaning ? rt.meaning + '；' : '') + '相关词辨析：' + (notes[correct] || '').replace(/^正确项[：:]\s*/, ''),
        basis: '相关词辨析（自创-辨析）'
      });
      questions.push(q);
    });
  }

  items.forEach(function (item) {
    if (!item.testable) return;
    var kind = item.kind;
    var target = targetOf(item);
    if (kind === 'knowledge' || kind === 'substitution') return;

    if (kind === 'word' || (kind === 'phrase' && !(item.phrase && arr(item.phrase.blanks).length))) {
      var bi = blankInfo(item.sentence, item);
      if (bi) {
        questions.push(mk(item, {
          suffix: 'cloze', mode: 'c2e', skill: 'c2e', difficulty: 'D2', type: 'word-cloze',
          prompt: '补全句子。', stem: bi.stem, answers: bi.answers, hint: '输入英文词/短语',
          why: item.hook || item.meaning, basis: sourceBasis(item)
        }));
      }
      if ((arr(item.confusables).length || item.error) && kind === 'word') addPitfall(item);
    }

    if (kind === 'phrase' && item.phrase && arr(item.phrase.blanks).length) {
      var phrase = item.phrase;
      var hint = phrase.hint || item.term || '';
      var blanks = arr(phrase.blanks);
      blanks.forEach(function (b, bi) {
        var opts = arr(b.options);
        if (opts.length < OPTION_MIN) return;
        var shuffled = seededShuffle(uniq([b.answer].concat(opts)), 'phrase-prep-' + item.id + '-' + bi);
        var notes = {};
        var rawNotes = b.optionNotes && typeof b.optionNotes === 'object' ? b.optionNotes : {};
        Object.keys(rawNotes).forEach(function (k) { if (shuffled.indexOf(k) >= 0) notes[k] = rawNotes[k]; });
        questions.push(mk(item, {
          suffix: 'phrase-prep-choice-' + bi, mode: 'c2e', skill: 'c2e', difficulty: 'D2', type: 'phrase-prep-choice',
          prompt: '选正确的介词/小品词。', stem: hint, options: shuffled, answer: shuffled.indexOf(b.answer),
          correctTerm: b.answer, optionPool: shuffled.slice(), optionCount: Math.max(OPTION_MIN, Math.min(OPTION_MAX, 4)),
          optionNotes: notes,
          why: item.hook || item.meaning, basis: sourceBasis(item)
        }));
      });
      if (phrase.core) {
        questions.push(mk(item, {
          suffix: 'phrase-core', mode: 'c2e', skill: 'c2e', difficulty: 'D3', type: 'phrase-core-fill',
          prompt: '给中文和介词，写核心词。', stem: (phrase.hint || '') + '（' + (item.meaning || '') + '）',
          answers: [phrase.core], hint: '输入核心英文词',
          why: item.hook || item.meaning, basis: sourceBasis(item)
        }));
      }
    }

    if (kind === 'pattern' || kind === 'golden') {
      var prompt = kind === 'golden'
        ? '默写这句金句：' + (item.translation || item.meaning || '')
        : '默写这个句式：' + (item.meaning || item.translation || '');
      questions.push(mk(item, {
        suffix: 'recite', mode: 'c2e', skill: 'c2e', difficulty: 'D3', type: 'recite-full',
        prompt: prompt, answers: [kind === 'golden' ? item.text : (item.text || item.term || '')],
        selfCheck: true, why: item.hook || item.meaning || item.translation || '',
        basis: sourceBasis(item)
      }));
    }
  });

  // v5.13：拼写题独立生成——card-only 短语（无 blanks、testable:false）也能进拼写本。
  items.forEach(function (item) {
    if (item.kind !== 'word' && item.kind !== 'phrase') return;
    var spellZh = item.meaning || item.translation || item.title || item.summary || '';
    var spellAnswers = uniq([item.surface, item.term, item.base, targetOf(item)].filter(Boolean));
    if (!spellZh || !spellAnswers.length) return;
    questions.push(mk(item, {
      suffix: 'spell', mode: 'c2e', skill: 'c2e', difficulty: 'D2', type: 'spell-word',
      prompt: '看中文，拼写英文', stem: spellZh, answers: spellAnswers, hint: '输入英文词/短语',
      why: item.hook || item.meaning || '看中文回忆英文。', basis: sourceBasis(item),
      reveal: { term: targetOf(item), meaning: spellZh, hook: item.hook || '', ipa: item.ipa || '' }
    }));
  });

  // 覆盖检查
  var byItem = new Map();
  questions.forEach(function (q) {
    if (!byItem.has(q.itemId)) byItem.set(q.itemId, []);
    byItem.get(q.itemId).push(q);
  });
  items.forEach(function (item) {
    if (!item.testable) return;
    if (item.kind === 'knowledge' || item.kind === 'substitution') return;
    var list = byItem.get(item.id) || [];
    if (!list.length) err(errors, 'items ' + item.id + ' 没有题目');
    if ((arr(item.confusables).length || item.error) && !list.some(function (q) { return q.difficulty === 'D4'; })) {
      err(errors, 'items ' + item.id + ' 有易混/易错但没生成 D4');
    }
    list.forEach(function (q) {
      if (!q.options) return;
      if (!Array.isArray(q.optionPool) || q.optionPool.length < OPTION_MIN) err(errors, '题 ' + q.id + ' 的 optionPool 不足 ' + OPTION_MIN);
      if (!Number.isInteger(q.optionCount) || q.optionCount < OPTION_MIN || q.optionCount > OPTION_MAX) err(errors, '题 ' + q.id + ' 的 optionCount 必须在 ' + OPTION_MIN + '–' + OPTION_MAX);
      if (!q.correctTerm || q.options[q.answer] !== q.correctTerm) err(errors, '题 ' + q.id + ' 的 correctTerm/answer 不一致');
      var notes = q.optionNotes || {};
      q.options.forEach(function (opt) {
        if (!notes[opt]) err(errors, '题 ' + q.id + ' 选项缺讲解: ' + opt);
      });
      if (q.type === 'pitfall-choice' && q.related && !arr(q.externalTerms).length) {
        err(errors, '题 ' + q.id + ' 的相关词题没有站外项');
      } else if (q.type === 'pitfall-choice' && !q.related && !item.error && arr(item.distractors).length && !q.options.some(function (opt) { return arr(item.distractors).indexOf(opt) >= 0; })) {
        err(errors, '题 ' + q.id + ' 的选项池没有本单元外 distractors');
      }
    });
  });
  if (errors.length) return { ok: false, errors: errors, warnings: warnings, content: null };

  // ── 6b. v5.13 易混卡片分组（从 confusables + optionNotes 生成，只读展示用） ──
  var termInfo = new Map();
  function rememberTerm(term, pos, meaning) {
    var t = String(term || '').trim();
    if (!t || termInfo.has(t)) return;
    termInfo.set(t, { pos: pos || '', meaning: meaning || '' });
  }
  items.forEach(function (i) {
    if (i.kind !== 'word' && i.kind !== 'phrase') return;
    rememberTerm(targetOf(i), i.pos, i.meaning || '');
  });
  clusters.forEach(function (c) {
    c.members.forEach(function (m) { rememberTerm(m.term, m.pos, m.meaning); });
  });
  var confusableGroups = [];
  items.forEach(function (item) {
    if (item.kind !== 'word') return;
    if (!arr(item.confusables).length) return;
    var notes = optionNotesFor(item);
    var target = targetOf(item);
    var terms = uniq([target].concat(arr(item.confusables).filter(function (t) { return isNonEmptyString(notes[t]); })));
    if (terms.length < 2) {
      warn(warnings, item._where + ' 易混卡片跳过：不到 2 个带讲解的词');
      return;
    }
    var details = terms.map(function (t) {
      var info = termInfo.get(t) || { pos: '', meaning: '' };
      return { term: t, pos: info.pos, meaning: info.meaning, note: String(notes[t] || '') };
    });
    details.forEach(function (d) {
      if (!isNonEmptyString(d.note)) err(errors, item._where + ' 易混卡片缺讲解: ' + d.term);
    });
    confusableGroups.push({
      id: 'cfg-' + item.id,
      unitId: item.unitId,
      targetItemId: item.id,
      targetTerm: target,
      terms: details,
      distinction: (item.error && item.error.why) || item.hook || '',
      source: primarySource(item) || '作者辨析'
    });
  });
  if (errors.length) return { ok: false, errors: errors, warnings: warnings, content: null };

  // ── 7. meta / sections ─────────────────────────────────
  var itemMap = new Map(items.map(function (i) { return [i.id, i]; }));
  function sectionCount(id) {
    if (id === 'contexts') return contexts.filter(function (c) { return true; }).length;
    if (id === 'pitfalls') return items.filter(function (i) { return arr(i.confusables).length || i.error; }).length;
    if (id === 'sheng') {
      return items.filter(function (i) {
        return i.kind === 'word' && arr(i.senses).some(function (s) { return s.sheng === true && !s.dropped; });
      }).length;
    }
    return items.filter(function (i) { return i.sectionId === id; }).length;
  }
  var sections = SECTION_DEFS.map(function (s) { return Object.assign({}, s); });
  var sectionCounts = {};
  sections.forEach(function (s) { sectionCounts[s.id] = sectionCount(s.id); });
  var pendingContextCount = items.filter(function (i) {
    if (i.testable || i.kind === 'knowledge') return false;
    if (i.kind === 'phrase' && i.phrase && !arr(i.phrase.blanks).length) return false;
    return true;
  }).length;
  var verifiedFalseCount = items.filter(function (i) { return i.verified === false; }).length;
  var meta = {
    unitCount: units.length,
    itemCount: items.length,
    questionCount: questions.length,
    sectionCounts: sectionCounts,
    confusableGroupCount: confusableGroups.length,
    pendingContextCount: pendingContextCount,
    verifiedFalseCount: verifiedFalseCount,
    buildTime: buildTime,
    contentVersion: raw.contentVersion,
    schemaVersion: SCHEMA_VERSION
  };
  var content = {
    meta: meta,
    units: units.map(function (u) {
      delete u._raw;
      return u;
    }),
    sections: sections,
    items: items.map(function (i) {
      delete i._raw;
      delete i._where;
      delete i._reading;
      return i;
    }),
    clusters: clusters,
    contexts: contexts,
    confusableGroups: confusableGroups,
    questions: questions
  };
  return { ok: true, errors: [], warnings: warnings, content: content };
}

export function buildHtml(content, template, appJs) {
  var errors = [];
  if (!content) return { ok: false, errors: ['没有 content'], html: '' };
  if (!isNonEmptyString(template)) errors.push('模板为空');
  if (!isNonEmptyString(appJs)) errors.push('app JS 为空');
  if (errors.length) return { ok: false, errors: errors, html: '' };
  if (!template.includes('__CONTENT_JSON__')) errors.push('模板缺 __CONTENT_JSON__');
  if (!template.includes('__APP_JS__')) errors.push('模板缺 __APP_JS__');
  if (errors.length) return { ok: false, errors: errors, html: '' };
  var safeJson = JSON.stringify(content)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  var safeApp = appJs.replace(/<\/script/gi, '<\\/script');
  var html = template.split('__CONTENT_JSON__').join(safeJson).split('__APP_JS__').join(safeApp);
  var validation = validateHtml(html, content);
  var warnings = validation.warnings || [];
  if (!validation.ok) return { ok: false, errors: validation.errors, warnings: warnings, html: html };
  return { ok: true, errors: [], warnings: warnings, html: html };
}

export function validateHtml(html, content) {
  var errors = [];
  var warnings = [];
  if (!isNonEmptyString(html)) return { ok: false, errors: ['HTML 为空'] };
  if (html.includes('__CONTENT_JSON__') || html.includes('__APP_JS__')) errors.push('HTML 仍有占位符');
  if (!/<meta\s+name="viewport"/i.test(html)) errors.push('HTML 缺 viewport');
  if (!/Content-Security-Policy/i.test(html)) errors.push('HTML 缺 CSP');
  if (!/speechSynthesis/.test(html)) errors.push('HTML 缺 speechSynthesis（TTS 回退）');
  if (!/localStorage/.test(html)) errors.push('HTML 缺 localStorage');
  if (!/window\.__WORD_REVIEW__/.test(html)) errors.push('HTML 缺内嵌数据');
  if (/(src|href)\s*=\s*["']\s*(https?:)?\/\//i.test(html)) errors.push('HTML 含外部 src/href');
  if (/(@import|https?:\/\/)/i.test(html)) errors.push('HTML 含外部资源/URL');
  var bytes = Buffer.byteLength(html, 'utf8');
  warnings.push('HTML 大小: ' + bytes + ' bytes（v5 不设大小上限，仅报告）');
  if (!content || !content.meta) errors.push('content 缺 meta');
  else {
    if (content.meta.unitCount !== content.units.length) errors.push('meta.unitCount 不一致');
    if (content.meta.itemCount !== content.items.length) errors.push('meta.itemCount 不一致');
    if (content.meta.questionCount !== content.questions.length) errors.push('meta.questionCount 不一致');
  }
  return { ok: errors.length === 0, errors: errors, warnings: warnings };
}

function parseArgs(argv) {
  var out = { check: false };
  for (var i = 0; i < argv.length; i += 1) {
    var a = argv[i];
    if (a === '--check') out.check = true;
    else if (a === '--data') out.data = argv[++i];
    else if (a === '--book') out.book = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--template') out.template = argv[++i];
    else if (a === '--app') out.app = argv[++i];
    else if (a === '--build-time') out.buildTime = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
    else { out.error = '未知参数: ' + a; break; }
  }
  return out;
}

function summaryText(content) {
  var m = content.meta;
  var lines = [];
  lines.push('✅ ' + (m ? '校验通过' : '完成') + ': ' + m.unitCount + ' 单元 / ' + m.itemCount + ' 项 / ' + m.questionCount + ' 题');
  content.units.forEach(function (u) {
    var n = content.items.filter(function (i) { return i.unitId === u.id; }).length;
    lines.push('   ' + u.title + ': ' + n + ' 项');
  });
  lines.push('   七节：' + content.sections.map(function (s) { return s.title + ' ' + (m.sectionCounts[s.id] || 0); }).join(' / '));
  lines.push('   待补语境: ' + m.pendingContextCount + '；待核: ' + m.verifiedFalseCount + '；contentVersion: ' + m.contentVersion);
  return lines.join('\n');
}

function capacityText(content, bytes) {
  var n = content.items.length || 0;
  if (!n || !bytes) return '';
  var perItem = bytes / n;
  return '   大小：约 ' + (perItem / 1024).toFixed(2) + ' KB/项；共 ' + (bytes / 1024).toFixed(1) + ' KB（不设上限）';
}

function main() {
  var args = parseArgs(process.argv.slice(2));
  if (args.help || args.error) {
    console.log('用法: node build-word-review.mjs [--check] --data 单词复习数据.json --book 词汇情景本.md --out 单词复习站.html [--template ...] [--app ...]');
    if (args.error) process.exitCode = 2;
    return;
  }
  var dataPath = path.resolve(args.data || '单词复习数据.json');
  var dataDir = path.dirname(dataPath);
  var bookPath = path.resolve(args.book || path.join(dataDir, '词汇情景本.md'));
  var outPath = path.resolve(args.out || path.join(dataDir, '单词复习站.html'));
  var templatePath = path.resolve(args.template || DEFAULT_TEMPLATE);
  var appPath = path.resolve(args.app || DEFAULT_APP);
  var raw;
  try { raw = JSON.parse(fs.readFileSync(dataPath, 'utf8')); } catch (e) {
    console.error('❌ 读不了数据 JSON: ' + e.message);
    process.exitCode = 1;
    return;
  }
  var result = compileContent(raw, { dataDir: dataDir, bookPath: bookPath, buildTime: args.buildTime });
  if (!result.ok) {
    console.error('❌ 校验失败：');
    result.errors.forEach(function (e) { console.error('  - ' + e); });
    if (result.warnings.length) result.warnings.forEach(function (w) { console.error('  ! ' + w); });
    process.exitCode = 1;
    return;
  }
  result.warnings.forEach(function (w) { console.warn('  ! ' + w); });
  console.log(summaryText(result.content));
  if (args.check) {
    // --check 也做一次内存构建，确保 HTML 约束不会被数据变化破坏
    var template0, app0;
    try { template0 = fs.readFileSync(templatePath, 'utf8'); app0 = fs.readFileSync(appPath, 'utf8'); } catch (e) {
      console.error('❌ 读不了模板/app: ' + e.message);
      process.exitCode = 1;
      return;
    }
    var built0 = buildHtml(result.content, template0, app0);
    if (!built0.ok) {
      console.error('❌ HTML 校验失败：');
      built0.errors.forEach(function (e) { console.error('  - ' + e); });
      process.exitCode = 1;
      return;
    }
    (built0.warnings || []).forEach(function (w) { console.warn('  ! ' + w); });
    var checkBytes = Buffer.byteLength(built0.html, 'utf8');
    console.log('✅ --check 通过（HTML 约束也通过，' + checkBytes + ' bytes）');
    console.log(capacityText(result.content, checkBytes));
    return;
  }
  var template, appJs;
  try {
    template = fs.readFileSync(templatePath, 'utf8');
    appJs = fs.readFileSync(appPath, 'utf8');
  } catch (e) {
    console.error('❌ 读不了模板/app: ' + e.message);
    process.exitCode = 1;
    return;
  }
  var built = buildHtml(result.content, template, appJs);
  if (!built.ok) {
    console.error('❌ HTML 校验失败：');
    built.errors.forEach(function (e) { console.error('  - ' + e); });
    process.exitCode = 1;
    return;
  }
  (built.warnings || []).forEach(function (w) { console.warn('  ! ' + w); });
  var tmp = outPath + '.tmp-' + process.pid;
  try {
    fs.writeFileSync(tmp, built.html, 'utf8');
    fs.renameSync(tmp, outPath);
  } catch (e) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e2) { /* ignore */ }
    console.error('❌ 写 HTML 失败: ' + e.message);
    process.exitCode = 1;
    return;
  }
  var builtBytes = Buffer.byteLength(built.html, 'utf8');
  console.log('✅ 已写出: ' + outPath + ' (' + builtBytes + ' bytes)');
  console.log(capacityText(result.content, builtBytes));
}

var isMain = false;
try {
  var thisFile = fileURLToPath(import.meta.url);
  if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(thisFile)) isMain = true;
} catch (e) { /* ignore */ }
if (isMain) main();
