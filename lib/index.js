/**
 * dsh-task-scheduler — 宿主插件入口（lib/index.js）
 *
 * 组合方式（与 dsh-better-sidebar / dsh-host-webserver 的插件契约一致）：
 *  - 导出 `name`（插件名与日志名）、`inject`（依赖服务）、`apply(ctx, config)`。
 *  - 数据落在 `$DSH_HOME/dsh-task-scheduler/`（tasks.json + runs/<taskId>/<runId>.json +
 *    notifications/<taskId>.md），全部经原子写落盘，进程重启不丢。
 *  - HTTP 挂在 `ctx.webServer` 的前缀路由 `/dsh-task-scheduler/api`。若该服务不在，
 *    数据层照常工作，只是不注册路由（headless / Electron 组合）。
 *  - 对外暴露扩展接口（服务名 'dsh-task-scheduler'，另有安全别名 'dshTaskScheduler'，
 *    因为点号服务名无法用 `ctx.<name>` 属性读取）：
 *      store                      —— 存储层实例（TaskStore）
 *      registerRunner(fn)         —— 运行器（t4）注册「立即执行」实现
 *      registerCronPreview(fn)    —— cron 解析器（t3）注册预览实现
 *      registerBusyCheck(fn)      —— 调度器（t3）注册并发占用判定
 *      getService()               —— 取服务对象本身
 *
 * t4 的接线（本文件只做「接线」，执行逻辑在 `lib/runner.mjs`、通知 IO 在 `lib/notify.mjs`）：
 *  - `createTaskRunner` 生成执行器 → `TaskScheduler` 的 `execute` → `registerRunner` 暴露给 HTTP；
 *  - `registerCronPreview` 用 `lib/cron.mjs` 的 `nextRuns` 实现（spec §5 的 `{cron, from?}` → `{next}`）；
 *  - `registerBusyCheck` 把调度器的并发占用（在跑 + 已占位）暴露给 `POST /tasks/:id/run`；
 *  - `store.on('tasks-changed')` → `scheduler.onTasksChanged`（新建/改 cron/停用/删除立刻生效）；
 *  - `store.on('paused-changed')` → 全局暂停时**停止排期**（`scheduler.stop()`），解除时重装定时器；
 *  - 存储就绪后 `scheduler.start()`（恢复上次进程遗留的 running 记录）并异步跑一次 `catchUp()`（漏跑补偿）。
 *
 * 注意：本文件不 import 任何第三方包，只用 Node 内置模块 + 本目录内的 .mjs，
 * 因此可以脱离宿主用 `node` 直接加载验证（见 docs/api-contract.md 的验证小节）。
 */
import { TaskStore } from './store.mjs'
import { API_PREFIX, registerApiRoutes } from './routes.mjs'
import { trustedHostsOf } from './trust-fence.mjs'
import { describeBackend, probeHomePaths } from './dsh-home.mjs'
import { PluginError, WIRE_ERROR_CODES } from './model.mjs'
import { MAX_CONCURRENT_RUNS, TaskScheduler } from './scheduler.mjs'
import { nextRuns } from './cron.mjs'
import { createTaskRunner } from './runner.mjs'

/** 插件名（Cordis 用于诊断与日志命名）。 */
export const name = 'dsh-task-scheduler'

/**
 * 依赖的服务名（docs/spec.md §11.4）。
 *
 * **`webRuntime` 不能漏**：`trustedHosts` 的真源在它上面（`dsh-web-app/lib/index.js:83-88,173-175`），
 * 漏声明会让本插件在绑 `0.0.0.0` 的部署下全部 API 返回 403。
 * `sessions` / `agents` 是 t4 执行链路（开新会话 + 权限档位）要用的同一批宿主服务名，
 * 在这里一并声明，保证插件只在这些服务齐备时加载。
 */
export const inject = ['webServer', 'sessions', 'agents', 'webRuntime']

/** 服务登记名（点号形式，宿主内唯一）。 */
export const SERVICE_NAME = 'dsh-task-scheduler'

/** 供 `ctx.<name>` 属性访问的别名（点号名无法作为属性读取）。 */
export const SERVICE_ALIAS = 'dshTaskScheduler'

/**
 * 插件配置。
 * @typedef {object} DshTaskSchedulerConfig
 * @property {boolean} [enabled] - false 时插件不注册路由、不建存储。
 * @property {string} [dataRoot] - 显式数据根（默认 `$DSH_HOME/dsh-task-scheduler`）。
 * @property {string} [home] - 显式 DSH 主目录（宿主已解析的结果，优先于 $DSH_HOME）。
 * @property {string[]} [trustedHosts] - 额外信任的 HTTP authority（如 Tailscale 域名）。
 */

/**
 * 插件主体。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 宿主上下文。
 * @param {DshTaskSchedulerConfig} [config] - 插件配置。
 * @returns {Promise<void>}
 */
export async function apply(ctx, config = {}) {
  const { enabled = true, dataRoot, home, trustedHosts = [] } = config
  if (enabled === false) return

  const logger = typeof ctx.logger === 'function' ? ctx.logger(name) : undefined
  // spec §11.4：主目录解析优先用 @deepseek-ai/dsh-home-paths。在造 store 之前先探一次，
  // 这样 TaskStore 构造时的数据根解析就走官方实现（探不到时回退到语义等价的本地实现）。
  await probeHomePaths()
  logInfo(logger, describeBackend())
  const store = new TaskStore({ dataRoot, home })

  /** 运行器（t4）注册的实现。 */
  let runnerImpl
  /** cron 解析器（t3）注册的实现。 */
  let cronPreviewImpl
  /** 并发占用判定（t3）注册的实现。 */
  let busyImpl
  /** 初始化失败时的错误（路由统一回 E_STORAGE，避免静默空列表）。 */
  let initError
  /** 磁盘状态载入的 promise（测试与其它插件可 await，避免猜测时序）。 */
  let initPromise = Promise.resolve()

  const service = {
    name,
    apiPrefix: API_PREFIX,
    /** 存储层实例（调度器与运行器共用同一份内存模型）。 */
    store,
    /**
     * 注册「立即执行」实现（由 t4 运行器调用）。
     * @param {(input: {taskId: string, task: object, trigger: string, scheduledFor?: string}) => Promise<unknown>} fn - 实现。
     * @returns {() => void} 注销函数。
     */
    registerRunner(fn) {
      if (typeof fn !== 'function') throw new PluginError('internal', 'registerRunner 需要函数')
      runnerImpl = fn
      return () => { if (runnerImpl === fn) runnerImpl = undefined }
    },
    /**
     * 注册 cron 预览实现（由 t3 调用）。
     * 入参为 spec §5 的 `{cron, from?}`；实现返回 `{next: string[]}`。
     * @param {(input: {cron: string, from?: string}) => Promise<{next: string[]}>} fn - 实现。
     * @returns {() => void} 注销函数。
     */
    registerCronPreview(fn) {
      if (typeof fn !== 'function') throw new PluginError('internal', 'registerCronPreview 需要函数')
      cronPreviewImpl = fn
      return () => { if (cronPreviewImpl === fn) cronPreviewImpl = undefined }
    },
    /**
     * 注册并发占用判定（由 t3 调度器调用）。
     * @param {() => boolean} fn - 返回 true 表示队列已满。
     * @returns {() => void} 注销函数。
     */
    registerBusyCheck(fn) {
      if (typeof fn !== 'function') throw new PluginError('internal', 'registerBusyCheck 需要函数')
      busyImpl = fn
      return () => { if (busyImpl === fn) busyImpl = undefined }
    },
    /** 是否已有运行器。 */
    hasRunner() {
      return typeof runnerImpl === 'function'
    },
    /** 是否已有 cron 预览实现。 */
    hasCronPreview() {
      return typeof cronPreviewImpl === 'function'
    },
    /** 服务对象本身（便于扩展）。 */
    getService() {
      return service
    },
    /**
     * 磁盘状态载入完成的 promise（载入失败时 reject）。
     * 供调度器 / 运行器与验证脚本等待「存储就绪」，不要靠 sleep 猜时序。
     * @returns {Promise<void>} 载入完成。
     */
    ready() {
      return initPromise
    },
  }

  // 1) 先登记服务：后续加载的插件（t3 调度器 / t4 运行器）能在自己的 apply 里读到它。
  provideService(ctx, service)

  // 2) 再注册 HTTP 路由：处理器闭包直接引用同一份 store。
  //    trustedHosts 的真源是 ctx.webRuntime（spec §11.4/§11.5.2：漏了它，绑 0.0.0.0 时
  //    本插件全部 API 会 403），config 里的只是额外补充。
  const effectiveTrustedHosts = trustedHostsOf(ctx, trustedHosts)
  logInfo(logger, `信任清单：${effectiveTrustedHosts.length === 0 ? '（仅回环）' : effectiveTrustedHosts.join(', ')}`)
  const webServer = ctx.get('webServer')
  if (webServer !== undefined && webServer !== null) {
    const disposeRoutes = registerApiRoutes(webServer, {
      store,
      trustedHosts: effectiveTrustedHosts,
      runNow: async (input) => {
        if (initError !== undefined) {
          throw new PluginError(wireCode('storage', 'storage-error'), `存储层初始化失败：${initError.message}`)
        }
        if (typeof runnerImpl !== 'function') {
          throw new PluginError('runner-unavailable', '运行器尚未装载（由 lib/runner.mjs 注册）')
        }
        return await runnerImpl(input)
      },
      cronPreview: async (input) => {
        if (typeof cronPreviewImpl !== 'function') return undefined
        return await cronPreviewImpl(input)
      },
      isBusy: () => (typeof busyImpl === 'function' ? busyImpl() === true : false),
      onError: (error, where) => {
        logError(logger, `接口失败 ${where.method} ${where.path}`, error)
      },
    })
    ctx.effect(() => () => {
      if (typeof disposeRoutes === 'function') disposeRoutes()
    }, 'dsh-task-scheduler: /dsh-task-scheduler/api routes')
  } else {
    logWarn(logger, 'ctx.webServer 不可用，已跳过 HTTP 路由注册（数据层仍然工作）')
  }

  // 3) 接线执行链路与调度器（t4）：runner 提供「怎么跑」，scheduler 提供「什么时候跑」。
  //    两者共用同一份 store，因此运行记录、任务状态与路由看到的是同一个内存模型。
  const runner = createTaskRunner({
    store,
    ctx,
    logger: message => logInfo(logger, message),
  })
  const scheduler = new TaskScheduler({
    store,
    execute: runner.execute,
    log: message => logInfo(logger, message),
  })
  // 把 runner / scheduler 也挂在服务上：验证方（tools/verify-runner.mjs）与宿主诊断需要
  // 「等通知落盘」「看排期状态」，否则只能靠 sleep 猜时序。不改变任何对外行为。
  service.runner = runner
  service.scheduler = scheduler

  // cron 预览（spec §5）：`{cron, from?}` → `{next:[ISO ×5]}`；非法表达式必须是 cron 类错误码。
  service.registerCronPreview(({ cron, from }) => {
    const fromDate = from === undefined || from === null ? new Date() : new Date(from)
    if (Number.isNaN(fromDate.getTime())) {
      throw new PluginError('bad-request', `"from" 不是合法时间：${String(from)}`)
    }
    try {
      return { next: nextRuns(String(cron), 5, fromDate).map(date => date.toISOString()) }
    } catch (error) {
      throw new PluginError(wireCode('cron-invalid', 'invalid-cron'), error instanceof Error ? error.message : String(error))
    }
  })

  // 立即执行（HTTP `POST /tasks/:id/run`）走调度器的同一条路径：同样受重叠/并发/重试策略约束。
  service.registerRunner(async input => await scheduler.runNow({
    taskId: String(input?.taskId ?? ''),
    trigger: typeof input?.trigger === 'string' && input.trigger !== '' ? input.trigger : 'manual',
    scheduledFor: input?.scheduledFor,
  }))

  // 并发占用：在跑 + 已占位（含 await 期间预留的额度），与调度器 #fire 的判定完全一致。
  service.registerBusyCheck(
    () => scheduler.activeRuns.size + scheduler.reservedSlots.size >= MAX_CONCURRENT_RUNS,
  )

  /** 任务变更 → 让新建 / 改 cron / 停用 / 删除立刻生效（不用等下一次收敛）。 */
  const offTasksChanged = store.on('tasks-changed', payload => {
    Promise.resolve(scheduler.onTasksChanged(payload)).catch(error => {
      logError(logger, '调度器处理任务变更失败', error)
    })
  })

  /**
   * 全局暂停开关（spec §3/§9）：暂停即**停止排期**；解除后重装定时器。
   *
   * 这里刻意用 `onTasksChanged({})` 而不是 `start()` 恢复：`start()` 会把「正在 running 的记录」
   * 当成上个进程留下的孤儿并记成 failed（见 TaskScheduler#recoverOrphanRuns）。暂停期间正在跑的
   * 运行**不该**被误判，因此恢复排期只做「重装定时器」这一步。
   * 语义代价（已写进契约）：暂停期间错过的触发点不做补跑，恢复后从下一个触发点开始。
   */
  let scheduleFrozen = false
  const offPausedChanged = store.on('paused-changed', payload => {
    if (payload?.paused === true) {
      if (scheduleFrozen) return
      scheduleFrozen = true
      scheduler.stop()
      logInfo(logger, '全局暂停：已停止排期（正在执行的运行会自然收尾）')
      return
    }
    if (!scheduleFrozen) return
    scheduleFrozen = false
    Promise.resolve(scheduler.onTasksChanged({})).catch(error => {
      logError(logger, '恢复排期失败', error)
    })
    logInfo(logger, '全局暂停解除：已重装排期定时器')
  })

  ctx.effect(() => () => {
    if (typeof offTasksChanged === 'function') offTasksChanged()
    if (typeof offPausedChanged === 'function') offPausedChanged()
  }, 'dsh-task-scheduler: scheduler subscriptions')

  // 4) 最后异步载入磁盘状态：失败不炸宿主，但路由会以 storage 错误码明确回绝，
  //    避免「看起来正常、其实永远空列表」的假象。载入成功后启动调度。
  ctx.effect(() => {
    initPromise = (async () => {
      try {
        await store.init()
        logInfo(logger, `已就绪，数据根：${store.dataRoot}`)
      } catch (error) {
        initError = error instanceof Error ? error : new Error(String(error))
        logError(logger, '存储层初始化失败', initError)
        throw initError
      }
      // 调度启动失败不应把「存储不可用」的错误码带进来：分开处理，只记日志。
      try {
        const stats = await scheduler.start()
        logInfo(logger, `调度已启动：恢复中断运行 ${stats.recoveredOrphans} 条，已排期任务 ${stats.scheduled} 个`)
        if (store.state().paused === true) {
          scheduleFrozen = true
          scheduler.stop()
          logInfo(logger, '全局暂停中：本次启动不排期')
        } else {
          // 漏跑补偿（spec §6：默认补最近一次，可切全补）：不阻塞插件加载。
          scheduler.trackWork(scheduler.catchUp()).then(created => {
            if (Array.isArray(created) && created.length > 0) logInfo(logger, `漏跑补偿：补跑 ${created.length} 次`)
          }).catch(error => logError(logger, '漏跑补偿失败', error))
        }
      } catch (error) {
        logError(logger, '调度器启动失败（数据仍可用，可手工重试）', error)
      }
    })()
    // 未消费的 rejection 不应触发 unhandledRejection（宿主只看日志）。
    initPromise.catch(() => undefined)
    return () => {
      scheduler.stop()
      Promise.resolve(runner.dispose()).catch(() => undefined)
    }
  }, 'dsh-task-scheduler: load persisted state')
}

/**
 * 取 spec §5 冻结集里的线上错误码，收敛未完成时回落到当前实现仍在用的旧码。
 *
 * 背景：`invalid-cron` / `storage-error` 是 t2 早期用词，spec §5 冻结的是 `cron-invalid` / `storage`；
 * t9 会统一（`lib/model.mjs` 的 `WIRE_ERROR_CODES`）。本函数让本文件的码**跟着 model 走**，
 * 避免 t9 收敛之后这里硬编码的旧码被 PluginError 静默降级成 `internal`。
 * @param {string} preferred - spec §5 的码。
 * @param {string} fallback - 当前仍在用的旧码。
 * @returns {string} 实际可用的码。
 */
function wireCode(preferred, fallback) {
  return WIRE_ERROR_CODES.includes(preferred) ? preferred : fallback
}

/**
 * 把服务登记到上下文（点号名 + 安全别名）。
 * `ctx.provide` 不可用时退回直接属性赋值，保证插件仍可独立加载。
 * @param {object} ctx - 宿主上下文。
 * @param {object} service - 服务对象。
 */
function provideService(ctx, service) {
  if (typeof ctx.provide === 'function') {
    const disposers = [ctx.provide(SERVICE_NAME, service), ctx.provide(SERVICE_ALIAS, service)]
    ctx.effect(() => () => {
      for (const dispose of disposers) {
        if (typeof dispose === 'function') dispose()
      }
    }, 'dsh-task-scheduler: service registration')
    return
  }
  ctx[SERVICE_NAME] = service
  ctx[SERVICE_ALIAS] = service
}

/** 安全日志：只输出 message，不输出可能含凭据的对象。 */
function logInfo(logger, message) {
  if (logger !== undefined && typeof logger.info === 'function') logger.info(message)
}

/** 安全日志：警告。 */
function logWarn(logger, message) {
  if (logger !== undefined && typeof logger.warn === 'function') logger.warn(message)
}

/** 安全日志：错误（只取 message，绝不把任务 prompt / cmd 打进日志）。 */
function logError(logger, message, error) {
  const detail = error instanceof Error ? error.message : String(error)
  if (logger !== undefined && typeof logger.warn === 'function') logger.warn(`${message}: ${detail}`)
}

// ── 供其它模块直接复用的再导出（t3 调度器 / t4 运行器从本文件取用） ──────────
// 只在这里用「来源再导出」，避免与上面的具名 import 同名而触发 ESM ambiguous export。
export { TaskStore } from './store.mjs'
export { API_PREFIX, API_ROUTES, createApiHandler, registerApiRoutes, writeError, writeOk, readJsonBody } from './routes.mjs'
export { isTrustedApiRequest, isLoopbackHostname, trustedHostsOf } from './trust-fence.mjs'
export { latestRun, nextAttempt, normalizeTaskInput, applyTaskPatch, validateCronShape, ERROR_CODES, WIRE_ERROR_CODES, SPEC_ERROR_CODES, SPEC_CODE_OF, ERROR_STATUS } from './model.mjs'
export { resolveDataRoot, resolveDshHome, dshHomePath, logsDirPath, notifyDirPath, activeBackend, describeBackend } from './paths.mjs'
export { renderNotificationEntry, renderNotificationHeader, resolveNotificationPath } from './notifications.mjs'
/** 默认导出：插件对象形态（Cordis 同时支持函数与 { apply } 形态）。 */
export default { name, inject, apply }
