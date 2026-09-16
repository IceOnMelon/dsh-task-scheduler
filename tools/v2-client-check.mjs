/**
 * verifier-2 独立验证脚本（只读 + 临时目录，绝不触碰 ~/.dsh）
 *
 * 1) 用 Node 桩加载 lib/client.js（替换 window.__ModuleLoader__），断言：
 *    - factory 可取出，模块带 apply / inject
 *    - inject 至少含 'slots'
 *    - sidebar.panellist 恰好注册一次，带 id / order / label(function)
 *    - main 恰好注册一次，key 与 panellist 的 id 同名
 * 2) 直接调用 lib/cron.mjs 的 nextRun，覆盖 4 类用例。
 */
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

let pass = 0
let fail = 0
const failures = []
function ok(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ok   ${name}`) }
  else { fail += 1; failures.push(name); console.log(`  FAIL ${name} ${detail}`) }
}

// ── 1) 客户端 bundle 桩加载 ────────────────────────────────────────────────
console.log('\n[1] lib/client.js 桩加载')
let reg = null
const sandboxWindow = {}
const ctxObject = {
  window: sandboxWindow,
  console,
  document: undefined,
  navigator: undefined,
}
sandboxWindow.__ModuleLoader__ = { load: (options) => { reg = options } }
createContext(ctxObject)
runInContext(readFileSync(join(root, 'lib/client.js'), 'utf8'), ctxObject, { filename: 'client.js' })

ok('__ModuleLoader__.load 被调用一次', reg !== null && typeof reg === 'object')
ok('注册 id = dsh-task-scheduler', reg?.id === 'dsh-task-scheduler', String(reg?.id))
ok('factory 是函数', typeof reg?.factory === 'function')

let reactCalls = []
const reactStub = {
  createElement: (...args) => { reactCalls.push(args); return { __el: true, args } },
}
const requireStub = (spec) => {
  if (spec === 'react') return reactStub
  throw new Error(`未预期的平台模块请求：${spec}`)
}

let mod = null
let factoryError = null
/** 覆盖 Node 全局（navigator 在 Node 24 里只有 getter，必须用 defineProperty）。 */
const savedGlobals = {}
function setGlobal(name, value) {
  if (!(name in savedGlobals)) {
    savedGlobals[name] = { had: name in globalThis, descriptor: Object.getOwnPropertyDescriptor(globalThis, name) }
  }
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true, enumerable: true })
}
function restoreGlobals() {
  for (const [name, saved] of Object.entries(savedGlobals)) {
    if (saved.descriptor) Object.defineProperty(globalThis, name, saved.descriptor)
    else delete globalThis[name]
  }
}
setGlobal('document', {
  documentElement: { lang: 'zh-CN', getAttribute: (name) => (name === 'lang' ? 'zh-CN' : null) },
  head: { appendChild: () => {} },
  getElementById: () => null,
  createElement: () => ({ setAttribute: () => {}, appendChild: () => {}, textContent: '' }),
})
setGlobal('navigator', { language: 'zh-CN' })
try {
  mod = reg.factory(requireStub)
} catch (error) {
  factoryError = error
}
restoreGlobals()

ok('factory(require) 不抛错', factoryError === null, factoryError ? String(factoryError && factoryError.message) : '')
ok('模块导出 apply 函数', typeof mod?.apply === 'function')
ok('模块导出 inject 数组', Array.isArray(mod?.inject), JSON.stringify(mod?.inject))
ok("inject 含 'slots'", Array.isArray(mod?.inject) && mod.inject.includes('slots'), JSON.stringify(mod?.inject))

// apply 桩上下文：捕获每个槽的注册
const registrations = []
const slotCtx = {
  slots: {
    inject: (slot, fn) => { registrations.push({ slot, fn, called: false }); return () => {} },
    register: (options, component) => {
      const last = registrations[registrations.length - 1]
      if (last) last.called = true
      registrations.push({ slot: `register:${options?.name}`, options, component })
      return () => {}
    },
  },
  get: () => undefined,
}
let applyError = null
try {
  const createPanel = mod.apply(slotCtx)
  // apply 返回 undefined，但注册与 inject 都是同步的；也允许返回 Promise
  if (createPanel && typeof createPanel.then === 'function') await createPanel
} catch (error) {
  applyError = error
}
ok('apply(ctx) 不抛错', applyError === null, applyError ? String(applyError.message) : '')

const injectCalls = registrations.filter(r => r.slot === 'sidebar.panellist' || r.slot === 'main')
ok("ctx.slots.inject 被调用两次（sidebar.panellist + main）", injectCalls.length === 2, JSON.stringify(registrations.map(r => r.slot)))
ok("inject('sidebar.panellist') 命中", injectCalls.some(r => r.slot === 'sidebar.panellist'))
ok("inject('main') 命中", injectCalls.some(r => r.slot === 'main'))

// 模拟外壳物化：对每个槽调用一次 fn
for (const r of injectCalls) r.fn()
const registers = registrations.filter(r => typeof r.slot === 'string' && r.slot.startsWith('register:'))
const panellistRegs = registers.filter(r => r.options?.name === 'sidebar.panellist')
const mainRegs = registers.filter(r => r.options?.name === 'main')
ok('sidebar.panellist 注册恰好一次', panellistRegs.length === 1, String(panellistRegs.length))
ok('main 注册恰好一次', mainRegs.length === 1, String(mainRegs.length))

const panelOptions = panellistRegs[0]?.options ?? {}
ok('panellist 带 id', typeof panelOptions.id === 'string' && panelOptions.id !== '', JSON.stringify(panelOptions.id))
ok('panellist 带 order（数字）', typeof panelOptions.order === 'number', JSON.stringify(panelOptions.order))
ok('panellist label 是函数（随语言变化）', typeof panelOptions.label === 'function', typeof panelOptions.label)
let labelZh = null
let labelEn = null
try {
  labelZh = panelOptions.label?.({})
} catch { /* 忽略 */ }
ok('label() 返回非空字符串', typeof labelZh === 'string' && labelZh !== '', JSON.stringify(labelZh))
if (typeof panelOptions.label === 'function') {
  setGlobal('document', {
    documentElement: { lang: 'en-US', getAttribute: (name) => (name === 'lang' ? 'en-US' : null) },
    head: { appendChild: () => {} },
    getElementById: () => null,
  })
  setGlobal('navigator', { language: 'en-US' })
  try { labelEn = panelOptions.label({}) } catch { /* 忽略 */ }
  restoreGlobals()
}
const mainOptions = mainRegs[0]?.options ?? {}
ok('main 的 key 与 panellist 的 id 同名', mainOptions.key === panelOptions.id, `key=${JSON.stringify(mainOptions.key)} id=${JSON.stringify(panelOptions.id)}`)
ok('panellist 注册带组件（TaskIcon）', typeof panellistRegs[0]?.component === 'function')
ok('main 注册带组件（TaskPanel）', typeof mainRegs[0]?.component === 'function')
console.log(`  info label(zh)=${JSON.stringify(labelZh)} label(en)=${JSON.stringify(labelEn)} order=${panelOptions.order}`)

// 图标/面板不会被这里的桩渲染（无 react-dom），只做类型断言
console.log(`  info 本次加载触发的 React.createElement 调用数=${reactCalls.length}`)

// ── 2) cron.nextRun 四类用例 ───────────────────────────────────────────────
console.log('\n[2] lib/cron.mjs nextRun')
const cron = await import(new URL('../lib/cron.mjs', import.meta.url).href)
ok("导出 nextRun", typeof cron.nextRun === 'function')
ok("导出 parseCron", typeof cron.parseCron === 'function')

const local = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi, 0, 0)

{
  const from = local(2026, 9, 16, 10, 30)
  const r = cron.nextRun('0 9 * * *', from)
  ok('`0 9 * * *` from 2026-09-16T10:30(local) → 次日 09:00（严格大于起点）',
    r instanceof Date && !Number.isNaN(r.getTime())
    && r.getFullYear() === 2026 && r.getMonth() === 8 && r.getDate() === 17 && r.getHours() === 9 && r.getMinutes() === 0,
    r instanceof Date ? r.toString() : String(r))
  console.log(`  info nextRun('0 9 * * *', ${from.toISOString()}) = ${r instanceof Date ? r.toISOString() : r}（本地 ${r}）`)
}
{
  const from = local(2026, 9, 16, 10, 31)
  const r = cron.nextRun('*/5 * * * *', from)
  ok('`*/5 * * * *` from 10:31(local) → 10:35',
    r instanceof Date && r.getHours() === 10 && r.getMinutes() === 35 && r.getDate() === 16,
    r instanceof Date ? r.toString() : String(r))
  console.log(`  info nextRun('*/5 * * * *', ${from.toISOString()}) = ${r instanceof Date ? r.toISOString() : r}`)
}
{
  const from = local(2026, 9, 16, 10, 30)
  const r = cron.nextRun('0 0 1 * *', from)
  ok('`0 0 1 * *` from 2026-09-16 → 2026-10-01T00:00',
    r instanceof Date && r.getFullYear() === 2026 && r.getMonth() === 9 && r.getDate() === 1 && r.getHours() === 0,
    r instanceof Date ? r.toString() : String(r))
  console.log(`  info nextRun('0 0 1 * *', ${from.toISOString()}) = ${r instanceof Date ? r.toISOString() : r}`)
}
{
  // 额外：nextRun 结果必须落在分钟边界，且严格大于 from
  const from = local(2026, 9, 16, 9, 0)
  const r = cron.nextRun('0 9 * * *', from)
  ok('nextRun 严格大于起点（同分钟不重复命中）', r.getTime() > from.getTime(), `${from.toISOString()} -> ${r.toISOString()}`)
  ok('nextRun 秒/毫秒为 0', r.getSeconds() === 0 && r.getMilliseconds() === 0)
}
{
  // 额外：日/周同时受限时的 Vixie 语义（取或），以及区间/列表组合
  const from = local(2026, 9, 16, 10, 30)
  const viaDom = cron.nextRun('0 9 1 * 1', from)
  ok('`0 9 1 * 1` 取或语义：从 2026-09-16（周三）起下一次命中的是最近的周一 09-21（不是 10-01）',
    viaDom.getMonth() === 8 && viaDom.getDate() === 21 && viaDom.getHours() === 9,
    viaDom.toString())
  const listRange = cron.nextRun('0 9 * * 1-5', from)
  ok('`0 9 * * 1-5`（工作日）→ 2026-09-17（周四）09:00',
    listRange.getDate() === 17 && listRange.getHours() === 9, listRange.toString())
  const both = cron.nextRun('15,45 */2 * * *', from)
  ok('`15,45 */2 * * *`（列表 + 步进）→ 2026-09-16 10:45',
    both.getDate() === 16 && both.getHours() === 10 && both.getMinutes() === 45, both.toString())
  const after = cron.nextRun('0 9 1 * 1', local(2026, 9, 22, 10, 30))
  ok('`0 9 1 * 1` 从 2026-09-22 起下一次仍是周一 2026-09-28（证明「周」分支未失效）',
    after.getMonth() === 8 && after.getDate() === 28 && after.getHours() === 9,
    after.toString())
  const domOnly = cron.nextRun('0 9 1 * *', local(2026, 9, 22, 10, 30))
  ok('`0 9 1 * *` 的「日」分支单独生效 → 2026-10-01 09:00',
    domOnly.getMonth() === 9 && domOnly.getDate() === 1 && domOnly.getHours() === 9,
    domOnly.toString())
}
{
  const invalid = ['', '0 9 * *', '60 9 * * *', '0 24 * * *', '0 9 32 * *', '*/0 * * * *', '0 9 * * 8', 'a b c d e', '0 9 * * * *', '5-1 * * * *', '0 9 * 13 *']
  let allThrew = true
  const detail = []
  for (const expr of invalid) {
    try {
      const r = cron.nextRun(expr, local(2026, 9, 16, 10, 30))
      allThrew = false
      detail.push(`${JSON.stringify(expr)} → 未抛错，返回 ${String(r)}`)
    } catch (error) {
      detail.push(`${JSON.stringify(expr)} → ${error?.name}:${error?.code}:${error?.message}`)
    }
  }
  ok(`${invalid.length} 类非法表达式全部抛错且不返回 Invalid Date`, allThrew, detail.join(' | '))
  console.log('  info 非法用例：\n    ' + detail.join('\n    '))
}

console.log(`\n结果：${pass} passed, ${fail} failed`)
if (failures.length > 0) console.log('失败项：' + failures.join('; '))
process.exit(fail === 0 ? 0 : 1)
