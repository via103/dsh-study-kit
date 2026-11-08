// code-tutor 预设的结构性验证：证明它相对 shipped `standard` **只**改了该改的，
// 并让两个新科目档案真的过一遍守护与规划器的解析（不重复实现规则，直接用插件本身）。
//
// ═══ 2026-09-22 改读来源（0.1.7）═══════════════════════════════════════════════
// 以前这里读两个文件：shipped 的 `dsh-agent-presets/presets/standard/agent.cordis.yml`
// 和我们的 `.agent-presets/code-tutor/agent.cordis.yml`。0.1.7 把两者都换成了
// `@deepseek-ai/dsh-agent-preset` 的**行内声明**，旧路径已不存在（shipped 那个直接 ENOENT
// 把这个脚本打崩了）。现在统一从 `tools/presets.mjs` 取——**一处知道声明住哪里**。
//
// 结构不变量本身没变，依然是"shipped standard + 我们自己的行"：那正是升级时替我们抓到
// 上游漂移（workflow-ptc / tool-ralph）的那张网，0.1.7 这次又靠它确认了行数没漂。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { declById, findPluginRow, personaPrefixOf, resolveRowName } from '../tools/presets.mjs'

const PLUGINS = 'C:/Users/Administrator/.dsh/study-plugins/'
const ST = 'D:/Administrator/Documents/DSH/ST'

const companion = await import(pathToFileURL(PLUGINS + 'companion-core.js').href)
const plan = await import(pathToFileURL(PLUGINS + 'plan-core.js').href)

let pass = 0
let fail = 0
function check(label, cond, extra) {
  if (cond) { pass += 1; console.log('  ✅', label) }
  else { fail += 1; console.log('  ❌', label, extra === undefined ? '' : `→ ${extra}`) }
}

console.log('\n① 与 shipped standard 的结构差异')
const stdDecl = declById('standard')
const myDecl = declById('code-tutor')
if (stdDecl === undefined || myDecl === undefined) {
  console.log(`  ❌ 读不到声明（standard=${stdDecl !== undefined} code-tutor=${myDecl !== undefined}）—— 后面全跳过`)
  console.log(`\n结果：${pass} 通过 / ${fail + 1} 失败`)
  process.exit(1)
}
// 顶层行（不展开 group）：结构不变量关心的是"清单里多了哪一行"。
const base = stdDecl.plugins
const mine = myDecl.plugins
const idsOf = (rows) => rows.map((r) => r.id)
const baseIds = idsOf(base)
const mineIds = idsOf(mine)
check('两端都能读到行', Array.isArray(base) && Array.isArray(mine) && base.length > 0)
check(`code-tutor 声明于用户层（不是 shipped）`, myDecl.shipped === false, String(myDecl.layer))
check('standard 声明于 shipped 层', stdDecl.shipped === true, String(stdDecl.layer))
// 2026-09-18：学习插件收敛成**一行套件入口**（`study` → study-suite.js，内部挂各部件），
// 所以这里的 N 从 3 变成 1。**不变量本身没变**：依然是"shipped standard + 我们自己的行"，
// 而这正是升级时替我们抓到上游漂移（workflow-ptc / tool-ralph）的那张网。
check('行数 = standard + 1', mine.length === base.length + 1, `${base.length} → ${mine.length}`)
const added = mineIds.filter((id) => !baseIds.includes(id))
const removed = baseIds.filter((id) => !mineIds.includes(id))
check('只新增了 1 行', added.length === 1, JSON.stringify(added))
check('新增的正是套件入口', JSON.stringify(added) === JSON.stringify(['study']), JSON.stringify(added))
check('没有删掉 standard 的任何行', removed.length === 0, JSON.stringify(removed))
check('行序除新增外未变', JSON.stringify(mineIds.filter((id) => baseIds.includes(id))) === JSON.stringify(baseIds))
check('present 仍在（副本未落后于上游）', mineIds.includes('present'))
check('command-goal 仍在', mineIds.includes('command-goal'))
// 逐行按 id 对比（不能整体比较：mine 本来就比 base 多 1 行，长度不同必然不等）
// ★ 2026-11-05（0.2.2）：`tool-plugin-manager` **故意**与上游不同——教学预设里一律
//   `disabled: true`（学员会话不给插件管理工具），而 0.2.2 的 standard 改成了
//   `disabled: "!ctx.get('profileContext')"` 条件式。这是我们的选择，不是漂移，
//   所以只在**这一行**上豁免；其余每一行仍要求逐字等于上游（那张网就是靠它抓到
//   tool-fs / delegation 在 0.2.2 的改名）。
const INTENTIONAL_DIFF = new Set(['persona', 'tool-plugin-manager'])
const shape = (r) => JSON.stringify({ id: r.id, name: r.name, group: r.group, isolate: r.isolate, disabled: r.disabled, config: r.id === 'persona' ? undefined : r.config })
const drifted = baseIds.filter((id) => !INTENTIONAL_DIFF.has(id)).filter((id) => shape(base.find((r) => r.id === id)) !== shape(mine.find((r) => r.id === id)))
check('除 persona 外每一行逐字未改', drifted.length === 0, JSON.stringify(drifted))
for (const g of ['planning', 'compaction', 'delegation']) {
  const row = mine.find((r) => r.id === g)
  check(`${g} 的 isolate realm 仍在`, row !== undefined && row.group === true && Object.keys(row.isolate ?? {}).length > 0)
}

console.log('\n② persona 行（0.1.5 的 prefix 口径）')
const persona = mine.find((r) => r.id === 'persona')
check('persona 存在且是 @deepseek-ai/dsh-persona', persona?.name === '@deepseek-ai/dsh-persona')
check('用 prefix: 而不是已废弃的 text:', typeof persona?.config?.prefix === 'string' && persona?.config?.text === undefined)
check('没有残留 suffix 覆盖（避免与 prefix 双份人格）', persona?.config?.suffix === undefined)
const text = persona?.config?.prefix ?? ''
check('persona 有实质长度（>2500 字符）', text.length > 2500, `${text.length} 字符`)
check('没有重复的 persona 块', mine.filter((r) => r.name === '@deepseek-ai/dsh-persona').length === 1)
// 声明里的 persona 文本必须与"取出 persona 文本"的那个工具读到的一致——两个读法不一致
// 会让下面 ③⑥ 的断言与运行时看到的不是同一份东西。
check('personaPrefixOf 读到的就是这一份', personaPrefixOf(myDecl) === text)

console.log('\n③ persona 必须写明的代码层事实')
for (const [label, needle] of [
  ['code_run 是判定入口', 'code_run'],
  ['study_judge 分工', 'study_judge'],
  ['点明 study_judge kind=code 只跑 JS', '只能跑 JavaScript'],
  ['「未做判定」不等于答错', '未做判定'],
  ['档案行数上限 60', '60 行'],
  ['档案字节上限 6KB', '6KB'],
  ['本周任务只读（只许勾选）', '只许把'],
  ['档案更新使旧任务依据作废', '旧依据就作废'],
  ['C 用共享库宿主执行，如实说明', '共享库'],
  ['不代做作业 / 给最小提示', '不代做作业'],
  ['两个科目目录', 'ST\\C'],
]) {
  check(label, text.includes(needle))
}

console.log('\n④ 套件入口：文件在，且它点名的部件表认得')
{
  const row = findPluginRow(myDecl, 'study')
  // 0.1.7 起行内声明的相对路径基准是**声明它的那一层**（profile 目录），不再是预设目录——
  // 所以这里不能用字面前缀比，要走同一个解析器（规则只有一份）。
  const res = row === undefined ? { ok: false } : resolveRowName(row.name, { baseDir: myDecl.baseDir })
  check('study 行指向存在的套件文件', res.ok === true && res.target === join(PLUGINS, 'study-suite.js').replaceAll('\\', '/') || (res.ok === true && String(res.target).replaceAll('\\', '/').toLowerCase() === (PLUGINS + 'study-suite.js').toLowerCase()), `${row?.name} → ${res.target ?? res.detail}`)
  const parts = row?.config?.parts
  check('  它点名了 parts 且非空', Array.isArray(parts) && parts.length > 0, JSON.stringify(parts))
  // 部件名必须在部件表里认得——**写错的名字会表现成"预设能开、但那个工具就是没有"，最难查**。
  // 这里直接调 apply 拿它的报错，比自己再抄一份部件名单可靠（规则只有一份）。
  const suiteMod = await import(pathToFileURL(PLUGINS + 'study-suite.js').href)
  let err
  try { await suiteMod.apply({ plugin: () => Promise.resolve() }, { parts }) } catch (e) { err = e.message }
  check('  每个部件名都在部件表里', err === undefined, err)
  check('  套件文件自己也导出 apply/name', typeof suiteMod.apply === 'function' && suiteMod.name === 'study-suite')
}

console.log('\n⑤ 科目档案：过一遍真实守护与规划器')
const today = plan.studyDate()
for (const lang of ['C', 'Python']) {
  const file = `${ST}/${lang}/学习档案.md`
  const raw = readFileSync(file, 'utf8')
  // **不要用系统日期当基准**：这两个档案只在学员真的学那一科时才更新，隔一天就必然对不上。
  // 2026-09-17 实测红过一次（Python 停在 09-16）——那不是产品问题，是断言把时间写死了。
  // 这一组要证的是"结构合法、没过页"；"戳够不够新"是运行期规则，另有专门用例覆盖。
  const stamp = /更新于:\s*(\d{4}-\d{2}-\d{2})/.exec(raw)?.[1] ?? ''
  const why = companion.validateArchive(raw, 60, 6144, stamp)
  check(`${lang} 档案通过写入守护（以档案自己的戳为今天）`, why === undefined, why)
  check(`  ${lang} 日期戳合法且不落在未来`, /^\d{4}-\d{2}-\d{2}$/.test(stamp) && stamp <= today, `${stamp} vs today=${today}`)
  // ★ 「余量够不够」是**运行期数据健康**，不是"我们的逻辑对不对"——它归 `study-doctor` 第 5 层
  //   （70% 提醒 / 85% 报警，按字节与行数两条墙）。2026-09-20 这里正好红过一次：两个档案被
  //   伴学会话正常写大到了 4.6KB/4.7KB，金丝雀按设计响了，但 `npm test` 也跟着红了 ——
  //   于是"全绿"不再等于"代码没问题"，这正是断言放错层的代价。留一行informational 输出，
  //   值不值得压缩由 doctor 判。
  const bytes = Buffer.byteLength(raw, 'utf8')
  const lines = raw.split('\n').length
  const pct = Math.max(Math.round((bytes / 6144) * 100), Math.round((lines / 60) * 100))
  console.log(`     ℹ️  ${lang} 档案 ${bytes} B / ${lines} 行（约 ${pct}% 上限）——余量判定归 study-doctor 第 5 层`)
}
const subjects = plan.survey(ST, today).map((s) => s.name)
check('规划器自动发现了 C 与 Python', subjects.includes('C') && subjects.includes('Python'), JSON.stringify(subjects))
check('原有科目仍在（英语/网安）', subjects.includes('英语') && subjects.includes('网安'), JSON.stringify(subjects))

// ★ 这条以前直接断言「现场那个 C 目录里没有本周任务.md」——而总规划预设**有权**下发任务，
//   它一下发，回归就红（2026-09-20 就发生了）。要证的不变量是"没任务时不误报漂移"，
//   那用一个**自己造的科目目录**就能证，而且永远不随现场数据翻脸。
{
  const fixture = mkdtempSync(join(tmpdir(), 'dsh-no-task-'))
  const subject = join(fixture, '某科')
  mkdirSync(subject, { recursive: true })
  writeFileSync(join(subject, '学习档案.md'), `# 学习档案\n\n更新于: ${today}\n\n## 学校当前进度\n第 1 章。\n\n## 已答主题与卡点\n- 无。\n\n## 未消化薄弱点\n- 无。\n`, 'utf8')
  const state = plan.survey(fixture, today).find((s) => s.name === '某科')
  check('无本周任务的科目：task.exists 为 false（不误报任务漂移）', state?.task?.exists === false, JSON.stringify(state?.task))
  check('  且该科目仍被规划器发现（没任务 ≠ 不存在）', state !== undefined, JSON.stringify(plan.survey(fixture, today).map((s) => s.name)))
  rmSync(fixture, { recursive: true, force: true })
}

console.log('\n⑥ 复习提纲：四个伴学预设的 persona 必须说的是同一件事')
// 2026-09-17 合并：`复习清单.md`（每科的第三个协议文件）已删掉，知识点只存在 `复习提纲.md`
// 一处。提纲不进守护、不进注入、不参与计划，所以这里断言的不是"与某个常量同源"，
// 而是**四份 persona 对同一件事说了同一句话**——它们各自独立演进，最容易在这里漂移。
{
  const tutors = ['netsec-tutor', 'math-tutor', 'english-tutor', 'code-tutor']
  // ★ 这里断言的是**模型真正收到的那段 persona 文本**，不是预设文件的全文。
  //   以前读文件全文，于是注释里的字样也能让断言变绿——那种绿是假的：模型看不到注释。
  //   0.1.7 改成读声明之后顺手修正了这一点（声明里只有 persona 文本本身）。
  const textOf = (id) => personaPrefixOf(declById(id)) ?? ''
  for (const id of tutors) {
    const raw = textOf(id)
    check(`${id}：读到了非空 persona`, raw.length > 500, `${raw.length} 字符`)
    const has = (s) => raw.includes(s)
    check(`${id}：写明「复习提纲」`, has('复习提纲.md'))
    check(`${id}：不再提「复习清单」（第三个文件已删）`, !has('复习清单'))
    check(`${id}：给出条目格式`, has('｜复 N｜上 MM-DD'))
    check(`${id}：明说「复习完不删、条目保留」`, has('条目保留'))
    check(`${id}：出池只由学员决定`, has('不用再复习了'))
    check(`${id}：有「整理」这个入口`, has('整理一下'))
    check(`${id}：宣告「知识点只在这一处」`, has('知识点只在这一处'))
    // 2026-11-07 学员改口径：不再按「最近 5 个学习日」的时间窗删，改成写不下就通读整个文件、
    // 按信息量取舍（删高频可重建的，留「有用、只说过一次」的）。断言跟着改成钉新口径。
    check(`${id}：写不下时通读整个文件重写（不是从最老的删）`, has('没有固定窗口'))
    check(`${id}：按信息量取舍，保留只说过一次的`, has('只说过一次'))
    check(`${id}：明说知识点不进档案流水`, has('它进提纲'))
    check(`${id}：注入行会显示字节数`, has('当前字节数 / 上限'))
    // 2026-09-28 起这句话本身就变了：提纲**正文**仍不进注入、不参与计划，但"不受守护"不再成立
    // ——别科会话只能追加（守护执行），而且别科追加进来的条目**会**随档案注入提示本科。
    // 断言跟着改成"口径与实现一致"，而不是钉住某一句旧措辞。
    check(`${id}：说明提纲正文不进注入、不参与计划`, has('提纲正文不进注入'))
    check(`${id}：说明它受跨科守护（本科自由、别科只许追加）`, has('本科自己怎么写都行') && has('别科只能追加'))
  }
  check('三个老预设不再写「已消化的薄弱点随手删」（那正是销毁复习材料的那句）', tutors.every((id) => !textOf(id).includes('已消化的薄弱点随手删')))
  check('四个预设都讲了备考/复习模式', tutors.every((id) => textOf(id).includes('复习模式')))
  check('备考支持都写明「范围由他的话决定」', tutors.every((id) => textOf(id).includes('范围由他的话决定')))
  check('code-tutor 仍有「备考支持」（另外三个都有，之前只有它没有）', textOf('code-tutor').includes('备考支持'))
}

console.log('\n⑦ 课堂积累文件必须「够得着」（2026-10-09「规范只写在文件里」）')
// 学员把整套英语方法写进了 `词汇情景本.md`，然后问「只写在文件里面能不能起到良好的规范作用」。
// 实测答案是**不能**：该文件不进注入（设计如此，它会一直长到 60KB），而 english-tutor 的 persona
// 原文提到 `复习提纲.md` 8 次、`词汇情景本` **0 次**，也没有任何"每次会话先读某文件"的硬指令；
// 真实会话统计里 9 个英语会话只有 1 个读过它。→ 缺的不是规则，是**"去读它"这一步**。
// 所以断言钉的是"模型每轮都收得到这个指令"，而不是"文件里写了规则"。
{
  const eng = personaPrefixOf(declById('english-tutor')) ?? ''
  check('english-tutor：persona 提到课堂积累文件', eng.includes('词汇情景本.md'), eng.includes('词汇情景本') ? '(提到但没有 .md 全名)' : '(完全没提)')
  check('english-tutor：有《课堂积累》这一节', eng.includes('# 课堂积累'))
  check('english-tutor：写明它不进注入（所以必须主动读）', eng.includes('不进注入') && eng.includes('你要去读它'))
  check('english-tutor：给出「何时读」的三处时机', eng.includes('每次开工前') && eng.includes('课堂笔记') && eng.includes('改一下方法'))
  // 卡**概念**不卡措辞。这一段的要点是"别每轮把整个文件读一遍"；
  // 而实现方式应当是**引用文件自己写的那条规定**（「平时只读两处：最新一条目 + 最新周汇总」），
  // 不是我另发明一套读法——我发明的读法不如它自己写的准。第一版断言钉的是我的原话
  // 「不必每轮读」，于是把措辞改成"以文件自己的规定为准"时断言就红了：**那是断言在钉我的措辞，不是钉概念。**
  check('english-tutor：区分「规范段」与「积累内容」，避免每轮读整个 21KB', eng.includes('规范段') && eng.includes('积累的内容') && (eng.includes('以文件自己的规定为准') || eng.includes('不必每轮读')))
  check('english-tutor：读法引用文件自己的规定（不是我发明的读法）', eng.includes('平时只读两处') && eng.includes('+15 抽查'))
  check('english-tutor：规范段的分界口径可执行（不是写死行数）', eng.includes('第一个具体的《周汇总') && !/\d+\s*行/.test(eng.slice(eng.indexOf('# 课堂积累'), eng.indexOf('# 回答的默认形态'))))
  check('english-tutor：四条默认设置进了 persona', ['每周产量上限', '复习 = **召回**', '裸说稿必须学员自己写'].every((s) => eng.includes(s)))
  check('english-tutor：摘要与文件冲突时以文件为准（防止摘要变陈旧权威）', eng.includes('以文件为准') && eng.includes('文件是唯一权威'))
  check('english-tutor：改动要留痕的规矩在 persona 里', eng.includes('方法变更'))

  // ★ 反向断言：这一节只该落在英语预设，不能污染别的科目。
  //   mind-companion 也在这张反向清单里——它是从 code-tutor 抄的行集，最容易被顺手带脏。
  for (const id of ['netsec-tutor', 'math-tutor', 'code-tutor', 'study-planner', 'fact-verify', 'mind-companion']) {
    const raw = personaPrefixOf(declById(id)) ?? ''
    check(`${id}：没有被英语的课堂积累一节污染`, !raw.includes('词汇情景本') && !raw.includes('# 课堂积累'))
  }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
