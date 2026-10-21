/**
 * dsh-task-scheduler — HTTP 接口层（宿主半侧）
 *
 * 挂在 `ctx.webServer` 上的前缀路由 `/dsh-task-scheduler/api`。
 *
 * handler 顺序**固定**（docs/spec.md §11.5.3，参考 dsh-better-sidebar/src/index.ts:887-912）：
 *   栅栏 → 方法检查(405) → 方法分派(404) → body 读取(≤1 MiB) → 业务 → 信封写出
 *
 * 信封与状态码（§11.5.4 + t7 片段）：
 *   - 成功恒 `200 {ok:true, value}`；
 *   - 栅栏拒绝恒 `403 {ok:false, error:{code:'forbidden', message:'forbidden'}}`；
 *   - 其余失败 `{ok:false, error:{code, message}}`，HTTP 状态见下表
 *     （405 method-error / 404 not-found / 业务失败 200）。
 *
 * **线上错误码只允许 spec §5 冻结集**（t9 收敛）：`error.code` ∈ {@link WIRE_ERROR_CODES}。
 * `E_*` 只是契约文档与自检内部的 specCode 口径（`PluginError.specCode`，**不上线**）；
 * 旧别名（`invalid-cron` / `storage-error`）由 `PluginError` 在构造时归一到冻结码，
 * 本层再兜一次 `wireCodeOf`，保证任何响应体都不可能漏出冻结集以外的码。
 * 路由表也**严格等于 spec §5**：不提供 `/overview`、`/paused`、`GET /cron/preview` 等别名。
 *
 * 安全（§11.5）：`/api` 的浏览器 cookie **只保护 index.html**
 * （`authorizeIndex` 唯一调用点 `dsh-host-frontend-static/lib/index.js:60`），
 * 静态资源与所有插件路由都不校验 cookie —— 因此「用户已登录」不能当作本插件 API 的保护，
 * 栅栏必须每个 handler 自己加。判据来自 `lib/trust-fence.mjs`（逐行取自 t7 片段）。
 */
import {
  BUSINESS_ERROR_STATUS, ERROR_STATUS, EXEC_KINDS, PluginError, RUN_STATUSES,
  WIRE_ERROR_CODES, isPlainObject, wireCodeOf,
} from './model.mjs'
import { isTrustedApiRequest } from './trust-fence.mjs'

/** 路由前缀（绝对 pathname，无尾斜杠）。 */
export const API_PREFIX = '/dsh-task-scheduler/api'

/** 单请求 JSON 体上限（字节，§11.5.3）。 */
export const MAX_BODY_BYTES = 1 << 20

/** 默认分页大小。 */
export const DEFAULT_RUN_PAGE_SIZE = 20

/** 单页运行记录上限。 */
export const MAX_RUN_PAGE_SIZE = 200

/** 允许的 HTTP 方法。 */
export const ALLOWED_METHODS = Object.freeze(['GET', 'POST', 'PATCH', 'DELETE'])

/**
 * 路由表（spec §5 的**逐行**落地；契约文档与前端半侧共用，顺序即文档顺序）。
 *
 * 除根清单（`GET <base>`，前端能力探测用）与 `GET /tasks/<id>/runs/<runId>`
 * （运行记录详情，§9「可展开看输出尾部」需要）外，**没有任何别名**：
 * `/overview`、`/paused`、`GET /cron/preview`、`POST /tasks/<id>`、`POST /tasks/<id>/delete`
 * 一律不实现（t9 收敛；§11.6 已给出占位名 → 真实路由映射表）。
 */
export const API_ROUTES = Object.freeze([
  'GET    /dsh-task-scheduler/api',
  'GET    /dsh-task-scheduler/api/state',
  'POST   /dsh-task-scheduler/api/state',
  'GET    /dsh-task-scheduler/api/categories',
  'POST   /dsh-task-scheduler/api/categories',
  'GET    /dsh-task-scheduler/api/tasks',
  'POST   /dsh-task-scheduler/api/tasks',
  'GET    /dsh-task-scheduler/api/tasks/<taskId>',
  'PATCH  /dsh-task-scheduler/api/tasks/<taskId>',
  'DELETE /dsh-task-scheduler/api/tasks/<taskId>',
  'POST   /dsh-task-scheduler/api/tasks/<taskId>/run',
  'GET    /dsh-task-scheduler/api/tasks/<taskId>/runs',
  'GET    /dsh-task-scheduler/api/tasks/<taskId>/runs/<runId>',
  'GET    /dsh-task-scheduler/api/runs',
  'POST   /dsh-task-scheduler/api/cron/preview',
])

/**
 * JSON 响应。
 * @param {object} res - node HTTP 响应。
 * @param {number} status - HTTP 状态码。
 * @param {unknown} body - 响应体（会被 JSON 序列化）。
 * @param {Record<string, string>} [headers] - 附加响应头。
 */
export function writeJson(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers })
  res.end(JSON.stringify(body))
}

/** 成功信封（恒 200）。 */
export function writeOk(res, value) {
  writeJson(res, 200, { ok: true, value })
}

/**
 * 失败信封（§11.5.4：只有 `{code, message}`，没有额外字段、**没有 specCode**）。
 *
 * @param {object} res - node HTTP 响应。
 * @param {string} code - 线上码；不是冻结集成员时归一到 `internal`（绝不透传未知码）。
 * @param {string} message - 人类可读说明（不含凭据）。
 * @param {number} [status] - HTTP 状态码。
 * @param {Record<string, string>} [headers] - 附加响应头（如 retry-after）。
 */
export function writeError(res, code, message, status = 200, headers = {}) {
  writeJson(res, status, { ok: false, error: { code: wireCodeOf(code), message } }, headers)
}

/** 把任意异常写成失败信封（未知异常折叠为 internal，绝不泄露栈）。 */
export function writeThrown(res, error) {
  // 先归一：`error.code` 可能来自旧别名或任意第三方异常，绝不能原样上线。
  const code = error instanceof PluginError ? wireCodeOf(error.code) : 'internal'
  const ok = error instanceof Error && typeof error.message === 'string' && error.message !== ''
  const message = ok ? error.message : String(error)
  const headers = {}
  if (typeof error?.retryAfterMs === 'number' && error.retryAfterMs > 0) {
    headers['retry-after'] = String(Math.ceil(error.retryAfterMs / 1000))
  }
  writeError(res, code, message, ERROR_STATUS[code] ?? BUSINESS_ERROR_STATUS, headers)
}

/**
 * 读取并解析限长 JSON 请求体（§11.5.3：上限 1 MiB）。
 * @param {AsyncIterable<Buffer|string|Uint8Array>} req - node HTTP 请求。
 * @returns {Promise<Record<string, unknown>>} 解析后的对象（空体 → {}）。
 * @throws {PluginError} too-large / bad-request。
 */
export async function readJsonBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk)
    total += buffer.length
    if (total > MAX_BODY_BYTES) {
      throw new PluginError('too-large', `请求体超过 ${MAX_BODY_BYTES} 字节上限`)
    }
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new PluginError('bad-request', '请求体不是合法 JSON')
  }
  if (!isPlainObject(parsed)) {
    throw new PluginError('bad-request', '请求体必须是 JSON 对象')
  }
  return parsed
}

/** 读取必填字符串参数。 */
function requireParam(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new PluginError('bad-request', `缺少参数 "${name}"`)
  }
  return value.trim()
}

/** 读取可空字符串参数。 */
function readOptionalString(value, name) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || value.trim() === '') {
    throw new PluginError('bad-request', `"${name}" 必须是非空字符串`)
  }
  return value.trim()
}

/** 解析非负整数查询参数。 */
function readIntQuery(params, name, fallback, max) {
  const raw = params.get(name)
  if (raw === null || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) {
    throw new PluginError('bad-request', `参数 "${name}" 必须是非负整数`)
  }
  return max === undefined ? value : Math.min(value, max)
}

/** 解析逗号分隔的状态过滤参数。 */
function readStatuses(params) {
  const raw = params.get('status')
  if (raw === null || raw.trim() === '') return undefined
  const statuses = raw.split(',').map(value => value.trim()).filter(value => value !== '')
  for (const status of statuses) {
    if (!RUN_STATUSES.includes(status)) {
      throw new PluginError('bad-request', `未知运行状态：${status}`)
    }
  }
  return statuses
}

/** 分页读取运行记录（任务内或全局）。 */
function pagedRuns(source, params) {
  const limit = readIntQuery(params, 'limit', DEFAULT_RUN_PAGE_SIZE, MAX_RUN_PAGE_SIZE)
  const offset = readIntQuery(params, 'offset', 0)
  const statuses = readStatuses(params)
  const filtered = statuses === undefined ? source : source.filter(run => statuses.includes(String(run.status)))
  return { runs: filtered.slice(offset, offset + limit), total: filtered.length, limit, offset }
}

/**
 * 创建 API 处理器。
 *
 * @param {object} options
 * @param {import('./store.mjs').TaskStore} options.store - 存储层。
 * @param {readonly string[]} [options.trustedHosts] - §11.4 的信任清单（来自 ctx.webStartup / ctx.webRuntime）。
 * @param {(input: {taskId: string, task: object, trigger: string, scheduledFor?: string}) => Promise<Record<string, unknown>>|Record<string, unknown>} [options.runNow]
 *   立刻执行一个任务并返回新的运行记录；由运行器（t4）提供。
 * @param {(input: {cron: string, from?: string}) => Promise<{next: string[]}>|{next: string[]}} [options.cronPreview]
 *   cron 预览（t3 提供真实实现；缺省时返回形状固定的降级响应）。
 * @param {() => boolean} [options.isBusy] - 并发是否已满。
 * @param {(error: unknown, context: {method: string, path: string}) => void} [options.onError] - 错误观测钩子。
 * @returns {(req: object, res: object) => Promise<void>} 处理器。
 */
export function createApiHandler(options) {
  const { store, trustedHosts = [], runNow, cronPreview, isBusy, onError } = options
  if (store === undefined) throw new PluginError('internal', 'createApiHandler 需要 store')

  return async function handleApiRequest(req, res) {
    // 1) 栅栏（必须第一行；§11.5.1）
    if (!isTrustedApiRequest(req, trustedHosts)) {
      writeError(res, 'forbidden', 'forbidden', 403)
      return
    }
    // 2) 方法检查（405）
    const method = req.method
    if (!ALLOWED_METHODS.includes(method)) {
      writeError(res, 'method-error', `仅支持 ${ALLOWED_METHODS.join(' / ')}`, 405)
      return
    }
    const url = new URL(req.url ?? '/', 'http://dsh.internal')
    const pathname = url.pathname
    const tail = pathname.startsWith(`${API_PREFIX}/`) ? pathname.slice(API_PREFIX.length + 1) : ''
    const segments = tail === '' ? [] : tail.split('/').filter(segment => segment !== '')
    // 3) 方法分派（404 = 路径不存在；405 = 路径存在但方法不匹配）
    const route = resolveRoute(segments)
    if (route === null) {
      writeError(res, 'not-found', `未知接口：${[API_PREFIX, ...segments].join('/')}`, 404)
      return
    }
    if (!route.methods.includes(method)) {
      writeError(res, 'method-error', `${pathname} 只接受 ${route.methods.join(' / ')}`, 405)
      return
    }
    try {
      // 4) body + 5) 业务 + 6) 信封
      const value = await route.handle(segments, {
        req, store, params: url.searchParams, method, runNow, cronPreview, isBusy,
      })
      if (!res.writableEnded) writeOk(res, value)
    } catch (error) {
      if (typeof onError === 'function') {
        try { onError(error, { method, path: pathname }) } catch { /* 观测钩子不得影响响应 */ }
      }
      if (!res.writableEnded) writeThrown(res, error)
    }
  }
}

/**
 * 把路径段解析成一个路由（返回 `null` 表示路径不存在 → 404）。
 * 这里只做「形状」匹配，不读写任何业务状态，因此可以在方法检查之前调用。
 * @param {string[]} segments - 去掉前缀后的路径段。
 * @returns {{ methods: string[], handle: (segments: string[], ctx: object) => unknown|Promise<unknown> }|null} 路由。
 */
function resolveRoute(segments) {
  const [first, second, third, fourth] = segments
  if (segments.length === 0) return { methods: ['GET'], handle: apiManifest }
  if (first === 'state' && second === undefined) return { methods: ['GET', 'POST'], handle: stateRoute }
  if (first === 'categories' && second === undefined) return { methods: ['GET', 'POST'], handle: categoriesRoute }
  if (first === 'runs' && second === undefined) return { methods: ['GET'], handle: allRunsRoute }
  if (first === 'cron' && second === 'preview' && third === undefined) {
    return { methods: ['POST'], handle: cronPreviewRoute }
  }
  if (first === 'tasks') {
    if (second === undefined) return { methods: ['GET', 'POST'], handle: tasksCollectionRoute }
    if (third === undefined) return { methods: ['GET', 'PATCH', 'DELETE'], handle: taskItemRoute }
    if (third === 'run' && fourth === undefined) return { methods: ['POST'], handle: taskRunRoute }
    if (third === 'runs' && fourth === undefined) return { methods: ['GET'], handle: taskRunsRoute }
    if (third === 'runs' && fourth !== undefined && segments.length === 4) {
      return { methods: ['GET'], handle: runItemRoute }
    }
  }
  return null
}

// ── 各路由实现（每个都返回 value，信封由外层写） ────────────────────────────

/** GET <base> —— 自描述清单（前端启动时探测能力）。 */
function apiManifest(segments, { store, runNow, cronPreview }) {
  return {
    name: 'dsh-task-scheduler',
    apiPrefix: API_PREFIX,
    version: 1,
    routes: [...API_ROUTES],
    execKinds: [...EXEC_KINDS],
    runStatuses: [...RUN_STATUSES],
    errorCodes: [...WIRE_ERROR_CODES],
    features: {
      runNow: typeof runNow === 'function',
      cronPreview: typeof cronPreview === 'function',
    },
    dataRoot: store.dataRoot,
  }
}

/** 全局状态快照（`GET /state` 的唯一读逻辑）。 */
function stateSnapshot(store) {
  return store.state()
}

/** GET <base>/state —— 全局状态。 */
function stateRoute(segments, { store, method, req }) {
  if (method === 'GET') return stateSnapshot(store)
  return updatePaused(store, req)
}

/** POST /state 的写逻辑（body `{paused}`）。 */
async function updatePaused(store, req) {
  const body = await readJsonBody(req)
  if (typeof body.paused !== 'boolean') {
    throw new PluginError('bad-request', '"paused" 必须是布尔值')
  }
  const result = await store.setPaused(body.paused)
  return { ...result, state: store.state() }
}

/** GET/POST <base>/categories。 */
async function categoriesRoute(segments, { store, method, req }) {
  if (method === 'GET') return { categories: store.state().categories }
  const body = await readJsonBody(req)
  const payload = 'categories' in body ? body.categories : body
  return { categories: await store.setCategories(payload) }
}

/** GET <base>/runs —— 全部任务的运行记录。 */
function allRunsRoute(segments, { store, params }) {
  return pagedRuns(store.allRuns(), params)
}

/**
 * POST <base>/cron/preview —— 未来 5 次运行时间（spec §5：`{cron, from?}` → `{next:[ISO ×5]}`）。
 *
 * 只接受 POST（t9 收敛：不再支持 `GET /cron/preview?expr=` 别名）。
 * 预览实现由 t3/t4 经 `registerCronPreview` 注入且**必然存在**（插件在 `apply()` 里就地注册），
 * 因此这里不再保留「未装载 → available:false」的降级分支：缺实现就是内部缺陷，按 `internal` 明确失败，
 * 不用空 `next` 假装「算出了结果」。
 */
async function cronPreviewRoute(segments, { req, cronPreview }) {
  const body = await readJsonBody(req)
  const raw = body.cron !== undefined ? body.cron : body.expression
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new PluginError('cron-invalid', '"cron" 必须是非空字符串（5 段：分 时 日 月 周）')
  }
  const from = readOptionalString(body.from, 'from')
  if (typeof cronPreview !== 'function') {
    throw new PluginError('internal', 'cron 预览实现尚未装载（应由 lib/index.js 注册 lib/cron.mjs 的 nextRuns）')
  }
  const expression = raw.trim()
  let result
  try {
    result = await cronPreview({ cron: expression, from })
  } catch (error) {
    // cron 解析失败必须保持 cron 类错误码：直接 `new PluginError(error.code, ...)` 会把
    // lib/cron.mjs 的 CronError('invalid-cron') 当成未知码降级成 `internal`（出错原因丢失）。
    if (error instanceof PluginError) throw error
    const code = wireCodeOf(error?.code)
    throw new PluginError(code === 'internal' ? 'cron-invalid' : code, error instanceof Error ? error.message : String(error))
  }
  if (!Array.isArray(result?.next)) {
    throw new PluginError('internal', 'cron 预览实现未返回 {next: string[]}')
  }
  return { cron: expression, from: from ?? null, next: result.next }
}

/** GET/POST <base>/tasks。 */
async function tasksCollectionRoute(segments, { store, method, req, params }) {
  if (method === 'GET') {
    return {
      tasks: store.listTasks({
        includeDeleted: params.get('includeDeleted') === '1',
        category: params.get('category') ?? undefined,
        execKind: params.get('execKind') ?? undefined,
        enabledOnly: params.get('enabled') === '1',
        query: params.get('q') ?? undefined,
      }),
    }
  }
  const body = await readJsonBody(req)
  const payload = isPlainObject(body.task) ? body.task : body
  return { task: await store.createTask(payload) }
}

/** GET/PATCH/DELETE <base>/tasks/<taskId>。 */
async function taskItemRoute(segments, { store, method, req }) {
  const task = store.requireTask(segments[1])
  if (method === 'GET') {
    const { total } = store.listRuns(task.id, { limit: 1, offset: 0 })
    return { task, latestRun: store.latestRunOf(task.id), runCountStored: total }
  }
  if (method === 'DELETE') {
    const result = await store.deleteTask(task.id)
    return { taskId: result.taskId, deletedAt: result.deletedAt }
  }
  const body = await readJsonBody(req)
  const payload = isPlainObject(body.task) ? body.task : (isPlainObject(body.patch) ? body.patch : body)
  return { task: await store.updateTask(task.id, payload) }
}

/** POST <base>/tasks/<taskId>/run —— 立即执行。 */
async function taskRunRoute(segments, { store, req, runNow, isBusy }) {
  const task = store.requireTask(segments[1])
  const body = await readJsonBody(req)
  if (store.state().paused) {
    throw new PluginError('paused', '全局暂停中，已拒绝立即执行；请先 POST /state {paused:false} 恢复')
  }
  if (typeof isBusy === 'function' && isBusy() === true) {
    throw new PluginError('busy', '并发已满（上限 3），请稍后重试', { retryAfterMs: 30_000 })
  }
  if (typeof runNow !== 'function') {
    throw new PluginError('runner-unavailable', '运行器尚未装载（由 lib/runner.mjs 注册）')
  }
  const run = await runNow({
    taskId: task.id,
    task,
    trigger: 'manual',
    scheduledFor: readOptionalString(body.scheduledFor, 'scheduledFor'),
  })
  return { run }
}

/** GET <base>/tasks/<taskId>/runs。 */
function taskRunsRoute(segments, { store, params }) {
  const task = store.requireTask(segments[1])
  // 取全量再分页，保证 total 是真实总数（不受单页上限影响）。
  const all = store.listRuns(task.id, { limit: Number.MAX_SAFE_INTEGER, offset: 0 }).runs
  return { taskId: task.id, ...pagedRuns(all, params) }
}

/** GET <base>/tasks/<taskId>/runs/<runId>。 */
function runItemRoute(segments, { store }) {
  const task = store.requireTask(segments[1])
  return { taskId: task.id, run: store.requireRun(task.id, segments[3]) }
}

/**
 * 在 webServer 上注册前缀路由。
 * @param {{register: (route: {kind: string, path: string, handler: Function}) => () => void}} webServer - ctx.webServer。
 * @param {object} options - 同 createApiHandler 的选项。
 * @returns {() => void} 释放函数（撤销路由注册）。
 */
export function registerApiRoutes(webServer, options) {
  if (webServer === undefined || typeof webServer.register !== 'function') {
    throw new PluginError('internal', 'webServer 不可用：无法注册 /dsh-task-scheduler/api 路由')
  }
  const handler = createApiHandler(options)
  return webServer.register({ kind: 'prefix', path: API_PREFIX, handler })
}

