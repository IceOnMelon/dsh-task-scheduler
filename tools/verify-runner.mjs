/**
 * dsh-task-scheduler — 执行链路自检（t4 交付，随项目保留）
 *
 * 用法（在项目根 `dsh-task-scheduler/` 下）：
 *   node tools/verify-runner.mjs
 *
 * 覆盖 t4 的六条验收：
 *  1) Prompt 型：`agents.create` 开**全新会话**、`meta.cwd` = workspaceCwd、不指定模型
 *     （不给 agentOptions）、不设 `origin:'subagent'`、不给 parentAgent；
 *     prompt 在 create resolve **之后**用 `followup(createUserMessage(...))` 投递；sessionId 进运行记录
 *  2) shell 型：cwd = workspaceCwd、退出码进运行记录、**完整输出写日志文件**、运行记录只留末 200 行
 *  3) 权限：三档沙箱映射 + `autoApprove` 开关注入 **agent 作用域**的 `approval/request` 应答者
 *     （策略永远是 `'ask'`，绝不 `'never'`；绝不用全局监听器）
 *  4) 成功判定：Prompt 型 `turn/end` = completed → ok，error/aborted/max-tokens/blocked/缺失 → failed；
 *     shell 型退出码 0 → ok，非 0 / 被信号杀 / spawn 失败 → failed；超时钩子终止子进程与会话
 *  5) 通知：每任务一个 markdown 文件（路径可配）、追加式、含 时间/任务名/状态/会话 id/摘要；
 *     会话未读标记的能力事实（DSH 0.1.5-rc.1 无此 API）不假装支持
 *  6) 凭据：任务 prompt / shell 命令原文**不进日志、不进通知**；落盘产物不含令牌字样
 *  7) 接线（lib/index.js）：cron 预览走真实 nextRuns、立即执行走同一调度路径、全局暂停停排期、
 *     启动恢复孤儿 running、漏跑补偿触发一次 run
 *
 * 依赖全部注入（agents / 平台模块 / spawn / 时钟），因此**不需要真实 DSH**；
 * 第 6 组额外跑**真实子进程**（输出直接重定向到日志文件 fd，不用管道，沙箱也允许）。
 * 只跑系统临时目录，不碰 `~/.dsh`。
 */
import { mkdtempSync, rmSync, readFileSync, existsSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { TaskStore } from '../lib/store.mjs'
import {
  APPROVAL_POLICY, PERMISSION_SANDBOX_MODES, SANDBOX_MODES, createTaskRunner,
  evaluateTurnOutcome, lastLines, resolveWorkspaceCwd, toSandboxMode,
} from '../lib/runner.mjs'
import { SESSION_UNREAD_MARKER, appendRunNotification, readNotificationFile } from '../lib/notify.mjs'
import { API_PREFIX } from '../lib/routes.mjs'

let pass = 0
let fail = 0
function check(name, condition, detail = '') {
  if (condition) {
    pass += 1
    console.log(`  PASS  ${name}`)
  } else {
    fail += 1
    console.log(`  FAIL  ${name}${detail === '' ? '' : ` — ${detail}`}`)
  }
}
function eq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`)
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
/** 有界轮询（真实 fs / 真实子进程的异步完成需要事件循环；绝不无限 sleep）。 */
async function until(predicate, { timeoutMs = 5000, stepMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() > deadline) return null
    await sleep(stepMs)
  }
}

const BASE = mkdtempSync(join(tmpdir(), 'dts-runner-'))
console.log(`临时根目录：${BASE}`)

// ── 桩件 ───────────────────────────────────────────────────────────────────

/**
 * 最小 agents 桩：记录 create 的 options、在「创建事务」里调用 setup、
 * 给出可控的 `turn/end`，并可选地让 `whenIdle()` 挂住（测超时钩子）。
 */
function makeAgents(options = {}) {
  const order = []
  const created = []
  let releaseIdle = null
  return {
    order,
    created,
    release() { if (releaseIdle !== null) { const done = releaseIdle; releaseIdle = null; done() } },
    async create(createOptions) {
      order.push('create')
      if (typeof options.failCreate === 'string') throw new Error(options.failCreate)
      const events = []
      let approvalListener = null
      const agentCtx = {
        on(event, listener) {
          if (event === 'approval/request') approvalListener = listener
          return () => { if (approvalListener === listener) approvalListener = null }
        },
      }
      const session = {
        id: createOptions.sessionId,
        snapshotEvents: () => events,
        deriveMessages: () => (options.assistantText === undefined
          ? []
          : [{ role: 'assistant', content: [{ type: 'text', text: options.assistantText }] }]),
      }
      const agent = {
        session,
        followup(message) {
          order.push('followup')
          session.lastMessage = message
          events.push({ type: 'user/message', data: message })
        },
        async whenIdle() {
          order.push('whenIdle')
          if (options.hangWhenIdle === true) {
            await new Promise(resolve => { releaseIdle = resolve })
          }
          const kind = options.turnEnd === undefined ? 'completed' : options.turnEnd
          if (kind === null) return
          events.push({
            type: 'turn/end',
            data: {
              turn: 1,
              reason: kind === 'error'
                ? { kind: 'error', error: { message: options.errorMessage ?? 'boom', code: 'E_TEST' } }
                : { kind },
            },
          })
        },
        cancel() { order.push('cancel') },
      }
      const handle = { agent, dispose: async () => { order.push('dispose') } }
      if (typeof createOptions.setup === 'function') createOptions.setup(agentCtx, agent)
      created.push({
        options: createOptions,
        handle,
        agentCtx,
        hasApprover: () => approvalListener !== null,
      })
      return handle
    },
  }
}

/** 平台模块桩：记录每次调用。 */
function makePlatform() {
  const calls = []
  return {
    calls,
    createUserMessage: input => { calls.push({ fn: 'createUserMessage', input }); return { __userMessage: input } },
    setSandboxMode: (session, mode) => { calls.push({ fn: 'setSandboxMode', sessionId: session.id, mode }) },
    setApprovalPolicy: (session, policy) => { calls.push({ fn: 'setApprovalPolicy', sessionId: session.id, policy }) },
  }
}

/** 假 spawn：把 `text` 追加进指定日志文件（模拟子进程写 fd），随后发 close / error。 */
function makeSpawnStub(logPath, { code = 0, signal = null, text = '', error = null, hang = false } = {}) {
  const calls = []
  const listeners = { error: [], close: [] }
  let lastChild = null
  const spawn = (cmd, spawnOptions) => {
    const record = { cmd, options: spawnOptions, logFilePath: logPath }
    calls.push(record)
    const child = {
      pid: 8123,
      on(event, listener) { (listeners[event] ?? (listeners[event] = [])).push(listener); return child },
      kill() { record.killed = true },
    }
    record.child = child
    lastChild = child
    if (hang !== true) {
      setImmediate(() => {
        if (text !== '') appendFileSync(logPath, text)
        if (error !== null) for (const listener of listeners.error) listener(error)
        for (const listener of listeners.close) listener(code, signal)
      })
    }
    return child
  }
  return {
    spawn,
    calls,
    /** 让挂住的子进程收尾（超时钩子测试用）。 */
    finish(result = { code: 0, signal: null }) {
      if (text !== '') appendFileSync(logPath, text)
      for (const listener of listeners.close) listener(result.code ?? null, result.signal ?? null)
    },
    get lastChild() { return lastChild },
  }
}

/** 造一个已初始化、数据根在临时目录的 store。 */
async function makeStore(name) {
  const root = mkdtempSync(join(tmpdir(), `dts-runner-${name}-`))
  const store = new TaskStore({ dataRoot: root })
  await store.init()
  return { store, root }
}

/** 造一个执行 Prompt 型任务的运行器（可覆盖 agents / 平台桩）。 */
function makeRunner(store, overrides = {}) {
  const agents = 'agents' in overrides ? overrides.agents : makeAgents(overrides.agentOptions ?? {})
  const platform = overrides.platform ?? makePlatform()
  const logs = []
  const runner = createTaskRunner({
    store,
    deps: {
      agents,
      createUserMessage: platform.createUserMessage,
      setSandboxMode: platform.setSandboxMode,
      setApprovalPolicy: platform.setApprovalPolicy,
      randomUUID: () => 'fixed-uuid',
      ...overrides.deps,
    },
    logger: message => logs.push(message),
  })
  return { runner, agents, platform, logs }
}

/** 跑一次 Prompt 型任务（含 startRun/finishRun 与通知落盘）。 */
async function runPromptOnce(taskInput, extra = {}) {
  const { store } = await makeStore('prompt')
  const { runner, agents, platform, logs } = makeRunner(store, {
    ...(extra.agents === undefined ? {} : { agents: extra.agents }),
    platform: extra.platform,
    agentOptions: {
      turnEnd: extra.turnEnd,
      assistantText: extra.assistantText,
      failCreate: extra.failCreate,
      errorMessage: extra.errorMessage,
    },
    deps: extra.deps,
  })
  const task = await store.createTask({ execKind: 'prompt', prompt: '汇总昨日工作', ...taskInput })
  const run = await store.startRun(task.id, { trigger: 'manual' })
  const outcome = await runner.execute({ task: store.requireTask(task.id), attempt: 1, sessionIdHint: null })
  await store.finishRun(run.runId, {
    status: outcome.status,
    sessionId: outcome.sessionId ?? null,
    summary: outcome.summary,
    tailOutput: outcome.tailOutput,
  })
  await runner.waitIdle()
  return { store, task, run, outcome, runner, agents, platform, logs, created: agents.created.at(-1) }
}

// ── 1. 通知文件（notify.mjs） ──────────────────────────────────────────────
console.log('\n[1] 通知文件：每任务一个 markdown、追加式、路径可配')
{
  const { store, root } = await makeStore('notify')
  const task = await store.createTask({ execKind: 'shell', cmd: 'echo hi', title: '日报任务' })
  const run = await store.startRun(task.id, { trigger: 'schedule', sessionId: 'session-x' })
  const finished = await store.finishRun(run.runId, { status: 'ok', exitCode: 0, summary: '命令退出码 0' })

  const first = await appendRunNotification({ task, run: finished, dataRoot: root })
  const second = await appendRunNotification({ task, run: finished, dataRoot: root })
  const text = await readNotificationFile(first.path)
  eq('默认路径 = <数据根>/notify/<taskId>.md', first.path, join(root, 'notify', `${task.id}.md`))
  check('首次写入创建文件', first.created === true && second.created === false)
  check('含标题头', text.includes(`# 定时任务：${task.title}`))
  check('追加式（两次＝两段条目）', (text.match(/^## /gm) ?? []).length === 2)
  check('含时间（ISO）', /## \d{4}-\d{2}-\d{2}T/.test(text))
  check('含任务名', text.includes(task.title))
  check('含状态中文标签与英文码', text.includes('成功') && text.includes('`ok`'))
  check('含会话 id 行', text.includes('| 会话 |') && text.includes('session-x'))
  check('含摘要', text.includes('命令退出码 0'))
  check('不含 shell 命令原文（凭据不外泄）', !text.includes('echo hi'))
  check('不含令牌字样', !/password|token|secret|api[-_]?key/i.test(text))
  eq('读不存在的通知文件返回 null', await readNotificationFile(join(root, 'notify', 'nope.md')), null)

  const customPath = join(root, 'custom-notify.md')
  const custom = await store.createTask({ execKind: 'shell', cmd: 'echo x', notifyFile: customPath })
  const customRun = await store.finishRun((await store.startRun(custom.id, { trigger: 'manual' })).runId, { status: 'ok', exitCode: 0 })
  const customResult = await appendRunNotification({ task: custom, run: customRun, dataRoot: root })
  eq('notifyFile 可配：写到自定义路径', customResult.path, customPath)
  check('自定义路径文件已生成', existsSync(customPath))

  const brokenFs = {
    mkdir: async () => {},
    stat: async () => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }) },
    writeFile: async () => {},
    appendFile: async () => { throw new Error('EACCES: 通知目录不可写') },
  }
  let threw = false
  try {
    await appendRunNotification({ task, run: finished, dataRoot: root, fs: brokenFs })
  } catch (error) {
    threw = String(error.message).includes('EACCES')
  }
  check('写入失败向上抛（不静默）', threw)

  // 运行器的通知订阅：写失败只记日志，绝不影响执行
  const failLogs = []
  const failingRunner = createTaskRunner({
    store,
    deps: { agents: makeAgents(), appendRunNotification: () => { throw new Error('通知写崩了') } },
    logger: message => failLogs.push(message),
  })
  const failing = await store.startRun(task.id, { trigger: 'manual' })
  await store.finishRun(failing.runId, { status: 'failed', summary: 'x' })
  await failingRunner.waitIdle()
  check('通知写入失败被兜住并记日志', failLogs.some(line => line.includes('通知写入失败')))
  await failingRunner.dispose()
}

// ── 2. Prompt 型：全新会话 + cwd + 默认模型 + sessionId 进记录 ─────────────
console.log('\n[2] Prompt 型：全新会话 + cwd + 默认模型 + sessionId 进记录')
{
  const workspace = mkdtempSync(join(tmpdir(), 'dts-runner-ws-'))
  const result = await runPromptOnce(
    { workspaceCwd: workspace, permission: 'workspace-write', autoApprove: true, title: '日报' },
    { assistantText: '昨天的汇总如下：…' },
  )
  const { created, outcome, platform, agents } = result
  eq('会话 id 形态', outcome.sessionId, 'session-fixed-uuid')
  eq('create 的 sessionId 一致', created.options.sessionId, outcome.sessionId)
  eq('meta.cwd = workspaceCwd', created.options.meta, { cwd: workspace })
  check('不给 agentOptions（跟随 DSH 当前默认模型）', created.options.agentOptions === undefined)
  check('不设 meta.origin / 不给 parentAgent', created.options.meta.origin === undefined && created.options.parentAgent === undefined)
  check('不传 seed / inheritedEventCount', created.options.seed === undefined && created.options.inheritedEventCount === undefined)
  check('prompt 在 create resolve 之后投递', agents.order.indexOf('create') < agents.order.indexOf('followup'))
  const message = created.handle.agent.session.lastMessage
  const firstText = message?.__userMessage?.content?.[0]?.text ?? ''
  check('首条用户消息带可辨认前缀（【任务】标题 · MM-DD HH:mm）',
    /^【任务】日报 · \d{2}-\d{2} \d{2}:\d{2}\n\n汇总昨日工作$/.test(firstText), firstText)
  eq('前缀之后就是任务 prompt 原文（一字不改）',
    firstText.slice(firstText.indexOf('\n\n') + 2), '汇总昨日工作')
  eq('消息只有一条 text 段', message?.__userMessage?.content?.length, 1)
  eq('消息来源标为 user', message?.__userMessage?.source, { kind: 'user' })
  eq('沙箱档位写入 workspace-write', platform.calls.find(call => call.fn === 'setSandboxMode')?.mode, 'workspace-write')
  eq('审批策略固定 ask（绝不 never）', platform.calls.find(call => call.fn === 'setApprovalPolicy')?.policy, APPROVAL_POLICY)
  check('autoApprove=true 注册了 agent 作用域应答者', created.hasApprover() === true)
  check('句柄已释放（dispose）', agents.order.includes('dispose'))
  eq('执行结果 ok', outcome.status, 'ok')
  eq('输出尾部取最后一条 assistant 文本', outcome.tailOutput, '昨天的汇总如下：…')
  check('运行记录写入 sessionId', result.store.requireTask(result.task.id).sessionIds.includes(outcome.sessionId))

  // 工作区为空的语义：沿用宿主默认 —— 即宿主进程的 cwd（DSH CLI：运行命令时所在的目录
  // 即默认 workspace 根目录）。**必须传 cwd**：宿主组装 system prompt 需要 {{cwd}}，
  // 缺了它会话创建会失败（prompt variable "{{cwd}}" has no value for this assembly）。
  const { store: blankStore } = await makeStore('blank')
  const blankRunner = makeRunner(blankStore)
  const blankTask = await blankStore.createTask({ execKind: 'prompt', prompt: 'x', workspaceCwd: '' })
  const blankOutcome = await blankRunner.runner.execute({ task: blankTask, attempt: 1 })
  eq('空工作区 → meta.cwd 用宿主进程 cwd 且执行成功',
    [blankRunner.agents.created.at(-1).options.meta, blankOutcome.status],
    [{ cwd: process.cwd() }, 'ok'])
}

// ── 3. 权限三档 + 自动批准开关 ────────────────────────────────────────────
console.log('\n[3] 权限三档 + 自动批准开关（含作用域红线）')
{
  for (const [permission, mode] of Object.entries(PERMISSION_SANDBOX_MODES)) {
    const { platform } = await runPromptOnce({ permission }, {})
    eq(`permission=${permission} → 沙箱 ${mode}`, platform.calls.find(call => call.fn === 'setSandboxMode')?.mode, mode)
  }
  eq('三档映射表与 DSH 词汇一致', Object.values(PERMISSION_SANDBOX_MODES), SANDBOX_MODES)
  eq('未知档位回落到 workspace-write', toSandboxMode('nope'), 'workspace-write')

  const off = await runPromptOnce({ autoApprove: false }, {})
  check('autoApprove=false 不注册应答者', off.created.hasApprover() === false)
  eq('autoApprove=false 策略仍是 ask', off.platform.calls.find(call => call.fn === 'setApprovalPolicy')?.policy, 'ask')

  const on = await runPromptOnce({ autoApprove: true }, {})
  check('autoApprove 通过 setup(agentCtx) 注入（作用域隔离）', typeof on.created.options.setup === 'function' && on.created.hasApprover() === true)

  // 相对路径的工作区必须明确失败，绝不静默跑在错目录
  const bad = await runPromptOnce({ workspaceCwd: 'relative/dir' }, {})
  eq('相对工作区 → 明确失败', [bad.outcome.status, bad.outcome.errorCode], ['failed', 'invalid-workspace'])
  check('相对工作区不会创建会话', bad.agents.created.length === 0)
}

// ── 4. 成功判定 + 超时钩子 ────────────────────────────────────────────────
console.log('\n[4] 成功判定（Prompt 型按 turn/end）与超时钩子')
{
  for (const [kind, expected, errorCode] of [
    ['completed', 'ok', undefined],
    ['error', 'failed', 'turn-error'],
    ['aborted', 'failed', 'turn-aborted'],
    ['max-tokens', 'failed', 'turn-max-tokens'],
    ['blocked', 'failed', 'turn-blocked'],
    ['interrupted', 'failed', 'turn-interrupted'],
  ]) {
    const { outcome } = await runPromptOnce({}, { turnEnd: kind })
    eq(`turn/end=${kind} → ${expected}`, outcome.status, expected)
    if (errorCode !== undefined) eq(`turn/end=${kind} 错误码`, outcome.errorCode, errorCode)
  }
  const missing = await runPromptOnce({}, { turnEnd: null })
  eq('没有 turn/end → failed', [missing.outcome.status, missing.outcome.errorCode], ['failed', 'turn-missing'])
  const boom = await runPromptOnce({}, { turnEnd: 'error', errorMessage: '模型调用失败' })
  check('error 原因带进摘要', boom.outcome.summary.includes('模型调用失败'))
  const createFail = await runPromptOnce({}, { failCreate: 'agents.create 拒绝' })
  eq('创建会话失败 → failed', [createFail.outcome.status, createFail.outcome.errorCode], ['failed', 'prompt-execute-error'])

  // agents 服务缺失（宿主 inject 漏了 agents）→ 诚实失败，不静默跳过
  const { store: noAgentsStore } = await makeStore('noagents')
  const noAgentsRunner = makeRunner(noAgentsStore, { agents: null })
  const noAgentsTask = await noAgentsStore.createTask({ execKind: 'prompt', prompt: 'x' })
  const noAgentsOutcome = await noAgentsRunner.runner.execute({ task: noAgentsTask, attempt: 1 })
  eq('无 agents 服务 → 诚实失败（runner-unavailable）', [noAgentsOutcome.status, noAgentsOutcome.errorCode], ['failed', 'runner-unavailable'])

  eq('evaluateTurnOutcome 无会话时不虚报成功', evaluateTurnOutcome({}).status, 'failed')
  eq('resolveWorkspaceCwd 空串＝宿主默认', resolveWorkspaceCwd('  '), { cwd: undefined })
  check('resolveWorkspaceCwd 相对路径明确失败', typeof resolveWorkspaceCwd('relative/dir').error === 'string')
  eq('lastLines 保留末 N 行', lastLines('a\nb\nc', 2), 'b\nc')

  // 超时钩子：Prompt 型 → cancel() 会话
  const { store: timeoutStore } = await makeStore('timeout')
  const hangAgents = makeAgents({ hangWhenIdle: true, turnEnd: 'aborted' })
  const { runner: hangRunner } = makeRunner(timeoutStore, { agents: hangAgents })
  const promptTask = await timeoutStore.createTask({ execKind: 'prompt', prompt: '长任务' })
  const pending = hangRunner.execute({ task: promptTask, attempt: 1 })
  await until(() => hangAgents.order.includes('whenIdle'))
  hangRunner.execute.onTimeout({ task: promptTask, attempt: 1 })
  check('超时钩子 cancel 了会话', hangAgents.order.includes('cancel'))
  hangAgents.release()
  const hung = await pending
  eq('被 cancel 后按 turn/end 判定为失败（不记成功）', hung.status, 'failed')
}

// ── 5. shell 型：cwd、日志文件、末 200 行、失败判定 ────────────────────────
console.log('\n[5] shell 型：cwd / 退出码 / 完整输出写日志 / 记录只留末 200 行')
{
  const workspace = mkdtempSync(join(tmpdir(), 'dts-runner-sh-'))
  const { store } = await makeStore('shell')
  const task = await store.createTask({ execKind: 'shell', cmd: 'echo hello', workspaceCwd: workspace, title: 'shell 任务' })
  const logPath = store.resolveLogFilePath(task)
  const stub = makeSpawnStub(logPath, { code: 0, text: 'hello\n' })
  const runner = createTaskRunner({
    store,
    deps: { agents: makeAgents(), spawn: stub.spawn, randomUUID: () => 'x' },
  })
  const run = await store.startRun(task.id, { trigger: 'manual' })
  const outcome = await runner.execute({ task, attempt: 1 })
  const spawnOptions = stub.calls[0].options
  eq('工作目录 = workspaceCwd', spawnOptions.cwd, workspace)
  check('走 shell 执行', spawnOptions.shell === true)
  check('stdout/stderr 直接重定向到日志 fd（不经管道）',
    spawnOptions.stdio[0] === 'ignore'
    && spawnOptions.stdio[1] === spawnOptions.stdio[2]
    && spawnOptions.stdio[1] !== 'pipe'
    && spawnOptions.stdio[1] !== 'inherit')
  eq('退出码 0 → ok', [outcome.status, outcome.exitCode], ['ok', 0])
  eq('运行记录 logFilePath = 任务日志路径', outcome.logFilePath, logPath)
  const logText = readFileSync(logPath, 'utf8')
  check('日志写入运行分隔头（含次数与时间）', /===== 第 1 次运行 · 开始 \d{4}-/.test(logText))
  check('日志含子进程完整输出', logText.includes('hello'))
  check('日志不重复写命令原文（凭据不外泄）', !logText.includes('echo hello'))
  check('运行记录输出尾部含子进程输出', outcome.tailOutput.includes('hello'))
  await store.finishRun(run.runId, { status: outcome.status, exitCode: outcome.exitCode, tailOutput: outcome.tailOutput, summary: outcome.summary, logFilePath: outcome.logFilePath })
  await runner.waitIdle()

  const exit3 = makeSpawnStub(logPath, { code: 3, text: 'boom\n' })
  const exit3Outcome = await createTaskRunner({ store, deps: { agents: makeAgents(), spawn: exit3.spawn } }).execute({ task, attempt: 1 })
  eq('退出码非 0 → failed', [exit3Outcome.status, exit3Outcome.exitCode, exit3Outcome.errorCode], ['failed', 3, 'exit-code'])

  const killedStub = makeSpawnStub(logPath, { code: null, signal: 'SIGKILL' })
  const killedOutcome = await createTaskRunner({ store, deps: { agents: makeAgents(), spawn: killedStub.spawn } }).execute({ task, attempt: 1 })
  eq('被信号终止 → failed（exitCode null）', [killedOutcome.status, killedOutcome.exitCode, killedOutcome.errorCode], ['failed', null, 'killed'])

  const errorStub = makeSpawnStub(logPath, { error: new Error('spawn ENOENT') })
  const errorOutcome = await createTaskRunner({ store, deps: { agents: makeAgents(), spawn: errorStub.spawn } }).execute({ task, attempt: 1 })
  eq('spawn 失败 → failed（spawn-error）', [errorOutcome.status, errorOutcome.errorCode], ['failed', 'spawn-error'])

  // 超时钩子：shell 型 → 终止进程树
  const hangStub = makeSpawnStub(logPath, { hang: true })
  const hangRunner = createTaskRunner({
    store,
    deps: { agents: makeAgents(), spawn: hangStub.spawn, killProcessTree: child => { child.kill() } },
  })
  const pending = hangRunner.execute({ task, attempt: 1 })
  await until(() => hangStub.calls.length > 0)
  hangRunner.execute.onTimeout({ task, attempt: 1 })
  check('超时钩子终止了子进程', hangStub.calls[0].killed === true)
  hangStub.finish({ code: null, signal: 'SIGTERM' })
  eq('被超时终止的运行记 failed', (await pending).status, 'failed')

  // 大输出：运行记录只留末 200 行，日志文件仍完整
  const bigTask = await store.createTask({ execKind: 'shell', cmd: 'big', title: '大输出' })
  const bigLog = store.resolveLogFilePath(bigTask)
  const lines = Array.from({ length: 300 }, (_, index) => `line-${index}`).join('\n')
  const bigStub = makeSpawnStub(bigLog, { code: 0, text: lines })
  const big = await createTaskRunner({ store, deps: { agents: makeAgents(), spawn: bigStub.spawn } }).execute({ task: bigTask, attempt: 1 })
  eq('输出尾部恰好 200 行', big.tailOutput.split('\n').length, 200)
  check('输出尾部是最后一段（含末行 line-299、不含开头 line-0）',
    big.tailOutput.includes('line-299') && !big.tailOutput.includes('line-0'))
  check('完整输出仍在日志文件里（line-0 也在）', readFileSync(bigLog, 'utf8').includes('line-0'))

  // 自定义 logFilePath
  const customLog = join(workspace, 'custom.log')
  const customTask = await store.createTask({ execKind: 'shell', cmd: 'x', logFilePath: customLog, title: '自定义日志' })
  const customStub = makeSpawnStub(customLog, { code: 0, text: 'in-custom\n' })
  const customOutcome = await createTaskRunner({ store, deps: { agents: makeAgents(), spawn: customStub.spawn } }).execute({ task: customTask, attempt: 1 })
  eq('logFilePath 可配', customOutcome.logFilePath, customLog)
  check('自定义日志文件已写入', readFileSync(customLog, 'utf8').includes('in-custom'))

  // 空 cmd 的防御分支（正常写入口会被 model 拒收，这里直接喂一个脏任务对象）
  const emptyCmdOutcome = await createTaskRunner({ store, deps: { agents: makeAgents() } })
    .execute({ task: { id: 'dirty-task', execKind: 'shell', cmd: '   ' }, attempt: 1 })
  eq('空 cmd 不执行（empty-cmd）', [emptyCmdOutcome.status, emptyCmdOutcome.errorCode], ['failed', 'empty-cmd'])
}

// ── 6. 真实子进程（输出重定向到日志文件，不用管道） ────────────────────────
console.log('\n[6] 真实子进程：cwd 生效 / 退出码 / 完整输出落日志')
{
  const workspace = mkdtempSync(join(tmpdir(), 'dts-runner-real-'))
  const { store } = await makeStore('real')
  const task = await store.createTask({
    execKind: 'shell',
    cmd: 'node -e "process.stdout.write(\'cwd=\' + process.cwd() + \'\\n\'); process.stderr.write(\'err-line\\n\')"',
    workspaceCwd: workspace,
    title: '真实子进程',
  })
  const runner = createTaskRunner({ store, deps: { agents: makeAgents() } })
  const outcome = await runner.execute({ task, attempt: 1 })
  eq('真实子进程退出码 0 → ok', [outcome.status, outcome.exitCode], ['ok', 0])
  const logText = readFileSync(outcome.logFilePath, 'utf8')
  check('真实子进程的 stdout 落日志', logText.includes(`cwd=${workspace}`))
  check('真实子进程的 stderr 也落日志', logText.includes('err-line'))
  check('日志不含命令原文', !logText.includes('process.stdout.write'))
  check('运行记录尾部含 stdout', outcome.tailOutput.includes(`cwd=${workspace}`))

  const failing = await store.createTask({ execKind: 'shell', cmd: 'node -e "process.exit(4)"', workspaceCwd: workspace, title: '真实失败' })
  const failed = await runner.execute({ task: failing, attempt: 1 })
  eq('真实子进程退出码 4 → failed', [failed.status, failed.exitCode], ['failed', 4])
}

// ── 7. 端到端接线（lib/index.js + HTTP + 调度） ────────────────────────────
console.log('\n[7] 端到端接线：cron 预览 / 立即执行 / 暂停 / 孤儿恢复 / 漏跑补偿')
{
  const root = mkdtempSync(join(tmpdir(), 'dts-runner-e2e-'))
  const seed = new TaskStore({ dataRoot: root })
  await seed.init()
  const orphanTask = await seed.createTask({ execKind: 'shell', cmd: 'node -e "process.exit(0)"', title: '孤儿任务' })
  await seed.startRun(orphanTask.id, { trigger: 'schedule' })
  const missedTask = await seed.createTask({ execKind: 'shell', cmd: 'node -e "process.exit(0)"', cron: '0 9 * * *', title: '漏跑任务' })
  const twentyHoursAgo = new Date(Date.now() - 20 * 60 * 60 * 1000).toISOString()
  await seed.patchRuntime(missedTask.id, { lastRunAt: twentyHoursAgo, nextRunAt: twentyHoursAgo })

  const plugin = await import('../lib/index.js')
  const webServer = makeWebServer()
  const ctx = makeCtx(webServer, { trustedHosts: [], agents: makeAgents() })
  await plugin.apply(ctx, { dataRoot: root })
  const svc = ctx.provided.get('dsh-task-scheduler')
  await svc.ready()
  const store = svc.store
  const handler = webServer.handler

  check('服务已登记（点号名 + 别名）', ctx.provided.has('dsh-task-scheduler') && ctx.provided.has('dshTaskScheduler'))
  check('runner / cron 预览都已接线', svc.hasRunner() === true && svc.hasCronPreview() === true)
  check('接线暴露 runner 与 scheduler（诊断/验证用）', svc.runner !== undefined && svc.scheduler !== undefined)
  check('启动日志：调度已启动', ctx.logs.some(line => line.includes('调度已启动')))
  check('启动日志：恢复中断运行 1 条', ctx.logs.some(line => line.includes('恢复中断运行 1 条')))
  const orphanRun = store.listRuns(orphanTask.id, { limit: 10 }).runs[0]
  eq('孤儿 running 被收尾为 failed/interrupted', [orphanRun.status, orphanRun.errorCode], ['failed', 'interrupted'])

  // cron 预览：真实 nextRuns（spec §5：`{cron, from?}` → `{next:[ISO ×5]}`）
  const preview = await call(handler, { method: 'POST', path: '/cron/preview', body: { cron: '0 9 * * *' } })
  eq('cron 预览返回 5 次', preview.json.value.next.length, 5)
  eq('cron 预览回显表达式', preview.json.value.cron, '0 9 * * *')
  check('cron 预览返回 ISO 且都在未来', preview.json.value.next.every(iso => Date.parse(iso) > Date.now()))
  const badCron = await call(handler, { method: 'POST', path: '/cron/preview', body: { cron: '99 9 * * *' } })
  check('非法 cron → cron 类码（不是 internal）', ['cron-invalid', 'invalid-cron'].includes(badCron.json?.error?.code), JSON.stringify(badCron.json))

  // 立即执行：HTTP → 调度器 → runner → 真实子进程 → 运行记录 + 通知
  const task = await store.createTask({ execKind: 'shell', cmd: 'node -e "process.stdout.write(\'e2e-ok\')"', title: '端到端任务' })
  const manual = await call(handler, { method: 'POST', path: `/tasks/${task.id}/run`, body: {} })
  eq('POST /tasks/:id/run 200', manual.status, 200)
  const runId = manual.json.value.run.runId
  eq('触发来源 manual', manual.json.value.run.trigger, 'manual')
  const terminal = await until(() => {
    const record = store.listRuns(task.id, { limit: 10 }).runs.find(item => item.runId === runId)
    return record !== undefined && ['ok', 'failed', 'timeout'].includes(String(record.status)) ? record : null
  })
  eq('运行进终态 ok', terminal?.status, 'ok')
  eq('运行记录带退出码 0', terminal?.exitCode, 0)
  check('运行记录带 logFilePath', typeof terminal?.logFilePath === 'string' && terminal.logFilePath.endsWith('.log'))

  await svc.runner.waitIdle()
  const notifyPath = store.resolveNotifyFilePath(task)
  const notifyText = await until(() => {
    const text = existsSync(notifyPath) ? readFileSync(notifyPath, 'utf8') : ''
    return text.includes(task.title) ? text : null
  })
  check('立即执行后写入任务通知文件', notifyText !== null, notifyPath)
  check('通知含运行状态与摘要', notifyText !== null && notifyText.includes('`ok`') && notifyText.includes('命令退出码 0'))
  check('通知不含命令原文', notifyText !== null && !notifyText.includes('process.stdout.write'))

  // 漏跑补偿：启动时补最近一次
  const catchupRun = await until(() => store.listRuns(missedTask.id, { limit: 10 }).runs.find(run => run.trigger === 'catchup'))
  check('漏跑补偿产生 catchup 运行', catchupRun !== null && catchupRun !== undefined)
  eq('补跑那次真的执行成功', catchupRun?.status, 'ok')

  // 全局暂停 → 停排期；暂停中拒绝立即执行；解除 → 重装
  await call(handler, { method: 'POST', path: '/state', body: { paused: true } })
  check('暂停日志：已停止排期', ctx.logs.some(line => line.includes('全局暂停：已停止排期')))
  const pausedRun = await call(handler, { method: 'POST', path: `/tasks/${task.id}/run`, body: {} })
  eq('暂停中立即执行被拒（paused）', [pausedRun.status, pausedRun.json.error.code], [200, 'paused'])
  await call(handler, { method: 'POST', path: '/state', body: { paused: false } })
  check('解除日志：已重装排期定时器', ctx.logs.some(line => line.includes('已重装排期定时器')))

  // Prompt 型端到端：平台依赖可用时真开会话；不可用时诚实失败（不假装成功）
  const promptTask = await store.createTask({ execKind: 'prompt', prompt: '写日报', title: 'Prompt 任务' })
  const promptRun = await call(handler, { method: 'POST', path: `/tasks/${promptTask.id}/run`, body: {} })
  const promptRecord = await until(() => {
    const record = store.listRuns(promptTask.id, { limit: 10 }).runs[0]
    return record !== undefined && ['ok', 'failed'].includes(String(record.status)) ? record : null
  })
  if (promptRecord?.status === 'ok') {
    check('平台依赖可用：Prompt 型真开会话并记 sessionId',
      typeof promptRecord.sessionId === 'string' && promptRecord.sessionId.startsWith('session-'))
  } else {
    eq('平台依赖不可用：诚实失败（runner-unavailable，不假装成功）', [promptRecord?.status, promptRecord?.errorCode], ['failed', 'runner-unavailable'])
  }

  // 凭据：任务定义原样存（spec §4），但日志 / 通知 / 运行记录不得出现命令里的密码
  const secretCmd = process.platform === 'win32'
    ? 'rem SUPERSECRET42'
    : 'true # SUPERSECRET42'
  const secretTask = await store.createTask({ execKind: 'shell', cmd: secretCmd, title: '含密任务' })
  await call(handler, { method: 'POST', path: `/tasks/${secretTask.id}/run`, body: {} })
  await svc.runner.waitIdle()
  const secretLog = readFileSync(store.resolveLogFilePath(secretTask), 'utf8')
  const secretNotify = readFileSync(store.resolveNotifyFilePath(secretTask), 'utf8')
  const runsText = readFileSync(join(root, 'runs.json'), 'utf8')
  const tasksText = readFileSync(join(root, 'tasks.json'), 'utf8')
  check('日志不含命令里的密码', !secretLog.includes('SUPERSECRET42'))
  check('通知不含命令里的密码', !secretNotify.includes('SUPERSECRET42'))
  check('运行记录不含命令里的密码', !runsText.includes('SUPERSECRET42'))
  check('任务定义允许原样保存（spec §4）', tasksText.includes('SUPERSECRET42'))

  eq('插件导出形态', [plugin.name, plugin.default.name], ['dsh-task-scheduler', 'dsh-task-scheduler'])
  eq('inject 含 webServer/sessions/agents/webRuntime', plugin.inject, ['webServer', 'sessions', 'agents', 'webRuntime'])

  // 卸载：停调度 + 泄放订阅（不留下定时器）
  for (const dispose of ctx.effects) {
    try { await dispose() } catch { /* 卸载失败不影响断言结果 */ }
  }
  check('卸载后调度器已停止', svc.scheduler.started === false)
}

console.log('\n[8] 会话未读标记：能力事实（不假装支持）')
{
  eq('notify 明确声明未读标记不受支持', SESSION_UNREAD_MARKER.supported, false)
  check('给出原因与替代方案', typeof SESSION_UNREAD_MARKER.reason === 'string' && SESSION_UNREAD_MARKER.substitutes.length >= 3)
  check('替代方案含每任务通知文件', SESSION_UNREAD_MARKER.substitutes.some(text => text.includes('通知')))
  const notifText = readFileSync(new URL('../lib/notify.mjs', import.meta.url), 'utf8')
  check('notify.mjs 写明「不假装支持」', notifText.includes('不假装支持'))
}

// ── 桩件（HTTP / ctx） ─────────────────────────────────────────────────────

function makeWebServer() {
  const routes = []
  return {
    routes,
    register(route) {
      routes.push(route)
      return () => {
        const index = routes.indexOf(route)
        if (index >= 0) routes.splice(index, 1)
      }
    },
    get handler() {
      if (routes.length !== 1) throw new Error(`期望 1 条路由，实际 ${routes.length}`)
      return routes[0].handler
    },
  }
}

function makeReq({ method = 'GET', path = '', host = '127.0.0.1:3080', body, headers = {} } = {}) {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')])
  stream.method = method
  stream.url = `${API_PREFIX}${path}`
  stream.headers = { host, 'sec-fetch-site': 'same-origin', ...headers }
  return stream
}

async function call(handler, options) {
  const res = {
    status: 0, headers: {}, payload: '', writableEnded: false,
    writeHead(status, headers) { res.status = status; res.headers = headers ?? {} },
    end(chunk) { res.payload = chunk === undefined ? '' : String(chunk); res.writableEnded = true },
  }
  await handler(makeReq(options), res)
  let json = null
  try { json = JSON.parse(res.payload) } catch { /* 非 JSON */ }
  return { status: res.status, json, raw: res.payload }
}

/** cordis 风格上下文桩（与 tools/verify.mjs 同构；额外支持注入 agents）。 */
function makeCtx(webServer, { trustedHosts = [], agents } = {}) {
  const provided = new Map()
  const effects = []
  const logs = []
  const services = { webServer, webRuntime: { trustedHosts }, agents }
  return {
    provided,
    effects,
    logs,
    logger: () => ({
      info: message => logs.push(`info:${message}`),
      warn: message => logs.push(`warn:${message}`),
    }),
    get: name => (name in services ? services[name] : provided.get(name)),
    provide: (name, value) => {
      provided.set(name, value)
      return () => provided.delete(name)
    },
    effect: fn => {
      const dispose = fn()
      effects.push(dispose === undefined ? () => undefined : dispose)
      return dispose
    },
  }
}

rmSync(BASE, { recursive: true, force: true })
console.log(`\n结果：${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
