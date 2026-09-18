/**
 * dsh-task-scheduler — 执行链路（宿主半侧，t4 交付）
 *
 * 两种执行类型（spec §7）：
 *  - **Prompt 型**：每次执行开一个**全新 agent 会话**，`cwd = task.workspaceCwd`，
 *    `task.prompt` 作为首条用户消息，**不指定模型**（跟随 DSH 当前默认模型）；
 *  - **shell 型**：以 `task.workspaceCwd` 为工作目录跑 `task.cmd`，完整输出写 `logFilePath`，
 *    运行记录只存退出码 + 末 200 行。
 *
 * 机制来源（docs/m0-findings.md，t1 侦察，权威；本文件不自创第二条推导路径）：
 *  - `ctx.agents.create(CreateAgentOptions)` 是公共 seam，一次给全 sessionId / meta.cwd / setup；
 *    prompt 必须在 `create(...)` resolve **之后**用 `agent.followup(createUserMessage(...))` 投递
 *    （`setup` 只做组合、不做驱动）。
 *  - **绝不**设 `meta.origin:'subagent'`、**绝不**给 `parentAgent`：否则该会话在会话列表里不可见，
 *    前端「打开会话」必然失败（`dsh-client-ui-workspace/lib/client.js:338-339`）。
 *  - 沙箱档位：`setSandboxMode(session, 'read-only'|'workspace-write'|'danger-full-access')`，
 *    可在轮次之外调用，落成会话日志 `sandbox/mode` 事件（`workspace-write` 的边界 = 会话 header.cwd）。
 *  - 自动批准：审批策略**保持 `'ask'`**（**绝不** `'never'`，那会在瀑布分发前确定性拒绝），
 *    在 `setup(agentCtx)` 内注册 **agent 作用域**的 `approval/request` 应答者返回 `'allowed-once'`；
 *    **绝不**用全局 `ctx.on('approval/request')`（未打标签的全局监听器会收到所有 agent 的请求，
 *    等于把用户自己在 GUI 里的会话一起放行）。
 *  - 成功判定：读会话日志里最后一条 `turn/end` 的 `reason.kind`（`completed|aborted|blocked|error|
 *    max-tokens|interrupted`），`completed` = `ok`，其余 = `failed`。
 *  - 超时（1 小时）由调度器施加（`TaskScheduler` 的 race），到点会调本执行器的 `onTimeout` 钩子；
 *    本模块据此终止子进程 / `cancel()` 会话。
 *
 * 安全（spec §4）：**任何落盘产物都不含凭据**——日志只写子进程原始输出与一行运行分隔头（**不重复
 * 写 cmd**，避免把命令里的密码复制进日志），通知只写 t2 渲染器给的字段（标题/状态/会话 id/摘要/
 * 输出尾部），summary 只带错误消息，绝不带任务 prompt 原文或环境变量。
 *
 * 「会话未读标记」：DSH 0.1.5-rc.1 无此能力，本模块不假装支持，见 `lib/notify.mjs` 的
 * `SESSION_UNREAD_MARKER` 与 `docs/api-contract.md` 对应小节。
 */
import { randomUUID } from 'node:crypto'
import { spawn as nodeSpawn } from 'node:child_process'
import { appendFile, mkdir, open, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'

import { PluginError } from './model.mjs'
import { appendRunNotification } from './notify.mjs'

/** 本模块用到的 fs 子集（可整体注入，便于失败路径测试与跨平台替身）。 */
export const defaultFs = Object.freeze({ appendFile, mkdir, open, readFile, stat, writeFile })

// ── 策略常量（spec §6/§7 已锁定，改动必须由 Captain 改规格） ─────────────────

/** 逐任务权限档 → DSH 沙箱档（spec §11.2 表格，逐行照做）。 */
export const PERMISSION_SANDBOX_MODES = Object.freeze({
  readonly: 'read-only',
  'workspace-write': 'workspace-write',
  full: 'danger-full-access',
})

/** DSH 合法的沙箱档词汇（`@deepseek-ai/dsh-sandbox-policy` 的 SANDBOX_MODES）。 */
export const SANDBOX_MODES = Object.freeze(['read-only', 'workspace-write', 'danger-full-access'])

/** 任务未指定权限（或取值意外）时使用的档位，与契约 §2.1 的默认值一致。 */
export const DEFAULT_PERMISSION = 'workspace-write'

/**
 * 审批策略：**必须是 `'ask'`**。
 * `'never'` 会在瀑布分发之前确定性拒绝每一个审批请求（`dsh-user-approval/lib/index.js:178`），
 * 自动批准反而永远不生效。
 */
export const APPROVAL_POLICY = 'ask'

/** 运行记录里保留的输出上限（读日志文件时最多回读的字节数；末 200 行由 store 再截断）。 */
export const MAX_TAIL_BYTES = 512 * 1024

/** 单条运行记录保留的输出行数（spec §7：末 200 行；与 store 的截断保持一致）。 */
export const TAIL_LINES = 200

/** 平台模块的裸包名（宿主内可解析；脱离宿主时必须注入 deps）。 */
export const PLATFORM_PACKAGES = Object.freeze({
  llm: '@deepseek-ai/dsh-llm',
  sandbox: '@deepseek-ai/dsh-sandbox-policy',
  approval: '@deepseek-ai/dsh-user-approval',
})

// ── 平台依赖装载（动态 import，失败要明说，不假装能用） ──────────────────────

let platformCache = null

/**
 * 装载宿主平台依赖（`createUserMessage` / `setSandboxMode` / `setApprovalPolicy`）。
 *
 * 用**动态** import 而不是静态 import 的理由：本项目以 `link:` 安装、Node 按 realpath 解析，
 * 静态裸包名 import 会让「脱离宿主跑自检」直接失败；动态 import + 明确报错则两条路都能走
 * （与 `lib/dsh-home.mjs` 的双路径策略同源）。
 * @returns {Promise<{ createUserMessage: Function, setSandboxMode: Function, setApprovalPolicy: Function }>}
 * @throws {PluginError} `runner-unavailable`（平台依赖不可用时）。
 */
export async function loadPlatformDeps() {
  if (platformCache !== null) return platformCache
  let llm
  let sandbox
  let approval
  try {
    ;[llm, sandbox, approval] = await Promise.all([
      import(PLATFORM_PACKAGES.llm),
      import(PLATFORM_PACKAGES.sandbox),
      import(PLATFORM_PACKAGES.approval),
    ])
  } catch (error) {
    throw new PluginError(
      'runner-unavailable',
      `无法装载宿主平台依赖（${Object.values(PLATFORM_PACKAGES).join(', ')}）：${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const createUserMessage = llm.createUserMessage
  const setSandboxMode = sandbox.setSandboxMode
  const setApprovalPolicy = approval.setApprovalPolicy
  for (const [name, fn] of [
    ['createUserMessage', createUserMessage],
    ['setSandboxMode', setSandboxMode],
    ['setApprovalPolicy', setApprovalPolicy],
  ]) {
    if (typeof fn !== 'function') {
      throw new PluginError('runner-unavailable', `宿主平台依赖缺少导出：${name}`)
    }
  }
  platformCache = { createUserMessage, setSandboxMode, setApprovalPolicy }
  return platformCache
}

/** 重置平台依赖缓存（仅测试用；生产不调用）。 */
export function resetPlatformCache() {
  platformCache = null
}

// ── 纯函数工具（导出以便单测与验证方直接断言） ───────────────────────────────

/**
 * 解析任务工作区为绝对路径。
 * 空串 = 沿用宿主默认（返回 `{ cwd: undefined }`）；非绝对路径 = 明确失败（**绝不**静默回退，
 * 否则「跑在错目录」会静默发生）。
 * @param {unknown} raw - `task.workspaceCwd`。
 * @returns {{ cwd: string|undefined, error?: string }} 解析结果。
 */
export function resolveWorkspaceCwd(raw) {
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (value === '') return { cwd: undefined }
  if (!isAbsolute(value)) return { cwd: undefined, error: `工作区必须是绝对路径：${value}` }
  return { cwd: value }
}

/** 任务权限档 → 沙箱档（未知取值回落到默认档，不抛错，避免历史脏数据让任务永久失败）。 */
export function toSandboxMode(permission) {
  return PERMISSION_SANDBOX_MODES[permission] ?? PERMISSION_SANDBOX_MODES[DEFAULT_PERMISSION]
}

/** 保留文本的最后 `maxLines` 行。 */
export function lastLines(text, maxLines = TAIL_LINES) {
  if (typeof text !== 'string' || text === '') return ''
  const lines = text.split('\n')
  return lines.length <= maxLines ? text : lines.slice(lines.length - maxLines).join('\n')
}

/**
 * 判定一次 Prompt 型运行是否成功。
 *
 * 依据：会话日志里**最后一条** `turn/end` 的 `reason.kind`（spec §4.7 的 reason 词汇）。
 * @param {object} agent - `handle.agent`。
 * @returns {{ status: 'ok'|'failed', summary: string, errorCode?: string }} 判定结果。
 */
export function evaluateTurnOutcome(agent) {
  let events = []
  try {
    events = typeof agent?.session?.snapshotEvents === 'function' ? agent.session.snapshotEvents() : []
  } catch {
    events = []
  }
  let last = null
  for (const event of events) {
    if (event !== null && typeof event === 'object' && event.type === 'turn/end') last = event
  }
  const reason = last?.data?.reason
  const kind = typeof reason?.kind === 'string' ? reason.kind : undefined
  if (kind === 'completed') {
    return { status: 'ok', summary: 'Prompt 型会话正常跑完（turn/end: completed）' }
  }
  if (kind === undefined) {
    return {
      status: 'failed',
      summary: '会话没有产生 turn/end，无法确认执行完毕',
      errorCode: 'turn-missing',
    }
  }
  if (kind === 'error') {
    const message = reason?.error?.message ?? reason?.error?.code ?? '未知错误'
    return { status: 'failed', summary: `会话执行报错：${String(message)}`, errorCode: 'turn-error' }
  }
  return { status: 'failed', summary: `会话以 ${kind} 结束，未正常跑完`, errorCode: `turn-${kind}` }
}

/**
 * 从会话里取最后一条 assistant 消息的文本，作为运行记录的「输出尾部」。
 * （Prompt 型的成果在会话里；把最后一段回答放进运行记录，前端不必打开会话就能看个大概。）
 * @param {object} agent - `handle.agent`。
 * @returns {string} 文本（可能为空串）。
 */
export function assistantTail(agent) {
  let messages = []
  try {
    messages = typeof agent?.session?.deriveMessages === 'function' ? agent.session.deriveMessages() : []
  } catch {
    return ''
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'assistant') continue
    const blocks = Array.isArray(message.content) ? message.content : []
    const text = blocks
      .filter(block => block?.type === 'text' && typeof block.text === 'string')
      .map(block => block.text)
      .join('\n')
      .trim()
    if (text !== '') return lastLines(text)
  }
  return ''
}

// ── 执行器 ─────────────────────────────────────────────────────────────────

/**
 * 创建任务执行器（供 `TaskScheduler` 的 `execute` 与 HTTP `POST /tasks/:id/run` 共用）。
 *
 * @param {object} options
 * @param {import('./store.mjs').TaskStore} options.store - 存储层（用于解析日志/通知路径与订阅运行事件）。
 * @param {object} [options.ctx] - 插件上下文（取 `agents` 服务）。
 * @param {object} [options.deps] - 依赖注入（测试用；缺省走真实实现）：
 *   `agents`、`createUserMessage`、`setSandboxMode`、`setApprovalPolicy`、`spawn`、
 *   `killProcessTree`、`randomUUID`、`appendRunNotification`、`fs`、`now`。
 * @param {(message: string) => void} [options.logger] - 日志（只输出文本，绝不输出任务内容）。
 * @returns {{
 *   execute: ((input: {task: object, attempt?: number, sessionIdHint?: string|null}) => Promise<object>) & { onTimeout?: Function },
 *   waitIdle: () => Promise<void>,
 *   dispose: () => Promise<void>,
 *   notifyRun: (payload: {taskId: string, run: object}) => Promise<object|null>,
 *   snapshot: () => object,
 * }}
 */
export function createTaskRunner(options) {
  const { store, ctx } = options
  if (store === undefined || store === null) throw new PluginError('internal', 'createTaskRunner 需要 store')
  const deps = options.deps ?? {}
  const logger = typeof options.logger === 'function' ? options.logger : () => {}
  const log = message => { try { logger(message) } catch { /* 日志失败不得影响执行 */ } }
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now()
  const newId = typeof deps.randomUUID === 'function' ? deps.randomUUID : randomUUID
  const spawnImpl = typeof deps.spawn === 'function' ? deps.spawn : nodeSpawn
  const fsImpl = deps.fs ?? defaultFs
  const notifyImpl = typeof deps.appendRunNotification === 'function' ? deps.appendRunNotification : appendRunNotification
  const killProcessTreeImpl = typeof deps.killProcessTree === 'function' ? deps.killProcessTree : killProcessTree

  /** @type {Map<string, {kind: 'prompt'|'shell', handle?: object, child?: object, sessionId?: string}>} */
  const active = new Map()
  /** 在飞的通知写入（`waitIdle` 要等它们落盘）。 */
  const pendingNotifications = new Set()

  const offRunFinished = store.on('run-finished', payload => {
    // 通知是「事后动作」：失败只记日志，绝不影响执行或调度（spec §7 的通知不改变成败）。
    const work = Promise.resolve()
      .then(() => notifyRun(payload))
      .catch(error => { log(`通知写入失败：${error instanceof Error ? error.message : String(error)}`) })
    pendingNotifications.add(work)
    work.finally(() => pendingNotifications.delete(work))
  })

  /**
   * 把一次终态运行追加到任务的通知文件（spec §7）。
   * @param {{taskId: string, run: Record<string, unknown>}} payload - `run-finished` 事件载荷。
   * @returns {Promise<{path: string, created: boolean}|null>} 写入结果；任务不存在时为 null。
   */
  async function notifyRun(payload) {
    const taskId = String(payload?.taskId ?? payload?.run?.taskId ?? '')
    if (taskId === '') return null
    const task = store.findTask(taskId, { includeDeleted: true })
    if (task === null || task === undefined) return null
    const run = payload.run ?? store.latestRunOf(taskId)
    if (run === null || run === undefined) return null
    const result = await notifyImpl({ task, run, dataRoot: store.dataRoot, fs: fsImpl })
    log(`通知已追加：${result.path}${result.created === true ? '（新建）' : ''}`)
    return result
  }

  /** 等到所有在飞的通知写入完成。 */
  async function waitIdle() {
    while (pendingNotifications.size > 0) {
      await Promise.allSettled([...pendingNotifications])
    }
  }

  /** 解析平台依赖（注入优先）。 */
  async function resolvePlatform() {
    if (typeof deps.createUserMessage === 'function'
      && typeof deps.setSandboxMode === 'function'
      && typeof deps.setApprovalPolicy === 'function') {
      return {
        createUserMessage: deps.createUserMessage,
        setSandboxMode: deps.setSandboxMode,
        setApprovalPolicy: deps.setApprovalPolicy,
      }
    }
    return await loadPlatformDeps()
  }

  /** 取 agents 服务（注入优先，其次 `ctx.get('agents')`）。 */
  function resolveAgents() {
    if (deps.agents !== undefined && deps.agents !== null) return deps.agents
    if (ctx === undefined || ctx === null) return undefined
    if (typeof ctx.get === 'function') return ctx.get('agents')
    return ctx.agents
  }

  /**
   * 取 DSH 当前部署默认模型，供新会话的 `agentOptions` 使用。
   *
   * **为什么必须显式给**：宿主组装 system prompt 时会填 `{{model}}`（section
   * `deployment:persona-prefix`）；创建 agent 时若完全不指定模型路由，该变量没有值，
   * 会话创建会直接抛 `prompt variable "{{model}}" has no value for this assembly`。
   * 所以「跟随 DSH 当前默认模型」（spec §7：任务不指定模型）的正确落地是
   * **把默认模型显式取出来交给宿主**，而不是省略 `agentOptions`。
   * 来源：`@deepseek-ai/dsh-agent-default-model` 注册的 `agentDefaultModel` 服务
   * （`currentSelection() → { provider, model, reasoningEffort? }`）。
   * @returns {{provider: string, model: string}|null} 取不到时返回 null，交由宿主报错。
   */
  function resolveDefaultModel() {
    try {
      const service = deps.defaultModel !== undefined && deps.defaultModel !== null
        ? deps.defaultModel
        : (ctx !== undefined && ctx !== null && typeof ctx.get === 'function' ? ctx.get('agentDefaultModel') : undefined)
      if (service === undefined || service === null || typeof service.currentSelection !== 'function') return null
      const selection = service.currentSelection()
      if (selection === null || selection === undefined) return null
      const provider = String(selection.provider ?? '')
      const model = String(selection.model ?? '')
      if (provider === '' || model === '') return null
      return { provider, model }
    } catch {
      return null
    }
  }

  /**
   * 取部署默认的 agent preset id。
   *
   * **为什么必须给**：preset 就是 agent 自己的 cordis 组合，基础工具集（文件系统 / Shell / web 等）
   * 由 preset 挂载。不给 preset 时，新会话只剩部署级插件注册的工具（例如各插件自己的工具），
   * 变成一个「没有文件系统 / Shell 工具」的残废 agent —— 任务 prompt 再正确也做不了事。
   * 来源：`@deepseek-ai/dsh-agent-presets` 注册的 `agentPresets` 服务的 `defaultId` getter。
   * @returns {string|null} 取不到时返回 null（此时不传该字段）。
   */
  /**
   * 把默认 preset 的组合挂到新建 agent 的 scope 上。
   *
   * **这才是「给 agent 基础工具」的真正动作**：只在 `meta` 里写 `agentPreset` 名字不够 ——
   * 宿主自己的会话创建（`sessionController.createOrAdopt`）同样要把 preset 的 `setup` 交给
   * `agents.create`，其中就包含 `agentPresets.mount(agentCtx, id)`。少了这一步，任务会话
   * 只有部署级插件注册的工具（没有文件系统 / Shell），变成一个做不了事的 agent。
   * @param {string|null} presetId - 默认 preset id；null 时不做任何事。
   * @param {object} agentCtx - 新 agent 的上下文。
   * @returns {Promise<void>}
   */
  async function mountPreset(presetId, agentCtx) {
    if (presetId === null) return
    try {
      const service = deps.agentPresets !== undefined && deps.agentPresets !== null
        ? deps.agentPresets
        : (ctx !== undefined && ctx !== null && typeof ctx.get === 'function' ? ctx.get('agentPresets') : undefined)
      if (service === undefined || service === null || typeof service.mount !== 'function') return
      await service.mount(agentCtx, presetId)
    } catch (error) {
      log(`preset 挂载失败（${presetId}）：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  function resolveDefaultPreset() {
    try {
      const service = deps.agentPresets !== undefined && deps.agentPresets !== null
        ? deps.agentPresets
        : (ctx !== undefined && ctx !== null && typeof ctx.get === 'function' ? ctx.get('agentPresets') : undefined)
      if (service === undefined || service === null) return null
      const id = service.defaultId
      return typeof id === 'string' && id !== '' ? id : null
    } catch {
      return null
    }
  }

  // ── Prompt 型 ────────────────────────────────────────────────────────────

  /**
   * 在一个全新 agent 会话里执行任务 prompt。
   * @param {Record<string, unknown>} task - 任务。
   * @param {number} attempt - 第几次尝试。
   * @param {string|null} sessionIdHint - 预分配的会话 id（排队转正时可能有）。
   * @returns {Promise<object>} 执行器结果（见 §8 执行器契约）。
   */
  /**
   * 会话首条消息的前缀：让 DSH 会话列表里一眼认出这是哪个任务、哪一次跑的。
   * 只影响发送内容，**不写回任务数据**（任务标题的派生用的仍是任务自己的 prompt）。
   * @param {Record<string, unknown>} task - 任务记录。
   * @param {Date} [now] - 触发时刻。
   * @returns {string} 前缀（以空行结尾）。
   */
  function promptBanner(task, now = new Date()) {
    const title = String(task.title ?? '').trim()
    const pad = value => String(value).padStart(2, '0')
    const stamp = `${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
    return `【任务】${title === '' ? '未命名任务' : title} · ${stamp}\n\n`
  }

  async function runPromptTask(task, attempt, sessionIdHint) {
    const resolved = resolveWorkspaceCwd(task.workspaceCwd)
    if (resolved.error !== undefined) {
      return { status: 'failed', summary: resolved.error, errorCode: 'invalid-workspace' }
    }
    const agents = resolveAgents()
    if (agents === undefined || agents === null || typeof agents.create !== 'function') {
      return {
        status: 'failed',
        summary: 'agents 服务不可用，无法开新会话（宿主 inject 需含 agents）',
        errorCode: 'runner-unavailable',
      }
    }
    let platform
    try {
      platform = await resolvePlatform()
    } catch (error) {
      return {
        status: 'failed',
        summary: error instanceof Error ? error.message : String(error),
        errorCode: 'runner-unavailable',
      }
    }

    const sessionId = typeof sessionIdHint === 'string' && sessionIdHint !== ''
      ? sessionIdHint
      : `session-${newId()}`
    const sandboxMode = toSandboxMode(task.permission)
    const autoApprove = task.autoApprove === true
    const taskId = String(task.id)
    const defaultModel = resolveDefaultModel()
    const defaultPreset = resolveDefaultPreset()
    let handle = null
    try {
      handle = await agents.create({
        sessionId,
        // meta.cwd 决定 workspace-write 的写入边界，且宿主组装 system prompt 时需要它。
        // **必须给**：任务没填工作区时用宿主进程的 cwd —— 按 DSH CLI 约定「运行命令时所在的
        // 目录即默认 workspace 根目录」，这正是「沿用宿主默认」的真实含义。缺了它宿主会抛
        // prompt variable "{{cwd}}" has no value for this assembly（section deployment:persona-suffix）。
        meta: {
          cwd: resolved.cwd === undefined ? process.cwd() : resolved.cwd,
          // preset 决定 agent 的工具集与人设；**不给 preset 的会话没有基础工具**。
          ...(defaultPreset === null ? {} : { agentPreset: defaultPreset }),
        },
        // 模型：**显式**把 DSH 部署默认模型交给宿主（spec §7「任务不指定模型」= 不覆盖默认值）。
        // 必须给：缺了它宿主组装 system prompt 时 {{model}} 没有值，会话创建直接失败
        // （prompt variable "{{model}}" has no value for this assembly, section deployment:persona-prefix）。
        // 宿主自身的会话创建同样用 `agentOptions: { provider, model }` 这一形状。
        ...(defaultModel === null ? {} : { agentOptions: defaultModel }),
        // 刻意不给 parentAgent、不设 meta.origin：任务会话必须是普通顶层会话，否则列表不可见。
        setup: async (agentCtx, agent) => {
          // 先挂载 preset 的组合（基础工具集在这里），再做本插件的沙箱/审批接线。
          await mountPreset(defaultPreset, agentCtx)
          platform.setSandboxMode(agent.session, sandboxMode)
          platform.setApprovalPolicy(agent.session, APPROVAL_POLICY)
          if (autoApprove) {
            // agent 作用域的应答者：只影响这个会话，绝不污染用户自己的会话。
            agentCtx.on('approval/request', async () => 'allowed-once')
          }
        },
      })
      active.set(taskId, { kind: 'prompt', handle, sessionId })

      // 首条用户消息 = 任务的执行 Prompt（必须在 create resolve 之后投递）。
      handle.agent.followup(platform.createUserMessage({
        content: [{ type: 'text', text: promptBanner(task) + String(task.prompt ?? '') }],
        source: { kind: 'user' },
      }))
      await handle.agent.whenIdle()

      const outcome = evaluateTurnOutcome(handle.agent)
      return {
        ...outcome,
        sessionId,
        tailOutput: assistantTail(handle.agent),
      }
    } catch (error) {
      return {
        status: 'failed',
        sessionId,
        summary: `会话执行失败：${error instanceof Error ? error.message : String(error)}`,
        errorCode: 'prompt-execute-error',
      }
    } finally {
      active.delete(taskId)
      if (handle !== null) {
        // dispose 只停循环、卸载作用域；会话与历史仍持久化（spec §11.1）。
        try {
          await handle.dispose()
        } catch (error) {
          log(`会话释放失败（会话仍已持久化）：${error instanceof Error ? error.message : String(error)}`)
        }
      }
      log(`Prompt 型第 ${attempt} 次执行结束：${sessionId}`)
    }
  }

  // ── shell 型 ─────────────────────────────────────────────────────────────

  /**
   * 以子进程执行 shell 任务。
   *
   * 输出策略：子进程的 stdout/stderr **直接重定向到任务日志文件**（`stdio: ['ignore', fd, fd]`），
   * 而不是经过管道——这样巨量输出不会撑爆内存、插件中途被杀也不会丢已产出的输出；
   * 运行记录只回读「本次运行那一段」的末 200 行（spec §7）。
   * @param {Record<string, unknown>} task - 任务。
   * @param {number} attempt - 第几次尝试。
   * @returns {Promise<object>} 执行器结果。
   */
  async function runShellTask(task, attempt) {
    const cmd = typeof task.cmd === 'string' ? task.cmd.trim() : ''
    if (cmd === '') {
      return { status: 'failed', summary: 'shell 型任务的 cmd 为空，未执行', errorCode: 'empty-cmd' }
    }
    const resolved = resolveWorkspaceCwd(task.workspaceCwd)
    if (resolved.error !== undefined) {
      return { status: 'failed', summary: resolved.error, errorCode: 'invalid-workspace' }
    }
    const logFilePath = store.resolveLogFilePath(task)
    let handle = null
    const startedAt = new Date(now()).toISOString()
    try {
      await fsImpl.mkdir(dirname(logFilePath), { recursive: true })
      const fromOffset = await fileSize(fsImpl, logFilePath)
      handle = await fsImpl.open(logFilePath, 'a')
      // 分隔头只写「时间 + 第几次」，**不写 cmd**：命令里的密码/令牌绝不复制进日志。
      await handle.write(`\n===== 第 ${attempt} 次运行 · 开始 ${startedAt} =====\n`)

      const child = spawnImpl(cmd, {
        ...(resolved.cwd === undefined ? {} : { cwd: resolved.cwd }),
        shell: true,
        windowsHide: true,
        stdio: ['ignore', handle.fd, handle.fd],
      })
      active.set(String(task.id), { kind: 'shell', child })
      const settled = await waitForChild(child)
      await handle.write(`===== 第 ${attempt} 次运行 · 结束 ${new Date(now()).toISOString()} · 退出码 ${settled.code ?? 'null'} =====\n`)
      await handle.close()
      handle = null

      const output = lastLines(await readSlice(fsImpl, logFilePath, fromOffset))
      if (settled.error !== undefined) {
        return {
          status: 'failed',
          exitCode: null,
          logFilePath,
          tailOutput: output,
          summary: `子进程启动失败：${settled.error.message}`,
          errorCode: 'spawn-error',
        }
      }
      const exitCode = typeof settled.code === 'number' ? settled.code : null
      if (exitCode === 0) {
        return { status: 'ok', exitCode: 0, logFilePath, tailOutput: output, summary: '命令退出码 0' }
      }
      return {
        status: 'failed',
        exitCode,
        logFilePath,
        tailOutput: output,
        summary: exitCode === null
          ? `命令被信号 ${String(settled.signal ?? '')} 终止`
          : `命令退出码 ${exitCode}`,
        errorCode: exitCode === null ? 'killed' : 'exit-code',
      }
    } catch (error) {
      return {
        status: 'failed',
        logFilePath,
        summary: `shell 执行失败：${error instanceof Error ? error.message : String(error)}`,
        errorCode: 'shell-execute-error',
      }
    } finally {
      active.delete(String(task.id))
      if (handle !== null) {
        try { await handle.close() } catch { /* 关闭失败不影响结果 */ }
      }
      log(`shell 型第 ${attempt} 次执行结束（日志：${logFilePath}）`)
    }
  }

  /**
   * 执行一次任务（`TaskScheduler` 的 `execute` 契约 + HTTP 立即执行共用）。
   * @param {{task: Record<string, unknown>, attempt?: number, sessionIdHint?: string|null}} input - 入参。
   * @returns {Promise<object>} `{ status, exitCode, sessionId, summary, tailOutput, logFilePath, errorCode }`。
   */
  async function execute(input) {
    const task = input?.task
    if (task === undefined || task === null) {
      throw new PluginError('internal', '执行器需要 task')
    }
    const attempt = Number.isInteger(input.attempt) && input.attempt > 0 ? input.attempt : 1
    if (task.execKind === 'shell') return await runShellTask(task, attempt)
    return await runPromptTask(task, attempt, input.sessionIdHint ?? null)
  }

  /**
   * 超时收尾钩子（调度器在 1 小时到点时调用）。
   * shell 型终止进程树；Prompt 型 `cancel()` 该会话（等 `whenIdle` 自然返回）。
   * @param {{task: object, attempt?: number}} input - 入参。
   */
  function onTimeout(input) {
    const taskId = String(input?.task?.id ?? '')
    const record = active.get(taskId)
    if (record === undefined) return
    if (record.kind === 'shell' && record.child !== undefined) {
      try { killProcessTreeImpl(record.child) } catch { /* 收尾失败不影响 timeout 记录 */ }
      return
    }
    if (record.kind === 'prompt' && record.handle?.agent !== undefined) {
      try { record.handle.agent.cancel({ kind: 'user' }, { keepInbox: false }) } catch { /* 同上 */ }
    }
  }
  execute.onTimeout = onTimeout

  /** 释放：取消事件订阅并等通知落盘（不终止正在跑的执行——那是 onTimeout 的职责）。 */
  async function dispose() {
    if (typeof offRunFinished === 'function') offRunFinished()
    await waitIdle()
  }

  /** 诊断快照（**不含任务内容**，可安全打日志）。 */
  function snapshot() {
    return {
      activeTaskIds: [...active.keys()],
      activeKinds: [...active.values()].map(record => record.kind),
      pendingNotifications: pendingNotifications.size,
      platformCached: platformCache !== null,
      unreadMarkerSupported: false,
    }
  }

  return { execute, waitIdle, dispose, notifyRun, snapshot, onTimeout, PERMISSION_SANDBOX_MODES }
}

// ── 进程工具 ────────────────────────────────────────────────────────────────

/** 文件大小（不存在按 0，便于「本次运行输出」切片）。 */
async function fileSize(fsImpl, path) {
  try {
    const info = await fsImpl.stat(path)
    return typeof info.size === 'number' ? info.size : 0
  } catch {
    return 0
  }
}

/** 读取 `[fromOffset, 文件末]` 的内容，最多回读 `MAX_TAIL_BYTES` 字节（从末尾截）。 */
async function readSlice(fsImpl, path, fromOffset) {
  const info = await fsImpl.stat(path)
  const end = info.size
  if (end <= fromOffset) return ''
  const start = Math.max(fromOffset, end - MAX_TAIL_BYTES)
  const length = end - start
  const handle = await fsImpl.open(path, 'r')
  try {
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, start)
    return buffer.toString('utf8')
  } finally {
    try { await handle.close() } catch { /* 忽略 */ }
  }
}

/** 等子进程结束（取第一个 settle 的事件：error 或 close）。 */
function waitForChild(child) {
  return new Promise(resolve => {
    let settled = false
    const settle = value => {
      if (settled) return
      settled = true
      resolve(value)
    }
    child.on('error', error => settle({ code: null, signal: null, error }))
    child.on('close', (code, signal) => settle({ code: code ?? null, signal: signal ?? null }))
  })
}

/**
 * 终止一个子进程及其进程树。
 *
 * Windows 上 `child.kill()` 只杀 shell 包装（cmd.exe），真正的命令可能继续跑；
 * 因此 Windows 走 `taskkill /T /F`（不经 shell，参数数组传递，无注入面）。
 * @param {object} child - `spawn` 返回的子进程。
 */
export function killProcessTree(child) {
  const pid = child?.pid
  if (pid === undefined || pid === null) {
    try { child?.kill?.() } catch { /* 忽略 */ }
    return
  }
  if (process.platform === 'win32') {
    try {
      const killer = nodeSpawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      killer.on('error', () => { try { child.kill() } catch { /* 忽略 */ } })
    } catch {
      try { child.kill() } catch { /* 忽略 */ }
    }
    return
  }
  try { child.kill('SIGKILL') } catch { /* 忽略 */ }
}
