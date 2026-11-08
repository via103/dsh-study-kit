// study-suite.js — 学习插件的**唯一入口**：预设里只挂这一行，内部把整套挂起来。
//
// 为什么需要它（扩展点收敛）：以前每个伴学预设要逐个列 2~3 行
// （`companion-core` / `study-judge` / `code-run`……），于是
// **「加一个通用工具」= 写 .js + 改 N 个预设 + 改 persona + 测试 = 4 × N 处**。
// 收敛之后：**加一个通用工具 = 改这个文件（1 处）+ 测试（1 处）**，四个预设一个字都不用动。
//
// 预设里的用法：
//
//   - id: study
//     name: '<study-plugins 目录>/study-suite.js'
//     config:
//       parts: [companion, judge, code-run]     # 只挂需要的部件
//       options:                                 # 可选：给某个部件的 config
//         companion: { maxBytes: 8192 }
//
// 为什么科目专属的部件也在这里排队、而不各写各的：**出口只有一个**才谈得上"加一处"。
// 但**选哪些部件仍然由各预设自己决定**——英语会话不该拿到 `code-run`，除非它点名要。
//
// 前提已验证：`test/probe-metamount.mjs` 证明 `ctx.plugin(模块命名空间)` 是合法形状
// （Cordis 只认 `{ apply }`，而 ESM 命名空间恰好带着 `apply`/`name`/`inject`，额外导出被忽略）。
import * as companion from './companion-core.js'
import * as judge from './study-judge.js'
import * as plan from './plan-core.js'
import * as codeRun from './code-run.js'
import * as netsecRange from './netsec-range.js'

export const name = 'study-suite'

/**
 * 部件表。**加一个通用工具，只改这一张表**——四个预设不用动。
 * `label` 是给人看的（报错时会列出来）；`mod` 是真正的插件模块命名空间。
 */
const PARTS = {
  plan: { label: '总规划底座（看板注入 + 计划/任务守护）', mod: plan },
  companion: { label: '伴学档案注入 + 写入守护', mod: companion },
  judge: { label: '判题器（choice / cloze / numeric / code / flag）', mod: judge },
  'code-run': { label: '真编译真运行 C 与 Python（只有它需要本机工具链）', mod: codeRun },
  'netsec-range': { label: '本机靶场（仅 127.0.0.1）', mod: netsecRange },
}

export function apply(ctx, config) {
  const parts = config?.parts
  if (!Array.isArray(parts) || parts.length === 0) {
    throw new Error(`study-suite：config.parts 必须是一个非空数组。可用部件：${Object.keys(PARTS).join(' / ')}`)
  }
  const unknown = parts.filter((p) => PARTS[p] === undefined)
  if (unknown.length > 0) {
    // 说清楚"你写的名字"和"我知道的名字"。这一条以前的表现是"预设能开、但那个工具就是没有"——最难查。
    throw new Error(`study-suite：不认识的部件 ${unknown.join('、')}。可用部件：${Object.keys(PARTS).join(' / ')}`)
  }
  const options = config?.options ?? {}

  // 子插件挂在本行的 ctx 下 → 与"直接列在预设里"**同一个作用域**，
  // 于是归属、注入、守护的语义完全不变（这点由 verify-suite.mjs 钉住）。
  const fibers = parts.map((p) => ctx.plugin(PARTS[p].mod, options[p]))
  // 等所有子插件 settle：某个部件起不来时，失败要落在**套件这一行**上，而不是悄悄少一个工具。
  return Promise.all(fibers)
}
