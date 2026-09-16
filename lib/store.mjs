/**
 * dsh-task-scheduler — 存储层（宿主半侧，无外部依赖）
 *
 * 职责：任务与运行记录的内存模型 + 落盘持久化 + 变更事件。
 *
 * 落盘布局严格按 `docs/spec.md` §4，位于数据根 `<DSH_HOME>/dsh-task-scheduler/`：
 *   tasks.json  任务数组
 *   runs.json   全部运行记录数组（每条含 taskId）
 *   state.json  全局状态（paused + 分类表）
 *
 * 关键保证：
 *  1. **原子写**：所有写入经 `atomic-write.mjs`（同目录临时文件 + fsync + rename）。
 *  2. **进程重启不丢**：`init()` 从磁盘完整重建内存模型。
 *  3. **两个维度互斥**：进程内用串行 promise 队列；跨进程用数据根锁文件（`store.lock`）。
 *  4. **绝不写入凭据**：只持久化契约字段（`model.mjs` 的 TASK_FIELDS / RUN_FIELDS），
 *     不落任何环境变量、令牌或密码；任务内容原样保存以便前端回看。
 *
 * 事件（供 t3 调度器 / t4 运行器订阅）：
 *  - 'tasks-changed'     任务集合或字段变化（reason: created|updated|deleted|runtime|run-*）
 *  - 'run-queued'        一条运行记录以 queued 落盘（并发满时排队）
 *  - 'run-started'       一条运行记录进入 running
 *  - 'run-finished'      一条运行记录进入终态
 *  - 'paused-changed'    全局暂停开关变化
 *  - 'categories-changed' 分类表变化
 */
import { readFile } from 'node:fs/promises'
import {
  applyTaskPatch,
  createRunRecord,
  createTaskRecord,
  isPlainObject,
  latestRun,
  nextAttempt,
  normalizeCategories,
  normalizeGlobalState,
  PENDING_RUN_STATUSES,
  PluginError,
  reviveRun,
  reviveTask,
  TERMINAL_RUN_STATUSES,
  TASK_IMMUTABLE_FIELDS,
  TASK_RUNTIME_FIELDS,
  TASK_SERVER_MANAGED_FIELDS,
  orderTask,
} from './model.mjs'
import {
  defaultLogFilePath,
  defaultNotifyFilePath,
  lockFilePath,
  resolveDataRoot,
  runsFilePath,
  stateFilePath,
  tasksFilePath,
} from './paths.mjs'
import { ensureDir, readTextIfExists, withFileLock, writeJsonAtomic } from './atomic-write.mjs'

/** 各持久化文件的格式版本。 */
export const STORE_FORMAT_VERSION = 1

/** 事件名清单。 */
export const STORE_EVENTS = Object.freeze([
  'tasks-changed',
  'run-queued',
  'run-started',
  'run-finished',
  'paused-changed',
  'categories-changed',
])

/** 把任意异常包装成 E_STORAGE（保留原始 message 便于诊断）。 */
function storageError(message, cause) {
  const detail = cause instanceof Error ? cause.message : cause === undefined ? '' : String(cause)
  return new PluginError('storage', detail === '' ? message : `${message}：${detail}`)
}

/** 解析一个 JSON 文件为任意值（空文件视为 undefined）。 */
async function readJsonFile(filePath, label) {
  let text
  try {
    text = await readTextIfExists(filePath)
  } catch (error) {
    throw storageError(`读取 ${label} 失败`, error)
  }
  if (text === undefined || text.trim() === '') return undefined
  try {
    return JSON.parse(text)
  } catch (error) {
    throw storageError(`${label} 不是合法 JSON`, error)
  }
}

/**
 * 任务与运行记录存储。
 *
 * @example
 * const store = new TaskStore({ dataRoot: 'C:/tmp/x' })
 * await store.init()
 * const task = await store.createTask({ execKind: 'prompt', prompt: 'hello' })
 */
export class TaskStore {
  /**
   * @param {object} [options]
   * @param {string} [options.dataRoot] - 直接指定插件数据根（最高优先级，测试用）。
   * @param {string} [options.home] - 显式 DSH 主目录（宿主已解析的结果）。
   * @param {number} [options.lockTimeoutMs] - 跨进程写锁等待上限。
   * @param {boolean} [options.fileLock] - 是否启用跨进程 `store.lock`（默认 **false**，
   *   原因见 `atomic-write.mjs` 的 `withFileLock` 注释：本机实测该锁在「非 await 顶层进入」
   *   的调用链里会挂住，启用前必须在真实宿主上复验）。
   * @param {string} [options.logFilePath] - 便于分诊的日志文件路径（仅记录，不写内容）。
   */
  constructor(options = {}) {
    /** 插件数据根（绝对路径）。 */
    this.dataRoot = resolveDataRoot(options)
    /** 跨进程写锁等待上限。 */
    this.lockTimeoutMs = options.lockTimeoutMs ?? 5_000
    /** 是否启用跨进程文件锁（默认关闭，见类注释）。 */
    this.fileLockEnabled = options.fileLock === true
    /** 便于分诊的日志文件路径（可选）。 */
    this.logFilePath = options.logFilePath ?? ''
    /** @type {Map<string, Record<string, unknown>>} 任务 id → 任务对象（含软删除项）。 */
    this.tasks = new Map()
    /** @type {Map<string, Array<Record<string, unknown>>>} 任务 id → 运行记录（按 startedAt 降序）。 */
    this.runs = new Map()
    /** @type {{paused: boolean, categories: Array<object>, updatedAt: string|null}} 全局状态。 */
    this.global = normalizeGlobalState({})
    /** 是否已完成一次 init。 */
    this.ready = false
    /** @type {Map<string, Set<(payload: unknown) => void>>} 事件订阅表。 */
    this.listeners = new Map()
    /** 写入串行队列（进程内不交错写盘）。 */
    this.queue = Promise.resolve()
  }

  // ── 生命周期 ─────────────────────────────────────────────────────────────

  /**
   * 从磁盘加载全部状态（文件不存在按空状态处理）。
   * 磁盘内容非法时抛 E_STORAGE（绝不用损坏数据覆盖可用数据）。
   * @returns {Promise<void>}
   */
  async init() {
    await ensureDir(this.dataRoot)
    this.tasks = await this.#loadTasks()
    this.global = await this.#loadState()
    this.runs = await this.#loadRuns()
    this.ready = true
  }

  /** 读取并校验 tasks.json。 */
  async #loadTasks() {
    const raw = await readJsonFile(tasksFilePath(this.dataRoot), 'tasks.json')
    /** @type {Map<string, Record<string, unknown>>} */
    const tasks = new Map()
    if (raw === undefined) return tasks
    if (!Array.isArray(raw)) {
      throw new PluginError('storage', 'tasks.json 顶层必须是数组')
    }
    for (const item of raw) {
      const task = reviveTask(item, { source: 'tasks.json' })
      if (tasks.has(task.id)) {
        throw new PluginError('storage', `tasks.json 中任务 id 重复：${task.id}`)
      }
      tasks.set(task.id, task)
    }
    return tasks
  }

  /** 读取并校验 state.json。 */
  async #loadState() {
    const raw = await readJsonFile(stateFilePath(this.dataRoot), 'state.json')
    if (raw === undefined) return normalizeGlobalState({})
    if (!isPlainObject(raw)) {
      throw new PluginError('storage', 'state.json 顶层必须是对象')
    }
    return normalizeGlobalState(raw, { source: 'state.json' })
  }

  /** 读取并校验 runs.json，并按 taskId 建立索引。 */
  async #loadRuns() {
    const raw = await readJsonFile(runsFilePath(this.dataRoot), 'runs.json')
    /** @type {Map<string, Array<Record<string, unknown>>>} */
    const runs = new Map()
    if (raw === undefined) return runs
    if (!Array.isArray(raw)) {
      throw new PluginError('storage', 'runs.json 顶层必须是数组')
    }
    for (const item of raw) {
      const run = reviveRun(item, { source: 'runs.json' })
      const list = runs.get(run.taskId) ?? []
      list.push(run)
      runs.set(run.taskId, list)
    }
    for (const list of runs.values()) {
      list.sort((a, b) => String(b.runId).localeCompare(String(a.runId)))
    }
    return runs
  }

  // ── 事件 ─────────────────────────────────────────────────────────────────

  /**
   * 订阅变更事件。
   * @param {string} event - STORE_EVENTS 之一。
   * @param {(payload: unknown) => void} listener - 监听函数。
   * @returns {() => void} 取消订阅。
   */
  on(event, listener) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set())
    this.listeners.get(event).add(listener)
    return () => { this.listeners.get(event)?.delete(listener) }
  }

  /** 触发事件（监听器异常绝不影响写入结果）。 */
  #emit(event, payload) {
    const set = this.listeners.get(event)
    if (!set) return
    for (const listener of [...set]) {
      try {
        listener(payload)
      } catch {
        /* 订阅方故障不得破坏存储一致性 */
      }
    }
  }

  // ── 写串行与互斥 ─────────────────────────────────────────────────────────

  /**
   * 把一次变更排进串行队列。
   *
   * 进程内并发由这条队列消除（同一进程永远不会交错写盘）；跨进程的额外加固
   * （`store.lock`）默认关闭，需要时用 `new TaskStore({ fileLock: true })` 打开。
   * @template T
   * @param {() => Promise<T>} work - 变更函数。
   * @returns {Promise<T>} 变更结果。
   */
  #serialize(work) {
    const run = async () => {
      if (!this.fileLockEnabled) return await work()
      try {
        return await withFileLock(lockFilePath(this.dataRoot), work, { timeoutMs: this.lockTimeoutMs })
      } catch (error) {
        if (error && typeof error === 'object' && error.code === 'ELOCKED') {
          throw new PluginError('busy', '另一个 dsh 进程正在写同一数据根，请稍后重试', {
            retryAfterMs: 1_000,
          })
        }
        throw error
      }
    }
    const next = this.queue.then(run, run)
    // 队列本身永远保持 resolved，避免一次失败毒化后续变更。
    this.queue = next.then(() => undefined, () => undefined)
    return next
  }

  /** 断言 init() 已完成。 */
  #assertReady() {
    if (!this.ready) {
      throw new PluginError('internal', 'TaskStore 尚未 init()，拒绝读写')
    }
  }

  /** 持久化 tasks.json（全部任务，含软删除项）。 */
  async #persistTasks() {
    try {
      await writeJsonAtomic(tasksFilePath(this.dataRoot), [...this.tasks.values()])
    } catch (error) {
      throw storageError('写入 tasks.json 失败', error)
    }
  }

  /** 持久化 runs.json（全部运行记录，按 runId 倒序，便于人工阅读）。 */
  async #persistRuns() {
    const all = []
    for (const list of this.runs.values()) all.push(...list)
    all.sort((a, b) => String(b.runId).localeCompare(String(a.runId)))
    try {
      await writeJsonAtomic(runsFilePath(this.dataRoot), all)
    } catch (error) {
      throw storageError('写入 runs.json 失败', error)
    }
  }

  /** 持久化 state.json。 */
  async #persistState() {
    try {
      await writeJsonAtomic(stateFilePath(this.dataRoot), {
        version: STORE_FORMAT_VERSION,
        paused: this.global.paused,
        categories: this.global.categories,
        updatedAt: this.global.updatedAt,
      })
    } catch (error) {
      throw storageError('写入 state.json 失败', error)
    }
  }

  // ── 查询 ─────────────────────────────────────────────────────────────────

  /**
   * 列出任务。
   * @param {object} [filter]
   * @param {string} [filter.category] - 只保留该分类 id。
   * @param {string} [filter.execKind] - 只保留该执行类型。
   * @param {boolean} [filter.enabledOnly] - 只保留启用中的任务。
   * @param {boolean} [filter.includeDeleted] - 是否包含软删除任务（默认 false）。
   * @param {string} [filter.query] - 在 title/description/prompt/cmd 中做不区分大小写包含匹配。
   * @returns {Array<Record<string, unknown>>} 任务列表（按 createdAt 降序）。
   */
  listTasks(filter = {}) {
    let list = [...this.tasks.values()]
    if (!filter.includeDeleted) list = list.filter(task => !task.deletedAt)
    if (typeof filter.category === 'string' && filter.category !== '') {
      list = list.filter(task => task.category === filter.category)
    }
    if (typeof filter.execKind === 'string' && filter.execKind !== '') {
      list = list.filter(task => task.execKind === filter.execKind)
    }
    if (filter.enabledOnly === true) list = list.filter(task => task.enabled === true)
    if (typeof filter.query === 'string' && filter.query.trim() !== '') {
      const needle = filter.query.trim().toLowerCase()
      list = list.filter(task => [
        task.title, task.description, task.prompt, task.cmd, task.category,
      ].some(value => typeof value === 'string' && value.toLowerCase().includes(needle)))
    }
    return list.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
  }

  /**
   * 按 id 或唯一前缀查找任务。
   * @param {unknown} id - 任务 id 或其唯一前缀。
   * @param {object} [options]
   * @param {boolean} [options.includeDeleted] - 是否允许命中软删除任务。
   * @returns {Record<string, unknown>|null} 任务对象或 null。
   * @throws {PluginError} E_CONFLICT（前缀不唯一）。
   */
  findTask(id, options = {}) {
    if (typeof id !== 'string' || id === '') return null
    const exact = this.tasks.get(id)
    if (exact !== undefined && (options.includeDeleted === true || !exact.deletedAt)) return exact
    const matches = [...this.tasks.values()]
      .filter(task => task.id.startsWith(id) && (options.includeDeleted === true || !task.deletedAt))
    if (matches.length === 1) return matches[0]
    if (matches.length > 1) {
      throw new PluginError('conflict', `任务 id 前缀不唯一：${id}`, {
        details: { taskId: id, matches: matches.map(task => task.id) },
      })
    }
    return null
  }

  /**
   * 按 id 或唯一前缀取任务，不存在则抛 E_NOT_FOUND。
   * @param {unknown} id - 任务 id 或其唯一前缀。
   * @param {object} [options] - 同 findTask。
   * @returns {Record<string, unknown>} 任务对象。
   */
  requireTask(id, options = {}) {
    const task = this.findTask(id, options)
    if (task === null) {
      throw new PluginError('not-found', `任务不存在：${String(id)}`, { details: { taskId: String(id) } })
    }
    return task
  }

  /** 全部运行记录（扁平数组，按 startedAt 降序）。 */
  allRuns() {
    const all = []
    for (const list of this.runs.values()) all.push(...list)
    return all.sort((a, b) => String(b.runId).localeCompare(String(a.runId)))
  }

  /**
   * 某个任务的运行记录。
   * @param {string} taskId - 任务 id。
   * @param {object} [options]
   * @param {number} [options.limit] - 最多返回多少条（默认 20）。
   * @param {number} [options.offset] - 跳过多少条（默认 0）。
   * @param {string[]} [options.statuses] - 只保留这些状态。
   * @returns {{ runs: Array<Record<string, unknown>>, total: number }} 记录列表与总数。
   */
  listRuns(taskId, options = {}) {
    const { limit = 20, offset = 0, statuses } = options
    const all = this.runs.get(taskId) ?? []
    const filtered = Array.isArray(statuses) && statuses.length > 0
      ? all.filter(run => statuses.includes(String(run.status)))
      : all
    return {
      runs: filtered.slice(Math.max(0, offset), Math.max(0, offset) + Math.max(0, limit)),
      total: filtered.length,
    }
  }

  /**
   * 精确取一条运行记录。
   * @param {string} taskId - 任务 id。
   * @param {string} runId - 运行 id（或唯一前缀）。
   * @returns {Record<string, unknown>} 运行记录。
   * @throws {PluginError} E_NOT_FOUND / E_CONFLICT。
   */
  requireRun(taskId, runId) {
    const list = this.runs.get(taskId) ?? []
    const exact = list.find(run => run.runId === runId)
    if (exact !== undefined) return exact
    const matches = list.filter(run => String(run.runId).startsWith(runId))
    if (matches.length === 1) return matches[0]
    if (matches.length > 1) {
      throw new PluginError('conflict', `运行 id 前缀不唯一：${runId}`, { details: { runId } })
    }
    throw new PluginError('not-found', `运行记录不存在：${runId}`, { details: { runId, taskId } })
  }

  /** 最近的运行记录（指定任务或全局）。 */
  latestRunOf(taskId) {
    if (typeof taskId === 'string' && taskId !== '') return latestRun(this.runs.get(taskId) ?? [])
    return latestRun(this.allRuns())
  }

  /** 非终态的运行记录（queued + running）。 */
  pendingRuns() {
    const list = []
    for (const runs of this.runs.values()) {
      for (const run of runs) {
        if (PENDING_RUN_STATUSES.includes(String(run.status))) list.push(run)
      }
    }
    return list
  }

  /** 仍在 running 的运行记录。 */
  runningRuns() {
    return this.pendingRuns().filter(run => run.status === 'running')
  }

  /** 排队中的运行记录（按 queuedAt/startedAt 升序，先进先出）。 */
  queuedRuns() {
    return this.pendingRuns()
      .filter(run => run.status === 'queued')
      .sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)))
  }

  /** 当前处于 running/queued 的任务 id 集合（重叠判定用）。 */
  runningTaskIds() {
    const ids = new Set()
    for (const run of this.pendingRuns()) ids.add(String(run.taskId))
    return ids
  }

  /** 全局状态快照（含分类表与统计）。 */
  state() {
    return {
      paused: this.global.paused,
      categories: this.global.categories.map(category => ({ ...category })),
      updatedAt: this.global.updatedAt,
      taskCount: this.listTasks().length,
      runningCount: this.runningRuns().length,
      queuedCount: this.queuedRuns().length,
    }
  }

  /**
   * 某个任务的实际日志文件路径（`logFilePath` 为 null 时用默认 `logs/<taskId>.log`）。
   * @param {Record<string, unknown>} task - 任务对象。
   * @returns {string} 绝对路径。
   */
  resolveLogFilePath(task) {
    const custom = typeof task.logFilePath === 'string' ? task.logFilePath.trim() : ''
    return custom === '' ? defaultLogFilePath(this.dataRoot, String(task.id)) : custom
  }

  /**
   * 某个任务的实际 markdown 通知文件路径（`notifyFile` 为 null 时用默认 `notify/<taskId>.md`）。
   * @param {Record<string, unknown>} task - 任务对象。
   * @returns {string} 绝对路径。
   */
  resolveNotifyFilePath(task) {
    const custom = typeof task.notifyFile === 'string' ? task.notifyFile.trim() : ''
    return custom === '' ? defaultNotifyFilePath(this.dataRoot, String(task.id)) : custom
  }

  // ── 任务变更 ─────────────────────────────────────────────────────────────

  /**
   * 新建任务。
   * @param {unknown} input - 请求体。
   * @param {object} [options]
   * @param {number} [options.now] - 注入创建时间戳（可测试性；HTTP 路径不传）。
   * @returns {Promise<Record<string, unknown>>} 新任务。
   */
  createTask(input, options = {}) {
    this.#assertReady()
    return this.#serialize(async () => {
      const task = createTaskRecord(input, options.now === undefined ? {} : { now: options.now })
      this.tasks.set(task.id, task)
      await this.#persistTasks()
      this.#emit('tasks-changed', { reason: 'created', taskId: task.id, task })
      return task
    })
  }

  /**
   * 更新任务（PATCH 语义）。
   *
   * 接受用户可配置字段（含 `logFilePath`/`notifyFile`，可显式传 `null` 回到默认路径）；
   * **服务端管理字段一律拒写**：`id`、`createdAt`、`nextRunAt`、`lastRunAt`、`lastStatus`、
   * `runCount`、`sessionIds`、`updatedAt`（它们只能由 scheduler / runner 经 `patchRuntime` 写）。
   * @param {string} id - 任务 id。
   * @param {unknown} patch - 请求体。
   * @returns {Promise<Record<string, unknown>>} 更新后的任务。
   */
  updateTask(id, patch) {
    this.#assertReady()
    if (isPlainObject(patch)) {
      const rejected = Object.keys(patch).filter(key =>
        TASK_IMMUTABLE_FIELDS.includes(key) || TASK_SERVER_MANAGED_FIELDS.includes(key))
      if (rejected.length > 0) {
        throw new PluginError('bad-request', `以下字段由服务端管理，不可通过更新接口改写：${rejected.join(', ')}`, {
          details: { rejected, immutable: [...TASK_IMMUTABLE_FIELDS], serverManaged: [...TASK_SERVER_MANAGED_FIELDS] },
        })
      }
    }
    return this.#serialize(async () => {
      const current = this.requireTask(id)
      const next = applyTaskPatch(current, patch)
      this.tasks.set(next.id, next)
      await this.#persistTasks()
      this.#emit('tasks-changed', { reason: 'updated', taskId: next.id, task: next, previous: current })
      return next
    })
  }

  /**
   * 运行时字段写回（由 scheduler / runner 调用，不经 HTTP；不触发 HTTP 校验）。
   * @param {string} id - 任务 id。
   * @param {Partial<Record<'notifyFile'|'nextRunAt'|'lastRunAt'|'lastStatus'|'runCount'|'sessionIds'|'updatedAt', unknown>>} runtime - 运行时字段。
   * @returns {Promise<Record<string, unknown>>} 更新后的任务。
   */
  patchRuntime(id, runtime) {
    this.#assertReady()
    const rejected = Object.keys(runtime).filter(key => !TASK_RUNTIME_FIELDS.includes(key))
    if (rejected.length > 0) {
      throw new PluginError('internal', `patchRuntime 不接受字段：${rejected.join(', ')}`, { details: { rejected } })
    }
    return this.#serialize(async () => {
      const current = this.tasks.get(id)
      if (current === undefined) {
        throw new PluginError('not-found', `任务不存在：${String(id)}`, { details: { taskId: String(id) } })
      }
      const next = orderTask({ ...current, ...runtime })
      this.tasks.set(next.id, next)
      await this.#persistTasks()
      this.#emit('tasks-changed', { reason: 'runtime', taskId: next.id, task: next, previous: current })
      return next
    })
  }

  /**
   * 软删除任务：任务从列表消失，但运行记录保留（spec §9「历史全部保留，不自动清理」）。
   * @param {string} id - 任务 id。
   * @returns {Promise<{ taskId: string, deletedAt: string }>} 删除结果。
   */
  deleteTask(id) {
    this.#assertReady()
    return this.#serialize(async () => {
      const current = this.requireTask(id)
      const deletedAt = new Date().toISOString()
      const next = orderTask({ ...current, deletedAt, updatedAt: deletedAt })
      this.tasks.set(next.id, next)
      await this.#persistTasks()
      this.#emit('tasks-changed', { reason: 'deleted', taskId: next.id, task: next, previous: current })
      return { taskId: next.id, deletedAt }
    })
  }

  // ── 运行记录变更 ─────────────────────────────────────────────────────────

  /**
   * 放行一次运行（生成 runId 与 attempt，落盘并同步任务的 lastRunAt/runCount）。
   * `status` 为 `running` 时表示立即开跑；为 `queued` 时表示并发已满、排队等待。
   * @param {string} id - 任务 id。
   * @param {object} [options]
   * @param {string} [options.trigger] - 触发来源（schedule|manual|retry|catchup）。
   * @param {string} [options.status] - running（默认）或 queued。
   * @param {string} [options.sessionId] - 预先拿到的会话 id。
   * @param {string} [options.startedAt] - 开始/入队时间。
   * @param {string} [options.scheduledFor] - 计划触发时刻（ISO）。
   * @param {string} [options.summary] - 初始摘要。
   * @returns {Promise<Record<string, unknown>>} 新的运行记录。
   */
  startRun(id, options = {}) {
    this.#assertReady()
    const status = options.status ?? 'running'
    if (status !== 'running' && status !== 'queued') {
      throw new PluginError('internal', `startRun 的 status 只能是 running 或 queued，实际为 ${String(status)}`)
    }
    return this.#serialize(async () => {
      const task = this.requireTask(id)
      const existing = this.runs.get(task.id) ?? []
      const startedAt = options.startedAt ?? new Date().toISOString()
      const run = createRunRecord({
        taskId: task.id,
        attempt: nextAttempt(existing),
        trigger: options.trigger,
        status,
        sessionId: options.sessionId ?? null,
        startedAt,
        summary: options.summary ?? '',
        logFilePath: task.execKind === 'shell' ? this.resolveLogFilePath(task) : null,
        scheduledFor: options.scheduledFor,
        ...(status === 'queued' ? { queuedAt: startedAt } : {}),
      })
      this.runs.set(task.id, [run, ...existing])
      await this.#persistRuns()
      const nextTask = orderTask({
        ...task,
        lastRunAt: startedAt,
        lastStatus: status,
        runCount: (typeof task.runCount === 'number' ? task.runCount : 0) + 1,
        updatedAt: startedAt,
        sessionIds: run.sessionId === null
          ? task.sessionIds
          : [...new Set([...(task.sessionIds ?? []), run.sessionId])],
      })
      this.tasks.set(nextTask.id, nextTask)
      await this.#persistTasks()
      this.#emit(status === 'queued' ? 'run-queued' : 'run-started', { taskId: nextTask.id, run, task: nextTask })
      this.#emit('tasks-changed', { reason: `run-${status}`, taskId: nextTask.id, task: nextTask })
      return run
    })
  }

  /**
   * 把一条排队中的运行转为 running（调度器在有空位时调用）。
   * @param {string} runId - 运行 id。
   * @param {string} [sessionId] - 会话 id（prompt 型）。
   * @returns {Promise<Record<string, unknown>>} 更新后的运行记录。
   */
  promoteQueuedRun(runId, sessionId) {
    this.#assertReady()
    return this.#serialize(async () => {
      const located = this.#locateRun(runId)
      if (located === null) {
        throw new PluginError('not-found', `运行记录不存在：${String(runId)}`, { details: { runId: String(runId) } })
      }
      const { taskId, index } = located
      const list = this.runs.get(taskId) ?? []
      const current = list[index]
      if (current.status !== 'queued') {
        throw new PluginError('conflict', `运行记录不在排队中：${String(current.status)}`, {
          details: { runId: String(runId), status: String(current.status) },
        })
      }
      const updated = reviveRun(
        { ...current, status: 'running', sessionId: sessionId ?? current.sessionId },
        { source: `运行记录 ${String(runId)}` },
      )
      const nextList = [...list]
      nextList[index] = updated
      this.runs.set(taskId, nextList)
      await this.#persistRuns()
      this.#emit('run-started', { taskId, run: updated })
      return updated
    })
  }

  /**
   * 结束一次运行：写入终态、endedAt、sessionId、exitCode、tailOutput、summary。
   * @param {string} runId - 运行 id。
   * @param {object} result
   * @param {string} result.status - ok|failed|timeout|skipped_overlap（不允许 queued/running）。
   * @param {number|null} [result.exitCode] - 退出码。
   * @param {string} [result.tailOutput] - 输出尾部（自动截断到末 200 行）。
   * @param {string} [result.summary] - 一句话摘要。
   * @param {string|null} [result.sessionId] - 会话 id。
   * @param {string} [result.endedAt] - 结束时间。
   * @param {string} [result.errorCode] - 失败时的稳定错误码。
   * @param {string|null} [result.logFilePath] - 覆盖完整输出路径。
   * @returns {Promise<Record<string, unknown>>} 更新后的运行记录。
   */
  finishRun(runId, result) {
    this.#assertReady()
    const status = result?.status
    if (!TERMINAL_RUN_STATUSES.includes(status)) {
      throw new PluginError('internal', `finishRun 只接受终态 ${TERMINAL_RUN_STATUSES.join(' | ')}，实际为 ${String(status)}`)
    }
    return this.#serialize(async () => {
      const located = this.#locateRun(runId)
      if (located === null) {
        throw new PluginError('not-found', `运行记录不存在：${String(runId)}`, { details: { runId: String(runId) } })
      }
      const { taskId, index } = located
      const list = this.runs.get(taskId) ?? []
      const current = list[index]
      if (TERMINAL_RUN_STATUSES.includes(String(current.status))) {
        throw new PluginError('conflict', `运行记录已处于终态：${String(current.status)}`, {
          details: { runId: String(runId), status: String(current.status) },
        })
      }
      const endedAt = result.endedAt ?? new Date().toISOString()
      const updated = {
        ...current,
        endedAt,
        status,
        sessionId: result.sessionId === undefined ? current.sessionId : result.sessionId,
        exitCode: result.exitCode === undefined ? current.exitCode : result.exitCode,
        tailOutput: result.tailOutput === undefined ? current.tailOutput : result.tailOutput,
        summary: result.summary === undefined ? current.summary : result.summary,
        logFilePath: result.logFilePath === undefined ? current.logFilePath : result.logFilePath,
        ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
      }
      const normalized = reviveRun(updated, { source: `运行记录 ${String(runId)}` })
      const nextList = [...list]
      nextList[index] = normalized
      this.runs.set(taskId, nextList)
      await this.#persistRuns()
      const task = this.tasks.get(taskId)
      if (task !== undefined) {
        const nextTask = orderTask({
          ...task,
          lastStatus: normalized.status,
          lastRunAt: normalized.startedAt,
          updatedAt: endedAt,
          sessionIds: normalized.sessionId === null
            ? task.sessionIds
            : [...new Set([...(task.sessionIds ?? []), String(normalized.sessionId)])],
        })
        this.tasks.set(nextTask.id, nextTask)
        await this.#persistTasks()
        this.#emit('tasks-changed', { reason: 'run-finished', taskId: nextTask.id, task: nextTask })
      }
      this.#emit('run-finished', { taskId, run: normalized })
      return normalized
    })
  }

  /** 在内存中定位一条运行记录（返回其所属任务与下标）。 */
  #locateRun(runId) {
    for (const [taskId, list] of this.runs) {
      const index = list.findIndex(run => run.runId === runId)
      if (index >= 0) return { taskId, index }
    }
    return null
  }

  // ── 全局状态 ─────────────────────────────────────────────────────────────

  /**
   * 设置全局暂停开关（spec §3 全局状态）。
   * @param {unknown} paused - 必须是布尔值。
   * @returns {Promise<{ paused: boolean, updatedAt: string }>} 新状态。
   */
  setPaused(paused) {
    this.#assertReady()
    if (typeof paused !== 'boolean') {
      throw new PluginError('bad-request', '"paused" 必须是布尔值', { details: { field: 'paused' } })
    }
    return this.#serialize(async () => {
      const updatedAt = new Date().toISOString()
      this.global = { ...this.global, paused, updatedAt }
      await this.#persistState()
      this.#emit('paused-changed', { paused, updatedAt })
      return { paused, updatedAt }
    })
  }

  /**
   * 替换分类表（spec §8：默认四档，可自定义增删）。
   * @param {unknown} categories - 分类数组。
   * @returns {Promise<Array<{id: string, name: string, color: string}>>} 新分类表。
   */
  setCategories(categories) {
    this.#assertReady()
    const normalized = normalizeCategories(categories)
    return this.#serialize(async () => {
      const updatedAt = new Date().toISOString()
      this.global = { ...this.global, categories: normalized, updatedAt }
      await this.#persistState()
      this.#emit('categories-changed', { categories: normalized, updatedAt })
      return normalized
    })
  }
}
