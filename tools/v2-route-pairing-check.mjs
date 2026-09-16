/**
 * verifier-2 独立核验 #6 —— 前端调用面 ↔ 宿主路由真源 逐条配对（只读）
 *
 * 两条独立判据（不写死任何清单）：
 *  A) 宿主文档路由表 API_ROUTES（client-dev-2 提供的判据）
 *  B) 宿主**真实分派器** resolveRoute：用 createApiHandler 挂到真实 http 服务器，
 *     对每个 (method, path) 实打一次，记录 HTTP 状态与 error.code。
 *
 * B 比 A 更强：A 只证明「路由表怎么写的」，B 证明「真实 handler 收不收」。
 * 两者都指向同一结论时，才允许在报告里写成「宿主契约如何如何」。
 */
import { createServer, request as httpRequest } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { TaskStore } from '../lib/store.mjs'
import { API_PREFIX, API_ROUTES, createApiHandler } from '../lib/routes.mjs'

let pass = 0
let fail = 0
function ok(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ok   ${name}`) }
  else { fail += 1; console.log(`  FAIL ${name} ${detail}`) }
}

// ── A) 宿主文档路由表 ──────────────────────────────────────────────────────
console.log('\n[A] 宿主文档路由表 API_ROUTES（client-dev-2 的判据）')
const RE = /^(GET|POST|PATCH|DELETE)\s+(\S*)/
const rows = API_ROUTES.map(r => {
  const g = RE.exec(r)
  const rel = g[2].slice(API_PREFIX.length)
  return { raw: r, method: g[1], rel: rel === '' ? '/' : rel }
})
ok('API_ROUTES 全部可解析（15 条）', rows.length === 15, `实际 ${rows.length}`)
for (const r of rows) console.log(`   ${r.method.padEnd(6)} ${r.rel}`)
const tableHas = (method, rel) => rows.some(r => r.method === method && r.rel === rel)
ok('POST /tasks/<taskId> 不存在（别名已删）', tableHas('POST', '/tasks/<taskId>') === false)
ok('POST /tasks/<taskId>/delete 不存在（别名已删）', tableHas('POST', '/tasks/<taskId>/delete') === false)
ok('PATCH /tasks/<taskId> 存在', tableHas('PATCH', '/tasks/<taskId>') === true)
ok('DELETE /tasks/<taskId> 存在', tableHas('DELETE', '/tasks/<taskId>') === true)

// ── B) 真实分派器实打 ─────────────────────────────────────────────────────
console.log('\n[B] 宿主真实 handler 实打（比路由表更强：证明「收不收」）')
const dataRoot = await mkdtemp(join(tmpdir(), 'v2-routepair-'))
const store = new TaskStore({ dataRoot })
await store.init()
const handler = createApiHandler({
  store,
  trustedHosts: [],
  runNow: async ({ taskId }) => ({ run: { runId: 'r-1', taskId, status: 'running' } }),
  cronPreview: async () => ({ next: new Array(5).fill(new Date().toISOString()) }),
  isBusy: () => false,
})

const server = createServer((req, res) => { handler(req, res) })
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

function call(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body)
    const req = httpRequest({
      method,
      hostname: '127.0.0.1',
      port,
      path: `${API_PREFIX}${path}`,
      headers: {
        host: `127.0.0.1:${port}`,
        ...(payload === null ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
      },
    }, (res) => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        let json = null
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { /* 忽略 */ }
        resolve({ status: res.statusCode, code: json?.error?.code ?? null })
      })
    })
    req.on('error', reject)
    if (payload !== null) req.write(payload)
    req.end()
  })
}

const task = await store.createTask({ title: '配对用', execKind: 'shell', cmd: 'echo a' })
const tid = task.id
const cases = [
  ['GET', `/tasks/${tid}`, 200, null, '规范：详情'],
  ['PATCH', `/tasks/${tid}`, 200, null, '规范：更新（前端应该用这条）'],
  ['DELETE', `/tasks/${tid}`, 200, null, '规范：删除（前端应该用这条）'],
  ['POST', `/tasks/${tid}`, 405, 'method-error', '前端 updateTask 目前在用 ⇒ 405'],
  ['POST', `/tasks/${tid}/delete`, 404, 'not-found', '前端 deleteTask 目前在用 ⇒ 404'],
]
for (const [method, path, wantStatus, wantCode, note] of cases) {
  const r = await call(method, path, method === 'GET' || method === 'DELETE' ? undefined : {})
  const statusOk = r.status === wantStatus
  const codeOk = wantCode === null ? r.code === null : r.code === wantCode
  ok(`${method} ${path.replace(tid, '<taskId>')} → ${wantStatus}${wantCode ? ' ' + wantCode : ''}（${note}）`, statusOk && codeOk, `实际 ${r.status} ${r.code}`)
}

// 前端另外 11 条调用面逐条实打
console.log('\n[B2] 前端其余调用面逐条实打（应全部命中宿主真源）')
const other = [
  ['GET', '', 200], ['GET', '/state', 200], ['POST', '/state', 200],
  ['GET', '/categories', 200], ['POST', '/categories', 200],
  ['GET', '/tasks', 200], ['POST', '/tasks', 200],
  ['GET', '/runs', 200], ['POST', '/cron/preview', 200],
]
for (const [method, path, want] of other) {
  const body = method === 'POST'
    ? (path === '/state' ? { paused: false }
      : path === '/categories' ? { categories: [{ id: 'w', name: '工作', color: '#4c8dff' }] }
        : path === '/cron/preview' ? { cron: '0 9 * * *' }
          : { execKind: 'shell', cmd: 'echo b' })
    : undefined
  const r = await call(method, path, body)
  ok(`${method} ${path === '' ? '/' : path} → ${want}`, r.status === want, `实际 ${r.status} ${r.code}`)
}
const t2 = await store.createTask({ title: '配对用2', execKind: 'shell', cmd: 'echo c' })
ok(`POST /tasks/<taskId>/run → 200`, (await call('POST', `/tasks/${t2.id}/run`, {})).status === 200)
ok(`GET /tasks/<taskId>/runs → 200`, (await call('GET', `/tasks/${t2.id}/runs`)).status === 200)

await new Promise(resolve => server.close(resolve))
await rm(dataRoot, { recursive: true, force: true })

console.log(`\n结果：${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
