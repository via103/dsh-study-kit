#!/usr/bin/env node
// word-review-change.mjs — v5 改站包装器（数据预检 / 构建预演 / 显式写入）
// 用法：
//   node word-review-change.mjs --data-only --data <json>
//   node word-review-change.mjs --data <json> --out <html> [--write]
//
// 设计原则：默认只读；只有显式 --write 才写 HTML。数据文件永远不由本脚本写入。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileContent, buildHtml, SECTION_DEFS } from './build-word-review.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = {};
for (let i = 2; i < process.argv.length; i += 1) {
  const a = process.argv[i];
  if (a.startsWith('--')) {
    const k = a.slice(2);
    const v = process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : true;
    args[k] = v;
  }
}
const dataPath = args.data || 'ST/英语/单词复习数据.json';
const bookPath = args.book || 'ST/英语/词汇情景本.md';
const outPath = args.out || 'ST/英语/单词复习站.html';
const templatePath = args.template || path.join(HERE, '..', 'templates', 'word-review.template.html');
const appPath = args.app || path.join(HERE, '..', 'templates', 'word-review-app.js');

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function main() {
  let raw;
  try { raw = readJson(dataPath); } catch (e) { console.error('❌ 读不了数据：' + e.message); process.exitCode = 1; return; }
  const r = compileContent(raw, { dataDir: path.dirname(dataPath), bookPath: bookPath, buildTime: new Date().toISOString() });
  console.log('数据：' + dataPath);
  console.log('版本：' + (raw.contentVersion || '—') + ' · 单元 ' + (raw.units || []).length + ' · 条目 ' + (raw.items || []).length + ' · 聚类 ' + (raw.clusters || []).length);
  if (!r.ok) {
    console.error('❌ 校验失败');
    r.errors.slice(0, 20).forEach((e) => console.error('  - ' + e));
    r.warnings.forEach((w) => console.error('  ! ' + w));
    process.exitCode = 1;
    return;
  }
  r.warnings.forEach((w) => console.warn('  ! ' + w));
  const c = r.content;
  console.log('✅ 编译通过：' + c.units.length + ' 单元 / ' + c.items.length + ' 项 / ' + c.questions.length + ' 题 / 七节 ' + c.sections.length);
  const blind = c.items.filter((i) => i.testable && i.kind !== 'substitution' && i.kind !== 'knowledge' && !c.questions.some((q) => q.itemId === i.id && !q.options));
  console.log('无选项盲测缺口：' + blind.length + (blind.length ? '（' + blind.slice(0, 8).map((i) => i.term || i.title).join(' / ') + '）' : ''));
  const readings = c.units.map((u) => u.id + '：' + (u.reading ? (u.reading.wordCount + ' 词 / ' + u.reading.parts.length + ' 主题 / ' + (u.reading.itemIds || []).length + ' 词覆盖') : '缺 reading'));
  readings.forEach((x) => console.log('  · ' + x));
  const phrase = c.items.filter((i) => i.kind === 'phrase' && i.phrase);
  console.log('短语元数据：' + phrase.length + ' / ' + c.items.filter((i) => i.kind === 'phrase').length + '；clusters：' + (c.clusters || []).length);
  if (args['data-only']) return;
  const template = fs.readFileSync(templatePath, 'utf8');
  const app = fs.readFileSync(appPath, 'utf8');
  const built = buildHtml(c, template, app);
  if (!built.ok) {
    console.error('❌ HTML 校验失败');
    built.errors.slice(0, 20).forEach((e) => console.error('  - ' + e));
    process.exitCode = 1;
    return;
  }
  const bytes = Buffer.byteLength(built.html, 'utf8');
  console.log('HTML：' + bytes + ' bytes（不设大小上限）');
  if (args.write === true || args.write === 'true' || args.build === true || args.build === 'true') {
    const tmp = outPath + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, built.html, 'utf8');
    fs.renameSync(tmp, outPath);
    console.log('✅ 已写出：' + outPath);
  } else {
    console.log('（预演；加 --write 才写）');
  }
}
main();
