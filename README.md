# dsh-task-scheduler

DSH（DeepSeek Harness）Web 侧边栏的**定时任务**插件：把一段 Prompt 或一条 shell 命令挂上 cron，
到点在**一个全新的 Agent 会话**里执行，运行记录可回看、可一键跳转到那次会话。

> 目标版本：DSH `0.1.5-rc.1`。

## 特性

- **侧边栏入口**：一个「任务」席位，面板内含列表视图与看板视图（按分类或状态分列）
- **任务字段**：标题、描述、执行类型（Prompt / shell）、分类（默认四档带颜色，可自定义）、
  工作区目录、权限档位（只读 / 工作区内可写 / 完全放行）、自动批准开关、漏跑策略、
  cron、启用开关、日志文件与通知文件路径
- **cron**：5 段表达式；编辑器里预设点选 + 高级手写，并实时预览「接下来 5 次」运行时间
- **执行**
  - Prompt 型：每次开一个**全新顶层会话**（不设 `origin: 'subagent'`，因此能在会话列表里看到并跳转）
  - shell 型：以子进程执行，完整输出写日志文件，运行记录只存退出码 + 末 200 行
- **调度策略**（固定，不随任务变化）：并发上限 3（超出排队）、单次超时 1 小时、
  失败延迟 5 分钟重试 1 次、上一轮未结束时本轮记 `skipped_overlap` 且不启新会话、
  漏跑默认只补最近一次（可按任务切换为全部补跑）、历史全留
- **通知**：每个任务一个追加式 markdown 通知文件；面板上的「需要关注」标记由
  `lastStatus` 与在跑运行集合并集推导，纯服务端数据、零本地存储
- **安全**
  - 插件自己的 HTTP 路由带信任栅栏 —— 插件路由**不受**浏览器 cookie 保护，所以栅栏是必须的
  - 「自动批准」用 **agent 作用域**的审批应答者实现（策略保持 `ask`），
    **不会**影响你自己会话里的批准行为
  - 任何落盘产物都不写凭据；任务 prompt 原样存储但不会回显进日志或通知

## 安装

```sh
dsh plugin --profile web add dsh-task-scheduler
```

本地源码安装（推荐方式）：

```powershell
cd <插件源码目录>
npm pack --silent
dsh plugin --profile web add file:<插件源码目录>\dsh-task-scheduler-0.1.0.tgz
```

> ⚠️ **不要用 `link:` 安装。** `link:` 会让 Node 按 realpath（源码目录）解析依赖，
> 从那里向上找不到 DSH 自带的 `@deepseek-ai/*`，插件会在启动时报
> `Cannot find package '@deepseek-ai/dsh-llm'`。打成 tarball 装成真实包即可解决。
>
> 另外：改了源码要**重新 `npm pack` + 重新 `add`**，且必须先 `remove` 再 `add`
> —— pnpm 在依赖说明符没变时会跳过重装。

装完**重启 `dsh web`**，侧边栏会出现「定时任务」入口。

## 数据位置

`$DSH_HOME/dsh-task-scheduler/`

```
tasks.json   runs.json   state.json
logs/        notify/                 # shell 完整输出 / 每任务 markdown 通知
```

全部走「同目录 `.tmp` → fsync → rename」原子写，并有跨进程 `store.lock`。

## 已知限制

- **「会话未读标记」在 DSH 0.1.5-rc.1 上没有对应能力**，插件如实声明不支持，替代为：
  每任务通知文件 / 会话按 `updatedAt` 在列表中上浮 / 面板内「需要关注」标记。
  代码里 `SESSION_UNREAD_MARKER.supported === false` 显式表达这一点。
- **面板徽标尚未实现**（当前只在任务卡片上以状态色呈现）。
- **任务 prompt 不做变量替换**：`{WORKSPACE}`、`{LAST_RUN}` 这类占位符会原样交给 agent。
- 依赖 `ctx.agents.create`、`agentPresets`、`agentDefaultModel` 三个宿主服务；
  创建会话时必须**显式**给出模型（`agentOptions`）、目录（`meta.cwd`）、
  preset 名字（`meta.agentPreset`）以及 **preset 的 `setup`**（它负责挂载基础工具集）——
  少任何一样，任务会话要么起不来，要么变成一个没有文件系统 / Shell 工具的 agent。

## 开发与自检

`tools/` 下是可重跑的自检脚本，**只写系统临时目录，不碰 `~/.dsh`**：

```
node tools/verify.mjs             # 宿主：数据层 / 路由 / 信封 / 字段矩阵 / 错误码
node tools/verify-scheduler.mjs   # cron 解析与调度策略（含假时钟驱动）
node tools/verify-runner.mjs      # 执行链路（新会话 / 子进程 / 通知）
node tools/verify-paths.mjs       # 路径字段校验
node tools/v2-*.mjs               # 独立复核：路由配对、策略、$DSH_HOME 等价性、前端调用面
```

独立复核脚本会对着宿主真源做 **method + path 配对**断言，并把真实 `createApiHandler`
挂到真实 http 服务器上逐条实打 —— 「表里怎么写的」与「handler 收不收」是两回事。

## 许可

MIT
