// 宿主平面守护（file-guard）的独立验证：先把插件本身测通，再去动 profile 的启动配置。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const PLUGINS = '<study-plugins>/'
const guardMod = await import(pathToFileURL(PLUGINS + 'file-guard.js').href)
const plan = await import(pathToFileURL(PLUGINS + 'plan-core.js').href)
const companion = await import(pathToFileURL(PLUGINS + 'companion-core.js').href)

let pass = 0
let fail = 0
function check(label, cond, extra) {
  if (cond) { pass += 1; console.log('  ✅', label) }
  else { fail += 1; console.log('  ❌', label, extra === undefined ? '' : `→ ${extra}`) }
}
const blocked = (v) => typeof v === 'string' && v.length > 0

const TODAY = plan.studyDate()
const ROOT = mkdtempSync(join(tmpdir(), 'fileguard-'))
const ST = join(ROOT, 'ST')
const ENG = join(ST, '英语')
const OTHER = join(ROOT, '别的项目')
mkdirSync(ENG, { recursive: true })
mkdirSync(OTHER, { recursive: true })
const archive = `# 学习档案\n\n更新于: ${TODAY}\n\n## 学校当前进度\n- 进度\n\n## 已答主题与卡点\n- 卡点\n\n## 未消化薄弱点\n- 薄弱\n`
writeFileSync(join(ENG, '学习档案.md'), archive)
writeFileSync(join(OTHER, '学习档案.md'), archive) // 别处同名文件：不该被管

const guards = []
guardMod.apply({ get: (n) => (n === 'tools' ? { guard: (f) => guards.push(f) } : undefined) }, {})
const g = guards[0]
const call = (cwd, name, file, args) => g({ name, arguments: { file_path: file, ...args }, agent: { session: { header: { cwd } } } })

const goodPlan = `# 总规划（周看板）\n\n生成: ${TODAY}\n本次修订: 首次制定\n数据基准: 英语=${TODAY}\n\n## 一、本周硬约束\n- x\n\n## 二、每科 MVE\n### 英语\n- [ ] y\n\n## 三、漂移与风险\n- z\n\n## 四、下周预备\n- w\n`
const goodTask = `# 本周任务\n\n生成: ${TODAY}\n依据: 学习档案 更新于 ${TODAY}\n\n- [ ] a\n`
const goodLog = `# 变更记录\n\n生成: ${TODAY}\n\n- ${TODAY} 计划：首次制定\n`

console.log('\n① 基础接线')
check('注册了一个 guard', guards.length === 1)
check('classify：学习档案 → archive', guardMod.classify(join(ENG, '学习档案.md'))?.kind === 'archive')
check('classify：总规划 → plan', guardMod.classify(join(ST, '总规划.md'))?.kind === 'plan')
check('classify：无关文件名 → undefined', guardMod.classify(join(ST, '随手笔记.md')) === undefined)
check('looksLikeStudyRoot：ST 是学习根', guardMod.looksLikeStudyRoot(ST) === true)
check('looksLikeStudyRoot：别的项目不是', guardMod.looksLikeStudyRoot(OTHER) === false)

console.log('\n② 总规划会话（cwd = 学习根）')
check('写合法总规划 → 放行', call(ST, 'write', join(ST, '总规划.md'), { content: goodPlan }) === undefined)
check('写非法总规划 → 拦下', blocked(call(ST, 'write', join(ST, '总规划.md'), { content: 'x' })))
check('写合法变更记录 → 放行', call(ST, 'write', join(ST, '变更记录.md'), { content: goodLog }) === undefined)
check('写非法变更记录 → 拦下', blocked(call(ST, 'write', join(ST, '变更记录.md'), { content: 'x' })))
check('下发本周任务 → 校验生效', blocked(call(ST, 'write', join(ENG, '本周任务.md'), { content: 'x' })))
check('  写合法本周任务 → 放行', call(ST, 'write', join(ENG, '本周任务.md'), { content: goodTask }) === undefined)

console.log('\n③ 科目会话（cwd = 英语）')
check('写自己的档案（合法）→ 放行', call(ENG, 'write', join(ENG, '学习档案.md'), { content: archive }) === undefined)
check('写自己的档案（违规）→ 拦下', blocked(call(ENG, 'write', join(ENG, '学习档案.md'), { content: '没有三字段' })))
check('勾选本周任务 → 放行', call(ENG, 'edit', join(ENG, '本周任务.md'), { old_string: '- [ ] a', new_string: '- [x] a' }) === undefined)
check('重写本周任务 → 拦下', blocked(call(ENG, 'write', join(ENG, '本周任务.md'), { content: goodTask })))
check('改总规划 → 拦下', blocked(call(ENG, 'write', join(ST, '总规划.md'), { content: goodPlan })))
check('写变更记录 → 拦下', blocked(call(ENG, 'write', join(ST, '变更记录.md'), { content: goodLog })))

console.log('\n④ 这就是要堵的洞：无守护预设的会话')
check('cwd=学习根 但去改某科档案 → 拦下（旧行为下会被放行）', /由该科自己维护/.test(call(ST, 'write', join(ENG, '学习档案.md'), { content: archive }) ?? ''))
check('cwd=某科 但去改别科的档案 → 拦下', blocked(call(ENG, 'write', join(ST, '数学', '学习档案.md'), { content: archive })))
check('cwd=学习根 但去改别科的任务 → 按总规划处理（合法即放行）', call(ST, 'write', join(ENG, '本周任务.md'), { content: goodTask }) === undefined)

console.log('\n⑤ 管辖权：由协议定义（某目录下有子目录带 学习档案.md ⇒ 它是学习根）')
// 这是协议本身的定义，不是过度拦截：代价是「别处恰好叫 学习档案.md 的孤立文件也会被要求符合档案格式」。
// 注意：只要它旁边有科目目录，它就构成一棵学习树——所以这条会被管，而**非协议文件名**一律不管。
check('协议文件名 → 纳入管辖，内容不合档案格式即拦下', blocked(call(OTHER, 'write', join(OTHER, '学习档案.md'), { content: '随便' })))
check('  把内容写成合法档案 → 放行', call(OTHER, 'write', join(OTHER, '学习档案.md'), { content: archive }) === undefined)
check('非协议文件名 → 完全不管', call(OTHER, 'write', join(OTHER, '随便什么.md'), { content: '随便' }) === undefined)
check('别的项目里的 总规划.md（无科目结构）→ 不管', call(OTHER, 'write', join(OTHER, '子目录', '总规划.md'), { content: '随便' }) === undefined)

console.log('\n⑥ 边界与 fail-open：内部异常绝不能让所有写入挂掉')
check('arguments 为 undefined → 放行', g({ name: 'write', arguments: undefined, agent: undefined }) === undefined)
check('file_path 不是字符串 → 放行', g({ name: 'write', arguments: { file_path: 123 }, agent: undefined }) === undefined)
check('execution 为 null → 放行', g(null) === undefined)
check('非 write/edit → 放行', call(ST, 'read', join(ST, '总规划.md'), {}) === undefined)
check('agent 缺失（判不出归属）→ fail-closed 拦下，不是放行', blocked(g({ name: 'write', arguments: { file_path: join(ENG, '学习档案.md'), content: archive }, agent: undefined })))

console.log('\n⑦ edit 通道：内容校验必须跟着走（旧实现在这里对 archive/plan/log 整个放行）')
// 反例（协议审计发现）：宿主守护对这三种文件的 edit 一律放行，理由是"改后内容重建交给预设内守护"
// ——可那个守护只存在于挂了 companion-core 的预设里。用 standard 开会话就能一次绕开全部内容校验。
{
  const arch = readFileSync(join(ENG, '学习档案.md'), 'utf8')
  check('edit 档案成非法内容 → 拦下', blocked(call(ENG, 'edit', join(ENG, '学习档案.md'), { old_string: arch, new_string: 'x' })))
  check('edit 档案成合法内容 → 放行', call(ENG, 'edit', join(ENG, '学习档案.md'), { old_string: '- 进度\n', new_string: '- 进度（补一行）\n' }) === undefined)
  // 让计划与记录真的落在磁盘上（edit 要重建，文件不存在就无从重建）
  const planOnDisk = `# 总规划（周看板）\n\n生成: ${TODAY}\n本次修订: 基准刷新\n数据基准: 英语=${TODAY}\n\n## 一、本周硬约束\n- x\n\n## 二、每科 MVE\n### 英语\n- [ ] y\n\n## 三、漂移与风险\n- z\n\n## 四、下周预备\n- w\n`
  writeFileSync(join(ST, '总规划.md'), planOnDisk)
  writeFileSync(join(ST, '变更记录.md'), goodLog)
  check('edit 总规划成缺四节的内容 → 拦下', blocked(call(ST, 'edit', join(ST, '总规划.md'), { old_string: planOnDisk, new_string: '# 只剩标题' })))
  check('edit 总规划成合法内容 → 放行', call(ST, 'edit', join(ST, '总规划.md'), { old_string: '## 三、漂移与风险', new_string: '## 三、漂移与风险（本行改动）' }) === undefined)
  check('edit 变更记录塞进复选框 → 拦下', blocked(call(ST, 'edit', join(ST, '变更记录.md'), { old_string: `- ${TODAY} 计划：首次制定`, new_string: '- [ ] 伪造任务' })))
  check('edit 变更记录做合法追加 → 放行', call(ST, 'edit', join(ST, '变更记录.md'), { old_string: `- ${TODAY} 计划：首次制定`, new_string: `- ${TODAY} 计划：首次制定\n- ${TODAY} 全局：补一条` }) === undefined)
  // 重建不了必须拒绝（fail-closed），不能"校验不了就放行"
  const noMatch = call(ENG, 'edit', join(ENG, '学习档案.md'), { old_string: '这段文字根本不在文件里', new_string: 'x' })
  check('edit 的 old_string 找不到 → 拦下并说明', blocked(noMatch) && noMatch.includes('无法重建改后内容'), noMatch)
  check('  非协议文件的 edit 不受影响', call(ENG, 'edit', join(ENG, '随手笔记.md'), { old_string: 'a', new_string: 'b' }) === undefined)
}

console.log('\n⑧ 任务勾选：旧依据作废后连勾选都不算数（三份 persona 承诺过，代码里一直没有）')
{
  writeFileSync(join(ENG, '本周任务.md'), `# 本周任务\n\n生成: ${TODAY}\n依据: 学习档案 更新于 2020-01-01\n\n- [ ] 旧任务\n`)
  const staleVerdict = call(ENG, 'edit', join(ENG, '本周任务.md'), { old_string: '- [ ] 旧任务', new_string: '- [x] 旧任务' })
  check('旧依据的任务 → 勾选被拦', blocked(staleVerdict), staleVerdict)
  check('  拒绝理由点明「旧依据已经作废」', String(staleVerdict).includes('旧依据已经作废'))
  writeFileSync(join(ENG, '本周任务.md'), `# 本周任务\n\n生成: ${TODAY}\n依据: 学习档案 更新于 ${TODAY}\n\n- [ ] 新任务\n`)
  check('依据吻合 → 勾选放行', call(ENG, 'edit', join(ENG, '本周任务.md'), { old_string: '- [ ] 新任务', new_string: '- [x] 新任务' }) === undefined)
  check('  依据吻合但改任务文字 → 仍拦下', blocked(call(ENG, 'edit', join(ENG, '本周任务.md'), { old_string: '新任务', new_string: '换个说法' })))
}

console.log('\n⑨ 大小写别名：改个扩展名大小写不能绕过整条守护')
// 实测发现：classify 原本是精确比较，于是 `学习档案.MD` / `总规划.MD` / `本周任务.MD` 全部
// 直接放行 —— 而 Windows 上它们与 .md 是**同一个文件**。这正是红队当年给预设内守护指出、
// 并且已经修掉的别名绕过，在宿主守护里又长回来了。
for (const [n, kind] of [['学习档案.MD', 'archive'], ['总规划.MD', 'plan'], ['本周任务.MD', 'task'], ['变更记录.MD', 'log']]) {
  check(`classify：${n} → ${kind}`, guardMod.classify(join(ENG, n))?.kind === kind, JSON.stringify(guardMod.classify(join(ENG, n))))
}
check('用 .MD 写非法档案 → 拦下（不是放行）', blocked(call(ENG, 'write', join(ENG, '学习档案.MD'), { content: '随便' })))
check('用 .MD 写非法总规划 → 拦下', blocked(call(ST, 'write', join(ST, '总规划.MD'), { content: '随便' })))

console.log('\n⑩ 复习提纲：本科自由，**别科只许追加**')
// 2026-09-17 合并：与档案并列的 `复习清单.md`（≤6 条回看队列）已删——知识点现在只存在
// `复习提纲.md` 一处。
//
// ═══ 2026-09-28 规则变更 ══════════════════════════════════════════════════════════
// 原先这里写的是「**故意不归守护管**」：它的前提是"提纲里只会出现本科自己的知识点"。
// 学员在网安会话里打 CTF 时暴露出一片 **Python** 表述问题，这个前提就不成立了——知识点会
// 在别科会话里产生，而提纲是它唯一的家。于是规则改成：
//   · 本科自己的提纲：怎么整理都行（还是不管）
//   · **别科的提纲：只许追加**，且新增行要带来源戳（守护执行，见 verify-cross-subject.mjs）
// 本组只验宿主平面这一侧的接线；判定逻辑在 companion-core 里，两处共用同一个函数。
{
  const goodOutline = '- 09-16 数组名作为参数会退化成指针｜复 2｜上 09-20\n'
  const foreignAppend = `${goodOutline}- 09-28 变量名不能含短横线（源:网安 2026-09-28）\n`
  // ⚠️ 跨科判定要读**磁盘上的现状**（"旧行一条都不能少"），所以这里必须先把提纲落到盘上。
  //    第一版忘了这一步，于是"别科追加"被当成"在空文件上创建一份含无戳行的内容"而拒绝——
  //    守卫行为是对的，是测试没搭出台子。
  writeFileSync(join(ENG, '复习提纲.md'), goodOutline)
  check('classify：复习提纲.md → outline（2026-09-28 起它是一条有规则的协议文件）', guardMod.classify(join(ENG, '复习提纲.md'))?.kind === 'outline')
  check('本科写（任意内容）→ 放行', call(ENG, 'write', join(ENG, '复习提纲.md'), { content: goodOutline }) === undefined)
  check('  格式写歪了也放行（本科自己的笔记本没有代码契约）', call(ENG, 'write', join(ENG, '复习提纲.md'), { content: '一段随便的笔记' }) === undefined)
  check('别科**追加**（带来源戳）→ 放行', call(ST, 'write', join(ENG, '复习提纲.md'), { content: foreignAppend }) === undefined)
  check('  别科**整份重写**（丢掉旧行）→ 拦下', blocked(call(ST, 'write', join(ENG, '复习提纲.md'), { content: '随便' })))
  check('  别科**追加但不带来源戳** → 拦下', blocked(call(ST, 'write', join(ENG, '复习提纲.md'), { content: `${goodOutline}- 没出处\n` })))
  // 文件不存在时由别科创建：等价于"全是新增"，所以只有全带戳才放行
  mkdirSync(join(ST, '数学'), { recursive: true })
  check('  别科在**不存在**的提纲上创建（全带戳）→ 放行', call(ST, 'write', join(ST, '数学', '复习提纲.md'), { content: '- 09-28 x（源:网安 2026-09-28）\n' }) === undefined)
  check('  别科创建时夹了无戳行 → 拦下', blocked(call(ST, 'write', join(ST, '数学', '复习提纲.md'), { content: '- 09-28 x\n- 09-28 y（源:网安 2026-09-28）\n' })))
  check('旧的 复习清单.md 已不是协议文件', guardMod.classify(join(ENG, '复习清单.md')) === undefined)
  check('  写它也不拦（现在只是个可能遗留的普通文件）', call(ENG, 'write', join(ENG, '复习清单.md'), { content: '随便' }) === undefined)
  check(
    'file-guard 的依赖里已没有复习清单一族',
    companion.validateReviewList === undefined && companion.parseReviewList === undefined && companion.MAX_REVIEW_ITEMS === undefined,
  )
}

console.log('\n⑪ ★ 陪伴目录里不许出现 `学习档案.md`（否则陪伴静默变成第七个科目）')
// 为什么这条在**宿主平面**这一侧也要有：陪伴会话的 cwd 就是 `ST\心灵`，
// 而上面那条「archive 只允许 cwd === 该科目录的会话写」**正好会放行**这一种写法。
// 认科目的唯一判据是文件名，所以这一笔下去不是报错、是**变形**：
// 看板多一节 `■ 心灵`、总规划开始点名 `心灵（未下发）` 要任务。
// 实测（`.verify/probe-selfdestruct-enforcement.mjs`）：修之前宿主与预设内两层**都放行**。
{
  const MIND = join(ST, '心灵')
  mkdirSync(MIND, { recursive: true })
  writeFileSync(join(MIND, companion.COMPANION_NOTE_NAME), `# 心灵笔记\n\n更新于: ${TODAY}\n\n## 最近的状态\n- x\n`)
  check('looksLikeCompanionDir：ST\\心灵 是陪伴目录', companion.looksLikeCompanionDir(MIND) === true)
  check('looksLikeCompanionDir：真科目目录不是', companion.looksLikeCompanionDir(ENG) === false)
  // 夹具用一份**内容完全合法**的档案 —— 要拦的是身份，不是内容。
  check('  陪伴在自己目录里建 学习档案.md（内容合法）→ 拦下',
    blocked(call(MIND, 'write', join(MIND, '学习档案.md'), { content: archive })))
  check('  ★ 大写变体 `学习档案.MD` 也拦（防绕过）',
    blocked(call(MIND, 'write', join(MIND, '学习档案.MD'), { content: archive })))
  check('  edit 也一样拦（不是只拦 write）',
    blocked(call(MIND, 'edit', join(MIND, '学习档案.md'), { old_string: 'x', new_string: 'y' })))
  // 正控制：同一份内容、同一个会话，写进**真科目目录**必须放行——
  // 否则上面三条可能只是"档案校验坏了"或"守卫整个停了"，而不是这条规则在管事。
  check('    正控制·同一份内容写进真科目目录（cwd 也是该科）→ 放行',
    call(ENG, 'write', join(ENG, '学习档案.md'), { content: archive }) === undefined)
  // 陪伴笔记本身照常可写（别把新规则误伤到它自己那一份）。
  check('    正控制·陪伴写自己的 心灵笔记.md → 放行',
    call(MIND, 'write', join(MIND, companion.COMPANION_NOTE_NAME), { content: `# 心灵笔记\n\n更新于: ${TODAY}\n\n## 最近的状态\n- y\n` }) === undefined)
}

rmSync(ROOT, { recursive: true, force: true })
console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
