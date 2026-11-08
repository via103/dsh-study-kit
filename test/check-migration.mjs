// check-migration.mjs — 2026-09-16「复习清单 → 复习提纲」合并后的现场检查
// 用法：node test/check-migration.mjs
// 只读，不改任何文件。
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const PLUGINS = '<study-plugins>/'
const core = await import(pathToFileURL(PLUGINS + 'companion-core.js').href)

const ST = 'ST'
// ★ 只列**科目**（判据是目录里有 学习档案.md）。`心灵` 目录**故意不在这里**：
//   它是陪伴预设的家，不是科目——把它加进来会让 ① 与 ③ 用 validateArchive 去验
//   `心灵笔记.md`（契约不同：40 行 / 4KB / 没有三字段），得到的是**假红**。
//   它的现场检查在 study-doctor 层 5 的「心灵陪伴」那一条里单独做。
const SUBJECTS = ['网安', '英语', '数学', 'C', 'Python']
const OUTLINE = '复习提纲.md'
const today = core.studyDate()
let fail = 0
const ok = (label, cond, extra) => {
  if (cond) console.log('  ✅', label)
  else { fail += 1; console.log('  ❌', label, extra === undefined ? '' : `→ ${extra}`) }
}

console.log(`系统当前日期 ${today}\n`)

console.log('① 学习档案：现存档案都要过同一个校验器')
for (const s of SUBJECTS) {
  let raw
  try { raw = readFileSync(join(ST, s, core.ARCHIVE_NAME), 'utf8') } catch { continue }
  const bytes = Buffer.byteLength(raw, 'utf8')
  // 用**档案自己的戳**当"今天"：各科只在学员真的学它时才更新，拿系统日期做基准会让这条
  // 断言隔天就红（Python 停在 09-16 就会挂）。这里要证的是"结构合法、没超页"。
  const stamp = /更新于:\s*(\d{4}-\d{2}-\d{2})/.exec(raw)?.[1] ?? ''
  const verdict = core.validateArchive(raw, core.DEFAULT_MAX_LINES, core.DEFAULT_MAX_BYTES, stamp)
  const pct = Math.round((100 * bytes) / core.DEFAULT_MAX_BYTES)
  ok(`${s}：合法（${bytes} B = ${pct}%，戳 ${stamp}）`, verdict === undefined, verdict)
  ok(`  ${s} 的戳不落在未来（今天 ${today}）`, /^\d{4}-\d{2}-\d{2}$/.test(stamp) && stamp <= today, `${stamp} vs ${today}`)
}

console.log('\n② 流水窗口规则：用**自造夹具**验规则，现场数据只报不判')
{
  // 这条断言原来写的是「网安档案里学习日必须恰好 5 个」——**它测的是学员的内容，不是我的代码**。
  // 2026-10-06 它红了：网安实际覆盖 6 个学习日（学员连着打 CTF，一天一条新流水）。
  // 那是**真的漂了**，但它是**学员侧**的事，该由 doctor 层 5 报警、由该科会话自己收
  // （现在每轮注入里都会自动提醒，见 companion-core 的 renderHygiene），
  // 不该让 `npm test` 变红——否则"测试红了"和"学员该整理了"混成同一件事，
  // 前者会被后者的噪音淹没（这正是 §33.6 记下的那条教训：断言比契约严 = 假红 = 狼来了）。
  // 所以：**规则本身**用夹具验（数据无关、永远有效）；**现场**只打印现状。
  const F = (body) => `# 学习档案\n\n- 更新于: 2026-10-06\n\n## 已答主题与卡点\n${body}\n`
  const day = (d) => `- ${d} 一句话状态\n`
  const five = F(day('10-01') + day('10-02') + day('10-03') + day('10-04') + day('10-05'))
  const six = five + day('10-06')
  ok('  夹具·恰好 5 个学习日 → 不超窗', core.archiveHygiene(five).overWindow === false)
  ok('  夹具·第 6 个学习日 → 超窗', core.archiveHygiene(six).overWindow === true)
  ok('  夹具·两天之间的窗口按**学习日**算，不是按条数',
    core.archiveHygiene(F(day('10-01') + day('10-02') + day('10-03') + day('10-04') + day('10-05') + day('10-05'))).overWindow === false)
  ok('  夹具·一条 200 字节不算超长', core.archiveHygiene(F(`- 10-01 ${'字'.repeat(64)}\n`)).megaItems === 0)
  ok('  夹具·一条 201 字节算超长', core.archiveHygiene(F(`- 10-01 ${'字'.repeat(67)}\n`)).megaItems === 1)
  ok('  夹具·薄弱点那一节不算流水（它要长期保留）',
    core.archiveHygiene('# 学习档案\n\n## 未消化薄弱点\n' + day('09-01') + day('09-02') + day('09-03') + day('09-04') + day('09-05') + day('09-06')).overWindow === false)
  // 日期被 ** 包住（C 科的真实写法）也要认得出来——第一版漏了这一整个科目
  ok('  夹具·`- **09-22**：…` 这种写法也认',
    core.archiveHygiene(F('- **10-01**：a\n- **10-02**：b\n- **10-03**：c\n- **10-04**：d\n- **10-05**：e\n- **10-06**：f\n')).overWindow === true)

  // 现场：只报告。**不断言**——它反映的是学员学到哪儿了。
  console.log('  ── 现场现状（仅供参考，不影响成败）')
  for (const s of SUBJECTS) {
    let raw
    try { raw = readFileSync(join(ST, s, core.ARCHIVE_NAME), 'utf8') } catch { continue }
    const h = core.archiveHygiene(raw)
    if (h.flowItems === 0) continue
    const flags = [h.overWindow ? `超窗(${h.days}天)` : `${h.days} 天`, h.megaItems > 0 ? `长条 ${h.megaItems} 个(最长 ${h.longestFlow}B)` : '无长条'].join(' · ')
    console.log(`  ℹ️  ${s}：流水 ${h.flowItems} 条 / ${flags} / 占档案 ${h.ratio}%${h.overWindow || h.megaItems > 0 ? '　← 该科会话已被自动提醒收拢' : ''}`)
  }
}

console.log('\n③ 复习提纲：格式与体量')
for (const s of SUBJECTS) {
  let raw
  try { raw = readFileSync(join(ST, s, OUTLINE), 'utf8') } catch { continue }
  const lines = raw.split('\n').filter((l) => /^\s*-\s/.test(l))
  // **尾巴允许跟一段自由文本**：2026-09-17 实测，网安会话复习完会自己补一个结果标记
  // （`…｜复 1｜上 09-17 ✓` / `… ✗（答成「编号」——%E4%BD%A0 里没有 4F60）`）。
  // 提纲**没有代码契约**（不注入、不受守护、不参与计划），所以这不是"格式错"，是它自己长出来的用法。
  // 这条断言只该管**前半段可解析**，不该管人家在末尾写了什么。
  //
  // ⚠️ 2026-09-28 又踩一次：尾巴原来写成 `(?:\s+\S.*)?$`，**要求尾巴前有个空格**。
  //    网安会话写了 `上 09-28（逆元题答对 ✓；…）`（没空格）→ 断言红，而 code 一行没改。
  //    那正是这条注释自己说的"不该管人家末尾写了什么"——**注释写对了，正则没照做**。
  //    改成 `.*$`：前半段（日期 + `｜复 N｜上 MM-DD`）仍然必须可解析，尾巴彻底自由。
  const fmt = /^-\s+\d{2}-\d{2}\s+.+?｜\s*复\s*\d+\s*｜\s*上\s*(?:\d{2}-\d{2}|—).*$/
  // ⚠️ 2026-09-28 第三次踩同一条：**又一种合法行**出现了——「**归档指针**」。
  //    学员把重复的 Python 知识点从网安提纲里收敛掉，换成一行指针：
  //    `- 09-28 \`@Python\` **Python 语法类知识点已整科归档**（…9 条）→ 见 **\`..\Python\复习提纲.md\`**`
  //    它**不是知识点**（没有 `复 N｜上 MM-DD`，因为它不是要复习的东西，而是"东西在别处"的路标），
  //    所以按知识点格式判它"格式错"是错的。断言的范围要跟着**真实语义**走，不是跟着我当初想到的行类型走。
  //
  //    豁免条件写得**窄**（不能把"格式坏了"也放过去）：必须同时 ① 指向另一科的 `复习提纲.md`，
  //    ② 明说是归档/指路。其余任何不合格式的行仍然判错。
  const isPointer = (l) => /复习提纲\.md/.test(l) && /(已整科归档|已归档|不再重复列|→\s*见)/.test(l)
  const bad = lines.filter((l) => !fmt.test(l.trim()) && !isPointer(l.trim()))
  const pointers = lines.filter((l) => isPointer(l.trim()) && !fmt.test(l.trim()))
  ok(`${s}：${lines.length} 条知识点，格式全对`, bad.length === 0, JSON.stringify(bad.slice(0, 2)))
  if (pointers.length > 0) console.log(`      ℹ️  另有 ${pointers.length} 行「归档指针」（指向别科提纲，不是知识点，已豁免）：${pointers[0].trim().slice(0, 70)}…`)
  // ★ 体量只做**提示**，不算失败（2026-09-24 改）。
  //   提纲**没有代码契约**：不进注入、不受守护、不参与计划——它长到多大都不会让任何东西坏掉，
  //   所以"超过 8KB"不可能是"不合格"。原来是 ❌，于是网安把它写到 8963 B 时 `npm test` 就红了，
  //   而代码一行没改——**又是 F15（断言绑在现场数据上）**。这里留一行印出来给人看，
  //   真要判定"该整理了"由 doctor 层 5 按阈值报（那里有 warn/bad 的分级）。
  const bytes = Buffer.byteLength(raw, 'utf8')
  if (bytes >= 8192) console.log(`  ℹ️  ${s} 提纲 ${bytes} B —— 已经不小了（提示，不是失败）；提纲不进注入，压缩与否由你定`)
  else console.log(`  ✅ ${s} 提纲 ${bytes} B（不进注入，按需读）`)
}

console.log('\n④ 旧协议文件必须真的没有了')
{
  const found = []
  for (const s of SUBJECTS) {
    try { statSync(join(ST, s, '复习清单.md')); found.push(s) } catch { /* 不在，正常 */ }
  }
  try { statSync(join(ST, '复习清单.md')); found.push('<ST 根>') } catch { /* 正常 */ }
  ok('ST 下不再有任何 复习清单.md', found.length === 0, JSON.stringify(found))
  ok('  companion-core 也不再导出它', core.REVIEW_NAME === undefined && core.validateReviewList === undefined)
  ok(`  导出的协议名只剩 4 个：${[core.ARCHIVE_NAME, core.TASK_NAME, core.PLAN_NAME, core.NOTICE_NAME].join(' / ')}`, core.NOTICE_NAME === '变更记录.md')
}

console.log('\n⑤ 总规划看板：档位该降就降，但**漂移行与任务条目永不丢**')
{
  // ⚠️ 2026-09-28 重写。原断言是「看板里必须有一行 `卡点 ›`」，而看板的档位会随**现场数据体量**
  //    降档：5 个科目的档案都接近上限时，尾部（计划 + 基准行）变大 → 头部预算变小 →
  //    落到最低档、把「进度/卡点/薄弱」摘要整段省掉。学员学得越多，回归越红——**又是 F15**
  //    （断言绑在现场数据上），而且这次它红得"有道理"，更容易被误当成产品 bug。
  //
  //    现在拆成两半：**数据无关的不变量**查现场，**档位取舍**用自造的夹具查。
  const { survey, buildBoard, BOARD_MAX_BYTES } = await import(pathToFileURL(PLUGINS + 'plan-core.js').href)
  const subjects = survey(ST, today)
  const board = buildBoard(ST, { today, subjects, planRaw: undefined })
  const bytes = Buffer.byteLength(board, 'utf8')
  ok(`现场看板不超过 ${BOARD_MAX_BYTES} 字节（实测 ${bytes}）`, bytes <= BOARD_MAX_BYTES, `${bytes} B`)

  // 数据无关的不变量：降档可以说"摘要已省略"，但**每一条漂移、每一个任务条目都必须还在**。
  // 用"子串必须出现"而不是"数行数"——行数会随格式微调而漂，而这正是这条断言的本意：
  // **代码算出来的事实一条都不能丢**（verify-board-fit 那套管档位，这里做现场交叉确认）。
  const dropped = board.includes('摘要已整段省略')
  const missingDrift = []
  for (const s of subjects) for (const d of s.drift) if (!board.includes(d)) missingDrift.push(`${s.name}: ${d.slice(0, 30)}`)
  ok(`  降档=${dropped ? '是' : '否'}，${subjects.reduce((n, s) => n + s.drift.length, 0)} 条漂移一条不少`, missingDrift.length === 0, missingDrift.slice(0, 3).join(' · '))

  const missingTask = []
  for (const s of subjects) {
    for (const item of [...s.task.open, ...s.task.done]) {
      if (!board.includes(item.slice(0, Math.min(24, item.length)))) missingTask.push(`${s.name}: ${item.slice(0, 24)}`)
    }
  }
  ok(`  ${subjects.reduce((n, s) => n + s.task.open.length + s.task.done.length, 0)} 个任务条目也一条不少`, missingTask.length === 0, missingTask.slice(0, 3).join(' · '))

  // 档位取舍本身：用**自造的小夹具**证明"有空间时摘要会出现、卡点取最新的那条"。
  {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const fix = mkdtempSync(join(tmpdir(), 'board-pain-'))
    const sub = join(fix, '某科')
    mkdirSync(sub, { recursive: true })
    writeFileSync(join(sub, '学习档案.md'), `# 学习档案\n\n更新于: ${today}\n\n## 学校当前进度\n- 第 3 章\n\n## 已答主题与卡点\n- 09-04 最旧的一条卡点\n- ${today} 最新的一条卡点\n\n## 未消化薄弱点\n- 指针与数组退化\n`)
    const fx = survey(fix, today)
    const fb = buildBoard(fix, { today, subjects: fx, planRaw: undefined })
    const painLine = fb.split('\n').find((l) => l.includes('卡点 ›'))
    ok('  小夹具（有空间）→ 看板出现卡点行', painLine !== undefined, fb.slice(0, 200))
    ok('  卡点包含了最新那条', painLine !== undefined && painLine.includes('最新的一条卡点'), painLine)
    rmSync(fix, { recursive: true, force: true })
  }
}

console.log('\n⑥ 会话日志：文件名规则必须与版本无关')
// 2026-09-23（0.1.7-rc.1）：日志从 v3 升到 v4，而解码器与 doctor 当时都硬编码着
// `session.v3.jsonl.zstd` —— 新会话对它们**完全隐形**，且不报错（F21 同类：输入老了）。
// 这一条钉住"按模式认，不按版本号认"，并证实现存每种版本的日志都真的读得出来。
{
  const { SESSION_FILE_RE, listSessionFiles, readSessionHeader } = await import('../tools/decode-session.mjs')

  // 规则本身：历史上出现过的形态都要认，且不该认无关文件名。
  const mustMatch = ['session.jsonl.zstd', 'session.v1.jsonl.zstd', 'session.v3.jsonl.zstd', 'session.v4.jsonl.zstd', 'session.v12.jsonl.zstd']
  const mustNot = ['session-handoff.md', 'session.v4.jsonl', 'notes.jsonl.zstd', 'session.v4.jsonl.zstd.tmp']
  ok('文件名规则认所有版本形态（含将来的 v5+）', mustMatch.every((n) => SESSION_FILE_RE.test(n)), mustMatch.filter((n) => !SESSION_FILE_RE.test(n)).join('、'))
  ok('  且不误认无关文件', mustNot.every((n) => !SESSION_FILE_RE.test(n)), mustNot.filter((n) => SESSION_FILE_RE.test(n)).join('、'))

  const store = join(process.env.USERPROFILE ?? '~', '.dsh', 'sessions')
  const found = listSessionFiles(store)
  ok(`发现会话日志 ${found.length} 个`, found.length > 0, '一个都没发现——文件名规则或 store 路径不对')

  // 版本分布：出现新版本时这里会显示出来，是"上游改了格式"的第一个信号。
  const versions = new Map()
  for (const f of found) versions.set(f.file, (versions.get(f.file) ?? 0) + 1)
  console.log(`      版本分布：${[...versions].map(([k, v]) => `${k} × ${v}`).join(' · ')}`)

  // 发现的每一个都必须真的能解出头——"找得到但读不出"正是这次故障的形状。
  // 但**空文件要单独算**：0 字节的日志（会话建了却没写过任何事件）本来就没有头。
  // "空"和"读不出"是两件事，混在一起报会让人去查一个不存在的问题——
  // 档案那条 F11 用的是同一个区分。
  const empty = found.filter((f) => f.bytes === 0)
  const nonEmpty = found.filter((f) => f.bytes > 0)
  const unreadable = nonEmpty.filter((f) => readSessionHeader(f.abs) === undefined)
  ok(`  非空日志都能读出头部（${nonEmpty.length} 个）`, unreadable.length === 0, unreadable.slice(0, 3).map((f) => f.file).join('、'))
  if (empty.length > 0) console.log(`      ℹ️  另有 ${empty.length} 个 0 字节日志（会话建了没写事件，本来就没有头）——不算故障`)

  const newest = found[0]
  const head = newest === undefined ? undefined : readSessionHeader(newest.abs)
  ok('  最新那个会话头里有 agentPreset 字段', head !== undefined && 'agentPreset' in head, JSON.stringify(head ?? {}).slice(0, 120))
  if (head !== undefined) console.log(`      最新：${newest.file} · cwd=${head.cwd} · 创建时预设=${head.agentPreset}`)
}

console.log(`\n${fail === 0 ? '✅ 现场检查全部通过' : `❌ ${fail} 项不合格`}`)
process.exit(fail === 0 ? 0 : 1)
