/**
 * dsh-task-scheduler —— `/dsh-task-scheduler/api` 客户端调用封装（浏览器半侧用）。
 *
 * 纯 JS：无框架、无打包工具、无 JSX。由 lib/client.js 的 factory 用
 * `require('./wire.js')` 或直接内联取得（DSH 客户端模块加载器只处理
 * 平台模块，本文件按普通模块随插件一起被引用）。
 *
 * 设计要点（证据见 docs/client-host-api.md）：
 * - 同源相对路径 fetch，**不需要**任何令牌/cookie/CSRF header；
 * - 统一信封 `{ok:true,value}` / `{ok:false,error:{code,message}}`；
 * - 每个请求默认带超时；网络失败与业务失败都收敛成 TaskApiError；
 * - 写操作（POST）永不自动重试；只读 GET 允许有限重试。
 */

/** 路由前缀。与宿主 `ctx.webServer.register({ path: API_PREFIX })` 必须一致。 */
export const API_PREFIX = '/dsh-task-scheduler/api'

/** 默认超时（毫秒）。CRUD 很快，10 秒足够；「立即执行」是异步受理，也用同一个值。 */
const DEFAULT_TIMEOUT_MS = 10_000

/** 只读请求的默认重试次数（网络层失败才重试；4xx/5xx 不重试）。 */
const DEFAULT_READ_RETRIES = 1

/**
 * 一次 API 失败的统一形态。
 * `code` 是宿主给的稳定错误码（见 docs/api-contract.md）；网络/超时/解析失败用本地码。
 */
export class TaskApiError extends Error {
  /**
   * @param {string} code 稳定错误码（宿主码或本地码 network|timeout|bad-json|http）
   * @param {string} message 人类可读说明
   * @param {number} [status] HTTP 状态码（本地码时可能为 0）
   */
  constructor(code, message, status) {
    super(message)
    this.name = 'TaskApiError'
    this.code = code
    this.status = status === undefined ? 0 : status
  }
}

/** 本地错误码：不会与宿主错误码冲突。 */
export const LOCAL_CODES = Object.freeze({
  network: 'network',
  timeout: 'timeout',
  badJson: 'bad-json',
  http: 'http',
})

/**
 * 把 `{ok:false,error:{code,message}}` / 非 JSON / 非 2xx 统一抛成 TaskApiError。
 * @param {Response} response
 * @returns {Promise<unknown>} 成功信封里的 value
 */
async function readEnvelope(response) {
  let parsed = null
  try {
    parsed = await response.json()
  } catch {
    parsed = null
  }
  if (!response.ok || parsed === null || parsed.ok !== true) {
    const code = (parsed && parsed.error && parsed.error.code) || LOCAL_CODES.http
    const message = (parsed && parsed.error && parsed.error.message) || `HTTP ${response.status}`
    throw new TaskApiError(code, message, response.status)
  }
  return parsed.value
}

/** 默认超时与调用方 signal 合并：任一方中止都结束请求。 */
function withTimeout(signal, timeoutMs) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    const timeout = AbortSignal.timeout(timeoutMs)
    if (signal === undefined || signal === null) return timeout
    if (typeof AbortSignal.any === 'function') return AbortSignal.any([signal, timeout])
    // 老浏览器兜底：只保留调用方 signal，超时交给下面手工计时器
    return signal
  }
  return signal
}

/** 等一小会儿（重试退避）。 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 发一次请求。**不自动重试**；重试由 {@link requestRead} 负责。
 * @param {string} method HTTP 方法
 * @param {string} path API 子路径（如 '/tasks'）
 * @param {object|null} body JSON 请求体（GET 传 null）
 * @param {{timeoutMs?:number, signal?:AbortSignal}} [options]
 */
async function requestOnce(method, path, body, options) {
  const timeoutMs = (options && options.timeoutMs) || DEFAULT_TIMEOUT_MS
  const signal = withTimeout(options && options.signal, timeoutMs)
  const init = { method, signal, headers: {} }
  if (body !== null) {
    // 只有带 body 的请求才设 content-type；GET 不带，避免无谓的预检语义
    init.headers['content-type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  let response
  try {
    // 同源相对路径：不带 credentials 选项也**会**自动携带本页 cookie（same-origin 默认值）
    response = await fetch(`${API_PREFIX}${path}`, init)
  } catch (error) {
    const aborted = error && (error.name === 'AbortError' || error.name === 'TimeoutError')
    const code = aborted ? LOCAL_CODES.timeout : LOCAL_CODES.network
    const message = error instanceof Error ? error.message : String(error)
    throw new TaskApiError(code, aborted ? `请求超时（${timeoutMs}ms）` : message)
  }
  return readEnvelope(response)
}

/**
 * 只读请求（GET）：允许对**网络层**失败做有限重试，绝不重试 4xx/5xx。
 * @param {string} path
 * @param {{timeoutMs?:number, signal?:AbortSignal, retries?:number}} [options]
 */
async function requestRead(path, options) {
  const retries = options && options.retries !== undefined ? options.retries : DEFAULT_READ_RETRIES
  let attempt = 0
  for (;;) {
    try {
      return await requestOnce('GET', path, null, options)
    } catch (error) {
      const transient = error instanceof TaskApiError
        && (error.code === LOCAL_CODES.network || error.code === LOCAL_CODES.timeout)
      // 调用方主动取消 / 业务错误 / 重试用尽 → 直接抛
      if (!transient || attempt >= retries) throw error
      attempt += 1
      await delay(150 * attempt)
    }
  }
}

/**
 * 写请求（POST）：**永不自动重试**（避免重复执行 / 重复创建）。
 * @param {string} path
 * @param {object} body
 * @param {{timeoutMs?:number, signal?:AbortSignal}} [options]
 */
function requestWrite(path, body, options) {
  return requestOnce('POST', path, body === undefined ? {} : body, options)
}

/** URL 查询串（把可选参数略掉）。 */
function query(params) {
  const search = new URLSearchParams()
  for (const key of Object.keys(params)) {
    const value = params[key]
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value))
  }
  const text = search.toString()
  return text === '' ? '' : `?${text}`
}

/**
 * 任务 API 的完整面。方法名对应 docs/api-contract.md 的路由。
 * 每一处 `signal` 都是可选的 AbortSignal，调用方负责在组件卸载时 abort。
 */
export const taskApi = {
  /** 全局暂停开关 + 概览。 */
  getOverview: (options) => requestRead('/overview', options),

  /** 任务列表。 */
  listTasks: (options) => requestRead('/tasks', options),

  /** 单个任务。 */
  getTask: (id, options) => requestRead(`/tasks/${encodeURIComponent(id)}`, options),

  /** 新建任务。 */
  createTask: (task, options) => requestWrite('/tasks', { task }, options),

  /** 更新任务（整体替换；服务端按 id 合并）。 */
  updateTask: (id, patch, options) => requestWrite(`/tasks/${encodeURIComponent(id)}`, { patch }, options),

  /** 删除任务。 */
  deleteTask: (id, options) => requestWrite(`/tasks/${encodeURIComponent(id)}/delete`, {}, options),

  /** 立即执行一次（异步受理，返回 runId）。 */
  runNow: (id, options) => requestWrite(`/tasks/${encodeURIComponent(id)}/run`, {}, options),

  /** 运行记录列表（最新在前）。 */
  listRuns: (id, options) => requestRead(`/tasks/${encodeURIComponent(id)}/runs`, options),

  /** 单条运行记录（详情抽屉 / 轮询用）。 */
  getRun: (id, runId, options) => requestRead(`/tasks/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}`, options),

  /** cron 预览：返回未来 5 次运行时间。 */
  previewCron: (expr, options) => requestRead(`/cron/preview${query({ expr })}`, options), // eslint-disable-line max-len

  /** 全局暂停开关。 */
  setPaused: (paused, options) => requestWrite('/paused', { paused }, options),
}

/**
 * 轮询一个运行记录直到它不是 running（用于「立即执行」后的进度）。
 * 幂等、可取消、失败不炸。
 * @param {string} taskId
 * @param {string} runId
 * @param {(run:object)=>void} onUpdate 每次拿到新记录都回调（含 running 态）
 * @param {{intervalMs?:number, signal?:AbortSignal, timeoutMs?:number}} [options]
 * @returns {Promise<object|null>} 终态记录；超出 totalTimeout 时返回 null
 */
export async function pollRun(taskId, runId, onUpdate, options) {
  const intervalMs = (options && options.intervalMs) || 1_500
  const totalMs = (options && options.timeoutMs) || 65 * 60 * 1000 // 覆盖宿主 1 小时超时
  const signal = options && options.signal
  const deadline = Date.now() + totalMs
  for (;;) {
    if (signal !== undefined && signal !== null && signal.aborted) return null
    let run = null
    try {
      run = await taskApi.getRun(taskId, runId, { signal, timeoutMs: 8_000 })
    } catch (error) {
      // 单次失败不结束轮询：下一次再试
      run = null
    }
    if (run !== null && typeof onUpdate === 'function') onUpdate(run)
    if (run !== null && run.status !== 'running') return run
    if (Date.now() >= deadline) return null
    await delay(intervalMs)
  }
}

export default taskApi
