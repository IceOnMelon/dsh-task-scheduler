/**
 * dsh-task-scheduler 宿主半侧验证脚本（自检工具，随项目保留）
 *
 * 用法（在项目根 `dsh-task-scheduler/` 下）：
 *   node tools/verify.mjs
 *
 * 覆盖：spec §3 模型字段集、§4 存储布局与原子写、§5 路由与错误码、§7 通知格式、
 *       §11.4 inject/webRuntime/主目录解析、§11.5 栅栏与信封、进程重启不丢（子进程重读）、
 *       不写凭据、插件入口 apply()，以及 docs/api-contract.md 与实现的一致性（防文档漂移）。
 * 全部用例都在系统临时目录里跑，不碰用户 `~/.dsh`，不碰真实数据根。
 */
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'

import { TaskStore } from '../lib/store.mjs'
import { registerApiRoutes, API_PREFIX, API_ROUTES, writeThrown } from '../lib/routes.mjs'
import {
  TASK_FIELDS, RUN_FIELDS, RUN_EXTRA_FIELDS, PENDING_RUN_STATUSES, EXEC_KINDS, PERMISSIONS,
  MISSED_RUN_POLICIES, RUN_STATUSES, DEFAULT_CATEGORIES, ERROR_CODES, WIRE_ERROR_CODES,
  LEGACY_ERROR_CODES, WIRE_ALIAS_OF, wireCodeOf, PluginError,
  SPEC_ERROR_CODES, SPEC_CODE_OF, ERROR_STATUS, BUSINESS_ERROR_STATUS, TAIL_OUTPUT_MAX_LINES,
} from '../lib/model.mjs'
import {
  resolveDataRoot, resolveDshHome, TASKS_FILE_NAME, RUNS_FILE_NAME, STATE_FILE_NAME,
  LOGS_DIR_NAME, NOTIFY_DIR_NAME, activeBackend, describeBackend, probeHomePaths,
} from '../lib/paths.mjs'
import { renderNotificationEntry, renderNotificationHeader } from '../lib/notifications.mjs'
import { nextRuns } from '../lib/cron.mjs'
import { isTrustedApiRequest, trustedHostsOf } from '../lib/trust-fence.mjs'

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
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  check(name, a === e, `expected ${e} got ${a}`)
}

/** 极简 webServer 桩：只实现 register。 */
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

/** 极简请求/响应桩。 */
function makeReq({ method = 'GET', path = '/', host = '127.0.0.1:3080', body, headers = {}, rawBody } = {}) {
  const stream = rawBody !== undefined
    ? Readable.from([Buffer.from(rawBody, 'utf8')])
    : (body === undefined ? Readable.from([]) : Readable.from([Buffer.from(JSON.stringify(body), 'utf8')]))
  stream.method = method
  stream.url = `${API_PREFIX}${path}`
  stream.headers = { host, 'sec-fetch-site': 'same-origin', ...headers }
  return stream
}

function makeRes() {
  const res = {
    status: 0,
    headers: {},
    payload: '',
    writableEnded: false,
    writeHead(status, headers) {
      res.status = status
      res.headers = headers ?? {}
    },
    end(chunk) {
      res.payload = chunk === undefined ? '' : String(chunk)
      res.writableEnded = true
    },
  }
  return res
}

async function call(handler, reqOptions) {
  const res = makeRes()
  await handler(makeReq(reqOptions), res)
  let json = null
  try { json = JSON.parse(res.payload) } catch { /* 非 JSON 响应 */ }
  return { status: res.status, headers: res.headers, raw: res.payload, json }
}

async function expectCode(name, fn, code) {
  try {
    await fn()
    check(name, false, '未抛错')
  } catch (error) {
    check(name, error?.code === code, `期望 ${code} 实际 ${error?.code}（${error?.message}）`)
  }
}

const root = mkdtempSync(join(tmpdir(), 'dts-verify-'))
/** 插件项目根（本脚本位于 <项目根>/tools/verify.mjs）。 */
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))
console.log(`数据根：${root}`)

// ── 0. 主目录解析后端（spec §11.4） ─────────────────────────────────────────
console.log('\n[0] 主目录解析（spec §11.4）')
await probeHomePaths()
check('探测完成后有明确后端', ['@deepseek-ai/dsh-home-paths', 'local-fallback'].includes(activeBackend()), activeBackend())
check('describeBackend 说明来源', typeof describeBackend() === 'string' && describeBackend().length > 0, describeBackend())
console.log(`  INFO  ${describeBackend()}`)

// ── 1. 存储层与数据模型 ─────────────────────────────────────────────────────
console.log('\n[1] 存储层与数据模型（spec §3/§4）')
const store = new TaskStore({ dataRoot: root })
await store.init()
check('init 后 ready', store.ready === true)

const created = await store.createTask({
  description: '每天早上汇总昨日工作',
  execKind: 'prompt',
  prompt: '请汇总我昨天的工作',
  category: 'work',
  workspaceCwd: 'D:\\AI_agent\\work',
  cron: '0 9 * * *',
  permission: 'workspace-write',
  autoApprove: true,
  missedRunPolicy: 'latest',
  enabled: true,
})
eq('任务字段集与契约一致', Object.keys(created), [...TASK_FIELDS])
check('id 形态', /^\d{13}-[0-9a-f]{4}-[0-9a-f]{6}$/.test(created.id), created.id)
check('title 缺省从 prompt 派生', created.title === '请汇总我昨天的工作', created.title)
check('logFilePath 默认 null', created.logFilePath === null)
check('notifyFile 默认 null', created.notifyFile === null)
const customPaths = await store.createTask({
  execKind: 'shell',
  cmd: 'echo x',
  logFilePath: 'D:\\logs\\a.log',
  notifyFile: 'D:\\notify\\a.md',
})
eq('可配置 logFilePath 生效', customPaths.logFilePath, 'D:\\logs\\a.log')
eq('可配置 notifyFile 生效', customPaths.notifyFile, 'D:\\notify\\a.md')
const rereadPaths = store.requireTask(customPaths.id)
eq('可配置路径可读回', [rereadPaths.logFilePath, rereadPaths.notifyFile], ['D:\\logs\\a.log', 'D:\\notify\\a.md'])
const clearedPaths = await store.updateTask(customPaths.id, { logFilePath: null, notifyFile: null })
eq('PATCH 显式 null 回到默认路径', [clearedPaths.logFilePath, clearedPaths.notifyFile], [null, null])
const reSetPaths = await store.updateTask(customPaths.id, { notifyFile: 'D:\\notify\\b.md' })
eq('PATCH 单改 notifyFile', [reSetPaths.notifyFile, reSetPaths.logFilePath], ['D:\\notify\\b.md', null])
await expectCode('非法 notifyFile 类型被拒', () => store.updateTask(customPaths.id, { notifyFile: 7 }), 'bad-request')
for (const field of ['id', 'createdAt', 'updatedAt', 'nextRunAt', 'lastRunAt', 'lastStatus', 'runCount', 'sessionIds']) {
  await expectCode(`PATCH 拒写服务端字段 ${field}`, () => store.updateTask(customPaths.id, { [field]: 1 }), 'bad-request')
}
await store.deleteTask(customPaths.id)
console.log(`  INFO  customPaths.id=${customPaths.id} 删除后=${store.listTasks({ includeDeleted: true }).map(t => t.id + (t.deletedAt ? '(del)' : '')).join(' | ')}`)
check('nextRunAt 初始为 null', created.nextRunAt === null)
check('updatedAt = createdAt', created.createdAt === created.updatedAt)
eq('sessionIds 初始为空数组', created.sessionIds, [])
// 同一毫秒批量建任务：id 必须互不相同（用独立临时数据根，避免污染本用例计数）
const bulkRoot = mkdtempSync(join(tmpdir(), 'dts-bulk-'))
const bulkStore = new TaskStore({ dataRoot: bulkRoot })
await bulkStore.init()
const idSet = new Set()
for (let i = 0; i < 50; i += 1) idSet.add((await bulkStore.createTask({ execKind: 'prompt', prompt: `批量-${i}` })).id)
eq('同一毫秒批量建任务 id 不重复', idSet.size, 50)
rmSync(bulkRoot, { recursive: true, force: true })
eq('枚举值域 execKind', [...EXEC_KINDS], ['prompt', 'shell'])
eq('枚举值域 permission', [...PERMISSIONS], ['readonly', 'workspace-write', 'full'])
eq('枚举值域 missedRunPolicy', [...MISSED_RUN_POLICIES], ['latest', 'all'])
eq('spec §3 RunStatus', [...RUN_STATUSES], ['queued', 'running', 'ok', 'failed', 'timeout', 'skipped_overlap'])
eq('spec §8 默认分类 id', DEFAULT_CATEGORIES.map(c => c.id), ['work', 'study', 'life', 'other'])
eq('spec §8 默认分类名', DEFAULT_CATEGORIES.map(c => c.name), ['工作', '学习', '生活', '其他'])

await expectCode('prompt 空串被拒', () => store.createTask({ execKind: 'prompt', prompt: '   ' }), 'bad-request')
await expectCode('shell 缺 cmd 被拒', () => store.createTask({ execKind: 'shell' }), 'bad-request')
await expectCode('未知字段被拒', () => store.createTask({ execKind: 'prompt', prompt: 'x', nope: 1 }), 'bad-request')
await expectCode('非法 permission 被拒', () => store.createTask({ execKind: 'prompt', prompt: 'x', permission: 'root' }), 'bad-request')
await expectCode('非法 cron 段数被拒', () => store.createTask({ execKind: 'prompt', prompt: 'x', cron: '0 9 * *' }), 'cron-invalid')
await expectCode('非法 cron 字符被拒', () => store.createTask({ execKind: 'prompt', prompt: 'x', cron: 'a 9 * * *' }), 'cron-invalid')
await expectCode('非法 logFilePath 类型被拒', () => store.createTask({ execKind: 'prompt', prompt: 'x', logFilePath: 42 }), 'bad-request')

const patched = await store.updateTask(created.id, { category: 'study', enabled: false })
check('PATCH 只改指定字段', patched.category === 'study' && patched.enabled === false)
check('PATCH 保留其它字段', patched.prompt === created.prompt && patched.cron === created.cron)
check('PATCH 更新 updatedAt', Date.parse(patched.updatedAt) >= Date.parse(created.updatedAt))
await expectCode('PATCH 拒绝服务端字段 runCount', () => store.updateTask(created.id, { runCount: 99 }), 'bad-request')
await expectCode('PATCH 拒绝只读字段 id', () => store.updateTask(created.id, { id: 'x' }), 'bad-request')
await expectCode('查不存在任务', () => store.requireTask('nonexistent'), 'not-found')

const shellTask = await store.createTask({ execKind: 'shell', cmd: 'echo hi', title: 'shell 任务' })
check('shell 任务默认日志路径在 logs/', store.resolveLogFilePath(shellTask).endsWith(join(LOGS_DIR_NAME, `${shellTask.id}.log`)))
check('默认通知路径在 notify/', store.resolveNotifyFilePath(shellTask).endsWith(join(NOTIFY_DIR_NAME, `${shellTask.id}.md`)))

// 运行记录
const run1 = await store.startRun(created.id, { trigger: 'manual' })
eq('运行记录字段顺序与契约一致', Object.keys(run1).slice(0, RUN_FIELDS.length), [...RUN_FIELDS])
check('初始状态 running', run1.status === 'running')
check('attempt 从 1 开始', run1.attempt === 1)
check('prompt 型 logFilePath 为 null', run1.logFilePath === null)
const shellRun = await store.startRun(shellTask.id, { trigger: 'schedule' })
check('shell 型 logFilePath 已填充', typeof shellRun.logFilePath === 'string' && shellRun.logFilePath.endsWith('.log'))
await store.finishRun(shellRun.runId, { status: 'ok', exitCode: 0, summary: 'ok' })
const afterStart = store.requireTask(created.id)
check('startRun 同步 runCount/lastStatus', afterStart.runCount === 1 && afterStart.lastStatus === 'running')

const finished = await store.finishRun(run1.runId, { status: 'ok', exitCode: 0, summary: '完成', tailOutput: 'done', sessionId: 'session-abc' })
check('终态写入 endedAt', typeof finished.endedAt === 'string' && finished.endedAt.length > 0)
check('sessionId 写入', finished.sessionId === 'session-abc')
eq('sessionIds 累积', store.requireTask(created.id).sessionIds, ['session-abc'])
check('lastStatus 收敛为 ok', store.requireTask(created.id).lastStatus === 'ok')
await expectCode('重复结束被拒', () => store.finishRun(run1.runId, { status: 'ok' }), 'conflict')
await expectCode('非法终态被拒', () => store.finishRun(run1.runId, { status: 'running' }), 'internal')

const run2 = await store.startRun(created.id, { trigger: 'retry' })
check('attempt 递增到 2', run2.attempt === 2)
await store.finishRun(run2.runId, { status: 'skipped_overlap' })
const run3 = await store.startRun(created.id, { trigger: 'schedule' })
await store.finishRun(run3.runId, { status: 'timeout' })
const run4 = await store.startRun(created.id, { trigger: 'catchup', status: 'queued' })
check('排队态可落盘', run4.status === 'queued' && run4.queuedAt !== undefined)
eq('queuedRuns 只含排队项', store.queuedRuns().map(r => r.runId), [run4.runId])
eq('runningRuns 排除排队项', store.runningRuns().length, 0)
eq('pendingRuns = queued + running', store.pendingRuns().length, 1)
check('PENDING_RUN_STATUSES 与语义一致', PENDING_RUN_STATUSES.join() === 'queued,running')
const promoted = await store.promoteQueuedRun(run4.runId, 'session-queued')
check('promoteQueuedRun 转 running', promoted.status === 'running' && promoted.sessionId === 'session-queued')
await store.finishRun(run4.runId, { status: 'ok' })
const listed = store.listRuns(created.id, {})
eq('运行记录倒序（attempt 降序）', listed.runs.map(r => r.attempt), [4, 3, 2, 1])
eq('运行记录总数', listed.total, 4)
eq('按状态过滤', store.listRuns(created.id, { statuses: ['timeout'] }).runs.map(r => r.attempt), [3])
eq('全量运行记录含两个任务', store.allRuns().length, 5)
check('latestRunOf 取最近一次', store.latestRunOf(created.id).runId === run4.runId)

// tailOutput 行数上限
const manyLines = Array.from({ length: 300 }, (_, i) => `line-${i}`).join('\n')
const runLong = await store.startRun(created.id, { trigger: 'manual' })
await store.finishRun(runLong.runId, { status: 'ok', tailOutput: manyLines })
const tail = store.requireRun(created.id, runLong.runId).tailOutput
eq('tailOutput 截断到末 200 行', tail.split('\n').length, TAIL_OUTPUT_MAX_LINES)
check('tailOutput 保留最后一行', tail.endsWith('line-299'))

// 软删除
const liveBeforeDelete = store.listTasks().length
const allBeforeDelete = store.listTasks({ includeDeleted: true }).length
await store.deleteTask(created.id)
check('活跃列表少一个', store.listTasks().length === liveBeforeDelete - 1, `liveBefore=${liveBeforeDelete} live=${store.listTasks().length}`)
check('includeDeleted 总数不变', store.listTasks({ includeDeleted: true }).length === allBeforeDelete)
check('软删除任务带 deletedAt', store.listTasks({ includeDeleted: true }).some(task => task.id === created.id && typeof task.deletedAt === 'string'))
check('运行记录在删除后仍可读', store.listRuns(created.id, {}).total === 5)

// 分类与暂停
const cats = await store.setCategories([{ name: 'custom', color: '#123456' }])
eq('分类替换', cats, [{ id: 'custom', name: 'custom', color: '#123456' }])
const cjkCats = await store.setCategories([{ name: '自定义', color: '#ABCDEF' }])
check('非 ASCII 分类名生成稳定 id 且颜色小写', /^cat-[0-9a-f]{6}$/.test(cjkCats[0].id) && cjkCats[0].color === '#abcdef', JSON.stringify(cjkCats))
await store.setCategories([{ name: 'custom', color: '#123456' }])
await expectCode('空分类表被拒', () => store.setCategories([]), 'bad-request')
await expectCode('分类 id 重复被拒', () => store.setCategories([{ id: 'a', name: 'x', color: '#111111' }, { id: 'a', name: 'y', color: '#222222' }]), 'bad-request')
await expectCode('分类颜色非法被拒', () => store.setCategories([{ name: 'x', color: 'red' }]), 'bad-request')
const paused = await store.setPaused(true)
check('暂停开关生效', paused.paused === true && store.state().paused === true)
await expectCode('暂停值非法被拒', () => store.setPaused('yes'), 'bad-request')
await store.setPaused(false)

// ── 2. 磁盘布局与原子写 ─────────────────────────────────────────────────────
console.log('\n[2] 持久化布局与原子写（spec §4）')
check('tasks.json 已生成', existsSync(join(root, TASKS_FILE_NAME)))
check('runs.json 已生成', existsSync(join(root, RUNS_FILE_NAME)))
check('state.json 已生成', existsSync(join(root, STATE_FILE_NAME)))
eq('数据根文件清单', readdirSync(root).filter(n => !n.startsWith('.')).sort(), ['runs.json', 'state.json', 'tasks.json'])
const diskTasks = JSON.parse(readFileSync(join(root, TASKS_FILE_NAME), 'utf8'))
check('tasks.json 顶层是数组', Array.isArray(diskTasks))
const diskRuns = JSON.parse(readFileSync(join(root, RUNS_FILE_NAME), 'utf8'))
check('runs.json 顶层是数组', Array.isArray(diskRuns) && diskRuns.length === 6)
const diskState = JSON.parse(readFileSync(join(root, STATE_FILE_NAME), 'utf8'))
check('state.json 有 paused/categories/version', diskState.version === 1 && diskState.paused === false && Array.isArray(diskState.categories))
check('state.json 无凭据键', !/password|token|secret|api[_-]?key/i.test(JSON.stringify(diskState)))
check('无残留 .tmp 文件', readdirSync(root).filter(n => n.endsWith('.tmp')).length === 0)
check('无残留锁文件', !existsSync(join(root, 'store.lock')))
const diskText = readFileSync(join(root, TASKS_FILE_NAME), 'utf8') + readFileSync(join(root, RUNS_FILE_NAME), 'utf8')
check('磁盘不含凭据类键名', !/password|passwd|token|secret|api[_-]?key|credential/i.test(diskText))
check('磁盘未落环境变量快照', !/DSH_HOME_|process\.env"|env:/i.test(diskText))
const deletedTask = JSON.parse(readFileSync(join(root, TASKS_FILE_NAME), 'utf8')).find(t => t.deletedAt)
check('磁盘样本字段顺序含 deletedAt', Object.keys(deletedTask).join() === [...TASK_FIELDS, 'deletedAt'].join())

// ── 3. HTTP 路由 ────────────────────────────────────────────────────────────
console.log('\n[3] HTTP 路由与错误码（spec §5 / §11.5）')
const web = makeWebServer()
let runNowCalls = []
let busy = false
let cronPreviewImpl = null
const dispose = registerApiRoutes(web, {
  store,
  trustedHosts: [],
  runNow: async (input) => {
    runNowCalls.push(input)
    return { runId: `manual-${runNowCalls.length}`, taskId: input.taskId, attempt: 1, trigger: 'manual', startedAt: new Date().toISOString(), endedAt: null, status: 'running', sessionId: null, exitCode: null, tailOutput: '', summary: '', logFilePath: null }
  },
  cronPreview: async (input) => (cronPreviewImpl === null ? undefined : cronPreviewImpl(input)),
  isBusy: () => busy,
})
check('前缀路由注册正确', web.routes.length === 1 && web.routes[0].kind === 'prefix' && web.routes[0].path === API_PREFIX)
const handler = web.handler

const listing = await call(handler, { method: 'GET', path: '' })
eq('根清单 200', listing.status, 200)
check('根清单 ok:true', listing.json.ok === true)
eq('根清单路由表条数', listing.json.value.routes.length, API_ROUTES.length)
check('根清单含 features', listing.json.value.features.runNow === true && listing.json.value.features.cronPreview === true)

// 栅栏（§11.5.1/§11.5.4）
const banned = await call(handler, { method: 'GET', path: '/state', host: 'evil.example.com' })
eq('非回环 Host 403', banned.status, 403)
eq('403 信封精确形状', banned.json, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
const crossSite = await call(handler, { method: 'GET', path: '/state', headers: { 'sec-fetch-site': 'cross-site' } })
eq('cross-site 403', crossSite.status, 403)
const badMethod = await call(handler, { method: 'PUT', path: '/state' })
eq('全局非法方法 405', badMethod.status, 405)
eq('405 码', [badMethod.json.ok, badMethod.json.error.code], [false, 'method-error'])
const wrongMethod = await call(handler, { method: 'DELETE', path: '/tasks' })
eq('路径存在但方法不对 405', [wrongMethod.status, wrongMethod.json.error.code], [405, 'method-error'])
const unknownRoute = await call(handler, { method: 'GET', path: '/nope/nope' })
eq('未知路径 404', [unknownRoute.status, unknownRoute.json.error.code], [404, 'not-found'])

// 状态与暂停（spec §5 名字；t9 已删除 /overview 与 /paused 别名）
const state = await call(handler, { method: 'GET', path: '/state' })
eq('GET /state 200', state.status, 200)
eq('state 分类', state.json.value.categories.map(c => c.name), ['custom'])
const overviewGone = await call(handler, { method: 'GET', path: '/overview' })
eq('GET /overview 别名已移除（404）', [overviewGone.status, overviewGone.json.error.code], [404, 'not-found'])
const pauseRes = await call(handler, { method: 'POST', path: '/state', body: { paused: true } })
check('POST /state 暂停 200', pauseRes.status === 200 && pauseRes.json.value.paused === true)
const pauseAliasGone = await call(handler, { method: 'POST', path: '/paused', body: { paused: true } })
eq('POST /paused 别名已移除（404）', [pauseAliasGone.status, pauseAliasGone.json.error.code], [404, 'not-found'])
const pauseBad = await call(handler, { method: 'POST', path: '/state', body: { paused: 'yes' } })
eq('暂停类型错误：业务失败 200 + bad-request', [pauseBad.status, pauseBad.json.error.code], [200, 'bad-request'])
await call(handler, { method: 'POST', path: '/state', body: { paused: false } })

const catsRes = await call(handler, { method: 'GET', path: '/categories' })
eq('GET /categories', catsRes.json.value.categories.map(c => c.id), ['custom'])

// 任务 CRUD
const createdRes = await call(handler, {
  method: 'POST',
  path: '/tasks',
  body: { execKind: 'prompt', prompt: '写日报', title: '日报', cron: '0 22 * * *', category: 'work' },
})
eq('POST /tasks 200', createdRes.status, 200)
const apiTask = createdRes.json.value.task
check('新建返回完整任务', Object.keys(apiTask).join() === TASK_FIELDS.join())
const listRes = await call(handler, { method: 'GET', path: '/tasks' })
check('GET /tasks 含新任务', listRes.json.value.tasks.some(t => t.id === apiTask.id))
const filtered = await call(handler, { method: 'GET', path: '/tasks?category=work' })
eq('分类过滤生效', filtered.json.value.tasks.map(t => t.id), [apiTask.id])
const one = await call(handler, { method: 'GET', path: `/tasks/${apiTask.id}` })
check('GET /tasks/:id 200', one.status === 200 && one.json?.value?.task?.id === apiTask.id, one.raw)
check('详情含 latestRun 字段', one.json !== null && 'latestRun' in (one.json.value ?? {}))
const patchRes = await call(handler, { method: 'PATCH', path: `/tasks/${apiTask.id}`, body: { enabled: false } })
check('PATCH /tasks/:id 200', patchRes.status === 200 && patchRes.json.value.task.enabled === false)
const postPatchGone = await call(handler, { method: 'POST', path: `/tasks/${apiTask.id}`, body: { enabled: true } })
eq('POST /tasks/:id 别名已移除（405）', [postPatchGone.status, postPatchGone.json.error.code], [405, 'method-error'])
const putPatch = await call(handler, { method: 'PUT', path: `/tasks/${apiTask.id}`, body: { enabled: true } })
eq('PUT /tasks/:id 405', [putPatch.status, putPatch.json.error.code], [405, 'method-error'])
const shortIdProbe = await store.createTask({ execKind: 'prompt', prompt: '短前缀探针' }, { now: Date.now() - 86_400_000 })
const shortId = await call(handler, { method: 'GET', path: `/tasks/${shortIdProbe.id.slice(0, 13)}` })
check('短 id 时间戳前缀可解析', shortId.status === 200 && shortId.json.value.task.id === shortIdProbe.id)
const fullPrefix = await call(handler, { method: 'GET', path: `/tasks/${shortIdProbe.id.slice(0, 18)}` })
check('含序号前缀唯一命中', fullPrefix.status === 200 && fullPrefix.json.value.task.id === shortIdProbe.id)

// 运行记录
const runsEmpty = await call(handler, { method: 'GET', path: `/tasks/${apiTask.id}/runs` })
eq('运行记录空列表', runsEmpty.json.value.runs, [])
const apiRun = await store.startRun(apiTask.id, { trigger: 'schedule' })
await store.finishRun(apiRun.runId, { status: 'ok', exitCode: 0, summary: '接口验证', tailOutput: 'ok!' })
const runsPaged = await call(handler, { method: 'GET', path: `/tasks/${apiTask.id}/runs?limit=1&offset=0` })
eq('分页 total', runsPaged.json.value.total, 1)
eq('分页 limit', runsPaged.json.value.limit, 1)
eq('分页内容', runsPaged.json.value.runs.map(r => r.summary), ['接口验证'])
const runsBadStatus = await call(handler, { method: 'GET', path: `/tasks/${apiTask.id}/runs?status=bogus` })
eq('非法状态过滤：200 + bad-request', [runsBadStatus.status, runsBadStatus.json.error.code], [200, 'bad-request'])
const allRunsRes = await call(handler, { method: 'GET', path: '/runs?limit=3' })
eq('GET /runs 200 且分页', [allRunsRes.status, allRunsRes.json.value.runs.length, allRunsRes.json.value.total, allRunsRes.json.value.limit], [200, 3, 7, 3])

// 立即执行
const runNow = await call(handler, { method: 'POST', path: `/tasks/${apiTask.id}/run`, body: {} })
check('立即执行 200', runNow.status === 200 && runNowCalls.length === 1)
check('立即执行 trigger=manual', runNowCalls[0].trigger === 'manual')
busy = true
const busyRes = await call(handler, { method: 'POST', path: `/tasks/${apiTask.id}/run`, body: {} })
eq('并发满：200 + busy', [busyRes.status, busyRes.json.error.code], [200, 'busy'])
check('busy 带 retry-after', busyRes.headers['retry-after'] === '30')
busy = false
await call(handler, { method: 'POST', path: '/state', body: { paused: true } })
const pausedRun = await call(handler, { method: 'POST', path: `/tasks/${apiTask.id}/run`, body: {} })
eq('暂停中拒绝立即执行：200 + paused', [pausedRun.status, pausedRun.json.error.code], [200, 'paused'])
await call(handler, { method: 'POST', path: '/state', body: { paused: false } })

// 单条运行记录与错误分支
const runIdRes = await call(handler, { method: 'GET', path: `/tasks/${apiTask.id}/runs/${apiRun.runId}` })
eq('按 runId 取记录 200', runIdRes.status, 200)
check('记录内容一致', runIdRes.json.value.run.summary === '接口验证')
const noRun = await call(handler, { method: 'GET', path: `/tasks/${apiTask.id}/runs/nope-nope` })
eq('未知 runId 404', [noRun.status, noRun.json.error.code], [404, 'not-found'])
const noTask = await call(handler, { method: 'GET', path: '/tasks/deadbeefdead' })
eq('未知任务 404', [noTask.status, noTask.json.error.code], [404, 'not-found'])
const tooLarge = await call(handler, { method: 'POST', path: '/tasks', body: { execKind: 'prompt', prompt: 'x'.repeat(1_100_000) } })
eq('超大请求体：200 + too-large', [tooLarge.status, tooLarge.json.error.code], [200, 'too-large'])
const badJson = await call(handler, { method: 'POST', path: '/tasks', rawBody: '{not json' })
eq('非法 JSON：200 + bad-request', [badJson.status, badJson.json.error.code], [200, 'bad-request'])
const noBadge = await call(handler, { method: 'POST', path: '/tasks', body: { execKind: 'prompt' } })
eq('缺 prompt：200 + bad-request', [noBadge.status, noBadge.json.error.code], [200, 'bad-request'])

// 恢复「已装载 cron」状态再测真实预览路径（上面的降级块把注入实现置回 null 了）。
// 这里用**真实的 lib/cron.mjs** 当注入实现，等价于 lib/index.js 在 apply() 里的注册方式。
cronPreviewImpl = ({ cron, from }) => ({
  next: nextRuns(cron, 5, from === undefined || from === null ? new Date() : new Date(from)).map(date => date.toISOString()),
})
// cron 预览：真实实现路径（t9 后只保留 POST；GET + expr 别名已移除）
const cronPreviewReal = await call(handler, { method: 'POST', path: '/cron/preview', body: { cron: '*/5 * * * *' } })
eq('POST cron 预览 200', cronPreviewReal.status, 200)
eq('真实实现形状只有 cron/from/next', Object.keys(cronPreviewReal.json.value).sort(), ['cron', 'from', 'next'])
eq('真实实现返回 5 次', [cronPreviewReal.json.value.cron, cronPreviewReal.json.value.next.length], ['*/5 * * * *', 5])
const cronGetGone = await call(handler, { method: 'GET', path: '/cron/preview?expr=*%2F5%20*%20*%20*%20*' })
eq('GET cron 预览别名已移除（405）', [cronGetGone.status, cronGetGone.json.error.code], [405, 'method-error'])
cronPreviewImpl = async () => ({ next: ['2026-03-01T09:00:00.000Z', '2026-03-02T09:00:00.000Z', '2026-03-03T09:00:00.000Z', '2026-03-04T09:00:00.000Z', '2026-03-05T09:00:00.000Z'] })
const cronReal = await call(handler, { method: 'POST', path: '/cron/preview', body: { cron: '0 9 * * *' } })
eq('已装载实现返回 5 次', [cronReal.json.value.next.length, cronReal.json.value.from], [5, null])
const cronRealFrom = await call(handler, { method: 'POST', path: '/cron/preview', body: { cron: '0 9 * * *', from: '2026-03-01T00:00:00.000Z' } })
eq('from 参数透传', cronRealFrom.json.value.from, '2026-03-01T00:00:00.000Z')
cronPreviewImpl = null
const cronBad = await call(handler, { method: 'POST', path: '/cron/preview', body: { cron: '' } })
eq('cron 缺表达式：200 + cron-invalid', [cronBad.status, cronBad.json.error.code], [200, 'cron-invalid'])

// 删除
const delRes = await call(handler, { method: 'DELETE', path: `/tasks/${apiTask.id}` })
eq('DELETE /tasks/:id 200', delRes.status, 200)
check('删除返回 taskId/deletedAt', delRes.json.value.taskId === apiTask.id && typeof delRes.json.value.deletedAt === 'string')
const delAgain = await call(handler, { method: 'DELETE', path: `/tasks/${apiTask.id}` })
eq('重复删除 404', delAgain.status, 404)
const delAliasProbe = await store.createTask({ execKind: 'prompt', prompt: '删除别名探针' })
const delAlias = await call(handler, { method: 'POST', path: `/tasks/${delAliasProbe.id}/delete`, body: {} })
eq('POST /tasks/:id/delete 别名已移除（404）', [delAlias.status, delAlias.json.error.code], [404, 'not-found'])

// 无运行器 / 无 cron
const noRunnerWeb = makeWebServer()
registerApiRoutes(noRunnerWeb, { store })
const createNoRunner = await call(noRunnerWeb.handler, { method: 'POST', path: '/tasks', body: { execKind: 'prompt', prompt: 'x' } })
const noRunnerId = createNoRunner.json.value.task.id
const noRunner = await call(noRunnerWeb.handler, { method: 'POST', path: `/tasks/${noRunnerId}/run`, body: {} })
eq('无运行器：200 + runner-unavailable', [noRunner.status, noRunner.json.error.code], [200, 'runner-unavailable'])
const noCron = await call(noRunnerWeb.handler, { method: 'POST', path: '/cron/preview', body: { cron: '0 9 * * *' } })
eq('无 cron 实现：200 + internal（不用空 next 假装算出了结果）', [noCron.status, noCron.json.error.code], [200, 'internal'])

// 错误码模型（§11.5.4 线上码 + spec §5 映射）
check('spec §5 五个码齐备', SPEC_ERROR_CODES.every(c => ['E_VALIDATION', 'E_NOT_FOUND', 'E_CRON_INVALID', 'E_STORAGE', 'E_BUSY'].includes(c)))
check('spec 五码就是常量本身', SPEC_ERROR_CODES.join() === 'E_VALIDATION,E_NOT_FOUND,E_CRON_INVALID,E_STORAGE,E_BUSY')
check('每个线上码都映射到 spec 码', WIRE_ERROR_CODES.every(c => typeof SPEC_CODE_OF[c] === 'string'))
eq('线上码清单', [...WIRE_ERROR_CODES], ERROR_CODES)
eq('只有 forbid/method/not-found 用真实状态码', ERROR_STATUS, { 'forbidden': 403, 'method-error': 405, 'not-found': 404 })
eq('业务失败用 200', BUSINESS_ERROR_STATUS, 200)
check('busy 映射到 E_BUSY', SPEC_CODE_OF.busy === 'E_BUSY' && SPEC_CODE_OF['runner-unavailable'] === 'E_BUSY')
check('线上码无旧别名', !WIRE_ERROR_CODES.some(c => LEGACY_ERROR_CODES.includes(c)))
check('旧别名有归一化映射', LEGACY_ERROR_CODES.every(c => WIRE_ERROR_CODES.includes(WIRE_ALIAS_OF[c])))
eq('wireCodeOf 归一旧码', [wireCodeOf('invalid-cron'), wireCodeOf('storage-error'), wireCodeOf('invalid-task'), wireCodeOf('nope')], ['cron-invalid', 'storage', 'bad-request', 'internal'])
eq('PluginError 旧码也归一', new PluginError('invalid-cron', 'x').code, 'cron-invalid')
const thrownRes = makeRes()
writeThrown(thrownRes, new PluginError('storage-error', 'boom'))
eq('响应信封不含 specCode', Object.keys(JSON.parse(thrownRes.payload).error), ['code', 'message'])
eq('响应体只写冻结码', JSON.parse(thrownRes.payload).error.code, 'storage')

// 信任清单真源（§11.4/§11.5.2）
const runtimeCtx = { get: (n) => (n === 'webRuntime' ? { trustedHosts: ['100.64.0.1:3080', 'lan.example'] } : undefined) }
eq('trustedHostsOf 从 webRuntime 取', trustedHostsOf(runtimeCtx), ['100.64.0.1:3080', 'lan.example'])
eq('trustedHostsOf 合并 config 去重', trustedHostsOf(runtimeCtx, ['lan.example', 'extra:1']), ['lan.example', 'extra:1', '100.64.0.1:3080'])
eq('无 webRuntime 时为空', trustedHostsOf({ get: () => undefined }, []), [])
check('webRuntime 的 host 可通过栅栏', isTrustedApiRequest({ headers: { host: '100.64.0.1:3080' } }, trustedHostsOf(runtimeCtx)))
check('非清单 host 被拒', !isTrustedApiRequest({ headers: { host: 'evil.example.com' } }, trustedHostsOf(runtimeCtx)))

dispose()
eq('释放后路由移除', web.routes.length, 0)

// ── 4. 通知文件格式（spec §7） ───────────────────────────────────────────────
console.log('\n[4] 通知文件格式（spec §7）')
const notifyTask = store.requireTask(shellTask.id, { includeDeleted: true })
const header = renderNotificationHeader(notifyTask, root)
check('通知头含任务标题与路径', header.includes('# 定时任务：shell 任务') && header.includes('$DSH_HOME/dsh-task-scheduler/notify/'))
const entry = renderNotificationEntry({ task: notifyTask, run: store.latestRunOf(shellTask.id), dataRoot: root })
check('通知片段含时间', /## \d{4}-\d{2}-\d{2}T/.test(entry))
check('通知片段含任务名', entry.includes('shell 任务'))
check('通知片段含状态', entry.includes('成功') && entry.includes('`ok`'))
check('通知片段含会话 id 行', entry.includes('| 会话 |'))
check('通知片段含摘要', entry.includes('摘要：ok'))

// ── 5. 进程重启不丢 ─────────────────────────────────────────────────────────
console.log('\n[5] 进程重启不丢（子进程重读）')
// 快照用「当下的真实内存状态」，不硬编码数字。
const diskTaskCountBeforeReload = store.listTasks({ includeDeleted: true }).length
const diskRunCountBeforeReload = store.listRuns(created.id, { limit: 100 }).total
console.log(`  INFO  重启前：任务 ${diskTaskCountBeforeReload} 个、created 任务运行记录 ${diskRunCountBeforeReload} 条`)
// 子进程通过文件回传结果：本沙箱禁止「带管道的子进程」（EPERM），
// 因此用 stdio:'ignore' + 结果文件，而不是捕获 stdout。
const reloadScriptPath = join(root, 'reload-check.mjs')
const reloadOutPath = join(root, 'reload-out.json')
writeFileSync(reloadScriptPath, `
import { writeFileSync } from 'node:fs'
import { TaskStore } from ${JSON.stringify(new URL('../lib/store.mjs', import.meta.url).href)}
const store = new TaskStore({ dataRoot: ${JSON.stringify(root)} })
await store.init()
const tasks = store.listTasks({ includeDeleted: true })
const runs = store.listRuns(${JSON.stringify(created.id)}, { limit: 50 })
writeFileSync(${JSON.stringify(reloadOutPath)}, JSON.stringify({
  taskCount: tasks.length,
  runCount: runs.total,
  first: tasks.find(t => t.id === ${JSON.stringify(created.id)}),
  statuses: runs.runs.map(r => r.status),
  attempts: runs.runs.map(r => r.attempt),
  categories: store.state().categories.map(c => c.name),
  paused: store.state().paused,
}))
`, 'utf8')
const child = spawnSync(process.execPath, [reloadScriptPath], { stdio: 'ignore' })
check('子进程读取成功', child.status === 0 && existsSync(reloadOutPath), `status=${child.status} error=${child.error}`)
if (child.status === 0 && existsSync(reloadOutPath)) {
  const reloaded = JSON.parse(readFileSync(reloadOutPath, 'utf8'))
  eq('重启后任务数一致', reloaded.taskCount, diskTaskCountBeforeReload)
  eq('重启后运行记录数一致', reloaded.runCount, diskRunCountBeforeReload)
  eq('重启后状态一致', reloaded.statuses, ['ok', 'ok', 'timeout', 'skipped_overlap', 'ok'])
  eq('重启后 attempt 一致', reloaded.attempts, [5, 4, 3, 2, 1])
  eq('重启后分类一致', reloaded.categories, ['custom'])
  eq('重启后暂停位一致', reloaded.paused, false)
  eq('重启后任务字段顺序一致', Object.keys(reloaded.first), [...TASK_FIELDS, 'deletedAt'])
  check('重启后 prompt 原样保留', reloaded.first.prompt === '请汇总我昨天的工作')
}

// 原子性：损坏文件不得被静默覆盖
writeFileSync(join(root, TASKS_FILE_NAME), '{ broken', 'utf8')
const brokenStore = new TaskStore({ dataRoot: root })
await expectCode('损坏 tasks.json 抛 storage', () => brokenStore.init(), 'storage')
check('损坏后文件未被覆写', readFileSync(join(root, TASKS_FILE_NAME), 'utf8') === '{ broken')
writeFileSync(join(root, TASKS_FILE_NAME), '[]', 'utf8')

// ── 6. 插件入口 apply(ctx) ──────────────────────────────────────────────────
console.log('\n[6] 插件入口、inject 与 $DSH_HOME 解析（spec §11.4）')
const plugin = await import('../lib/index.js')
eq('插件名', plugin.name, 'dsh-task-scheduler')
eq('inject 含 webServer/sessions/agents/webRuntime', plugin.inject, ['webServer', 'sessions', 'agents', 'webRuntime'])
check('默认导出为 { apply } 形态', typeof plugin.default.apply === 'function' && plugin.default.name === plugin.name)

/** cordis 风格上下文桩（ctx.effect 立即执行 callback 并保存释放函数）。 */
function makeCtx(webServer, webRuntime) {
  const provided = new Map()
  const effects = []
  const logs = []
  const services = { webServer, webRuntime }
  return {
    provided,
    effects,
    logs,
    logger: (scope) => ({
      info: (m) => logs.push(`info:${scope}:${m}`),
      warn: (m) => logs.push(`warn:${scope}:${m}`),
    }),
    get: (n) => (n in services ? services[n] : provided.get(n)),
    provide: (n, v) => {
      provided.set(n, v)
      return () => provided.delete(n)
    },
    effect: (fn) => { const d = fn(); effects.push(d === undefined ? () => undefined : d); return d },
  }
}

const pluginRoot = join(root, 'plugin-home')
const ctx = makeCtx(makeWebServer(), { trustedHosts: ['100.64.0.1:3080'] })
await plugin.apply(ctx, { dataRoot: pluginRoot, trustedHosts: ['extra.example:1'] })
await ctx.provided.get('dsh-task-scheduler').ready()
check('服务已登记（点号名）', ctx.provided.has('dsh-task-scheduler'))
check('服务已登记（属性别名）', ctx.provided.has('dshTaskScheduler'))
const svc = ctx.provided.get('dsh-task-scheduler')
check('服务暴露 store', svc.store instanceof TaskStore)
const unregister = svc.registerRunner(async () => ({ runId: 'x' }))
check('runner 注册后可见', svc.hasRunner() === true)
unregister()
check('runner 注销后不可见', svc.hasRunner() === false)
const pluginWeb = makeCtx(makeWebServer(), { trustedHosts: ['100.64.0.1:3080'] })
await plugin.apply(pluginWeb, { dataRoot: pluginRoot })
await pluginWeb.get('dsh-task-scheduler').ready()
check('日志确认主目录后端来源', pluginWeb.logs.some(line => line.includes('主目录解析')))
check('日志确认信任清单来自 webRuntime', pluginWeb.logs.some(line => line.includes('100.64.0.1:3080')))
check('启用后数据根目录被创建', existsSync(pluginRoot))
const pluginHandler = pluginWeb.get('webServer').handler
const pluginList = await call(pluginHandler, { method: 'GET', path: '/tasks' })
eq('插件注册的路由可服务', pluginList.status, 200)
const pluginCreate = await call(pluginHandler, { method: 'POST', path: '/tasks', body: { execKind: 'prompt', prompt: '插件冒烟' } })
check('插件路由写入数据根', pluginCreate.status === 200 && existsSync(join(pluginRoot, TASKS_FILE_NAME)))
const pluginTrusted = await call(pluginHandler, { method: 'GET', path: '/state', host: '100.64.0.1:3080' })
eq('webRuntime 的 trustedHosts 生效', pluginTrusted.status, 200)
const pluginUntrusted = await call(pluginHandler, { method: 'GET', path: '/state', host: 'other.example.com' })
eq('未声明 host 仍被拒', [pluginUntrusted.status, pluginUntrusted.json.error.code], [403, 'forbidden'])
const pluginUnavailable = await call(pluginHandler, { method: 'POST', path: '/cron/preview', body: { cron: '0 9 * * *' } })
// t9 后不再有 available 降级：插件在 apply() 里就地注册 nextRuns，缺实现属内部缺陷。
eq('插件 cron 预览返回真实 5 次', [pluginUnavailable.status, pluginUnavailable.json.value.next.length], [200, 5])
const pluginDisabled = makeCtx(makeWebServer(), { trustedHosts: [] })
await plugin.apply(pluginDisabled, { enabled: false })
check('enabled:false 不注册任何东西', pluginDisabled.provided.size === 0 && pluginDisabled.effects.length === 0)

const originalHome = process.env.DSH_HOME
process.env.DSH_HOME = join(root, 'fake-home')
check('$DSH_HOME 生效', resolveDataRoot().endsWith(join('fake-home', 'dsh-task-scheduler')))
check('显式 home 优先于 $DSH_HOME', resolveDshHome(join(root, 'explicit')) === join(root, 'explicit'))
process.env.DSH_HOME = '   '
check('空白 $DSH_HOME 视为未设置', resolveDshHome().endsWith(join('.dsh')))
if (originalHome === undefined) delete process.env.DSH_HOME
else process.env.DSH_HOME = originalHome
check('主目录后端结论稳定', ['@deepseek-ai/dsh-home-paths', 'local-fallback'].includes(activeBackend()))

rmSync(root, { recursive: true, force: true })

// ── 7. docs/api-contract.md 与实现一致性（防止文档漂移） ─────────────────────
console.log('\n[7] 契约文档与实现一致性')
const contractPath = join(projectRoot, 'docs', 'api-contract.md')
check('契约文档存在', existsSync(contractPath))
if (existsSync(contractPath)) {
  const doc = readFileSync(contractPath, 'utf8')
  /** 抓某个小节内 markdown 表格的首列反引号字段名。 */
  const tableFields = (section) => {
    const start = doc.indexOf(section)
    if (start < 0) return []
    const rest = doc.slice(start + section.length)
    const nextHeading = rest.search(/^#{2,3} /m)
    const chunk = nextHeading < 0 ? rest : rest.slice(0, nextHeading)
    return [...chunk.matchAll(/^\| `([^`]+)`(?: \*\(补充\)\*)? \|/gm)].map(m => m[1])
  }
  eq('文档 §2.1 列出全部任务字段', tableFields('### 2.1 Task'), [...TASK_FIELDS])
  eq('文档 §2.2 列出全部运行记录字段（含补充）', tableFields('### 2.2 Run'), [...RUN_FIELDS, ...RUN_EXTRA_FIELDS])
  for (const code of WIRE_ERROR_CODES) {
    check(`文档 §5 收录线上错误码 ${code}`, doc.includes(`\`${code}\``))
  }
  for (const specCode of SPEC_ERROR_CODES) {
    check(`文档 §5 收录 spec 码 ${specCode}`, doc.includes(specCode))
  }
  for (const route of API_ROUTES) {
    const method = route.split(' ')[0]
    const path = route.split(/\s+/).pop().replace('/dsh-task-scheduler/api', '<base>')
    check(`文档 §4 收录路由 ${method} ${path}`, doc.includes(`| ${method} | \`${path}\``))
  }
  check('文档登记了 queued 扩展', doc.includes("'queued'") && doc.includes('并发上限 3'))
  check('文档登记了 catchup 扩展', doc.includes("'catchup'"))
  check('文档写明 inject 含 webRuntime', doc.includes('webRuntime'))
  check('文档写明 403 固定信封', doc.includes('forbidden') && doc.includes("code:'forbidden', message:'forbidden'"))
  check('文档声明验证结果与工具路径', /passed, 0 failed/.test(doc) && doc.includes('tools/verify.mjs'))
  check('文档含验证复现命令', doc.includes('node tools/verify.mjs') && doc.includes('node --check'))
}

console.log(`\n结果：${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
