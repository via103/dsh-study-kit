# test/ —— 开发期回归

这些脚本**不参与运行时**，只在改完插件后手动跑。它们按"作者自己的完整工作区"写成，
所以放进一个只有插件的目录里跑，会报「缺数据 / 找不到 profile」——那是环境不对，不是代码坏了。

只验证**规则本身**、任何机器都能跑的：

```bash
node test/verify-board-fit.mjs          # 看板头部预算
node test/verify-companion-budget.mjs   # 陪伴块预算
node test/verify-task-life.mjs          # 本周任务生命期
node test/verify-classnotes-hygiene.mjs # 课堂积累体量
node test/check-profile-live.mjs        # 投递一致性（没有 profile 时自动跳过）
```

需要完整工作区（各科 `学习档案.md`、`本周任务.md`、profile 里的预设）才能跑的：
`verify-planner`、`verify-cross-subject`、`verify-curriculum-route`、`verify-code-tutor`、
`verify-mind-preset`、`verify-word-review*`、`check-migration`、`verify-study-day` 等。

跑法：在**学习根**里执行（或 `DSH_STUDY_ROOT=<学习根>`），并确保本机已装 DSH。
