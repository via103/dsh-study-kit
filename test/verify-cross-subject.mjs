// verify-cross-subject.mjs —— **跨科知识点**：别科会话学到的本科知识点，怎么落到它该在的家。
//
// 为什么需要它（2026-09-28 学员在网安会话里的真实发现）：
//   打 CTF 的 PRNG_1 时，学员的 **Python** 表述错了一片——变量名带 `-`、列表忘了 `[0]`、
//   模运算误用 `/`、`print` 加引号把值变成字符串、缺 `long_to_bytes`。这些是**真正的 Python 知识点**，
//   却发生在网安会话里、被记进了**网安**的档案。而 Python 会话自 09-22 起就没再跑过——
//   最有价值的一手证据（真实压力下暴露的表述错误）一条都没到它手里。
//
// 本套件钉住的处理方式（不建"预设之间的对话通道"，而是"归属 + 移交"）：
//   · 知识点**永远写进它所属科目的 `复习提纲.md`**（那是"一份事实一个家"的既定唯一入口）；
//   · 别科写这份提纲**只许追加**，且新增的每一行都要带**来源戳**（`（源:网安 2026-09-28）`）；
//   · 本科会话**一定会看到**别科追加了什么（注入），判据是"晚于本科档案的「更新于」"——
//     于是本科一更新档案，提醒自己就消失，不需要 ack 协议。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const core = await import('../companion-core.js')
const guard = await import('../file-guard.js')
const { declById, personaPrefixOf } = await import('../tools/presets.mjs')

let pass = 0
let fail = 0
const check = (label, cond, extra) => {
  if (cond) { pass += 1; console.log('  ✅', label) }
  else { fail += 1; console.log('  ❌', label, extra === undefined ? '' : `→ ${extra}`) }
}
const blocked = (v) => typeof v === 'string' && v.length > 0

const OUTLINE = core.OUTLINE_NAME
const TAG = '（源:网安 2026-09-28）'
const OUTLINE_OLD = `# 复习提纲\n\n- 09-20 while 循环｜复 1｜上 09-21\n- 09-19 列表 append 返回 None｜复 0｜上 —\n`
const APPENDED = `- 09-28 变量名不能含短横线；列表取元素要写下标（源:网安 2026-09-28）\n`

console.log('\n① 判定纯函数：别科只许追加 + 必须带来源戳')
{
  const V = core.validateOutlineForeignWrite
  check('追加一行且带来源戳 → 通过', V(OUTLINE_OLD, OUTLINE_OLD + APPENDED) === undefined, V(OUTLINE_OLD, OUTLINE_OLD + APPENDED))
  check('  插在最前面也通过（条目"新的在上"，位置不该被格式绑架）', V(OUTLINE_OLD, APPENDED + OUTLINE_OLD) === undefined)
  check('删掉一行 → 拒', blocked(V(OUTLINE_OLD, OUTLINE_OLD.split('\n').filter((l) => !l.includes('while')).join('\n'))))
  check('改写一行 → 拒', blocked(V(OUTLINE_OLD, OUTLINE_OLD.replace('09-19', '09-18'))))
  check('  拒绝话术说清"只许追加"', (V(OUTLINE_OLD, OUTLINE_OLD.replace('09-19', '09-18')) ?? '').includes('只许'))
  check('新增行没带来源戳 → 拒', blocked(V(OUTLINE_OLD, OUTLINE_OLD + '- 09-28 随手加的一行\n')))
  check('  拒绝话术给出格式样例', (V(OUTLINE_OLD, OUTLINE_OLD + 'x\n') ?? '').includes('源:'))
  check('一条都没加（原样回写）→ 通过', V(OUTLINE_OLD, OUTLINE_OLD) === undefined)
  check('旧文件不存在 + 全带戳 → 通过（等价于"全是新增"）', V('', APPENDED) === undefined)
  check('旧文件不存在 + 无戳 → 拒', blocked(V('', '- 没有出处的行\n')))
  check('控制字符 → 拒', blocked(V(OUTLINE_OLD, `${OUTLINE_OLD}${APPENDED}\u0000`)))
}

console.log('\n①-b 标记解析：必须认得**真实世界里写出来的形态**')
// ★★ 2026-09-28 实测回填的断言。网安会话**自发**做了移交，而它写的形态是
//    `- 09-28 \`@Python\` …`（反引号包着、日期在前），而第一版解析器要求 `@` **紧跟子弹行开头**
//    → **一条也认不出来**（parseHandoffs 返回 0），整条自动化静默失效。
//    现在解析器放宽到同时认这几种形态；下面每条都是防复发针。
{
  const plan2 = await import('../plan-core.js')
  const real = plan2.parseHandoffs('- 09-28 `@Python` Python 表达式三件套：% 取余；模逆元\n- 09-28 `@C` 顺手给 C 的\n', { source: '网安', fallbackDate: '2026-09-28' })
  check('认得真实形态：`- 09-28 \\`@Python\\` …`', real.length === 2, `认出 ${real.length} 条（第一版是 0）`)
  check('  科目与日期都解析对了', real[0]?.target === 'Python' && real[0]?.date === '2026-09-28', JSON.stringify(real[0] ?? null))
  check('  反引号不会混进正文', real[0]?.text.startsWith('Python 表达式三件套') === true, JSON.stringify(real[0]?.text?.slice(0, 40) ?? null))
  check('  也认规范形态（无日期、无引号）', plan2.parseHandoffs('- @Python：变量名不能含短横线\n', { fallbackDate: '2026-09-28' })[0]?.date === '2026-09-28')
  // 放宽不能放到误报——这两条是"正文里提到 @"的典型
  check('  放宽之后仍不误报：`- 正文里提一句 →@Python 不该被当成标记`', plan2.parseHandoffs('- 正文里提一句 →@Python 不该被当成标记\n', {}).length === 0)
  check('  也不误报：`- 09-28 提到的 @Python 是另一回事`', plan2.parseHandoffs('- 09-28 提到的 @Python 是另一回事\n', {}).length === 0)

  // ★★ 2026-10-07 实测回填的断言（第二个"无限重复提醒" bug）。
  //    行首那个 `MM-DD` 原本是**非捕获组** → 被静默丢掉 → `date` 退回**来源档案的「更新于」**，
  //    而「更新于」每写一次档案就变。于是网安 10-06 更新档案后，Python 那 9 条**早就收好**的
  //    知识点突然又变成"待收 1 条"，而且**永远收不完**（学员怎么改都追不上那个漂移的键）。
  //    真正的时间戳是**学员自己写在行首的那个日期**。
  check('  ★ 行首日期才是这条移交的日期（不是"档案最后一次被改的时间"）',
    plan2.parseHandoffs('- 09-28 `@Python` 变量名', { source: '网安', fallbackDate: '2026-10-06' })[0]?.date === '2026-09-28',
    plan2.parseHandoffs('- 09-28 `@Python` 变量名', { source: '网安', fallbackDate: '2026-10-06' })[0]?.date)
  check('    来源档案更新过也不影响它（这就是上面那个 bug 的现场）',
    plan2.parseHandoffs('- 09-28 `@Python` 变量名', { source: '网安', fallbackDate: '2026-12-31' })[0]?.date === '2026-09-28')
  check('  `@科目` 之后的日期也认', plan2.parseHandoffs('- `@Python`: 09-28 变量名', { source: '网安', fallbackDate: '2026-10-06' })[0]?.date === '2026-09-28')
  check('  两边都没日期 → 才退回来源档案的「更新于」', plan2.parseHandoffs('- `@Python` 变量名', { source: '网安', fallbackDate: '2026-10-06' })[0]?.date === '2026-10-06')
  // 年份补错也会造出同一类"永远收不完"（键是 `来源@日期`，年份错了就永久对不上）
  check('  ★ 跨年补年份：01-03 读到 12-28 的标记 → 退一年（2026-12-28 而不是未来的 2027-12-28）',
    plan2.parseHandoffs('- 12-28 `@Python` 变量名', { source: '网安', fallbackDate: '2027-01-03', now: new Date('2027-01-03T12:00:00') })[0]?.date === '2026-12-28',
    plan2.parseHandoffs('- 12-28 `@Python` 变量名', { source: '网安', fallbackDate: '2027-01-03', now: new Date('2027-01-03T12:00:00') })[0]?.date)
  check('    年内不该被误退（10-06 读 09-28 → 仍是 2026-09-28）',
    plan2.parseHandoffs('- 09-28 `@Python` 变量名', { source: '网安', fallbackDate: '2026-10-06' })[0]?.date === '2026-09-28')
  // 端到端：来源档案更新后，"已收下"仍必须认得出（这正是现场红的那个场景）
  check('  ★★ 端到端：来源档案更新后，已收下的条目不会又变成"待收"', (() => {
    const dir = mkdtempSync(join(tmpdir(), 'handoff-year-'))
    // 这个块在 `body` 定义之前，所以自带一个最小档案构造器（形状要跟真档案一致：有「更新于」）
    const mini = (stamp, lines) => `# 学习档案\n\n更新于: ${stamp}\n\n## 已答主题与卡点\n${lines.join('\n')}\n`
    try {
      mkdirSync(join(dir, 'Python'), { recursive: true })
      mkdirSync(join(dir, '网安'), { recursive: true })
      writeFileSync(join(dir, 'Python', '学习档案.md'), mini('2026-09-22', ['- 09-22 起步']))
      // 网安**今天**才更新档案，但标记写的是 09-28
      writeFileSync(join(dir, '网安', '学习档案.md'), mini('2026-10-06', ['- 09-28 `@Python` 变量名不能含短横线']))
      // Python 提纲里已经收下它了（凭据：同一来源同一日期）
      const outline = '# 复习提纲\n\n- 09-28 变量名不能含短横线（源:网安 2026-09-28）\n'
      const r = core.pendingHandoffs(join(dir, 'Python'), { outlineText: outline })
      return r.pending.length === 0
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })())
}

console.log('\n② 解析：来源戳 → 结构化条目 + 按日期过滤')
{
  const text = OUTLINE_OLD + '（源:英语 2026-09-10）不该被当成条目\n' + APPENDED
  const all = core.foreignOutlineEntries(text)
  check('只认整行条目里的来源戳（不是正文里提到"源:"）', all.length === 1, JSON.stringify(all.map((e) => e.source)))
  check('  解析出科目与日期', all[0]?.source === '网安' && all[0]?.date === '2026-09-28', JSON.stringify(all[0] ?? null))
  check('after 严格晚于：09-22 → 命中', core.foreignOutlineEntries(text, { after: '2026-09-22' }).length === 1)
  check('  after 恰好等于它 → 不命中', core.foreignOutlineEntries(text, { after: '2026-09-28' }).length === 0)
  check('  hasSourceTag 对带戳行为真、对普通条目为假', core.hasSourceTag('- x（源:网安 2026-09-28）') && !core.hasSourceTag('- 09-20 while 循环'))
  check('渲染块里带上了原文与出处', (() => { const r = core.renderForeignOutline(all); return r.includes('网安') && r.includes('变量名不能含短横线') })())
}

// ── 搭两个台子：预设内守护（companion-core）与宿主守护（file-guard）─────────────
const ROOT = mkdtempSync(join(tmpdir(), 'cross-subject-'))
const ST = join(ROOT, 'ST')
const ENG = join(ST, '英语')
const SEC = join(ST, '网安')
mkdirSync(ENG, { recursive: true })
mkdirSync(SEC, { recursive: true })
const archiveOf = (stamp) => `# 学习档案\n\n更新于: ${stamp}\n\n## 学校当前进度\n- x\n\n## 已答主题与卡点\n- y\n\n## 未消化薄弱点\n- z\n`
writeFileSync(join(ENG, '学习档案.md'), archiveOf('2026-09-22'))
writeFileSync(join(SEC, '学习档案.md'), archiveOf('2026-09-28'))
writeFileSync(join(ENG, OUTLINE), OUTLINE_OLD)
writeFileSync(join(SEC, OUTLINE), OUTLINE_OLD)

const presetGuards = []
core.apply({ on: () => () => {}, get: (n) => (n === 'tools' ? { guard: (f) => { presetGuards.push(f); return () => {} } } : undefined) }, {})
const hostGuards = []
guard.apply({ get: (n) => (n === 'tools' ? { guard: (f) => { hostGuards.push(f); return () => {} } } : undefined) }, {})

const call = (g) => (cwd, name, file, args) => g({ name, arguments: { file_path: file, ...args }, agent: { session: { header: { cwd } } } })

for (const [plane, g] of [['预设内', presetGuards[0]], ['宿主', hostGuards[0]]]) {
  if (g === undefined) { check(`${plane}守护注册上了`, false, '没拿到 guard'); continue }
  const c = call(g)
  console.log(`\n③ 守护（${plane}）：跨科写别科提纲`)
  check('本科写自己的提纲（整份重写）→ 放行', c(ENG, 'write', join(ENG, OUTLINE), { content: OUTLINE_OLD + '- 本科自己整理过的行\n' }) === undefined)
  check('别科**追加**一行（带来源戳）→ 放行', c(SEC, 'edit', join(ENG, OUTLINE), { old_string: OUTLINE_OLD, new_string: OUTLINE_OLD + APPENDED }) === undefined)
  check('  **追加**（用 write 把旧内容+新行一起写）→ 也放行', c(SEC, 'write', join(ENG, OUTLINE), { content: OUTLINE_OLD + APPENDED }) === undefined)
  check('  别科**删掉**旧行 → 拦下', blocked(c(SEC, 'write', join(ENG, OUTLINE), { content: APPENDED })))
  check('  别科**改写**旧行 → 拦下', blocked(c(SEC, 'write', join(ENG, OUTLINE), { content: OUTLINE_OLD.replace('09-19', '09-18') + APPENDED })))
  check('  别科追加但**不带来源戳** → 拦下', blocked(c(SEC, 'edit', join(ENG, OUTLINE), { old_string: OUTLINE_OLD, new_string: OUTLINE_OLD + '- 没出处\n' })))
  check('  无关文件不受影响', c(SEC, 'write', join(ENG, '随手笔记.md'), { content: 'x' }) === undefined)
}

console.log('\n④ 注入：本科会话一定会看到别科追加了什么')
{
  const handlers = new Map()
  core.apply({ on: (n, fn) => { handlers.set(n, fn); return () => {} }, get: (n) => (n === 'tools' ? { guard: () => () => {} } : undefined) }, {})
  const preStep = handlers.get('agent/pre-step')
  const agent = { id: 'agent-cross', session: { header: { cwd: ENG } } }
  const decision = { kind: 'continue', messages: [] }
  const run = async () => {
    const out = await preStep({ agent, step: 1, signal: { aborted: false } }, async () => decision)
    const msg = out.messages.find((m) => m.source?.plugin === 'companion-core')
    return msg === undefined ? undefined : msg.content[0].text
  }

  // 档案 09-22、别科条目 09-28 → 应该提示
  writeFileSync(join(ENG, OUTLINE), OUTLINE_OLD + APPENDED)
  const withNote = await run()
  check('别科条目晚于档案 → 注入里出现【跨科知识点】', withNote?.includes('【跨科知识点·别科追加】') === true, withNote === undefined ? '(未注入)' : withNote.slice(-200))
  check('  说明里点出了来源科目', withNote?.includes('网安') === true)
  check('  把那行原文也带进来了（本科的知识点本来就该看见）', withNote?.includes('变量名不能含短横线') === true)
  check('  ⚠️ 提纲本身**不进注入**（没带戳的行不该出现）', withNote?.includes('列表 append 返回 None') === false)

  const again = await run()
  check('  同内容第二次不重复注入', again === undefined)

  // 档案推到 09-29（= 本科已经动过、应该已经看过）→ 提示自己消失
  writeFileSync(join(ENG, '学习档案.md'), archiveOf('2026-09-29'))
  const after = await run()
  check('本科更新档案后 → 提示自清除（不需要 ack 协议）', after !== undefined && !after.includes('【跨科知识点】'), after === undefined ? '(未注入)' : after.slice(-160))
  rmSync(ROOT, { recursive: true, force: true })
}

console.log('\n⑥ 主路：在自己档案里打 `@科目` 标记 → 代码送到目标科目')
// 这是 2026-09-28 学员追问"所以之后要我自己在对应的学科里提醒吗"之后加的**主路**。
// 上一版要求发现方**直接写别科的提纲**——那是跨文件动作，在打 CTF 的中途很容易不做，
// 而且不做就没有任何痕迹。改成"只碰自己的文件 + 代码送到位"之后，学员不需要当搬运工。
{
  const plan = await import('../plan-core.js')
  const body = (stamp, lines) => `# 学习档案\n\n更新于: ${stamp}\n\n## 学校当前进度\n- x\n\n## 已答主题与卡点\n${lines.join('\n')}\n\n## 未消化薄弱点\n- z\n`
  const TAGS = body('2026-09-28', [
    '- 09-28 打 CTF，学员 Python 表述错了一片',
    '- @Python：变量名不能含短横线；列表忘下标',
    '- @Python 09-27 print 加引号把值变成字符串',
    '- @C 顺手记一条给 C 的',
    '- 正文里提一句 →@Python 不该被当成标记',
  ])

  console.log('  ① 标记解析（纯函数）')
  const hs = plan.parseHandoffs(TAGS, { source: '网安', fallbackDate: '2026-09-28' })
  check('只认"子弹行 + @ 开头"，正文里提到的 @ 不算', hs.length === 3, `解析出 ${hs.length} 条`)
  check('  `@Python：` 取兜底日期（该档案的更新于）', hs[0]?.target === 'Python' && hs[0]?.date === '2026-09-28', JSON.stringify(hs[0] ?? null))
  check('  `@Python 09-27` 用行内日期（更精确）', hs[1]?.target === 'Python' && hs[1]?.date === '2026-09-27', JSON.stringify(hs[1] ?? null))
  check('  能同时标给不同科目', hs[2]?.target === 'C')
  check('  空文本 / 无标记 → 空数组', plan.parseHandoffs('', {}).length === 0 && plan.parseHandoffs('# 学习档案\n- 普通一条\n', {}).length === 0)

  console.log('  ② 从兄弟档案收集 + 注入')
  {
    const fix2 = mkdtempSync(join(tmpdir(), 'handoff-'))
    // 科目名照实：收件方是 **Python**，标记也写 @Python（第一版夹具里两头对不上，白白红了一轮）
    mkdirSync(join(fix2, 'Python'), { recursive: true })
    mkdirSync(join(fix2, '网安'), { recursive: true })
    writeFileSync(join(fix2, 'Python', '学习档案.md'), body('2026-09-22', ['- 09-22 while 循环']))
    writeFileSync(join(fix2, '网安', '学习档案.md'), TAGS)

    const got = core.collectHandoffs(join(fix2, 'Python'), '2026-09-22')
    check('收集到标给本科的 2 条（`@C` 那条不算）', got.length === 2, JSON.stringify(got.map((h) => `${h.target}/${h.date}`)))
    check('  来源科目写对了', got.every((h) => h.source === '网安'))
    check('  本科档案更新之后就不再收集（自清除）', core.collectHandoffs(join(fix2, 'Python'), '2026-09-30').length === 0)
    check('  自己的档案不会给自己打移交（网安会话收不到自己标的）', core.collectHandoffs(join(fix2, '网安'), '2026-09-22').filter((h) => h.target === '网安').length === 0)

    // ★ 实测回填：网安会话把标记写在了**提纲**里（"标在要移交的那样东西上"），而第一版只扫档案。
    //   现在两个文件都扫——"现实写法 ≠ 我的假设"这个教训今天出现两次，一次覆盖掉。
    writeFileSync(join(fix2, '网安', OUTLINE), '- 09-28 `@Python` 表达式三件套：% 取余\n')
    const fromOutline = core.collectHandoffs(join(fix2, 'Python'), '2026-09-22')
    check('  也扫兄弟的**提纲**（`- 09-28 \\`@Python\\` …` 这种写法）', fromOutline.length === 3, `收到 ${fromOutline.length} 条`)
    check('    并标明是在哪个文件里找到的', fromOutline.some((h) => h.foundIn === OUTLINE))
    writeFileSync(join(fix2, '网安', '学习档案.md'), `${TAGS}\n- 09-28 \`@Python\` 表达式三件套：% 取余\n`)
    const dedup = core.collectHandoffs(join(fix2, 'Python'), '2026-09-22')
    check('    同一行在两个文件里都有 → 只算一次', dedup.filter((h) => h.line.includes('表达式三件套')).length === 1, JSON.stringify(dedup.map((h) => h.line.slice(0, 26))))
    writeFileSync(join(fix2, '网安', '学习档案.md'), TAGS)
    rmSync(join(fix2, '网安', OUTLINE), { force: true })

    const handlers2 = new Map()
    core.apply({ on: (n, fn) => { handlers2.set(n, fn); return () => {} }, get: (n) => (n === 'tools' ? { guard: () => () => {} } : undefined) }, {})
    const preStep2 = handlers2.get('agent/pre-step')
    const agent2 = { id: 'agent-handoff', session: { header: { cwd: join(fix2, 'Python') } } }
    const decision2 = { kind: 'continue', messages: [] }
    const run2 = async () => {
      const out = await preStep2({ agent: agent2, step: 1, signal: { aborted: false } }, async () => decision2)
      const msg = out.messages.find((m) => m.source?.plugin === 'companion-core')
      return msg === undefined ? undefined : msg.content[0].text
    }
    const withHandoff = await run2()
    check('  英语会话的注入里出现【跨科移交】', withHandoff?.includes('【跨科移交·别科指出】') === true, withHandoff === undefined ? '(未注入)' : withHandoff.slice(-240))
    check('    点出了来源科目与条数', withHandoff?.includes('网安') === true && withHandoff?.includes('2 条'))
    check('    带上了原文（学员不用去别处找）', withHandoff?.includes('变量名不能含短横线') === true)
    check('    明确要求"用当时的情境讲、别从头讲"', withHandoff?.includes('别当新知识从头讲') === true)
    check('    要求收进提纲并注明出处（出处戳同时是"已收下"的凭据）', withHandoff?.includes('源:') === true)
    check('  同内容第二次不重复注入', (await run2()) === undefined)

    // ★★ 修掉的静默丢失路径（2026-09-28）：旧判据是"日期晚于本科档案的更新于"，
    //    于是"顺手更新了档案、却没真把移交收进提纲"会让提醒**永久消失**，东西也丢了。
    //    现在判据是"**提纲里有没有这一条**" —— 没收下就一直提醒。
    writeFileSync(join(fix2, 'Python', '学习档案.md'), body('2026-09-29', ['- 09-29 顺手更新了一下档案']))
    const notYet = await run2()
    check('⚠️ 更新过档案但**没吸收** → 仍然提醒（旧判据在这里静默丢东西）', notYet?.includes('【跨科移交') === true, notYet === undefined ? '(未注入=丢了)' : notYet.slice(-200))
    check('   并且明说"你更新过档案、但还没收进提纲"', notYet?.includes('但还没收进提纲') === true)
    check('   同时给了"这条戳就是已收下的凭据"', notYet?.includes('凭据') === true)

    // 真收进提纲 → 提醒消失（凭据是提纲里出现同一来源与日期）
    writeFileSync(join(fix2, 'Python', '复习提纲.md'), '# 复习提纲\n\n- 09-28 变量名不能含短横线（源:网安 2026-09-28）\n- 09-27 print 加引号（源:网安 2026-09-27）\n')
    const absorbed = await run2()
    check('  两条都收进提纲 → 提醒才消失', absorbed !== undefined && !absorbed.includes('【跨科移交'), absorbed === undefined ? '(未注入)' : absorbed.slice(-160))
    // 只收一条 → 还剩一条（不能"收一条就全清"）
    writeFileSync(join(fix2, 'Python', '复习提纲.md'), '# 复习提纲\n\n- 09-28 变量名不能含短横线（源:网安 2026-09-28）\n')
    const half = await run2()
    check('  只收一条 → 另一条还在提醒（不会"收一条清全部"）', half?.includes('【跨科移交') === true && half?.includes('1 条') === true, half === undefined ? '(未注入)' : half.slice(-200))
    rmSync(fix2, { recursive: true, force: true })
  }
}

console.log('\n⑦ 六个预设的 persona 都写明了归属规则')
{
  // 按**角色**分别断言：伴学科目要执行"写进别科提纲"，总规划要执行"不当中转"。
  // 第一版拿同一句话去卡五个预设，总规划因为措辞不同（"属于那一科"而不是"所属科目"）误报——
  // 断言要卡住**概念**，不要卡住某一种措辞，否则它测的是文笔而不是规则。
  // ★ 这里**只列科目**：mind-companion 的账本是它自己的笔记、没有提纲，硬套这条是假红，
  //   它的断言在下面单独一组（角色不同，判据就该不同）。
  for (const id of ['netsec-tutor', 'math-tutor', 'english-tutor', 'code-tutor']) {
    const text = personaPrefixOf(declById(id)) ?? ''
    // 卡**概念**不卡措辞：「所属科目」/「所属的科目」/「属于那一科」都算（已经因为卡措辞误报两次）
    check(`${id}：写明知识点进「所属科目」的 ${OUTLINE}`, text.includes(OUTLINE) && /所属的?科目|属于那一科/.test(text), text.length === 0 ? '（读不到 persona）' : '（有提纲字样但没写归属）')
    // 主路：在**自己的**档案里打 `@科目` 标记（只需碰自己的文件），代码会送到位
    check(`${id}：写明"拿不准/懒得跨文件时就打 @科目 标记"这条主路`, /@\s*<科目>|@Python|@C\b|以 @/.test(text), text.slice(0, 0))
    check(`${id}：写明别科追加的条目会出现在注入里`, text.includes('【跨科知识点') || text.includes('【跨科移交'))
    check(`${id}：给了"拿不准归属就别猜"的兜底`, /拿不准归属|疑似归/.test(text))
  }
  {
    const text = personaPrefixOf(declById('study-planner')) ?? ''
    check('study-planner：写明跨科知识点不经过它（不需要当中转）', /不需要当中转|不要替它们转抄/.test(text))
    check('  且说明了发现方怎么移交（@标记 或 直接追加）', /@<目标科目>|@<科目>/.test(text) && text.includes(OUTLINE))
    check('  且说明了目标科目会从注入里直接看到', /从注入里直接看到|下一轮就会/.test(text))
    // 第二道网：总规划是**唯一每个会话都读全部档案**的角色，所以它是最自然的**兜底**
    // ——发现方忘了打标记时，还有一次机会被看见（而不是静默丢掉）。
    check('  且承担兜底：读档案时留意"明显属于别科"的东西并在下发里点一句', /兜底|顺手留意|明显属于别科|没打标记/.test(text))
  }
  // ★ 陪伴预设（mind-companion）走**同一套机制**，但账本不是 `复习提纲.md` 而是它自己的
  //   `心灵笔记.md`——所以**不能**把它塞进上面那个循环（那条会卡 OUTLINE 字样，是假红）。
  //   这里按它的真实角色断言：标记要打、收到的要看、拿不准别猜；账本换成它自己的名字。
  {
    const text = personaPrefixOf(declById('mind-companion')) ?? ''
    check('mind-companion：写明"给某一科"要在自己的笔记里打 @科目 标记', /@数学|@\s*<科目>|@科目/.test(text), text.length === 0 ? '（读不到 persona）' : '（没有 @ 标记这条主路）')
    check('  且写明收下别科来信及出处（不变成教学）', text.includes('收下别科来信') && text.includes('行尾来源戳'))
    check('  且给了"拿不准归属就别猜"的兜底', /拿不准归属|疑似归/.test(text))
    // 账本名必须是它自己的：写死 复习提纲.md 的话，陪伴会被告知"收进"一个它没有也不该有的文件。
    // ⚠️ 判据不能写成 `!text.includes(OUTLINE)`——persona 里**确实**提到了 `复习提纲.md`，
    //    但那句是"别去改别科的文件：… / 复习提纲.md / … 都不是你的"（**禁止**列表），
    //    是正确内容。要卡的是"让它**写进**提纲"这个动作，不是文件名的出现。
    check(
      `  且账本是它自己的 ${core.COMPANION_NOTE_NAME}（不是让它写进 ${OUTLINE}）`,
      text.includes(core.COMPANION_NOTE_NAME) && !/收进\s*复习提纲|写进\s*复习提纲|补进\s*复习提纲/.test(text),
      text.includes(core.COMPANION_NOTE_NAME) ? '（提到了"收进 复习提纲"，那是学科的账本）' : '（没提自己的笔记名）',
    )
    check('  隐私边界准确：规划单节渲染、学科定向、非文件ACL', text.includes(core.COMPANION_SECTION_PLAN) && text.includes('自动看板只渲染') && text.includes('不是文件访问隔离'))
  }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)