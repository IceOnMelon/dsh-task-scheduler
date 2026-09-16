/**
 * dsh-task-scheduler — 调度循环（宿主半侧）
 *
 * 规格（docs/spec.md §6，已锁定，不得自行更改）：
 *  - 5 段 cron；下次触发点用 `lib/cron.mjs` 的 `nextRun(expr, fromDate)`（宿主本地时区）
 *  - **漏跑**：默认「补跑最近一次」，任务可切「全部补跑」；没有漏跑时不产生多余运行
 *  - **重叠**：上一轮仍 running → 本轮记 `skipped_overlap`，**不启动新会话**
 *  - **并发**：同时最多 3 个运行中，超出写 `queued` 排队，有空位再起
 *  - **超时**：1 小时终止，记 `timeout`
 *  - **重试**：失败后延迟 5 分钟重试 1 次（`attempt=2`，同样开新会话）；再失败记 `failed` 不再重试
 *  - 定时器按最近触发点收敛，无任务时不空转烧 CPU
 *
 * 与 t4 的分工（关键）：本模块负责「什么时候、以什么策略调起一次运行」以及运行记录的
 * 状态机；**执行动作本身**（开新会话 / 跑 shell / 权限档位 / 通知写文件）由 t4 通过
 * `dependencies.execute(input)` 注入：
 *
 *   execute({ task, sessionIdHint }) → Promise<{
 *     status?: 'ok' | 'failed',      // 缺省按 exitCode 判定
 *     exitCode?: number | null,
 *     sessionId?: string | null,
 *     summary?: string,
 *     tailOutput?: string,
 *     logFilePath?: string | null,
 *     errorCode?: string,
 *   }>
 *
 * 若没有注册 execute（t4 尚未接线），调度器**不会静默跳过**：它照常占用一次运行记录，
 * 并以 `failed` + `errorCode: 'runner-unavailable'` 明确收尾，这样 UI 上看得见「到点了但没人执行」。
 */
import { CronError, nextRun } from './cron.mjs'

/** 并发上限：同时 running 的运行数（spec §6）。 */
export const MAX_CONCURRENT_RUNS = 3

/** 单次运行超时（spec §6）：1 小时。 */
export const RUN_TIMEOUT_MS = 60 * 60 * 1000

/** 失败后重试延迟（spec §6）：5 分钟。 */
export const RETRY_DELAY_MS = 5 * 60 * 1000

/** 最多重试次数（spec §6）：重试 1 次。 */
export const MAX_RETRIES = 1

/** 漏跑补偿的扫描窗口：只看最近 24 小时内错过的触发点，绝不回放很久以前的历史。 */
export const CATCHUP_WINDOW_MS = 24 * 60 * 60 * 1000

/** 单次漏跑补偿最多补几个触发点（`all` 策略的兜底上限）。 */
export const CATCHUP_MAX_OCCURRENCES = 25

/**
 * 定时器收敛时允许的最小间隔（毫秒）：避免「刚好等于现在」导致忙转。
 * 不足该间隔时按该间隔延后，下一轮再收敛。
 */
const MIN_TIMER_DELAY_MS = 1000

/** 定时器最大间隔：Node 的 setTimeout 超过 2^31-1 会立刻触发，这里主动分段。 */
const MAX_TIMER_DELAY_MS = 60 * 60 * 1000

/** 运行结束状态 → 是否需要重试。 */
const RETRYABLE_STATUSES = Object.freeze(['failed', 'timeout'])

/**
 * 调度器。
 *
 * @example
 * const scheduler = new TaskScheduler({ store, execute: t4Execute })
 * await scheduler.start()
 * await scheduler.runNow({ taskId: task.id, trigger: 'manual' })
 */
export class TaskScheduler {
  /**
   * @param {object} options
   * @param {import('./store.mjs').TaskStore} options.store - 存储层。
   * @param {(input: {task: Record<string, unknown>, sessionIdHint: string|null}) => Promise<object>} [options.execute]
   *   执行器（t4 注入）。缺省时所有运行都以 runner-unavailable 收尾。
   * @param {(message: string) => void} [options.log] - 日志函数（只输出文本，绝不输出任务内容）。
   * @param {() => number} [options.now] - 注入时钟（测试用）。
   * @param {typeof setTimeout} [options.setTimeoutImpl] - 注入定时器（测试用）。
   * @param {typeof clearTimeout} [options.clearTimeoutImpl] - 注入清除定时器（测试用）。
   */
  constructor(options = {}) {
    if (options.store === undefined) throw new Error('TaskScheduler 需要 store')
    this.store = options.store
    this.executeImpl = typeof options.execute === 'function' ? options.execute : null
    this.log = typeof options.log === 'function' ? options.log : () => {}
    this.now = typeof options.now === 'function' ? options.now : () => Date.now()
    this.setTimeoutImpl = options.setTimeoutImpl ?? setTimeout
    this.clearTimeoutImpl = options.clearTimeoutImpl ?? clearTimeout
    /**
     * 是否对单次运行施加 1 小时超时（spec §6 要求）。
     * 测试里若用「假定时器」驱动调度，可传 `timeout: false` 关掉这个 race，
     * 否则假定时器上的超时永远不会到点，会让 race 一直挂着（生产环境必须保持开启）。
     */
    this.timeoutEnabled = options.timeout !== false
    /**
     * 超时 / 重试延迟用的定时器对（默认真实 `setTimeout`）。
     * 与「排期定时器」（`setTimeoutImpl`）分开：排期定时器需要可被测试虚拟推进，
     * 而超时/重试是真实等待，两者混用会让测试与生产语义互相污染。
     */
    this.timeoutSetTimeout = options.timeoutSetTimeout ?? setTimeout
    this.timeoutClearTimeout = options.timeoutClearTimeout ?? clearTimeout
    /** 单次运行超时毫秒数（spec §6 固定 1 小时；测试可注入更短值）。 */
    this.runTimeoutMs = options.runTimeoutMs ?? RUN_TIMEOUT_MS
    /** 失败重试延迟毫秒数（spec §6 固定 5 分钟；测试可注入更短值）。 */
    this.retryDelayMs = options.retryDelayMs ?? RETRY_DELAY_MS

    /** @type {Map<string, number>} taskId → 定时器句柄。 */
    this.timers = new Map()
    /** @type {Map<string, string>} taskId → 正在执行的 runId。 */
    this.activeRuns = new Map()
    /** @type {Set<string>} 正在放行中的 taskId（startRun 已发出、尚未返回）。 */
    this.pendingFires = new Set()
    /** @type {Set<string>} 已占用并发额度、但还没写进 activeRuns 的 taskId（消除额度竞态）。 */
    this.reservedSlots = new Set()
    /** @type {Map<string, { taskId: string, attempt: number, timer: number }>} runId → 待重试计划。 */
    this.pendingRetries = new Map()
    /** @type {Map<string, string>} taskId → 已处理过的最新计划时刻（ISO），用于漏跑判定。 */
    this.lastScheduledAt = new Map()
    /** 是否已 start。 */
    this.started = false
    /** 全局定时器句柄（收敛后的最近一次触发）。 */
    this.globalTimer = null
    /** 在飞的异步工作数（tick / drive / 重试 / 排队提升），供诊断与测试等待。 */
    this.inflight = 0
    /** @type {Set<Promise<unknown>>} 在飞工作的 promise 集合（配合 waitIdle）。 */
    this.inflightPromises = new Set()
    /** @type {Array<() => void>} 空闲等待者。 */
    this.idleWaiters = []
  }

  /**
   * 跟踪一个后台工作：结束后递减 inflight 并 resolve 等待者。
   * 返回的 promise 同时可被调用方 await（调用方 await 不会改变内部计数语义）。
   */
  trackWork(promise) {
    this.inflight += 1
    const tracked = Promise.resolve(promise).then(
      (value) => { this.#workDone(); return value },
      (error) => { this.#workDone(); throw error },
    )
    this.inflightPromises.add(tracked)
    tracked.catch(() => undefined)
    return tracked
  }

  /** 单个工作结束：递减计数并唤醒等待者。 */
  #workDone() {
    this.inflight = Math.max(0, this.inflight - 1)
    if (this.inflight === 0) {
      const waiters = this.idleWaiters
      this.idleWaiters = []
      for (const resolve of waiters) resolve()
    }
  }

  /**
   * 等到当前所有在飞工作（tick / 执行 / 重试 / 排队提升）结束。
   * 宿主侧用它做优雅停机；测试用它做确定性推进（不需要 sleep 猜时序）。
   * @returns {Promise<void>} 空闲后 resolve。
   */
  async waitIdle() {
    // 反复等到「一轮结束后仍没有新工作」，因为收尾动作可能再排新工作（如重试、补位）。
    for (let round = 0; round < 100; round += 1) {
      if (this.inflight === 0) return
      await new Promise(resolve => this.idleWaiters.push(resolve))
    }
  }

  // ── 生命周期 ─────────────────────────────────────────────────────────────

  /**
   * 启动调度：清点孤儿运行、计算每个任务的 nextRunAt、收敛定时器。
   *
   * 「孤儿运行」= 上次进程被杀时留在 `running` 的记录。本进程不可能知道它是否还在跑，
   * 因此按 `failed` 收尾并注明原因（否则该任务会被永久判为「重叠」而再也不触发）。
   * @returns {Promise<{ recoveredOrphans: number, scheduled: number }>} 启动统计。
   */
  async start() {
    if (this.started) return { recoveredOrphans: 0, scheduled: 0 }
    this.started = true

    const recoveredOrphans = await this.#recoverOrphanRuns()
    for (const task of this.store.listTasks()) {
      this.#installTask(task)
    }
    await this.#reconcileTimers()
    return { recoveredOrphans, scheduled: this.#scheduledTaskIds().length }
  }

  /** 停止调度：清空所有定时器与重试计划（不影响已落盘的运行记录）。 */
  stop() {
    this.started = false
    for (const timer of this.timers.values()) this.clearTimeoutImpl(timer)
    this.timers.clear()
    for (const plan of this.pendingRetries.values()) this.clearTimeoutImpl(plan.timer)
    this.pendingRetries.clear()
    if (this.globalTimer !== null) {
      this.clearTimeoutImpl(this.globalTimer)
      this.globalTimer = null
    }
  }

  /** 上次进程留下的 running 记录 → failed（见 start 的说明）。 */
  async #recoverOrphanRuns() {
    const orphans = this.store.runningRuns()
    for (const run of orphans) {
      try {
        await this.store.finishRun(String(run.runId), {
          status: 'failed',
          summary: '宿主进程重启，运行被中断',
          errorCode: 'interrupted',
          endedAt: new Date(this.now()).toISOString(),
        })
      } catch {
        // 记录可能已被别的路径收尾；忽略即可，不能因此启动失败。
      }
    }
    return orphans.length
  }

  // ── 任务登记与定时器收敛 ─────────────────────────────────────────────────

  /**
   * 任务变更钩子：由插件入口在 `store.on('tasks-changed')` 上调用，
   * 让新增/改动 cron 的任务立刻进入调度，无需重启。
   * @param {{ reason?: string, taskId?: string }} payload - 存储事件载荷。
   * @returns {Promise<void>}
   */
  async onTasksChanged(payload = {}) {
    const { reason, taskId } = payload
    if (typeof taskId !== 'string') {
      await this.#reconcileTimers()
      return
    }
    const task = this.store.findTask(taskId, { includeDeleted: true })
    if (task === undefined || task === null || task.deletedAt !== undefined) {
      this.#uninstallTask(taskId)
    } else if (reason === 'updated' || reason === 'created' || reason === 'runtime') {
      this.#installTask(task)
    }
    await this.#reconcileTimers()
  }

  /** 把任务纳入调度（计算 nextRunAt、装定时器）。 */
  #installTask(task) {
    const taskId = String(task.id)
    const skipped = !task.enabled || String(task.cron).trim() === ''
    if (skipped) {
      this.#uninstallTask(taskId)
      return
    }
    try {
      const next = nextRun(String(task.cron), new Date(this.now()))
      this.#scheduleTimer(taskId, next.getTime())
    } catch (error) {
      // cron 非法：不排期，也不炸调度器（HTTP 层已在写入时做过结构性校验）。
      this.#uninstallTask(taskId)
      this.log(`任务 ${taskId} 的 cron 无法解析，已跳过排期：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** 把任务移出调度。 */
  #uninstallTask(taskId) {
    const timer = this.timers.get(taskId)
    if (timer !== undefined) {
      this.clearTimeoutImpl(timer)
      this.timers.delete(taskId)
    }
  }

  /** 为某任务装一个到 `fireAt` 的定时器。 */
  #scheduleTimer(taskId, fireAt) {
    this.#uninstallTask(taskId)
    const delay = Math.max(MIN_TIMER_DELAY_MS, fireAt - this.now())
    const timer = this.setTimeoutImpl(() => {
      this.timers.delete(taskId)
      // 定时器回调**等待整次执行收尾**再返回：这样调度器不存在任何「没人 await 的后台链」，
      // 执行结果、超时、重试都确定可见。代价是单个任务的一次执行会占用一个定时器回调的
      // 生命周期（task 之间互不影响，并发由 activeRuns + 排队控制）。
      this.tick(taskId).catch(error => {
        this.log(`任务 ${taskId} 触发处理失败：${error instanceof Error ? error.message : String(error)}`)
      })
    }, delay)
    this.timers.set(taskId, timer)
  }

  /**
   * 定时器收敛：把「每个任务一个定时器」收敛成「按最近触发点调度」，
   * 保证没有任务时不空转（所有定时器清空、不设全局忙轮询）。
   */
  async #reconcileTimers() {
    const live = new Set()
    for (const task of this.store.listTasks()) {
      if (!task.enabled || String(task.cron).trim() === '') continue
      live.add(String(task.id))
      if (!this.timers.has(String(task.id))) this.#installTask(task)
    }
    for (const taskId of [...this.timers.keys()]) {
      if (!live.has(taskId)) this.#uninstallTask(taskId)
    }
  }

  /** 已排期的任务 id 列表（诊断用）。 */
  #scheduledTaskIds() {
    return [...this.timers.keys()]
  }

  // ── 触发与执行 ───────────────────────────────────────────────────────────

  /**
   * 某个任务的定时器到点：走完整的「重叠 → 并发 → 执行 → 重试」流程，并排下一次。
   *
   * `await tick(id)` 返回时，本次触发的执行**已进终态**（执行器结束、运行记录已收尾）。
   * 调度器内部没有 fire-and-forget 的执行链：定时器回调也 await 它，因此不存在
   * 「后台链被进程/运行时丢弃」的可能。
   * @param {string} taskId - 任务 id。
   * @returns {Promise<Record<string, unknown>|null>} 本次运行记录（停用/无 cron 时为 null）。
   */
  async tick(taskId) {
    const task = this.store.findTask(taskId)
    if (task === null || task === undefined) {
      this.#uninstallTask(taskId)
      return null
    }
    const scheduledFor = new Date(this.now()).toISOString()
    let run = null
    if (task.enabled && String(task.cron).trim() !== '') {
      run = await this.#fire(task, { trigger: 'schedule', scheduledFor })
    }
    // 无论本次是否真的开跑，都把「计划时刻」推进到下一点，避免同一触发点被反复处理。
    try {
      const next = nextRun(String(task.cron), new Date(this.now()))
      this.lastScheduledAt.set(String(task.id), next.toISOString())
      this.#scheduleTimer(String(task.id), next.getTime())
    } catch {
      this.#uninstallTask(String(task.id))
    }
    // 本次触发可能占满并发而把别的任务挤出排队：收尾时把队列**放行**到 running
    // （只放行、不等执行结束，避免与其他任务的执行形成嵌套等待）。
    await this.startQueuedRuns()
    return run
  }

  /**
   * 漏跑补偿：进程启动时（或任务新启用时）检查窗口内错过的触发点。
   *
   * 规则（spec §6）：
   *  - `missedRunPolicy: 'latest'`（默认）→ 只补**最近一次**错过的触发点；
   *  - `'all'` → 窗口内每个错过的触发点都补（上限 {@link CATCHUP_MAX_OCCURRENCES}）；
   *  - 没有漏跑 → **不产生任何运行**。
   *
   * 扫描窗口只覆盖最近 {@link CATCHUP_WINDOW_MS}，绝不回放很久以前的日程；
   * 全新任务（从未运行过、也没有已记录的 nextRunAt）视为「没有漏跑」。
   *
   * @param {object} [options]
   * @param {number} [options.nowMs] - 注入当前时间（测试用）。
   * @returns {Promise<{ taskId: string, trigger: string, runId: string, scheduledFor: string }[]>} 补跑记录。
   */
  async catchUp(options = {}) {
    const nowMs = options.nowMs ?? this.now()
    const created = []
    for (const task of this.store.listTasks()) {
      if (!task.enabled || String(task.cron).trim() === '') continue
      const missed = this.#missedOccurrences(task, nowMs)
      if (missed.length === 0) continue
      const policy = task.missedRunPolicy === 'all' ? 'all' : 'latest'
      const targets = policy === 'all' ? missed : [missed[missed.length - 1]]
      for (const at of targets) {
        const run = await this.#fire(task, { trigger: 'catchup', scheduledFor: at.toISOString() })
        if (run !== null) created.push({ taskId: String(task.id), trigger: 'catchup', runId: String(run.runId), scheduledFor: at.toISOString() })
      }
      await this.startQueuedRuns()
    }
    return created
  }

  /** 计算窗口内错过的触发点（升序）。 */
  #missedOccurrences(task, nowMs) {
    const cron = String(task.cron).trim()
    if (cron === '') return []
    const recorded = typeof task.nextRunAt === 'string' ? Date.parse(task.nextRunAt) : Number.NaN
    const lastRunMs = typeof task.lastRunAt === 'string' ? Date.parse(task.lastRunAt) : Number.NaN
    // 「全新任务」判定：从来没有运行过、也没有已记录的 nextRunAt。
    // 这类任务没有任何「本该跑但没跑」的历史，一律不补跑——否则刚建的任务会被
    // 最近 24 小时内的历史触发点命中，一建出来就自己跑一次。
    const isNewTask = Number.isNaN(recorded) && Number.isNaN(lastRunMs)
    if (isNewTask) return []
    let cursorMs
    if (!Number.isNaN(recorded)) {
      cursorMs = recorded
    } else {
      cursorMs = lastRunMs
    }
    const from = Math.max(cursorMs, nowMs - CATCHUP_WINDOW_MS)
    if (from > nowMs) return []

    // 关键：`from` 本身若正是一个触发点，它**也算漏跑**。
    // 例如「上次算出的 nextRunAt = 10:00，但进程在 09:30 被杀，10:00 从未执行」——
    // 这时 10:00 必须补。因此 `nextRun` 的下一步从 `from - 1ms` 起算（含 from 本身）。
    const occurrences = []
    let cursor = new Date(from - 1)
    for (let guard = 0; guard < CATCHUP_MAX_OCCURRENCES + 2; guard += 1) {
      let next
      try {
        next = nextRun(cron, cursor)
      } catch {
        return []
      }
      if (next.getTime() > nowMs) break
      occurrences.push(next)
      cursor = next
    }
    return occurrences.slice(-CATCHUP_MAX_OCCURRENCES)
  }

  /**
   * 立即执行一次（手动触发，也用于漏跑补跑与重试的内部调用）。
   *
   * **返回语义（t6 F6）**：返回的是 `startRun` 那一刻的**运行记录快照**（`status` 为 `running`
   * 或 `queued`），该对象**不会**随 `finishRun` 写入终态而更新；`running` 路径在本次执行收尾后
   * 才 resolve，`queued` 路径（并发已满）入队即 resolve。需要终态请用返回的 `runId` 查询
   * （`GET /tasks/<id>/runs/<runId>`）—— 前端 `POST /tasks/:id/run` 之后随即 `pollRun` 拿终态。
   * @param {object} input
   * @param {string} input.taskId - 任务 id。
   * @param {string} [input.trigger] - `manual`（默认）/`catchup`/`retry`/`schedule`。
   * @param {string} [input.scheduledFor] - 计划触发时刻（ISO）。
   * @param {boolean} [input.force] - 仅被透传、**当前不生效**：重叠判定无法跳过（spec §6 要求
   *   重叠必须记 `skipped_overlap` 且不启新会话，故本实现不提供绕过该判定的开关）。
   * @returns {Promise<Record<string, unknown>>} 刚放行那一刻的运行记录快照（`running` 或 `queued`）。
   * @throws {Error} 任务不存在或已删除。
   */
  async runNow(input) {
    const task = this.store.findTask(input.taskId)
    if (task === null || task === undefined) {
      const error = new Error(`任务不存在：${String(input.taskId)}`)
      error.code = 'not-found'
      throw error
    }
    return this.#fire(task, {
      trigger: input.trigger ?? 'manual',
      scheduledFor: input.scheduledFor,
      force: input.force === true,
    }).then(async (run) => {
      // 手动执行也可能把队列挤动：收尾时推进队列。
      await this.startQueuedRuns()
      return run
    })
  }

  /**
   * 放行一次运行：重叠 → 并发 → 落盘 → 执行 → 收尾 → 可能重试。
   *
   * 执行是**内联 await** 的：`running` 路径下 `await #fire(...)` 返回时本次运行**已进终态**
   * （调度器内部没有 fire-and-forget 执行链，异步异常不会被环境吞掉）；`queued` 路径
   * （并发已满）返回时只是**已入队**，由 `startQueuedRuns()` 在后续收尾时补位执行。
   * **返回值始终是 `startRun` 那一刻的快照**（`status` 为 `running`/`queued`，之后被终态覆盖
   * 而**不**回写该对象）——需要终态请用 `runId` 查询，见 {@link TaskScheduler#runNow} 的说明。
   * 并发由 {@link MAX_CONCURRENT_RUNS} + `queued` 排队控制，不靠「不 await」实现并行。
   *
   * @param {Record<string, unknown>} task - 任务。
   * @param {{ trigger?: string, scheduledFor?: string, force?: boolean }} [options] - 触发信息。
   * @returns {Promise<Record<string, unknown>|null>} 运行记录；重叠跳过时为 `skipped_overlap` 记录，停用中（定时触发）为 `null`。
   */
  async #fire(task, options) {
    const taskId = String(task.id)
    if (!task.enabled && options.trigger === 'schedule') return null

    // 1) 重叠：该任务已有 running（或已有一次正在放行的触发）→ 记 skipped_overlap，
    //    绝不启动新会话。`pendingFires` 覆盖「startRun 已发出但还没返回」的窗口，
    //    否则同一任务的两次触发可能都通过这道检查。
    if (this.activeRuns.has(taskId) || this.pendingFires.has(taskId)) {
      const skipped = await this.store.startRun(taskId, {
        trigger: options.trigger,
        scheduledFor: options.scheduledFor,
      })
      return await this.store.finishRun(String(skipped.runId), {
        status: 'skipped_overlap',
        summary: '上一轮仍在运行，本轮跳过',
        errorCode: 'skipped_overlap',
      })
    }
    // 先占位再 await：`pendingFires` 覆盖「startRun 已发出但还没返回」的窗口，
    // 否则同一任务的两次触发可能都通过重叠检查（占位必须同步完成，不能放在 await 之后）。
    this.pendingFires.add(taskId)

    try {
      // 2) 并发：达到上限 → queued 排队，等有空位再起。
      //    **必须用「在跑 + 已占位」计数同步判断**：若只看 activeRuns.size，两个几乎同时
      //    发起的触发会在各自 await 期间都读到旧值，于是双双超过上限。
      const queued = this.activeRuns.size + this.reservedSlots.size >= MAX_CONCURRENT_RUNS
      if (!queued) this.reservedSlots.add(taskId)
      let run
      try {
        run = await this.store.startRun(taskId, {
          trigger: options.trigger,
          status: queued ? 'queued' : 'running',
          scheduledFor: options.scheduledFor,
        })
      } finally {
        // 存储写完后取消占位：真正的并发额度转由 activeRuns 表达（排队分支立刻释放）。
        if (!queued) this.reservedSlots.delete(taskId)
      }
      if (queued) {
        // 排队项由「有空位」时提升（#drainQueue / promoteNextQueued）；这里立即返回。
        return run
      }
      this.activeRuns.set(taskId, String(run.runId))
      await this.#drive(task, String(run.runId), 1)
      return run
    } finally {
      this.pendingFires.delete(taskId)
    }
  }

  /**
   * 驱动一次运行到终态（含超时与重试）。
   * @param {Record<string, unknown>} task - 任务。
   * @param {string} runId - 运行 id。
   * @param {number} attempt - 第几次尝试（1 首次，2 重试）。
   */
  async #drive(task, runId, attempt) {
    const taskId = String(task.id)
    let outcome
    try {
      outcome = await this.#invokeWithTimeout(task, attempt)
    } catch (error) {
      outcome = {
        status: 'failed',
        summary: `执行抛错：${error instanceof Error ? error.message : String(error)}`,
        errorCode: 'execute-threw',
      }
    }

    const status = outcome.status === 'ok' ? 'ok' : outcome.status === 'timeout' ? 'timeout' : 'failed'
    await this.store.finishRun(runId, {
      status,
      exitCode: outcome.exitCode ?? null,
      sessionId: outcome.sessionId ?? null,
      summary: outcome.summary ?? '',
      tailOutput: outcome.tailOutput ?? '',
      logFilePath: outcome.logFilePath ?? undefined,
      errorCode: outcome.errorCode,
    })
    this.activeRuns.delete(taskId)

    // 失败/超时 → 延迟 5 分钟重试 1 次（同样开新会话）；再失败不再重试。
    if (RETRYABLE_STATUSES.includes(status) && attempt <= MAX_RETRIES && !this.pendingRetries.has(taskId)) {
      this.#scheduleRetry(task, attempt + 1)
    }
    // 注意：这里**不**提升排队项。提升是独立的一步（`pumpQueue()`），由
    // `tick()` / `runNow()` / `catchUp()` 在收尾时 await 调用。否则一次执行里会嵌套
    // 等待下一次执行，形成「A 等 B、B 等 C」的阻塞链。
  }

  /** 调执行器并施加 1 小时超时（`timeoutEnabled === false` 时直接等执行器）。 */
  async #invokeWithTimeout(task, attempt) {
    if (this.executeImpl === null) {
      return {
        status: 'failed',
        summary: '运行器尚未装载（由 lib/runner.mjs / t4 注入 execute）',
        errorCode: 'runner-unavailable',
      }
    }
    const runWork = () => Promise.resolve()
      .then(() => this.executeImpl({ task, attempt, sessionIdHint: null }))
      .then(result => (result === undefined || result === null ? { status: 'failed', errorCode: 'execute-empty' } : result))
      .catch(error => ({
        status: 'failed',
        summary: `执行抛错：${error instanceof Error ? error.message : String(error)}`,
        errorCode: 'execute-threw',
      }))
    if (!this.timeoutEnabled) return await runWork()

    let timer
    const timeout = new Promise(resolve => {
      timer = this.timeoutSetTimeout(() => {
        // 超时后给执行器一个收尾机会（终止子进程 / cancel 会话）；不允许它抛错影响收尾。
        try {
          if (typeof this.executeImpl?.onTimeout === 'function') this.executeImpl.onTimeout({ task, attempt })
        } catch { /* 收尾失败不影响 timeout 结果 */ }
        resolve({
          status: 'timeout',
          summary: `运行超过 ${Math.round(this.runTimeoutMs / 60000)} 分钟，已终止`,
          errorCode: 'timeout',
        })
      }, this.runTimeoutMs)
    })
    try {
      return await Promise.race([runWork(), timeout])
    } finally {
      if (timer !== undefined) this.timeoutClearTimeout(timer)
    }
  }

  /** 安排一次重试（延迟 `${retryDelayMs}`，开新会话）。 */
  #scheduleRetry(task, attempt) {
    const taskId = String(task.id)
    const timer = this.timeoutSetTimeout(() => {
      this.pendingRetries.delete(taskId)
      // 定时器回调里发起的执行要能被 waitIdle() 观察到；回调本身同步返回。
      this.trackWork(this.#runRetry(taskId, attempt)).catch(error => {
        this.log(`重试 ${taskId} 失败：${error instanceof Error ? error.message : String(error)}`)
      })
    }, this.retryDelayMs)
    this.pendingRetries.set(taskId, { taskId, attempt, timer })
  }

  /**
   * 执行一次重试（此时应已有空位；若又被占满则转排队）。内联 await，无悬空链。
   */
  async #runRetry(taskId, attempt) {
    const task = this.store.findTask(taskId)
    if (task === null || task === undefined) return null
    if (this.activeRuns.size >= MAX_CONCURRENT_RUNS) {
      const queuedRun = await this.store.startRun(taskId, { trigger: 'retry', status: 'queued', summary: `第 ${attempt} 次尝试` })
      return queuedRun
    }
    const run = await this.store.startRun(taskId, { trigger: 'retry', status: 'running', summary: `第 ${attempt} 次尝试` })
    this.activeRuns.set(taskId, String(run.runId))
    await this.#drive(task, String(run.runId), attempt)
    return run
  }

  /**
   * 把「最老的一个」排队运行提为 running 并执行到终态。
   *
   * 单步版本（与 {@link startQueuedRuns} 的循环版并存）：测试与宿主维护任务用它做
   * 「补一个、并且拿到这一个的 promise」的控制。
   * @returns {Promise<Record<string, unknown>|null>} 被提升并收尾的运行记录；无可提升项时为 null。
   */
  async promoteNextQueued() {
    if (this.activeRuns.size + this.reservedSlots.size >= MAX_CONCURRENT_RUNS) return null
    const next = this.store.queuedRuns()[0]
    if (next === undefined) return null
    const taskId = String(next.taskId)
    const task = this.store.findTask(taskId)
    if (task === null || task === undefined) return null
    if (this.activeRuns.has(taskId) || this.reservedSlots.has(taskId)) return null
    const runId = String(next.runId)
    this.reservedSlots.add(taskId)
    try {
      await this.store.promoteQueuedRun(runId, undefined)
    } finally {
      this.reservedSlots.delete(taskId)
    }
    this.activeRuns.set(taskId, runId)
    try {
      await this.#drive(task, runId, typeof next.attempt === 'number' ? next.attempt : 1)
    } catch (error) {
      this.log(`提升排队运行 ${runId} 失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.activeRuns.delete(taskId)
    }
    return this.store.requireRun(taskId, runId)
  }

  /**
   * 把排队项提升为 running 并**执行到终态**，直到没有排队项或没有空位。
   *
   * 由 `tick()` / `runNow()` / `catchUp()` 收尾时 await。执行是内联的：本方法返回时
   * 被放行的那几次运行已经收尾——调度器里不存在任何「没人 await 的后台执行链」。
   * 并发上限由 `activeRuns + reservedSlots` 同步判断保证，不会因为等待而超限。
   * 宿主也可以周期性地调用它（例如每分钟一次），兜住「没有任何触发在跑但队列里还有等待项」。
   * @returns {Promise<Record<string, unknown>|null>} 最后一次被放行并收尾的运行记录。
   */
  async startQueuedRuns() {
    let last = null
    for (;;) {
      const promoted = await this.promoteNextQueued()
      if (promoted === null) return last
      last = promoted
    }
  }

  /** 兼容旧名：放行队列并执行到终态。 */
  async pumpQueue() {
    return this.startQueuedRuns()
  }

  /** 取某任务最近一次运行记录。 */
  #latestRun(taskId) {
    return this.store.latestRunOf(taskId)
  }

  /** 诊断快照（不包含任何任务内容）。 */
  snapshot() {
    return {
      started: this.started,
      scheduledTaskIds: this.#scheduledTaskIds(),
      activeTaskIds: [...this.activeRuns.keys()],
      activeCount: this.activeRuns.size,
      inflight: this.inflight,
      pendingRetryTaskIds: [...this.pendingRetries.keys()],
      maxConcurrent: MAX_CONCURRENT_RUNS,
    }
  }
}

/** 把 cron 错误统一成带稳定 code 的错误（调度器与 HTTP 层共用）。 */
export function isCronError(error) {
  return error instanceof CronError
}




