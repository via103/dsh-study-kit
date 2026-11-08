// verify-mind-preset.mjs —— 「心灵陪伴」预设：它不是科目，但**必须真的能用**。
//
// 为什么需要它：这个预设的全部安全性都建在**一个文件名**上——它的记忆文件叫
// `心灵笔记.md` 而不是 `学习档案.md`，于是 `discoverSubjects`（认科目的唯一判据就是这个
// 文件名）**天然**看不见它：不进看板、不排 MVE、不被逼下发 `本周任务.md`。
//
// 那个设计的代价是：三条既有通路**同时断掉**，而它们全都是静默的——
//   ① 注入（门槛是"自己的 学习档案.md 正文非空"）
//   ② 去路（`collectHandoffs` 扫兄弟目录，档案缺失就跳过整个目录）
//   ③ 账本（"已收下"的凭据只认 `复习提纲.md`）
// 任何一条没补回来，表现都是"什么都没发生"（0 条移交、看板没变化），
// 而**与"本来就没事"长得一模一样**。所以这一套件钉的不是"它能跑"，
// 而是**每一条通路都有一个同形状的正控制**（有内容时必须出数、还原后必须归零）。
//
// 分四组：
//   ① 不是科目（科目表 / 看板 / 任务 三条都不含它）
//   ② 去路通（它 → 学科）③ 回程通（学科 → 它）④ 看板外流面**只有一节**
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { declById, findPluginRow, personaPrefixOf } from '../tools/presets.mjs'

const PLUGINS = '<study-plugins>/'
const ST = 'ST'

const plan = await import(pathToFileURL(PLUGINS + 'plan-core.js').href)
const core = await import(pathToFileURL(PLUGINS + 'companion-core.js').href)
const guard = await import(pathToFileURL(PLUGINS + 'file-guard.js').href)

let pass = 0
let fail = 0
const check = (label, cond, extra) => {
  if (cond) { pass += 1; console.log('  ✅', label) }
  else { fail += 1; console.log('  ❌', label, extra === undefined ? '' : `→ ${extra}`) }
}
const blocked = (v) => typeof v === 'string' && v.length > 0
const NOTE = plan.COMPANION_NOTE_NAME
const PLAN_SECTION = plan.COMPANION_SECTION_PLAN

// ── 一个自造的"学习根"：一个真科目 + 一个陪伴目录 ─────────────────────────────
// 全部用夹具，**不碰现场数据**（F15：断言绑在现场数据上，学员一学习就红）。
const root = mkdtempSync(join(tmpdir(), 'mind-preset-'))
const today = plan.studyDate()
const 数学 = join(root, '数学')
const 心灵 = join(root, '心灵')
mkdirSync(数学, { recursive: true })
mkdirSync(心灵, { recursive: true })
const SCAFFOLD = `# 心灵笔记\n\n更新于: ${today}\n\n## 最近的状态\n\n（写你最近在想什么、什么在耗神。一两句就够，过去的滚动掉。）\n\n## 要跟学科说的\n\n（哪一科的事就写 \`- @数学：…\`。）\n\n## ${PLAN_SECTION}\n\n（只有这一节会被总规划看到。）\n\n## 收下的移交\n\n（别科标给你的，收下后留一行、行尾注明出处。）\n`
const notePath = join(心灵, NOTE)
writeFileSync(notePath, SCAFFOLD, 'utf8')
writeFileSync(join(数学, '学习档案.md'), `# 学习档案\n\n更新于: ${today}\n\n## 学校当前进度\n第 1 章。\n\n## 已答主题与卡点\n- 无。\n\n## 未消化薄弱点\n- 无。\n`, 'utf8')

console.log('\n① 它不是科目（三条通路都不该有它）')
{
  // ⚠️ `discoverSubjects` 返回的是**对象数组**（`{name, dir, archiveRaw}`），不是字符串数组。
  //    第一版写成 `subjects.includes('心灵')` —— 那对任何输入都是 false，于是
  //    「科目表里没有它」**永远绿**，而它是这套设计最核心的那条不变量（又一次 F28 的假绿形状）。
  //    所以这里先归一成名字，并且**正控制与反控制必须走同一个取数路径**。
  const names = plan.discoverSubjects(root).map((s) => s.name)
  check('  科目表里没有「心灵」', !names.includes('心灵'), JSON.stringify(names))
  check('  科目表里仍有「数学」（正控制：扫描本身没坏）', names.includes('数学'), JSON.stringify(names))
  const states = plan.survey(root, today)
  check('  survey 也不含它', !states.some((s) => s.name === '心灵'), JSON.stringify(states.map((s) => s.name)))

  // ★★ **反向自证**：上面那三条"没有它"如果永远绿，它们就是空断言。
  //    设计说得很清楚——"不是科目"完全由**文件名**决定。所以这里真的往那个目录里
  //    放一个 `学习档案.md`，断言它**立刻变成科目**（看板多出一个 `### 心灵`），
  //    然后删掉、断言又变回去。这一对证明的是：那三条测的是**机制**，不是运气。
  {
    const archiveInMind = join(心灵, '学习档案.md')
    writeFileSync(archiveInMind, `# 学习档案\n\n更新于: ${today}\n\n## 学校当前进度\nx\n\n## 已答主题与卡点\n- 无。\n\n## 未消化薄弱点\n- 无。\n`, 'utf8')
    const poisoned = plan.discoverSubjects(root).map((s) => s.name)
    check('  反向自证：往它目录里放一个 学习档案.md → **立刻变成科目**', poisoned.includes('心灵'), JSON.stringify(poisoned))
    const pStates = plan.survey(root, today)
    const pBoard = plan.buildBoard(root, { today, subjects: pStates, planRaw: undefined })
    // ⚠️ 科目小节的标题是 `■ 心灵`（不是 `### 心灵`——那是**计划文件**里的写法，
    //    看板用的是 `■`）。第一版按 `###` 断言，红了而代码完全正确。
    check('    且看板多出一个 `■ 心灵` 小节', /^■\s*心灵\s*$/m.test(pBoard), pBoard.split('\n').filter((l) => l.startsWith('■')).join(' / '))
    // 更强的一条：它一旦成为科目，就会被**要求下发本周任务**——那正是我们要避免的。
    check('    且「本轮该动什么」开始点名它要任务', pBoard.includes('心灵（未下发）'))
    rmSync(archiveInMind, { force: true })
    check('  删掉之后又变回去（成对，不是单向）', !plan.discoverSubjects(root).map((s) => s.name).includes('心灵'))
  }

  const board = plan.buildBoard(root, { today, subjects: states, planRaw: undefined })
  check('  看板里没有它的名字（不进「每科」小节）', !board.includes('心灵'), board.slice(0, 200))
  // ⚠️ 用 `■` 而不是 `###`：看板的科目小节标题是 `■ 数学`，而 `###` 是**计划文件**里的写法。
  //    第一版写成 `###` —— 那对任何看板都是 true，是一条**永远绿的空断言**（F28 的假绿形状）。
  check('  看板没有 `■ 心灵` 小节', !/^■\s*心灵\s*$/m.test(board), board.split('\n').filter((l) => l.startsWith('■')).join(' / '))
  check('  且没有把它算成"待下发任务"的科目', !board.includes('心灵（未下发）'))

  const verdict = plan.replanVerdict({ root, today, subjects: states })
  check('  「本轮该动什么」不把它算成待办科目', !JSON.stringify(verdict.taskWork ?? []).includes('心灵'), JSON.stringify(verdict.taskWork ?? []).slice(0, 160))
}

console.log('\n② 去路：它 → 学科（正控制 + 归零对照）')
{
  // 正控制：笔记里**真的写了** `- @数学：…` 才该出数。第一版实验漏了这行，于是"报 0"
  // 与"真的没有"分不清——这正是 F28，所以下面两条必须成对出现。
  writeFileSync(notePath, SCAFFOLD.replace('（哪一科的事就写 `- @数学：…`。）', '- @数学：这周心事多，数学那块想按 60% 的量走。'), 'utf8')
  const got = core.collectHandoffs(数学, undefined, { noteName: NOTE })
  check('  笔记里写了 `@数学` → 数学收得到（1 条）', got.length === 1, `收到 ${got.length} 条`)
  check('  来源写的是「心灵」', got[0]?.source === '心灵', String(got[0]?.source))
  check('  正文解析对了', got[0]?.text?.includes('按 60% 的量走') === true, String(got[0]?.text))
  check('  记下了它出自哪个文件（可追溯）', got[0]?.foundIn === NOTE, String(got[0]?.foundIn))

  // 归零对照：还原骨架后必须 0 条。**同一形状的 0** —— 这才证明上一条的 1 是真的。
  writeFileSync(notePath, SCAFFOLD, 'utf8')
  check('  还原骨架 → 0 条（同形状的对照）', core.collectHandoffs(数学, undefined, { noteName: NOTE }).length === 0)
}

console.log('\n③ 回程：学科 → 它')
{
  // 数学档案里标 `- @心灵：…` —— 这条通路**本来就通**（不需要新代码），但不能只靠"应该通"。
  writeFileSync(
    join(数学, '学习档案.md'),
    `# 学习档案\n\n更新于: ${today}\n\n## 学校当前进度\n第 1 章。\n\n## 已答主题与卡点\n- @心灵：他今天说数学有点跟不上了。\n\n## 未消化薄弱点\n- 无。\n`,
    'utf8',
  )
  const got = core.collectHandoffs(心灵, undefined, { noteName: NOTE })
  check('  数学标了 `@心灵` → 陪伴收得到（1 条）', got.length === 1, `收到 ${got.length} 条`)
  check('  来源是「数学」', got[0]?.source === '数学', String(got[0]?.source))

  // 账本 = **它自己的笔记**（不是 复习提纲.md）：补上同源戳即销账。
  // ⚠️ 来源戳必须落在**行尾**（`SOURCE_TAG_RE` 有 `$` 锚点，见 companion-core 的注释——
  //    不锚住的话正文里顺口提一句"（源:英语 2026-09-10）"就会被当成一条跨科条目）。
  //    第一版把戳写在行首，于是"销账"这条红了——**是测试写错了，不是代码**。
  const ledger = `${SCAFFOLD}\n- 他今天说数学有点跟不上了。（源:数学 ${got[0]?.date ?? today}）\n`
  const pending = core.pendingHandoffs(心灵, { outlineText: ledger, noteName: NOTE })
  check('  笔记里补上同源戳 → 销账（pending=0）', pending.pending.length === 0, JSON.stringify(pending.pending.map((h) => h.line)))
  check('  （对照）不补戳 → 仍挂着 1 条', core.pendingHandoffs(心灵, { outlineText: SCAFFOLD, noteName: NOTE }).pending.length === 1)
  // 还原，免得影响下面
  writeFileSync(join(数学, '学习档案.md'), `# 学习档案\n\n更新于: ${today}\n\n## 学校当前进度\n第 1 章。\n\n## 已答主题与卡点\n- 无。\n\n## 未消化薄弱点\n- 无。\n`, 'utf8')
}

console.log('\n④ 看板外流面：**只有**「要跟总规划说的」那一节')
{
  const SENTINEL_STATE = '哨兵-最近的状态-不外流'
  const SENTINEL_ASK = '哨兵-要跟学科说的-不外流'
  const SENTINEL_ABSORB = '哨兵-收下的移交-不外流'
  const VISIBLE = '哨兵-要跟总规划说的-应该出现'
  const full = `# 心灵笔记\n\n更新于: ${today}\n\n## 最近的状态\n- ${SENTINEL_STATE}\n\n## 要跟学科说的\n- @数学：${SENTINEL_ASK}\n\n## ${PLAN_SECTION}\n- ${VISIBLE}\n\n## 收下的移交\n- （源:数学 ${today}）${SENTINEL_ABSORB}\n`
  writeFileSync(notePath, full, 'utf8')

  // 走**真实渲染路径**（companionPlanItems → buildBoard），不是只测纯函数。
  const items = plan.companionPlanItems(full)
  check('  纯函数只抽出那一节的条目', items.length === 1 && items[0] === VISIBLE, JSON.stringify(items))

  const subjects = plan.survey(root, today)
  const noteRaw = readFileSync(notePath, 'utf8')
  const board = plan.buildBoard(root, { today, subjects, planRaw: undefined, noteRaw })
  check('  看板里有那一节的内容', board.includes(VISIBLE))
  check('  看板里**没有**「最近的状态」的内容', !board.includes(SENTINEL_STATE))
  check('  看板里**没有**「要跟学科说的」的内容', !board.includes(SENTINEL_ASK))
  check('  看板里**没有**「收下的移交」的内容', !board.includes(SENTINEL_ABSORB))
  check('  看板标注了"陪伴，不是科目"', board.includes('陪伴，不是科目'), board.slice(-400))
  check('  看板给了销账方式（变更记录）', board.includes(plan.NOTICE_NAME ?? '变更记录.md'))

  // 零成本：不传 noteRaw（= 别的预设）时看板一个字节都不多。
  const plain = plan.buildBoard(root, { today, subjects, planRaw: undefined })
  check('  不传 noteRaw → 看板里没有它的块（零成本）', !plain.includes('陪伴，不是科目'))
  check('  且比传了的那份短', Buffer.byteLength(plain, 'utf8') < Buffer.byteLength(board, 'utf8'))
  // ⚠️ 封顶要在**同一节里**测：第一版把三条追加在 `full` 末尾，而 `full` 的末尾已经是
  //    `## 收下的移交` 那一节了 —— 于是抽出来仍是 1 条，断言红了而代码是对的。
  //    （「测试写错了」与「代码错了」在输出上长得一样，这也是 F28 的一种。）
  const four = `# 心灵笔记\n\n更新于: ${today}\n\n## ${PLAN_SECTION}\n- 一\n- 二\n- 三\n- 四\n\n## 收下的移交\n`
  check(
    `  两条上限：4 条只出 ${plan.COMPANION_PLAN_ITEMS_MAX} 条`,
    plan.companionPlanItems(four).length === plan.COMPANION_PLAN_ITEMS_MAX,
    `实际 ${plan.companionPlanItems(four).length} 条：${JSON.stringify(plan.companionPlanItems(four))}`,
  )
  check('  且取的是**最前面**那几条（新的在上）', JSON.stringify(plan.companionPlanItems(four)) === JSON.stringify(['一', '二']), JSON.stringify(plan.companionPlanItems(four)))
}

console.log('\n⑤ 守护：它自己那一份受执法，别处不许代改')
{
  const calls = []
  await guard.apply({ get: (k) => (k === 'tools' ? { guard: (fn) => calls.push(fn) } : undefined) })
  check('  宿主守护注册上了', calls.length === 1, `${calls.length} 个回调`)
  if (calls.length === 1) {
    const decide = (cwd, content, file = notePath) =>
      calls[0]({ name: 'write', arguments: { file_path: file, content }, agent: { session: { header: { cwd } } } })
    check('  正控制·合法内容 → 放行', decide(心灵, SCAFFOLD) === undefined, String(decide(心灵, SCAFFOLD)))
    check('  没有日期戳 → 拒', blocked(decide(心灵, '# 心灵笔记\n\n## 最近的状态\n- x\n')))
    check('  日期戳不是今天 → 拒', blocked(decide(心灵, `# 心灵笔记\n\n更新于: 2020-01-01\n\n## 最近的状态\n- x\n`)))
    check('  超 40 行 → 拒', blocked(decide(心灵, `# 心灵笔记\n\n更新于: ${today}\n\n${Array.from({ length: 60 }, (_, i) => `- ${i}`).join('\n')}\n`)))
    check('  超 4096 字节 → 拒', blocked(decide(心灵, `# 心灵笔记\n\n更新于: ${today}\n\n${'字'.repeat(5000)}\n`)))
    check('  别的会话（cwd=数学）来写 → 拒', blocked(decide(数学, SCAFFOLD)))
    check('  大写变体 `心灵笔记.MD` 也认（防绕过）', blocked(decide(数学, 'x', join(心灵, '心灵笔记.MD'))))

    // ★★ 自毁路径（2026-10-12 补）：在**陪伴自己的目录**里建 `学习档案.md`。
    //    这一条上面那条反向自证**只证明了机制**（放进去就变成科目），没有证明"路走不通"。
    //    实测（`.verify/probe-selfdestruct-enforcement.mjs`）当时**三层守护没有一层拦它**：
    //      · file-guard 认 archive，但 `cwd === scopeDir` ⇒ "本科自己写自己的档案"正好放行
    //      · companion-core 的预设内守护同理（sameDir ⇒ 放行）
    //      · persona 只写了「别去改**别科**的文件」
    //    症状不是报错，而是**静默变形**：陪伴变第七个科目、进看板、总规划点名要任务。
    //    所以这条断言钉的是"身份"，不是"内容"——夹具用的是一份**内容完全合法**的档案。
    const legalArchive = `# 学习档案\n\n更新于: ${today}\n\n## 学校当前进度\nx\n\n## 已答主题与卡点\n- 无。\n\n## 未消化薄弱点\n- 无。\n`
    check('  ★ 陪伴目录里建 `学习档案.md`（内容完全合法）→ 拒',
      blocked(decide(心灵, legalArchive, join(心灵, '学习档案.md'))),
      String(decide(心灵, legalArchive, join(心灵, '学习档案.md'))))
    // 正控制：同一份内容放在**真正的科目目录**里必须放行，否则上面那条可能只是"档案校验坏了"。
    check('    正控制·同一份内容放进真科目目录 → 放行',
      decide(数学, legalArchive, join(数学, '学习档案.md')) === undefined,
      String(decide(数学, legalArchive, join(数学, '学习档案.md'))))
  }
}

console.log('\n⑥ 预设声明：它在，而且 parts/options 是那一套')
{
  const decl = declById('mind-companion')
  check('  组合树里有 mind-companion 这条声明', decl !== undefined)
  if (decl !== undefined) {
    check('  声明于用户层（不是 shipped）', decl.shipped === false, String(decl.layer))
    check('  名字是「心灵陪伴」', decl.name === '心灵陪伴', String(decl.name))
    const row = findPluginRow(decl, 'study')
    const parts = row?.config?.parts
    // ★ 它**故意**不挂 judge / code-run：陪伴不出题、不判分。这不是"漏了"，是设计。
    check('  parts 是 [ companion, plan ]（不出题、不判分）', JSON.stringify(parts) === JSON.stringify(['companion', 'plan']), JSON.stringify(parts))
    check('  options.companion.noteName 指向它的笔记', row?.config?.options?.companion?.noteName === NOTE, JSON.stringify(row?.config?.options?.companion))
    // plan 部件要能自己找到学习根：预设声明**没有 cwd 字段**，学员会在 GUI 里选目录。
    check('  options.plan.root 是绝对路径（不靠 cwd）', /^[A-Za-z]:\//.test(row?.config?.options?.plan?.root ?? ''), JSON.stringify(row?.config?.options?.plan))
    // 它**不该**配 companionDir —— 那是总规划的开关（渲染「心灵的话」），不是它的。
    check('  它自己不配 companionDir（那是总规划的事）', row?.config?.options?.plan?.companionDir === undefined)
    check('  persona 非空且不含 U+FFFD', (personaPrefixOf(decl) ?? '').length > 500 && !(personaPrefixOf(decl) ?? '').includes('\uFFFD'))

    // ★★ 2026-10-12 学员纠正：*「如果我说的一些话可能影响到我的规划…就应该有相应的变化，
    //    所以这个可能还需要预设自己来判断，不是那种说什么就写什么」*
    //    这一条把"陪伴 → 规划"的通道从**转述**改成**判断**。它是行为，不是代码契约，
    //    所以只能在 persona 上钉——**但必须钉**：这条指令掉了，通道就退回"说什么写什么"，
    //    而那是学员明确否掉的（且症状是"规划按一句情绪话重排"，很难归因）。
    {
      const p = personaPrefixOf(decl) ?? ''
      check('  ★ 有「判断」这一节（学员 2026-10-12 的纠正）', p.includes('# 判断'), '')
      // 判据是"有没有真的写清怎么判断"，不是"有没有那个词"：
      //   ① 要先问"会不会改变什么" ② 要写结论不写原话 ③ 要具体到能执行 ④ 拿不准不写 ⑤ 要闭环
      check('    ① 写了"先判断会不会改变什么"', /先问一句.*会改变什么/.test(p), '')
      check('    ② 写了"写结论，不写原话"', p.includes('写结论，不写原话'), '')
      check('    ③ 写了"具体到能执行"', p.includes('具体到能执行'), '')
      check('    ④ 写了"拿不准就不写"', p.includes('拿不准就不写'), '')
      check('    ⑤ 写了闭环（办完要删，否则一直挂着重复生效）', /办完就删/.test(p) && /重复生效/.test(p), '')
      // 反例必须真的在：没有 ❌/✅ 对照，这条指令很容易被读成"要写得委婉些"。
      check('    且带 ❌/✅ 对照（把"情绪原话"与"该写的结论"摆在一起）', p.includes('❌') && p.includes('✅'), '')
      // 自动看板仍只渲染规划节，但学科有定向通道，不能再声称其它节绝不外传。
      check('    隐私边界准确：看板单节渲染，不冒充文件 ACL', /自动看板只渲染这一节/.test(p) && p.includes('不是文件访问隔离'), '')
    }
  }
  // 总规划那边必须有开关，否则「心灵的话」永远不渲染——而那**不报错**。
  const planner = declById('study-planner')
  const pRow = planner === undefined ? undefined : findPluginRow(planner, 'study')
  check('  总规划的 plan 部件配了 companionDir（否则看板尾部永不渲染）', pRow?.config?.options?.plan?.companionDir === '心灵', JSON.stringify(pRow?.config?.options?.plan))
  // ★ 两侧口径要对上：陪伴产出"判断"，规划就得把它读成**待办**而不是"可选建议"。
  //   只改一边 = 陪伴写了、规划当耳旁风，学员看到的还是"没有相应的变化"。
  {
    const pp = personaPrefixOf(planner) ?? ''
    check('  ★ 总规划 persona 把那一块读成待办（不是"可以考虑"）', /当\*\*待办\*\*读|当待办读/.test(pp), '')
    // ⚠️ 别按字面匹配整句：persona 里有 `**` 加粗标记（实测 `你**删不掉**那一行` ⇒
    //    `/删不掉那一行/` 匹配不到，红了而内容是对的）。分开断言两个词。
    check('    且写明它删不掉那一行（那是陪伴的文件）', pp.includes('删不掉') && pp.includes('那是它的文件'), '')
    check('    且写了闭环（办完记一条变更记录）', /办完在 .*变更记录\.md.*记一条/.test(pp), '')
  }
}

rmSync(root, { recursive: true, force: true })

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
