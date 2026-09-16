/**
 * dsh-task-scheduler — `notifyFile` / `logFilePath` 路径字段规则自检
 * （t8 交付，随项目保留；归属见 docs/api-contract.md 头部「实现文件」清单）
 *
 * 用法（在项目根 `dsh-task-scheduler/` 下）：
 *   node tools/verify-paths.mjs
 *
 * 覆盖 t8 验收里「可配置 + 校验」的部分（规则冻结在 docs/api-contract.md §2.1.1）：
 *  1) 可空语义：缺省 / 显式 `null` = 用默认路径；非空字符串 = 用该路径，且可读回
 *  2) 非法值一律 `bad-request`（= spec §5 的 `E_VALIDATION`）：非字符串 / 空串 / 纯空白 /
 *     超长 / 控制字符 / `< > " | ? *` / 盘符以外的冒号
 *  3) **不落盘**：被拒的写入不改变 `tasks.json`（逐字节比对）
 *  4) HTTP 层（`POST /tasks`、`PATCH /tasks/:id`）真的接受这两个字段，错误也走同一套码
 *  5) 服务端管理字段仍然拒写
 *  6) 契约文档 §2.1.1 的矩阵与 `lib/model.mjs` 的常量逐项一致（防文档漂移）
 *
 * 只跑系统临时目录，不碰 `~/.dsh`、不碰真实数据根。
 */
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'

import { TaskStore } from '../lib/store.mjs'
import { API_PREFIX, registerApiRoutes } from '../lib/routes.mjs'
import {
  ILLEGAL_PATH_CHARS, TASK_SERVER_MANAGED_FIELDS, TASK_WRITABLE_FIELDS,
  assertUsablePath, readNullablePath,
} from '../lib/model.mjs'
import { TASKS_FILE_NAME } from '../lib/paths.mjs'

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

/** 断言某个路径值被拒绝，且线上码是 bad-request（specCode = E_VALIDATION）。 */
function expectRejected(name, value) {
  try {
    const result = readNullablePath({ notifyFile: value }, 'notifyFile')
    check(name, false, `未抛错，得到 ${JSON.stringify(result)}`)
  } catch (error) {
    check(name, error?.code === 'bad-request' && error?.specCode === 'E_VALIDATION', `code=${error?.code} specCode=${error?.specCode}`)
  }
}

const root = mkdtempSync(join(tmpdir(), 'dts-paths-'))
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))
console.log(`数据根：${root}`)

// ── 1. 单体校验：可空语义 ───────────────────────────────────────────────────
console.log('\n[1] readNullablePath：可空语义')
check('缺省 → null', readNullablePath({}, 'notifyFile') === null)
check('显式 null → null', readNullablePath({ notifyFile: null }, 'notifyFile') === null)
check('undefined → null', readNullablePath({ notifyFile: undefined }, 'notifyFile') === null)
eq('Windows 绝对路径原样保留', readNullablePath({ notifyFile: 'D:\\notify\\a.md' }, 'notifyFile'), 'D:\\notify\\a.md')
eq('POSIX 绝对路径原样保留', readNullablePath({ notifyFile: '/home/u/a.md' }, 'notifyFile'), '/home/u/a.md')
eq('UNC 路径原样保留', readNullablePath({ notifyFile: '\\\\server\\share\\a.md' }, 'notifyFile'), '\\\\server\\share\\a.md')
eq('相对路径不被本层禁止', readNullablePath({ notifyFile: 'notify/a.md' }, 'notifyFile'), 'notify/a.md')
eq('前后空白被去掉', readNullablePath({ notifyFile: '  D:\\a b.md  ' }, 'notifyFile'), 'D:\\a b.md')
check('盘符冒号不算非法', assertUsablePath('C:/logs/x.log', 'logFilePath') === 'C:/logs/x.log')

// ── 2. 单体校验：非法值一律 E_VALIDATION ───────────────────────────────────
console.log('\n[2] readNullablePath：非法值 → bad-request（E_VALIDATION）')
for (const [label, value] of [
  ['数字', 7],
  ['布尔', true],
  ['对象', {}],
  ['数组', []],
  ['空串', ''],
  ['纯空格', '   '],
  ['纯制表符', '\t\t'],
  ['超长（4001 字符）', `D:\\${'x'.repeat(4000)}`],
  ['NUL', 'D:\\a\u0000b.md'],
  ['换行', 'D:\\a\nb.md'],
  ['回车', 'D:\\a\rb.md'],
  ['内部制表符', 'D:\\a\tb.md'],
  ['DEL', 'D:\\a\u007fb.md'],
  ['小于号', 'D:\\a<b.md'],
  ['大于号', 'D:\\a>b.md'],
  ['双引号', 'D:\\a"b.md'],
  ['竖线', 'D:\\a|b.md'],
  ['问号', 'D:\\a?b.md'],
  ['星号', 'D:\\a*b.md'],
  ['流式冒号', 'D:\\a.txt:stream'],
  ['非盘符冒号', 'notify:a.md'],
]) {
  expectRejected(`拒绝：${label}`, value)
}
check('恰好 4000 字符可接受', readNullablePath({ notifyFile: 'D:\\' + 'x'.repeat(3997) }, 'notifyFile').length === 4000)
eq('非法字符常量', [...ILLEGAL_PATH_CHARS], ['<', '>', '"', '|', '?', '*'])

// ── 3. 存储层：可配置、可读回、不落盘 ──────────────────────────────────────
console.log('\n[3] 存储层：可配置 / 可读回 / 被拒的写入不落盘')
const store = new TaskStore({ dataRoot: root })
await store.init()
const tasksFile = join(root, TASKS_FILE_NAME)

const made = await store.createTask({
  execKind: 'shell',
  cmd: 'echo hi',
  logFilePath: 'D:\\logs\\a.log',
  notifyFile: 'D:\\notify\\a.md',
})
eq('POST 语义：两个路径写入实体', [made.logFilePath, made.notifyFile], ['D:\\logs\\a.log', 'D:\\notify\\a.md'])
const reread = new TaskStore({ dataRoot: root })
await reread.init()
eq('另一个进程实例读盘可读回', [reread.requireTask(made.id).logFilePath, reread.requireTask(made.id).notifyFile], ['D:\\logs\\a.log', 'D:\\notify\\a.md'])

const cleared = await store.updateTask(made.id, { logFilePath: null, notifyFile: null })
eq('PATCH 显式 null 回到默认路径', [cleared.logFilePath, cleared.notifyFile], [null, null])
check('默认日志路径 = logs/<taskId>.log', store.resolveLogFilePath(cleared).endsWith(join('logs', `${made.id}.log`)))
check('默认通知路径 = notify/<taskId>.md', store.resolveNotifyFilePath(cleared).endsWith(join('notify', `${made.id}.md`)))

const reSet = await store.updateTask(made.id, { notifyFile: 'D:\\notify\\b.md' })
eq('PATCH 单字段更新', [reSet.notifyFile, reSet.logFilePath], ['D:\\notify\\b.md', null])

const beforeBytes = readFileSync(tasksFile, 'utf8')
const beforeTask = store.requireTask(made.id)
for (const [label, patch] of [
  ['空串', { notifyFile: '' }],
  ['纯空白', { notifyFile: '   ' }],
  ['竖线', { notifyFile: 'D:\\a|b.md' }],
  ['冒号', { logFilePath: 'D:\\a:b.log' }],
  ['超长', { logFilePath: `D:\\${'y'.repeat(4000)}` }],
  ['类型错', { notifyFile: 42 }],
  ['null 以外的空值', { logFilePath: false }],
]) {
  try {
    await store.updateTask(made.id, patch)
    check(`更新被拒：${label}`, false, '未抛错')
  } catch (error) {
    check(`更新被拒：${label}（bad-request）`, error?.code === 'bad-request' && error?.specCode === 'E_VALIDATION', `code=${error?.code}`)
  }
}
eq('被拒的更新未改动 tasks.json（逐字节）', readFileSync(tasksFile, 'utf8'), beforeBytes)
eq('被拒的更新未改动内存实体', store.requireTask(made.id), beforeTask)
try {
  await store.createTask({ execKind: 'prompt', prompt: 'x', notifyFile: 'D:\\a*b.md' })
  check('创建被拒：星号', false, '未抛错')
} catch (error) {
  check('创建被拒：星号（bad-request）', error?.code === 'bad-request', `code=${error?.code}`)
}
eq('被拒的创建未落盘', readFileSync(tasksFile, 'utf8'), beforeBytes)

// ── 4. 服务端管理字段仍拒写 ────────────────────────────────────────────────
console.log('\n[4] 服务端管理字段仍拒写')
for (const field of TASK_SERVER_MANAGED_FIELDS) {
  try {
    await store.updateTask(made.id, { [field]: 1 })
    check(`PATCH 拒绝 ${field}`, false, '未抛错')
  } catch (error) {
    check(`PATCH 拒绝 ${field}`, error?.code === 'bad-request', `code=${error?.code}`)
  }
}
eq('被拒的服务端字段写入未落盘', readFileSync(tasksFile, 'utf8'), beforeBytes)

// ── 5. HTTP 层端到端（POST /tasks、PATCH /tasks/:id） ──────────────────────
console.log('\n[5] HTTP 层：POST /tasks 与 PATCH /tasks/:id')
const routes = []
const webServer = { register(route) { routes.push(route); return () => {} } }
registerApiRoutes(webServer, { store, trustedHosts: [] })
const handler = routes[0].handler

function makeReq({ method, path, body }) {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')])
  stream.method = method
  stream.url = `${API_PREFIX}${path}`
  stream.headers = { host: '127.0.0.1:3080', 'sec-fetch-site': 'same-origin' }
  return stream
}
async function call(options) {
  const res = {
    status: 0, headers: {}, payload: '', writableEnded: false,
    writeHead(status, headers) { res.status = status; res.headers = headers ?? {} },
    end(chunk) { res.payload = chunk === undefined ? '' : String(chunk); res.writableEnded = true },
  }
  await handler(makeReq(options), res)
  let json = null
  try { json = JSON.parse(res.payload) } catch { /* 非 JSON */ }
  return { status: res.status, json }
}

const httpCreated = await call({
  method: 'POST',
  path: '/tasks',
  body: { execKind: 'shell', cmd: 'echo hi', logFilePath: 'D:\\logs\\http.log', notifyFile: 'D:\\notify\\http.md' },
})
check('POST /tasks 接受两个路径', httpCreated.status === 200 && httpCreated.json.value.task.logFilePath === 'D:\\logs\\http.log' && httpCreated.json.value.task.notifyFile === 'D:\\notify\\http.md', httpCreated.payload?.slice(0, 200))
const httpId = httpCreated.json.value.task.id
const httpPatched = await call({ method: 'PATCH', path: `/tasks/${httpId}`, body: { notifyFile: 'D:\\notify\\http2.md', logFilePath: null } })
eq('PATCH /tasks/:id 改 notifyFile 并清 logFilePath', [httpPatched.status, httpPatched.json.value.task.notifyFile, httpPatched.json.value.task.logFilePath], [200, 'D:\\notify\\http2.md', null])
const httpGet = await call({ method: 'GET', path: `/tasks/${httpId}` })
eq('GET /tasks/:id 返回真实值', [httpGet.json.value.task.notifyFile, httpGet.json.value.task.logFilePath], ['D:\\notify\\http2.md', null])
const httpBad = await call({ method: 'PATCH', path: `/tasks/${httpId}`, body: { notifyFile: '' } })
eq('HTTP 非法路径：200 信封 + bad-request', [httpBad.status, httpBad.json.error.code], [200, 'bad-request'])
const httpServerField = await call({ method: 'PATCH', path: `/tasks/${httpId}`, body: { nextRunAt: '2026-01-01T00:00:00.000Z' } })
eq('HTTP 服务端字段：200 信封 + bad-request', [httpServerField.status, httpServerField.json.error.code], [200, 'bad-request'])

// ── 6. 契约文档 §2.1.1 矩阵与实现常量一致 ──────────────────────────────────
console.log('\n[6] 契约文档 §2.1.1 矩阵 vs 实现常量')
const contractPath = join(projectRoot, 'docs', 'api-contract.md')
const doc = readFileSync(contractPath, 'utf8')
const heading = '### 2.1.1 可写字段 vs 服务端管理字段（矩阵）'
const start = doc.indexOf(heading)
check('契约含 §2.1.1 矩阵小节', start >= 0)
const rest = start < 0 ? '' : doc.slice(start + heading.length)
const nextHeading = rest.search(/^#{2,3} /m)
const chunk = nextHeading < 0 ? rest : rest.slice(0, nextHeading)
const rows = [...chunk.matchAll(/^\| `([^`]+)` \| (可写|服务端管理) \|/gm)].map(m => ({ field: m[1], kind: m[2] }))
eq('矩阵「可写」集合与 TASK_WRITABLE_FIELDS 一致', rows.filter(r => r.kind === '可写').map(r => r.field), [...TASK_WRITABLE_FIELDS])
eq('矩阵「服务端管理」集合与常量一致', rows.filter(r => r.kind === '服务端管理').map(r => r.field), [...TASK_SERVER_MANAGED_FIELDS])
check('两个路径字段在矩阵里被标为可写', ['logFilePath', 'notifyFile'].every(f => rows.some(r => r.field === f && r.kind === '可写')))
check('文档写明空串被拒（不是回默认）', doc.includes('空串') && doc.includes('E_VALIDATION'))
check('文档写明控制字符与 Windows 保留字符规则', doc.includes('控制字符') && doc.includes('Windows 保留字符') && doc.includes('盘符'))

rmSync(root, { recursive: true, force: true })
console.log(`\n结果：${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
