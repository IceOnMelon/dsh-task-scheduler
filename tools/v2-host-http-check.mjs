/**
 * verifier-2 独立验证脚本 #2 —— 宿主 HTTP 层真实请求矩阵（只读 + 临时目录）
 *
 * 目的：不依赖任何实现方自检脚本，用**真实 http 服务器 + 真实 fetch** 打路由，
 * 逐条核对 spec §5 的路由 / 状态码 / 信封，并核对前端 lib/client.js 实际发出的
 * 请求形状能被宿主接受（API 契约一致性）。
 *
 * 绝不触碰 ~/.dsh：数据根一律用 os.tmpdir() 下的随机目录。
 */
import { createServer, request as httpRequest } from 'node:http'
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { TaskStore } from '../lib/store.mjs'
import { registerApiRoutes, API_PREFIX, MAX_BODY_BYTES } from '../lib/routes.mjs'

let pass = 0
let fail = 0
const failures = []
function ok(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ok   ${name}`) }
  else { fail += 1; failures.push(name); console.log(`  FAIL ${name} ${detail}`) }
}

const dataRoot = await mkdtemp(join(tmpdir(), 'v2-host-'))
const store = new TaskStore({ dataRoot })
await store.init()

const webServer = { register: (route) => { registerApiRoutes.registered = route; return () => {} } }
// webServer.register 需要真正把 handler 交给 http server；这里直接拿 handler
let handler = null
registerApiRoutes({ register: (route) => { handler = route.handler; return () => {} } }, {
  store,
  trustedHosts: [],
  runNow: async ({ taskId }) => ({ run: { runId: 'r-test', taskId } }),
  cronPreview: async ({ cron, from }) => {
    const { nextRuns } = await import('../lib/cron.mjs')
    const fromDate = from === undefined || from === null ? new Date() : new Date(from)
    if (Number.isNaN(fromDate.getTime())) throw Object.assign(new Error('bad from'), { code: 'bad-request' })
    try {
      return { next: nextRuns(String(cron), 5, fromDate).map(d => d.toISOString()) }
    } catch (error) {
      throw Object.assign(new Error(error.message), { code: error.code })
    }
  },
  isBusy: () => false,
})

const server = createServer((req, res) => { handler(req, res) })
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const base = `http://127.0.0.1:${port}${API_PREFIX}`

async function call(method, path, body, headers = {}) {
  const init = { method, headers: { host: `127.0.0.1:${port}`, ...headers } }
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json'
    init.body = typeof body === 'string' ? body : JSON.stringify(body)
  }
  const response = await fetch(`${base}${path}`, init)
  let json = null
  try { json = await response.json() } catch { /* 忽略 */ }
  return { status: response.status, json }
}

/**
 * 绕过 fetch 的 forbidden-header 规则，用 node:http 直接发指定 Host 的请求。
 * （fetch 会丢弃调用方设置的小写 host 头，因此 Host 栅栏类用例必须走这条路。）
 */
function rawCall(method, path, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body))
    const req = httpRequest({
      method,
      hostname: '127.0.0.1',
      port,
      path: `${API_PREFIX}${path}`,
      headers: {
        ...headers,
        ...(payload === null ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
      },
    }, (res) => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json = null
        try { json = JSON.parse(text) } catch { /* 忽略 */ }
        resolve({ status: res.statusCode, json })
      })
    })
    req.on('error', reject)
    if (payload !== null) req.write(payload)
    req.end()
  })
}

console.log(`\n[0] 数据根（临时）：${dataRoot}`)
console.log('\n[1] 路由 / 方法 / 404 / 405（spec §5 逐条）')

{
  const r = await call('GET', '')
  ok('GET <base> → 200 {ok:true}', r.status === 200 && r.json?.ok === true, JSON.stringify(r).slice(0, 200))
}
{
  const r = await call('GET', '/tasks')
  ok('GET /tasks → 200 且 value.tasks 是数组', r.status === 200 && Array.isArray(r.json?.value?.tasks), JSON.stringify(r).slice(0, 200))
}

const created = await call('POST', '/tasks', {
  title: '核验用任务',
  description: 'verifier-2',
  execKind: 'prompt',
  prompt: 'echo hello',
  category: 'work',
  workspaceCwd: process.cwd(),
  cron: '0 9 * * *',
  enabled: true,
  permission: 'workspace-write',
  autoApprove: false,
  missedRunPolicy: 'latest',
  logFilePath: null,
  notifyFile: null,
})
ok('POST /tasks（14 个可写字段）→ 200 {ok:true,value.task}', created.status === 200 && created.json?.ok === true && typeof created.json?.value?.task?.id === 'string', JSON.stringify(created).slice(0, 300))
const taskId = created.json?.value?.task?.id

{
  const r = await call('GET', `/tasks/${taskId}`)
  ok('GET /tasks/:id → 200 且 value.task.id 一致', r.status === 200 && r.json?.value?.task?.id === taskId, JSON.stringify(r).slice(0, 200))
}
{
  const r = await call('GET', '/tasks/does-not-exist')
  ok('GET /tasks/<未知 id> → not-found 且错误体只有 code/message',
    r.json?.ok === false && r.json?.error?.code === 'not-found' && Object.keys(r.json.error).sort().join(',') === 'code,message',
    `status=${r.status} ${JSON.stringify(r.json).slice(0, 200)}`)
  console.log(`  info 未知任务 id 的 HTTP 状态 = ${r.status}（spec §5 正文写「业务失败 200」，本实现按 ERROR_STATUS 返回 404：属实现取舍，见报告）`)
}
{
  const r = await call('GET', '/nope')
  ok('GET /nope → HTTP 404 + not-found', r.status === 404 && r.json?.error?.code === 'not-found', JSON.stringify(r).slice(0, 200))
}
{
  const r = await call('PUT', '/tasks')
  ok('PUT /tasks → HTTP 405 + method-error', r.status === 405 && r.json?.error?.code === 'method-error', JSON.stringify(r).slice(0, 200))
}
{
  const r = await rawCall('GET', '/tasks', { host: 'evil.example.com' })
  ok('Host: evil.example.com → HTTP 403 + forbidden（无 specCode）',
    r.status === 403 && r.json?.error?.code === 'forbidden' && r.json?.error?.message === 'forbidden'
    && Object.keys(r.json.error).sort().join(',') === 'code,message', JSON.stringify(r).slice(0, 300))
}
{
  const r = await rawCall('GET', '/tasks', { host: `127.0.0.1:${port}`, 'sec-fetch-site': 'cross-site' })
  ok('sec-fetch-site: cross-site → 403 forbidden', r.status === 403 && r.json?.error?.code === 'forbidden', JSON.stringify(r).slice(0, 200))
}
{
  const r = await rawCall('GET', '/tasks', { host: '127.0.0.1' })
  ok('Host: 127.0.0.1（无 Origin）→ 200 放行', r.status === 200 && r.json?.ok === true, JSON.stringify(r).slice(0, 200))
}
{
  const r = await rawCall('GET', '/tasks', { host: `localhost:${port}`, origin: `http://localhost:${port}` })
  ok('Host: localhost + 同源 Origin → 200 放行', r.status === 200 && r.json?.ok === true, JSON.stringify(r).slice(0, 200))
}
{
  const r = await rawCall('GET', '/tasks', { host: 'localhost', origin: 'http://evil.example.com' })
  ok('Host: localhost + 跨站 Origin → 403 forbidden（DNS-rebinding 防御）', r.status === 403 && r.json?.error?.code === 'forbidden', JSON.stringify(r).slice(0, 200))
}
{
  const r = await rawCall('GET', '/tasks', { host: 'localhost', origin: 'null' })
  ok('Origin: null → 403 forbidden', r.status === 403 && r.json?.error?.code === 'forbidden', JSON.stringify(r).slice(0, 200))
}
{
  const r = await rawCall('GET', '/tasks', { host: 'ts.example.ts.net' })
  ok('非回环可信清单外的 Host → 403 forbidden', r.status === 403 && r.json?.error?.code === 'forbidden', JSON.stringify(r).slice(0, 200))
}
{
  const big = 'x'.repeat(MAX_BODY_BYTES + 1024)
  const r = await call('POST', '/tasks', JSON.stringify({ title: big, execKind: 'prompt', prompt: 'a' }))
  ok('body > 1 MiB → too-large（不是 500）', r.json?.error?.code === 'too-large', JSON.stringify(r).slice(0, 200))
}
{
  const r = await call('POST', '/tasks', '{not json')
  ok('畸形 JSON → bad-request', r.json?.error?.code === 'bad-request', JSON.stringify(r).slice(0, 200))
}
{
  const r = await call('POST', '/cron/preview', { cron: '0 9 * * *' })
  ok('POST /cron/preview → {next:[ISO×5]}', r.status === 200 && Array.isArray(r.json?.value?.next) && r.json.value.next.length === 5, JSON.stringify(r).slice(0, 300))
}
{
  const r = await call('POST', '/cron/preview', { cron: '61 * * * *' })
  ok('非法 cron 预览 → error.code=cron-invalid（冻结码，不是 invalid-cron）', r.json?.error?.code === 'cron-invalid', JSON.stringify(r).slice(0, 200))
}
{
  const r = await call('GET', '/cron/preview?expr=0+9+*+*+*')
  ok('GET /cron/preview 别名不存在（405 方法错，不是 200）', r.status === 405, JSON.stringify(r).slice(0, 200))
}
{
  const r = await call('GET', '/overview')
  ok('GET /overview 别名不存在（404）', r.status === 404, JSON.stringify(r).slice(0, 200))
}
{
  const r = await call('POST', '/paused', { paused: true })
  ok('POST /paused 别名不存在（404）', r.status === 404, JSON.stringify(r).slice(0, 200))
}

console.log('\n[2] 前端 lib/client.js 实际发出的请求形状能否被宿主接受（契约一致性，最关键）')

// 前端早已改用 spec §5 的规范方法：这里改为断言**旧别名确实已移除**（防止有人再加回来）。
// 前端真正发出的 PATCH / DELETE 见下面两块，另有 tools/v2-client-pairing-check.mjs 逐条对照。
{
  const r = await call('POST', `/tasks/${taskId}`, { title: '改名' })
  ok('旧别名 POST /tasks/:id 已移除（宿主不再接受）', r.status !== 200 || r.json?.ok !== true, `status=${r.status} body=${JSON.stringify(r.json).slice(0, 200)}`)
}
{
  const r = await call('POST', `/tasks/${taskId}/delete`, {})
  ok('旧别名 POST /tasks/:id/delete 已移除（宿主不再接受）', r.status !== 200 || r.json?.ok !== true, `status=${r.status} body=${JSON.stringify(r.json).slice(0, 200)}`)
}
// spec §5 的规范方法（PATCH / DELETE）
{
  const r = await call('PATCH', `/tasks/${taskId}`, { title: '再改名' })
  ok('spec §5 的 PATCH /tasks/:id → 200', r.status === 200 && r.json?.ok === true, `status=${r.status} body=${JSON.stringify(r.json).slice(0, 200)}`)
}
{
  const r = await call('DELETE', `/tasks/${taskId}`)
  ok('spec §5 的 DELETE /tasks/:id → 200', r.status === 200 && r.json?.ok === true, `status=${r.status} body=${JSON.stringify(r.json).slice(0, 200)}`)
}

console.log('\n[3] 可写字段矩阵与非法值（t8 验收）')
{
  const t = await call('POST', '/tasks', { execKind: 'shell', cmd: 'echo hi', notifyFile: 'D:\\notify\\a.md', logFilePath: null })
  ok('POST 接受 notifyFile/logFilePath（显式 null 合法）', t.json?.ok === true && t.json?.value?.task?.notifyFile === 'D:\\notify\\a.md' && t.json?.value?.task?.logFilePath === null, JSON.stringify(t.json).slice(0, 300))
  const id = t.json?.value?.task?.id
  for (const field of ['id', 'createdAt', 'updatedAt', 'nextRunAt', 'lastRunAt', 'lastStatus', 'runCount', 'sessionIds']) {
    const r = await call('PATCH', `/tasks/${id}`, { [field]: 'x' })
    ok(`服务端管理字段 ${field} 被 PATCH 拒绝（bad-request）`, r.json?.ok === false && r.json?.error?.code === 'bad-request', JSON.stringify(r.json).slice(0, 200))
  }
  for (const bad of ['', '   ', 'a\u0000b', 'D:\\x|y.md', 'C:\\a:b\\c.md']) {
    const r = await call('PATCH', `/tasks/${id}`, { notifyFile: bad })
    ok(`非法 notifyFile ${JSON.stringify(bad)} → bad-request（不静默折算）`, r.json?.ok === false && r.json?.error?.code === 'bad-request', JSON.stringify(r.json).slice(0, 200))
  }
  const before = await readFile(join(dataRoot, 'tasks.json'), 'utf8')
  const bad2 = await call('PATCH', `/tasks/${id}`, { notifyFile: '' })
  const after = await readFile(join(dataRoot, 'tasks.json'), 'utf8')
  ok('非法值被拒后 tasks.json 逐字节不变（不落盘）', before === after && bad2.json?.ok === false)
}

console.log('\n[4] 落盘布局（spec §4）')
{
  const tasks = JSON.parse(await readFile(join(dataRoot, 'tasks.json'), 'utf8'))
  ok('tasks.json 是数组', Array.isArray(tasks))
  // state.json 只在首次写入全局状态时落盘（spec §4 列了该文件；这里是「惰性创建」的行为事实）
  const paused = await call('POST', '/state', { paused: true })
  ok('POST /state {paused:true} → 200 且 value.paused=true', paused.json?.ok === true && paused.json?.value?.paused === true, JSON.stringify(paused.json).slice(0, 200))
  const state = JSON.parse(await readFile(join(dataRoot, 'state.json'), 'utf8'))
  ok('写全局状态后 state.json 存在且含 paused/四个默认分类',
    typeof state.paused === 'boolean' && Array.isArray(state.categories) && state.categories.length >= 4, JSON.stringify(state).slice(0, 300))
  const names = state.categories.map(c => c.name).join(',')
  ok('默认分类 = 工作/学习/生活/其他', names === '工作,学习,生活,其他', names)
  // 用一个全新任务验证「暂停中拒绝立即执行」（taskId 变量此时已被 DELETE 软删）
  const fresh = await call('POST', '/tasks', { title: '暂停语义用', execKind: 'shell', cmd: 'echo hi' })
  const freshId = fresh.json?.value?.task?.id
  const pausedRun = await call('POST', `/tasks/${freshId}/run`, {})
  ok('全局暂停中 POST /tasks/:id/run → error.code=paused',
    pausedRun.json?.ok === false && pausedRun.json?.error?.code === 'paused', JSON.stringify(pausedRun.json).slice(0, 200))
  await call('POST', '/state', { paused: false })
  const html = tasks.map(t => JSON.stringify(t)).join('\n') + JSON.stringify(state)
  ok('落盘内容不含 password/token/secret/apiKey 字样', !/password|token|secret|api[-_]?key/i.test(html), html.slice(0, 200))
  const files = (await readdir(dataRoot)).sort()
  console.log(`  info 数据根文件：${files.join(', ')}（logs/ 与 notify/ 由运行器按需创建）`)
}
{
  // 运行记录路由：用真实调度器产出一条 queued 记录（stub runNow 只回 {run:{runId}}，不代表生产形状）
  const runTask = await call('POST', '/tasks', { title: '运行记录用', execKind: 'shell', cmd: 'echo hi' })
  const rid = runTask.json?.value?.task?.id
  const queued = await store.startRun(rid, { trigger: 'manual', status: 'queued' })
  await store.promoteQueuedRun(String(queued.runId), undefined)
  await store.finishRun(String(queued.runId), { status: 'ok', exitCode: 0, summary: '退出码 0', tailOutput: 'hi\n' })
  const all = await call('GET', '/runs')
  ok('GET /runs → {runs,total,limit,offset}', all.json?.ok === true && Array.isArray(all.json?.value?.runs) && typeof all.json?.value?.total === 'number', JSON.stringify(all.json).slice(0, 300))
  const one = await call('GET', `/tasks/${rid}/runs`)
  ok('GET /tasks/:id/runs → 任务维度运行记录', one.json?.ok === true && Array.isArray(one.json?.value?.runs), JSON.stringify(one.json).slice(0, 200))
  const single = await call('GET', `/tasks/${rid}/runs/${queued.runId}`)
  ok('GET /tasks/:id/runs/:runId → {taskId,run}', single.json?.ok === true && single.json?.value?.run?.runId === queued.runId, JSON.stringify(single.json).slice(0, 200))
  const files = await readdir(dataRoot)
  ok('runs.json 落盘', files.includes('runs.json'), files.join(','))
  const runJob = await call('POST', `/tasks/${rid}/run`, {})
  console.log(`  info stub runNow 返回形状：${JSON.stringify(runJob.json?.value)}（生产路径返回完整 Run 记录，见报告客户端兼容性一节）`)
}

await new Promise(resolve => server.close(resolve))
await rm(dataRoot, { recursive: true, force: true })

console.log(`\n结果：${pass} passed, ${fail} failed`)
if (failures.length > 0) console.log('失败项：\n  - ' + failures.join('\n  - '))
process.exit(fail === 0 ? 0 : 1)
