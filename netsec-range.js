// netsec-range — 本地网安靶场（DSH Cordis，宿主侧，纯 ESM，无外部依赖）
//
// 预置三关故意带漏洞的演示站，挂在 DSH 自身 webServer 的 /study-range/ 前缀下
//（DSH Web 默认只监听 127.0.0.1，靶场不暴露到局域网）：
//   L1 sqli —— SQL 注入登录绕过
//   L2 xss  —— 反射型 XSS
//   L3 idor —— 越权访问（水平越权）
//
// 工具：range_start(level) 返回入口 URL 与任务说明；range_submit(level, flag) 判定。
// flag 只存在于本文件的常量里，不出现在任何页面响应中（idor 关除外——那里的 flag
// 本身就是「越权才能看到的数据」，这是关卡设计）。
//
// 只消费宿主服务（webServer / tools），不发布服务，无需 isolate realm。
// 可选 config：{ baseUrl?: string }（默认 http://127.0.0.1:3080）。

export const name = 'netsec-range'

const FLAGS = {
  sqli: 'flag{sqli_login_bypass_ok}',
  xss: 'flag{xss_reflected_ok}',
  idor: 'flag{idor_horizontal_ok}',
}

const TASKS = {
  sqli: '这是一个登录页（ admin / admin123 可以正常登录，但正常路径没有 flag ）。请用 SQL 注入绕过登录校验拿到 flag。提示范围：登录框的用户名字段直接拼接进 SQL 查询。',
  xss: '这是一个搜索页，你的输入会被回显在页面上。请构造一个能真正执行的反射型 XSS payload（让浏览器执行脚本）拿到 flag。提示范围：回显没有做 HTML 转义。',
  idor: '你以学号 1 的身份登录了成绩系统（user/1 是你的页面）。系统里还有别的同学。请找到 flag。提示范围：注意 URL 里的数字。',
}

function page(title, body) {
  return `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><title>${title}</title></head><body style="font-family:sans-serif;max-width:640px;margin:3em auto">${body}</body></html>`
}

function send(res, html) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(html)
}

// ── 三关的 HTTP 处理（导出以便单测） ─────────────────────────────────────────

export function handleSqli(url, res) {
  if (url.pathname === '/study-range/sqli' ) {
    return send(res, page('学生登录', `
      <h2>学生成绩系统 · 登录</h2>
      <form method="GET" action="/study-range/sqli/login">
        <p>用户名：<input name="u" /></p>
        <p>密码：<input name="p" type="password" /></p>
        <p><button type="submit">登录</button></p>
      </form>`))
  }
  if (url.pathname === '/study-range/sqli/login') {
    const u = url.searchParams.get('u') ?? ''
    const p = url.searchParams.get('p') ?? ''
    // 漏洞：用户名被直接拼接进 SQL（模拟），注入特征命中即绕过
    const injected = /'\s*or\s+/i.test(u) || /'\s*or\s+/i.test(p) || /--\s*$/.test(u) || /'\s*--/.test(u)
    if (injected) {
      return send(res, page('登录成功', `
        <h2>登录成功（绕过）</h2>
        <p>查询返回了全部用户，你以管理员身份进入了系统。</p>
        <p>战利品：<strong>${FLAGS.sqli}</strong></p>`))
    }
    if (u === 'admin' && p === 'admin123') {
      return send(res, page('登录成功', '<h2>登录成功</h2><p>欢迎，admin。今天没有新成绩。（这里没有 flag——想想别的办法）</p>'))
    }
    return send(res, page('登录失败', '<h2>登录失败</h2><p>用户名或密码错误。</p>'))
  }
}

export function handleXss(url, res) {
  const q = url.searchParams.get('q') ?? ''
  const executed = /<\s*script/i.test(q) || /on(error|load|click)\s*=/i.test(q) || /<\s*img[^>]*onerror/i.test(q) || /<\s*svg[^>]*onload/i.test(q)
  const shown = q === '' ? '<p>输入关键词开始搜索。</p>' : `<p>「${q}」的搜索结果：无</p>`
  const loot = executed ? `<p>页面执行了你的脚本。战利品：<strong>${FLAGS.xss}</strong></p>` : ''
  return send(res, page('站内搜索', `
    <h2>站内搜索</h2>
    <form method="GET" action="/study-range/xss">
      <p><input name="q" style="width:24em" /> <button type="submit">搜索</button></p>
    </form>
    ${shown}
    ${loot}`))
}

export function handleIdor(url, res) {
  const m = /^\/study-range\/idor\/user\/(\d+)$/.exec(url.pathname)
  if (m === null) {
    return send(res, page('成绩系统', `
      <h2>成绩系统</h2>
      <p>你已登录（学号 1）。</p>
      <p><a href="/study-range/idor/user/1">查看我的成绩</a></p>`))
  }
  const id = m[1]
  if (id === '1') {
    return send(res, page('我的成绩', '<h2>张三（学号 1）的成绩</h2><p>网络安全导论：92</p><p>大学英语：85</p><p>（这是你自己的页面，没有 flag）</p>'))
  }
  if (id === '2') {
    return send(res, page('成绩详情', `<h2>李四（学号 2）的成绩</h2><p>网络安全导论：97</p><p>备注：${FLAGS.idor}</p>`))
  }
  return send(res, page('成绩详情', `<h2>学号 ${id}</h2><p>没有这位同学。</p>`))
}

function route(req, res) {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (url.pathname === '/study-range/' || url.pathname === '/study-range') {
    return send(res, page('本地靶场', `
      <h2>本地靶场</h2>
      <ul>
        <li>L1 <a href="/study-range/sqli">SQL 注入登录绕过</a></li>
        <li>L2 <a href="/study-range/xss">反射型 XSS</a></li>
        <li>L3 <a href="/study-range/idor">越权访问</a></li>
      </ul>
      <p>由伴学插件提供，仅供本机学习使用。</p>`))
  }
  if (url.pathname.startsWith('/study-range/sqli')) return handleSqli(url, res)
  if (url.pathname.startsWith('/study-range/xss')) return handleXss(url, res)
  if (url.pathname.startsWith('/study-range/idor')) return handleIdor(url, res)
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end('unknown range path')
}

// ── 插件本体 ────────────────────────────────────────────────────────────────

export function apply(ctx, config) {
  const webServer = ctx.get('webServer')
  const tools = ctx.get('tools')
  if (webServer === undefined || tools === undefined) return

  const baseUrl = typeof config?.baseUrl === 'string' ? config.baseUrl : 'http://127.0.0.1:3080'
  // 注意：prefix 匹配规则是 `pathname === prefix || pathname.startsWith(prefix + '/')`，
  // 所以前缀不能带尾斜杠（'/study-range/' 会要求子路径以 '//' 开头，永远匹配不到）。
  // 幂等：路由是进程级单例，同一进程内重挂载（standing 校验、recompose）会撞重复注册——
  // 已存在本前缀即视为已挂载，跳过；其他错误照常抛出。
  try {
    webServer.register({ kind: 'prefix', path: '/study-range', handler: route })
  } catch (error) {
    if (!String(error && error.message || error).includes('duplicate')) throw error
  }

  const levels = Object.keys(FLAGS)

  tools.register({
    name: 'range_start',
    description:
      '启动本地网安靶场关卡，返回入口 URL 与任务说明，把 URL 交给学员开打。' +
      'level 为必填参数，取值 ' + levels.join(' / ') + ' 之一（缺 level 会明确报「无法开局」，不算开局）。' +
      '靶场在学员本机（127.0.0.1），全程合法。',
    parameters: {
      type: 'object',
      properties: {
        level: { type: 'string' },
      },
      required: ['level'],
    },
    output: {
      schema: { type: 'object' },
      render(_args, value) {
        const v = value
        // 用法错误 ≠ 关卡结果：缺参数必须显式报「无法开局」，绝不能长得像一次正常开局
        if (v.ok === false) return [{ type: 'text', text: `⚠️ 无法开局（用法错误，不是关卡问题）\n${v.detail}` }]
        return [{ type: 'text', text: `关卡：${v.level}\n入口：${v.url}\n任务：${v.task}` }]
      },
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const level = String(args?.level ?? '').trim()
      if (!(level in FLAGS)) {
        const why = level === '' ? 'range_start 的 level 参数缺失（收到空值）' : `未知关卡「${level}」`
        return {
          ok: false,
          level,
          url: `${baseUrl}/study-range/`,
          detail: `${why}。可用关卡：${levels.join(' / ')}。请带 level 参数重新调用 range_start，例如 {"level":"${levels[0]}"}。`,
        }
      }
      return { ok: true, level, url: `${baseUrl}/study-range/${level}`, task: TASKS[level] }
    },
  })

  tools.register({
    name: 'range_submit',
    description:
      '判定学员提交的靶场 flag 是否正确。level 与 flag 均为必填：level 取 ' + levels.join(' / ') + ' 之一，flag 是学员打出来的完整 flag 串（含 flag{...}）。' +
      '判定归本工具，讲评归你。',
    parameters: {
      type: 'object',
      properties: {
        level: { type: 'string' },
        flag: { type: 'string' },
      },
      required: ['level', 'flag'],
    },
    output: {
      schema: { type: 'object' },
      render(_args, value) {
        const v = value
        // 输入非法时绝不能渲染成「flag 不对」——那会把用法错误伪装成学员答错
        if (v.ok === false) return [{ type: 'text', text: `⚠️ 无法判定（用法错误，不是学员答错）\n${v.detail}` }]
        return [{ type: 'text', text: v.pass ? `✅ flag 正确，${v.level} 关通过` : `❌ flag 不对（已按代码常量比对 ${v.level} 关）` }]
      },
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const level = String(args?.level ?? '').trim()
      const flag = String(args?.flag ?? '').trim()
      if (!(level in FLAGS)) {
        const why = level === '' ? 'range_submit 的 level 参数缺失（收到空值）' : `未知关卡「${level}」`
        return {
          ok: false,
          pass: false,
          level,
          detail: `${why}。可用关卡：${levels.join(' / ')}。本次没有做任何判定——请带 level 重新提交。`,
        }
      }
      if (flag === '') {
        return {
          ok: false,
          pass: false,
          level,
          detail: `flag 参数缺失（收到空值）：本次没有做任何判定——请带学员打出的完整 flag 重新调用，例如 {"level":"${level}","flag":"flag{...}"}。`,
        }
      }
      return { ok: true, level, pass: flag === FLAGS[level] }
    },
  })
}
