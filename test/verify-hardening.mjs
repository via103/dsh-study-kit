// verify-hardening.mjs — 约束加固（①判定层区分用法错误 ②flag 自证检测 ③档案陈旧提醒）的回归测试
// 用法：node verify-hardening.mjs
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const PLUGINS = '<study-plugins>/'
const netsec = await import(pathToFileURL(PLUGINS + 'netsec-range.js').href)
const judge = await import(pathToFileURL(PLUGINS + 'study-judge.js').href)
const core = await import(pathToFileURL(PLUGINS + 'companion-core.js').href)

let pass = 0
let fail = 0
function check(label, cond, extra) {
  if (cond) { pass += 1; console.log('  ✅', label) }
  else { fail += 1; console.log('  ❌', label, extra === undefined ? '' : `→ ${extra}`) }
}
const renderText = (def, value) => def.output.render(undefined, value).map((b) => b.text).join('\n')

// ── ① netsec-range ───────────────────────────────────────────────────────────
console.log('\n① netsec-range：用法错误不再伪装成关卡/判定结果')
{
  const registered = new Map()
  const ctx = {
    get: (n) => (n === 'tools' ? { register: (d) => { registered.set(d.name, d) } }
      : n === 'webServer' ? { register: () => () => {} } : undefined),
  }
  netsec.apply(ctx, {})
  const start = registered.get('range_start')
  const submit = registered.get('range_submit')
  check('两个工具都已注册', start !== undefined && submit !== undefined)

  const okStart = await start.execute({ level: 'sqli' })
  check('range_start(level=sqli) 正常开局', okStart.ok === true && okStart.url.endsWith('/study-range/sqli'), JSON.stringify(okStart))
  check('  渲染含入口与任务', renderText(start, okStart).includes('入口：') && renderText(start, okStart).includes('任务：'))

  const emptyStart = await start.execute({})
  check('range_start(空参数) → ok:false', emptyStart.ok === false, JSON.stringify(emptyStart))
  check('  说明点名 level 缺失', /level 参数缺失/.test(emptyStart.detail), emptyStart.detail)
  const emptyStartText = renderText(start, emptyStart)
  check('  渲染为「无法开局」而非正常菜单', emptyStartText.includes('无法开局') && !emptyStartText.includes('任务：'), emptyStartText)

  const badStart = await start.execute({ level: 'foo' })
  check('range_start(未知关卡) → ok:false + 未知关卡', badStart.ok === false && /未知关卡/.test(badStart.detail))

  const okSubmit = await submit.execute({ level: 'sqli', flag: 'flag{sqli_login_bypass_ok}' })
  check('range_submit(正确 flag) → ok:true pass:true', okSubmit.ok === true && okSubmit.pass === true, JSON.stringify(okSubmit))
  check('  渲染含关卡名', renderText(submit, okSubmit).includes('sqli 关通过'))

  const wrongSubmit = await submit.execute({ level: 'sqli', flag: 'flag{nope}' })
  check('range_submit(错误 flag) → ok:true pass:false（真判定）', wrongSubmit.ok === true && wrongSubmit.pass === false)
  check('  渲染「flag 不对」并标出比对关卡', renderText(submit, wrongSubmit).includes('flag 不对') && renderText(submit, wrongSubmit).includes('sqli 关'))

  const emptySubmit = await submit.execute({})
  check('range_submit(空参数) → ok:false', emptySubmit.ok === false)
  const emptySubmitText = renderText(submit, emptySubmit)
  check('  渲染「无法判定」且不含「flag 不对」', emptySubmitText.includes('无法判定') && !emptySubmitText.includes('flag 不对'), emptySubmitText)

  const noFlagSubmit = await submit.execute({ level: 'sqli' })
  check('range_submit(缺 flag) → ok:false + 说明 flag 缺失', noFlagSubmit.ok === false && /flag 参数缺失/.test(noFlagSubmit.detail))

  const xssSubmit = await submit.execute({ level: 'xss', flag: 'flag{xss_reflected_ok}' })
  check('range_submit(xss 正确 flag) → pass:true', xssSubmit.ok === true && xssSubmit.pass === true)

  // 关卡本体回归：注入 payload 仍能拿到 flag
  const res = { body: '', writeHead() {}, end(b) { this.body = b } }
  netsec.handleXss(new URL('http://127.0.0.1/study-range/xss?q=<img src=x onerror=alert(1)>'), res)
  check('xss 关卡本体仍吐 flag', res.body.includes('flag{xss_reflected_ok}'))
}

// ── ② study-judge ────────────────────────────────────────────────────────────
console.log('\n② study-judge：flag 自证可见 + 原有判定不回退')
{
  const defs = new Map()
  const runtime = { run: async () => ({ logs: ['JUDGE:[{"got":4,"expect":4,"pass":true}]'] }) }
  const ctx = {
    get: (n) => (n === 'tools' ? { register: (d) => { defs.set(d.name, d) } } : n === 'codeRuntime' ? runtime : undefined),
  }
  judge.apply(ctx)
  const sj = defs.get('study_judge')
  check('study_judge 已注册', sj !== undefined)

  const selfKeyed = await sj.execute({ kind: 'flag', answer: 'flag{sql_numeric_ok}', key: 'flag{sql_numeric_ok}' })
  check('flag：key 与作答相同 → selfKeyed:true（判定结果不变，仍 pass）', selfKeyed.pass === true && selfKeyed.selfKeyed === true, JSON.stringify(selfKeyed))
  check('  渲染追加「未独立校验」', renderText(sj, selfKeyed).includes('未独立校验'))

  const independent = await sj.execute({ kind: 'flag', answer: 'flag{a}', key: 'flag{b}' })
  check('flag：独立 key → pass:false 且无 selfKeyed', independent.pass === false && independent.selfKeyed === undefined)
  check('  渲染不含「未独立校验」', !renderText(sj, independent).includes('未独立校验'))

  const emptyKey = await sj.execute({ kind: 'flag', answer: 'flag{a}', key: '' })
  check('flag：空 key → usageError:true（不再谎报「未通过」）', emptyKey.usageError === true && emptyKey.pass === false, JSON.stringify(emptyKey))
  check('  渲染「无法判定」', renderText(sj, emptyKey).includes('无法判定'))

  const choiceWrong = await sj.execute({ kind: 'choice', answer: 'a', key: 'B' })
  check('choice 错答（回归）', choiceWrong.pass === false)
  const choiceRight = await sj.execute({ kind: 'choice', answer: 'C', key: 'C' })
  check('choice 答对（回归）+ 不打 selfKeyed 噪音', choiceRight.pass === true && choiceRight.selfKeyed === undefined)
  const clozeList = await sj.execute({ kind: 'cloze', answer: '预编译语句', key: '["参数化查询","预编译语句"]' })
  check('cloze 等价答案表（回归）', clozeList.pass === true)
  const regex = await sj.execute({ kind: 'cloze', answer: 'x', key: '/^x$/' })
  check('cloze 正则 key（回归）', regex.pass === true)
  const numericWrong = await sj.execute({ kind: 'numeric', answer: '1', key: '37' })
  check('numeric 错答（回归）', numericWrong.pass === false)
  const numericExpr = await sj.execute({ kind: 'numeric', answer: '0.333', key: '1/3' })
  check('numeric 表达式 + 默认容差（回归）', numericExpr.pass === true)
  const code = await sj.execute({ kind: 'code', answer: 'function solve(i){return i}', key: '{"cases":[{"input":4,"expect":4}]}' })
  check('code 沙箱判定（回归）', code.pass === true, JSON.stringify(code))
}

// ── ③ companion-core ─────────────────────────────────────────────────────────
console.log('\n③ companion-core：档案陈旧提醒 + 写入守护不回退')
{
  const dir = './创建预设/.tmp-hardening'
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const archive = join(dir, '学习档案.md')
  const body = (stamp) => `# 学习档案\n\n更新于: ${stamp}\n\n## 学校当前进度\n- x\n\n## 已答主题与卡点\n- y\n\n## 未消化薄弱点\n- z\n`

  const handlers = new Map()
  const guards = []
  const ctx = {
    on: (n, fn) => { handlers.set(n, fn); return () => {} },
    get: (n) => (n === 'tools' ? { guard: (g) => { guards.push(g); return () => {} } } : undefined),
  }
  core.apply(ctx, {})
  const preStep = handlers.get('agent/pre-step')
  check('agent/pre-step 已挂载', typeof preStep === 'function')

  const daysAgo = (n) => {
    const d = new Date()
    d.setDate(d.getDate() - n)
    return core.studyDate(d)
  }
  const agent = { id: 'agent-hardening', session: { header: { cwd: dir } } }
  const decision = { kind: 'continue', messages: [] }
  const run = async (step = 1) => {
    const out = await preStep({ agent, step, signal: { aborted: false } }, async () => decision)
    const msg = out.messages.find((m) => m.source?.plugin === 'companion-core')
    return msg === undefined ? undefined : msg.content[0].text
  }

  writeFileSync(archive, body(daysAgo(4)), 'utf8')
  const staleText = await run()
  check('陈旧档案：注入含「档案已 4 天未更新」', staleText !== undefined && staleText.includes('档案已 4 天未更新'), staleText === undefined ? '(未注入)' : staleText.slice(0, 160))
  check('  仍含系统当前日期基准', staleText.includes(`系统当前日期：${core.studyDate()}`))
  check('  仍含档案正文', staleText.includes('## 未消化薄弱点'))

  const second = await run()
  check('同内容第二次不重复注入', second === undefined)

  writeFileSync(archive, body(core.studyDate()), 'utf8')
  const freshText = await run()
  check('档案已更新：注入但不含陈旧提醒', freshText !== undefined && !freshText.includes('天未更新'))
  check('档案内容变化 → 重新注入', freshText.includes(core.studyDate()))

  const step2 = await run(2)
  check('step=2 不注入', step2 === undefined)

  // ── 档案卫生提醒（2026-10-06「网安档案总是满」）─────────────────────────────
  // 动机：persona 里那两条「流水只留最近 5 个学习日」「每条一句话」**只有 persona 在说、
  // 没有代码在查**，于是模型只在写入被拒之后才压缩 → 档案长期贴着 99% 跑（实测网安 6113/6144，
  // 31 行却平均 197 字节/行）。这里断言"数字真的被算出来并注入给模型了"。
  const hygieneBody = (flow) => `# 学习档案\n\n更新于: ${core.studyDate()}\n\n## 学校当前进度\n- x\n\n## 已答主题与卡点\n${flow}\n\n## 未消化薄弱点\n- z\n`
  const one = (d, n = 1) => `- ${d} ${'字'.repeat(n)}\n`

  // 超窗（6 个学习日）→ 必须提醒，且说清超了几个、上限是几个
  writeFileSync(archive, hygieneBody(one('10-01') + one('10-02') + one('10-03') + one('10-04') + one('10-05') + one('10-06')), 'utf8')
  const overText = await run()
  check('超窗：注入含档案卫生提醒', overText !== undefined && overText.includes('【档案卫生·自动提醒】'), overText === undefined ? '(未注入)' : '(不含提醒)')
  check('  说清了覆盖几天与上限', overText.includes('流水覆盖 **6 个学习日**') && overText.includes('只留最近 5 个'), overText.match(/流水覆盖[^；]*/)?.[0])
  check('  给了"先收拢再写"而不是"等被拒"', overText.includes('在写入新条目之前，先做一次收拢'))
  // "详情搬去哪"这条建议**只属于超长那条**（超窗的修法是合并旧日期，不是外搬）→ 断言要挂在超长夹具上。
  // 第一版把它挂在只超窗的 overText 上 → 按实际项数渲染后当场变红，是断言挂错了地方。
  // ★ 项数要按**实际**说：只超一条时不许写成"两处"。
  //   旧版把"这里有两处已经超了"写死 → C 科（只超长度）与英语（只超长度）读起来像超了两条，
  //   而且还会把"合并旧日期"这条**用不上的**修法一起塞给模型。
  //   overText 这个夹具全是短行 → 只超窗，所以这里应当说"有一处"。
  check('  只超窗 → 说"有一处"，不写死"两处"', overText.includes('有一处已经超了') && !overText.includes('两处'), overText.match(/这里[^：]*：/)?.[0])

  // 两处都超（6 天 + 一条 300 字节）→ 说"有 2 处"，且两条修法都给
  writeFileSync(archive, hygieneBody(one('10-01') + one('10-02') + one('10-03') + one('10-04') + one('10-05') + one('10-06') + `- 10-07 ${'z'.repeat(300)}` + '\n'), 'utf8')
  const bothText = await run()
  check('两处都超 → 说"有 2 处"', bothText.includes('有 2 处已经超了'), bothText.match(/这里[^：]*：/)?.[0])
  check('  两条修法都给', bothText.includes('合并成一句状态') && bothText.includes('一句话 + 详情指针'))

  // 只超长度（没超窗）→ 绝不能说"两处"，也**不许**让模型去做合并旧日期这件没必要的事
  // 注意：夹具必须与上面各条**互不相同** —— 注入是按内容做键去重的，同样的内容第二次不会重注入（返回 undefined）。
  writeFileSync(archive, hygieneBody(one('10-01') + `- 10-02 ${'y'.repeat(300)}` + '\n'), 'utf8')
  const onlyMega = await run()
  check('只超长度 → 说"有一处"而不是"两处"', onlyMega.includes('有一处已经超了'), onlyMega.match(/这里[^：]*：/)?.[0])
  check('  不写死项数（不出现"两处"）', !onlyMega.includes('两处'))
  check('  只给长度那条修法，不给多余的合并指令', onlyMega.includes('一句话 + 详情指针') && !onlyMega.includes('合并成一句状态'))
  check('  指明了详情该搬去哪儿（不进注入的文件）', onlyMega.includes('题目记录.md') && onlyMega.includes('不进注入'))

  // 只超窗（每条都短）→ 只说覆盖天数，且不给"拆长条"的指令
  writeFileSync(archive, hygieneBody('- 10-01 甲\n- 10-02 乙\n- 10-03 丙\n- 10-04 丁\n- 10-05 戊\n- 10-06 己\n'), 'utf8')
  const onlyWindow = await run()
  check('只超窗 → 说"有一处"', onlyWindow.includes('有一处已经超了'), onlyWindow.match(/这里[^：]*：/)?.[0])
  check('  只给窗口那条修法，不给多余的拆条指令', onlyWindow.includes('合并成一句状态') && !onlyWindow.includes('一句话 + 详情指针'))

  // 超长条（一句话规定）→ 提醒里要报出最长多少字节
  // 用 ASCII 让字节数＝字符数，好在断言里写死数字（汉字 1 个 = 3 字节，第一版就是在这里算错的）
  const longLine = `- 10-02 ${'x'.repeat(300)}`   // 8 + 300 = 308 字节
  writeFileSync(archive, hygieneBody(one('10-01') + longLine + '\n'), 'utf8')
  const megaText = await run()
  check('超长条：报出条数与最长字节', megaText.includes('超过 200 字节') && megaText.includes('最长 308 字节'), megaText.match(/有 \*\*\d+ 条\*\*[^；]*/)?.[0])

  // 干净档案 → **零噪音**（不能每轮都唠叨，否则模型会学会忽略它）
  writeFileSync(archive, hygieneBody(one('10-01') + one('10-02') + one('10-03') + one('10-04') + one('10-05')), 'utf8')
  const cleanText = await run()
  check('干净档案：不出现档案卫生提醒（零噪音）', cleanText !== undefined && !cleanText.includes('【档案卫生'), cleanText === undefined ? '(未注入)' : '(仍注入)')
  check('  干净时仍照常注入档案本身', cleanText.includes('## 未消化薄弱点'))

  // 卫生提醒必须以**档案内容**为准，且内容变干净后要重注入（否则模型永远停在旧提醒上）
  writeFileSync(archive, hygieneBody(one('10-01') + one('10-02') + one('10-03') + one('10-04') + one('10-05') + one('10-06')), 'utf8')
  const backOver = await run()
  check('由干净变超窗 → 重新注入并再次提醒', backOver !== undefined && backOver.includes('【档案卫生·自动提醒】'))

  // 薄弱点那一节**不受**窗口限制（那里是要长期保留的病灶，不能被当成流水清掉）
  writeFileSync(archive, `# 学习档案\n\n更新于: ${core.studyDate()}\n\n## 已答主题与卡点\n- 10-05 一句话\n\n## 未消化薄弱点\n${one('09-01') + one('09-02') + one('09-03') + one('09-04') + one('09-05') + one('09-06')}`, 'utf8')
  const weakText = await run()
  check('薄弱点那节不算流水（不误报超窗）', weakText !== undefined && !weakText.includes('【档案卫生'), weakText === undefined ? '(未注入)' : '(误报)')

  // staleNotice 纯函数边界
  check('staleNotice: 差 1 天不提醒', core.staleNotice(body('2026-09-08'), '2026-09-09') === '')
  check('staleNotice: 差 2 天提醒', core.staleNotice(body('2026-09-07'), '2026-09-09').includes('2 天未更新'))
  check('staleNotice: 无日期戳不提醒', core.staleNotice('# 学习档案\n\n## 学校当前进度', '2026-09-09') === '')
  check('staleNotice: 未来日期不提醒', core.staleNotice(body('2026-09-20'), '2026-09-09') === '')

  // 写入守护回归
  const guard = guards[0]
  check('写入守护已注册', typeof guard === 'function')
  const badStamp = guard({ name: 'write', arguments: { file_path: archive, content: body('2026-07-27') } })
  check('守护：日期戳错乱仍被拒', typeof badStamp === 'string' && badStamp.includes('2026-07-27'), String(badStamp))
  const missingField = guard({ name: 'write', arguments: { file_path: archive, content: `更新于: ${core.studyDate()}\n没有三字段` } })
  check('守护：缺三字段仍被拒', typeof missingField === 'string' && missingField.includes('进度'), String(missingField))
  // 档案默认字节上限 2026-09-13 从 4096 放宽到 6144（真实网安档案到过 4025/4195），夹具随之加大
  const tooBig = guard({ name: 'write', arguments: { file_path: archive, content: body(core.studyDate()) + 'x'.repeat(9000) } })
  check('守护：超字节上限仍被拒', typeof tooBig === 'string' && tooBig.includes('字节上限'), String(tooBig))
  const good = guard({ name: 'write', arguments: { file_path: archive, content: body(core.studyDate()) } })
  check('守护：合法内容放行', good === undefined, String(good))
  const unrelated = guard({ name: 'write', arguments: { file_path: join(dir, '别的.md'), content: '随便' } })
  check('守护：非档案文件不拦', unrelated === undefined)

  // ── 复习清单已合并进复习提纲（2026-09-17） ──────────────────────────────────
  // 第三个协议文件删掉后，它的导出必须真的消失——留着就是"文档说删了、代码还在"。
  check(
    '旧的复习清单三件套已从 companion-core 移除',
    core.parseReviewList === undefined &&
      core.validateReviewList === undefined &&
      core.MAX_REVIEW_ITEMS === undefined &&
      core.REVIEW_NAME === undefined,
  )

  rmSync(dir, { recursive: true, force: true })
}

// ── 启动痕迹：不许把"还活着的别的进程"的痕迹擦掉 ──────────────────────────
// 2026-09-18 实测：跑一次六个套件，doctor 的层 4 全变成"已退出的进程"——因为测试用假 ctx
// 调了 apply()，把宿主进程刚写下的真实痕迹覆盖掉了。诊断数据被诊断动作本身污染，最讽刺的那种。
console.log('\n⑥ writeHealth：诊断痕迹不许被测试/探针覆盖成假数据')
{
  const { writeHealth } = await import(pathToFileURL(PLUGINS + 'plan-core.js').href)
  const HF = `${PLUGINS}.health/__probe__.json`
  const base = { plugin: '__probe__', startedAt: 'x', toolsAvailable: true, guardRegistered: true, calls: 0 }
  rmSync(HF, { force: true })

  writeHealth('__probe__', { ...base, pid: process.ppid }) // 父进程：测试期间一定活着
  check('先写一条（pid = 父进程，一定活着）', JSON.parse(readFileSync(HF, 'utf8')).pid === process.ppid)

  writeHealth('__probe__', { ...base, pid: 999999, toolsAvailable: false })
  const kept = JSON.parse(readFileSync(HF, 'utf8'))
  check('  另一个活着的进程的痕迹**不被覆盖**', kept.pid === process.ppid && kept.toolsAvailable === true, JSON.stringify(kept))

  // 造一个"死进程留下的"痕迹（直接写盘，不走 writeHealth），再让 writeHealth 覆盖它——重启场景。
  // ⚠️ 这里第一版写错了：我以为上一步已经把 999999 写进去了，其实**被正确地跳过了**，
  //    所以文件里还是 ppid，第三步自然覆盖不动。**是断言写错，不是产品错**（第 6 次了）。
  writeFileSync(HF, JSON.stringify({ ...base, pid: 999999 }))
  writeHealth('__probe__', { ...base, pid: process.pid })
  check('  死进程留下的痕迹**可以**被覆盖（否则重启后再也刷不新）', JSON.parse(readFileSync(HF, 'utf8')).pid === process.pid)

  rmSync(HF, { force: true })
}

console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
