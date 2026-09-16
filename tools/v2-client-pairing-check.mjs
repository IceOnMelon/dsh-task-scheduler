/**
 * verifier-2 —— t15 闸门：lib/client.js 真实发出的 (method, path) ↔ 宿主路由真源 配对复核
 *
 * 这是 t6/F1 当初漏过去的那个盲区：前端自检用**手写 fetch 桩**断言「前端自己期望的形状」，
 * 永远不会与「宿主真正接受的方法/路径」碰撞。本脚本改为**从 lib/client.js 源码里抽取真实调用面**，
 * 再逐条对宿主的 `API_ROUTES`（唯一真源）做配对，并对**无法解析的调用形状 fail loud**——
 * 不允许「抽不到就当通过」。
 *
 * 用法：
 *   node tools/v2-client-pairing-check.mjs              # 断言：每条前端调用面都必须命中宿主路由
 *   node tools/v2-client-pairing-check.mjs --expect-red  # 基线模式：t13 未落地时，允许 2 条 CRUD 不匹配
 *
 * 预期生命周期：t13（CRUD 改 PATCH/DELETE）落地前 `--expect-red` 通过、无参运行失败；
 * 落地后两种模式都应通过。t11 的**字段级**漂移不在本脚本范围（见 v2-client-regression-check.mjs）。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { API_ROUTES, API_PREFIX } from '../lib/routes.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const expectRed = process.argv.includes('--expect-red')

let pass = 0
let fail = 0
const failures = []
function ok(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ok   ${name}`) }
  else { fail += 1; failures.push(name); console.log(`  FAIL ${name} ${detail}`) }
}

// ── 宿主真源 ───────────────────────────────────────────────────────────────
const ROUTE_RE = /^(GET|POST|PATCH|DELETE)\s+(\S*)/
const hostRoutes = API_ROUTES.map(raw => {
  const g = ROUTE_RE.exec(raw)
  const rel = g[2].slice(API_PREFIX.length)
  return { method: g[1], path: rel === '' ? '/' : rel }
})
const hostHas = (method, path) => hostRoutes.some(r => r.method === method && r.path === path)

// ── 抽取范围：只扫 `var api = { … }` 对象字面量（排除 request* 助手自身的实现体）──
const src = readFileSync(join(root, 'lib/client.js'), 'utf8')
const lines = src.split(/\r?\n/)
const startIdx = lines.findIndex(l => /^\s{4}var api = \{/.test(l))
if (startIdx < 0) {
  console.error('FAIL 未找到 `var api = {`：前端调用面抽取前置失败，本闸门不可信')
  process.exit(2)
}
let endIdx = startIdx + 1
for (let i = startIdx + 1; i < lines.length; i += 1) {
  if (/^\s{4}\}\s*$/.test(lines[i])) { endIdx = i; break }
}
console.log(`\n[0] 抽取范围：lib/client.js:${startIdx + 1}-${endIdx + 1}（api 对象字面量，共 ${endIdx - startIdx - 1} 行）`)
ok('抽取范围合理（>10 行且不覆盖整个文件）', endIdx - startIdx > 10 && endIdx < lines.length - 5, `${startIdx + 1}-${endIdx + 1}`)

/** 请求助手名 → HTTP 方法（t13 若新增 requestPatch/requestDelete，这里已预置）。 */
const HELPER_METHOD = {
  requestRead: 'GET',
  requestWrite: 'POST',
  requestPatch: 'PATCH',
  requestDelete: 'DELETE',
  requestUpdate: 'PATCH',
  requestRemove: 'DELETE',
}

const unresolved = []
const observed = []

for (let index = startIdx; index <= endIdx; index += 1) {
  const line = lines[index]
  const lineNo = index + 1
  if (!/request(Read|Write|Patch|Delete|Update|Remove|Once)\s*\(/.test(line)) continue

  // 1) 方法
  let method = null
  const helper = /\b(request(?:Read|Write|Patch|Delete|Update|Remove))\s*\(/.exec(line)
  if (helper !== null) method = HELPER_METHOD[helper[1]] ?? null
  if (method === null) {
    const literal = /\brequestOnce\s*\(\s*'([A-Z]+)'/.exec(line)
    if (literal !== null) method = literal[1]
  }
  if (method === null) { unresolved.push({ lineNo, text: line.trim(), why: '无法判定 HTTP 方法' }); continue }

  // 2) 路径
  let path = null
  const apiPathCall = /apiPath\(\s*id\s*(?:,\s*'([^']*)'\s*(?:\+\s*(.+?))?\s*)?\)/.exec(line)
  if (apiPathCall !== null) {
    const tail = apiPathCall[1]
    const concat = apiPathCall[2]
    if (tail === undefined) path = '/tasks/<taskId>'
    else if (tail === '/delete') path = '/tasks/<taskId>/delete'
    else if (tail === '/run') path = '/tasks/<taskId>/run'
    else if (tail === '/runs') path = '/tasks/<taskId>/runs' // 后面拼的是查询串，不是路径段
    else if (tail === '/runs/' && concat !== undefined) path = '/tasks/<taskId>/runs/<runId>'
    else if (tail.endsWith('/') && concat !== undefined) path = `/tasks/<taskId>${tail}<runId>`
    else path = `/tasks/<taskId>${tail}`
  } else {
    const literalArg = /\brequest(?:Read|Write|Patch|Delete|Update|Remove|Once)\s*\(\s*(?:'[A-Z]+'\s*,\s*)?'([^']*)'/.exec(line)
    if (literalArg !== null) path = literalArg[1]
  }
  if (path === null) { unresolved.push({ lineNo, text: line.trim(), why: '无法判定路径模板' }); continue }

  // 3) 调用方属性名（就近向上找 `name: function`）
  let caller = null
  for (let i = index; i >= startIdx && index - i < 8; i -= 1) {
    const m = /^\s*([A-Za-z][A-Za-z0-9_]*)\s*:\s*function/.exec(lines[i])
    if (m !== null) { caller = { name: m[1], lineNo: i + 1 }; break }
  }
  observed.push({ lineNo, method, path, caller })
}

console.log(`\n[1] 抽取到的真实调用面（${observed.length} 条）`)
for (const c of observed) {
  const hit = hostHas(c.method, c.path)
  console.log(`   ${hit ? '✓' : '✗'} ${c.method.padEnd(6)} ${c.path.padEnd(30)} ← ${c.caller ? c.caller.name + ' (:' + c.caller.lineNo + ')' : ':' + c.lineNo}`)
}

console.log('\n[2] fail-loud：无法解析的调用形状（不允许静默略过）')
for (const u of unresolved) console.log(`   ! :${u.lineNo} ${u.why} —— ${u.text.slice(0, 110)}`)
ok('没有无法解析的调用形状（否则本闸门不完整）', unresolved.length === 0, `发现 ${unresolved.length} 处`)

console.log('\n[3] 抽取完整性自检')
ok('抽到的调用面 ≥ 10 条', observed.length >= 10, `实际 ${observed.length}`)
const methodSet = [...new Set(observed.map(c => c.method))].sort()
console.log(`   info 观察到的方法集合（钉住）：${methodSet.join(',')}`)
ok('观察到的方法都在 host 支持的 4 个方法内', methodSet.every(m => ['GET', 'POST', 'PATCH', 'DELETE'].includes(m)), methodSet.join(','))

console.log('\n[4] 逐条配对（宿主 API_ROUTES 为唯一真源）')
const mismatches = observed.filter(c => !hostHas(c.method, c.path))
const isBaselineMismatch = c => c.method === 'POST' && ['/tasks/<taskId>', '/tasks/<taskId>/delete'].includes(c.path)
let knownRed = 0
for (const c of observed) {
  const where = `（调用方 ${c.caller ? c.caller.name : '?'}:${c.caller ? c.caller.lineNo : c.lineNo}）`
  if (hostHas(c.method, c.path)) ok(`${c.method} ${c.path} 命中宿主路由`, true)
  else if (expectRed && isBaselineMismatch(c)) { knownRed += 1; console.log(`  red  ${c.method} ${c.path} 未命中宿主路由 ${where} —— 基线预期（t13 待修）`) }
  else fail += 1, failures.push(`${c.method} ${c.path} 命中宿主路由`), console.log(`  FAIL ${c.method} ${c.path} 未命中宿主路由 ${where}`)
}

console.log('\n[5] 结论')
if (mismatches.length === 0) console.log('   前端全部调用面与宿主契约一致。')
else {
  console.log(`   不匹配 ${mismatches.length} 条：`)
  for (const c of mismatches) console.log(`     - ${c.method} ${c.path}（调用方 ${c.caller ? c.caller.name : '?'}:${c.caller ? c.caller.lineNo : c.lineNo}）`)
}

const baselineOk = mismatches.length === 2 && mismatches.every(isBaselineMismatch)
ok(expectRed
  ? `基线模式：不匹配项恰好是 t13 的两条 CRUD 调用面（实测 ${knownRed} 条 known-red）`
  : '所有前端调用面均命中宿主路由',
expectRed ? baselineOk : mismatches.length === 0,
`mismatches=${JSON.stringify(mismatches.map(c => c.method + ' ' + c.path))}`)

console.log(`\n结果：${pass} passed, ${knownRed} known-red, ${fail} failed${expectRed ? '（基线模式 --expect-red）' : ''}`)
if (failures.length > 0) console.log('失败项：\n  - ' + failures.join('\n  - '))
process.exit(fail === 0 ? 0 : 1)
