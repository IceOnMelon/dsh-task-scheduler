#!/usr/bin/env node
/**
 * verify-editor-render.mjs —— 任务编辑器的「真实渲染」冒烟测试。
 *
 * 静态检查（node --check / class 存在性）证明不了编辑器**能跑**：函数体里的拼写错误、
 * 拿错 props、把 undefined 拼进文案，都只有执行到才发现。
 * 这里把 lib/client.js 的 factory 体抽出来，用最小的 react 替身（createElement + 三个 hook）
 * 直接调用组件函数、遍历返回的渲染树做断言 —— 不需要浏览器，也不需要 DSH。
 *
 *   node tools/verify-editor-render.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import vm from 'node:vm'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = readFileSync(path.join(here, '..', 'lib', 'client.js'), 'utf8')

let pass = 0
let fail = 0
const failures = []
function ok(name, condition, detail) {
  if (condition) { pass += 1; console.log(`  ok   ${name}`) }
  else { fail += 1; failures.push(name); console.log(`  FAIL ${name}${detail === undefined ? '' : ' → ' + detail}`) }
}

// ── 1. 抽出 factory 体并求值 ────────────────────────────────────────────────
// TaskEditor / Select / ScheduleField 都定义在 createPanel(ctx) 内部（闭包持有 ctx），
// 工厂顶层看不到它们：所以在 createPanel 结尾前注入一个捕获点，再调一次 apply(stubCtx)。
function loadComponents() {
  const open = source.indexOf('factory: (require) => {')
  const close = source.lastIndexOf('\n  },\n})')
  if (open < 0 || close < 0) throw new Error('未能定位 factory 体')
  let body = source.slice(source.indexOf('\n', open) + 1, close)

  // 插在 createPanel 函数体最开头：函数声明在该作用域内提升，
  // 所以这里能安全引用后面才定义的 TaskEditor / Select，也不受 return 位置影响。
  const head = /function createPanel\([^)]*\)\s*\{/.exec(body)
  if (head === null) throw new Error('未能定位 createPanel 定义')
  const capture = '\n    globalThis.__DTS_TEST__ = {'
    + ' TaskEditor: typeof TaskEditor === "function" ? TaskEditor : null,'
    + ' Select: typeof Select === "function" ? Select : null,'
    + ' ScheduleField: typeof ScheduleField === "function" ? ScheduleField : null }'
  const ins = head.index + head[0].length
  body = body.slice(0, ins) + capture + body.slice(ins)

  // 最小 react 替身：createElement 建树，hook 只给初值（一次性渲染，不重渲染）
  function createElement(type) {
    const args = Array.prototype.slice.call(arguments, 2)
    const props = {}
    const given = arguments[1]
    if (given) for (const key in given) props[key] = given[key]
    if (args.length === 1) props.children = args[0]
    else if (args.length > 1) props.children = args
    return { type, props }
  }
  const react = {
    createElement,
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => undefined,
    useRef: (init) => ({ current: init }),
  }
  const sandbox = {
    require: (id) => (id === 'react' ? react : {}),
    console: { log() {}, info() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    Date, Math, JSON, Object, Array, String, Number, Boolean, RegExp, Error, Promise, Proxy,
    isNaN, parseInt, parseFloat,
    fetch: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) }),
    document: {
      createElement: () => ({ setAttribute() {}, appendChild() {} }),
      head: { appendChild() {} },
      getElementById: () => null,
      addEventListener() {}, removeEventListener() {},
    },
  }
  const factory = vm.runInNewContext(`(function (require) { ${body}\n })`, sandbox)
  const mod = factory(sandbox.require)

  // 宽容的 ctx：面板创建期若惰性取服务，也不该让测试挂掉
  function anyStub() {
    return new Proxy(function () {}, {
      get: () => anyStub(),
      apply: () => anyStub(),
      set: () => true,
    })
  }
  const ctx = {
    slots: { inject() {}, register() { return null } },
    get: () => anyStub(),
    on() {}, off() {},
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  }
  if (mod && typeof mod.apply === 'function') mod.apply(ctx)
  return sandbox.__DTS_TEST__ || {}
}

const components = loadComponents()
const TaskEditor = components.TaskEditor
const Select = components.Select
if (typeof TaskEditor !== 'function' || typeof Select !== 'function') {
  console.log('FAIL 未能取到组件（捕获点未命中或 apply 抛异常）')
  console.log('  拿到：' + JSON.stringify(Object.keys(components)))
  process.exit(1)
}

// ── 2. 渲染树遍历工具（会真正展开函数组件，并记录渲染期异常） ────────────────
function collect(node, out, depth) {
  if (node === null || node === undefined) return out
  const kind = typeof node
  if (kind === 'boolean') return out
  if (kind === 'string' || kind === 'number') { out.texts.push(String(node)); return out }
  if (Array.isArray(node)) { for (const item of node) collect(item, out, depth); return out }
  out.nodes.push(node)
  if (typeof node.type === 'function') {
    if (depth > 40) { out.errors.push('组件嵌套超过 40 层（可能自我渲染）：' + (node.type.name || '匿名')); return out }
    let rendered = null
    try {
      rendered = node.type(node.props)
    } catch (err) {
      out.errors.push((node.type.name || '匿名组件') + ': ' + (err && err.message ? err.message : String(err)))
      return out
    }
    collect(rendered, out, depth + 1)
    return out
  }
  if (node.props) {
    collect(node.props.children, out, depth)
    collect(node.props.footer, out, depth) // Modal 的底栏走 props.footer，不进 children
  }
  return out
}
function tree(element) {
  const out = { nodes: [], texts: [], errors: [] }
  collect(element, out, 0)
  return out
}
function byClass(rendered, name) {
  return rendered.nodes.filter((node) => typeof node.props.className === 'string'
    && node.props.className.split(/\s+/).indexOf(name) >= 0)
}
function hasText(rendered, needle) {
  return rendered.texts.some((text) => text.indexOf(needle) >= 0)
}
function textOf(node) {
  const out = tree(node)
  return out.texts.join('')
}

const CATEGORIES = [
  { id: 'work', name: '工作', color: '#4c8dff' },
  { id: 'other', name: '其他', color: '#9a6bff' },
]
const NOOP = () => {}
const baseProps = { categories: CATEGORIES, onClose: NOOP, onSaved: NOOP, onCategories: NOOP, onRunNow: NOOP }

function render(task) {
  return tree(TaskEditor(Object.assign({}, baseProps, { task })))
}
const EXISTING = {
  id: 'tsk_1', title: '每天早上汇总工作区改动', description: '备注',
  execKind: 'prompt', prompt: '检查工作区改动', cmd: '',
  category: 'work', workspaceCwd: 'D:\\AI_agent\\work', cron: '0 9 * * *',
  enabled: true, permission: 'workspace-write', autoApprove: false, missedRunPolicy: 'latest',
  logFilePath: null, notifyFile: null,
  createdAt: '2026-08-17T02:00:00.000Z', updatedAt: '2026-09-17T06:31:00.000Z',
  nextRunAt: '2026-09-18T01:00:00.000Z', lastRunAt: '2026-09-17T01:00:00.000Z', lastStatus: 'ok',
}

console.log('=== [1] 新建任务：能渲染且不抛异常 ===')
let created = null
try { created = render(null) } catch (err) { console.log('  异常：' + err.message) }
ok('TaskEditor(task=null) 正常返回', created !== null)
ok('有标题输入框（dts-title-in）', created !== null && byClass(created, 'dts-title-in').length === 1)
ok('有执行内容大灰块（dts-ta-lg）', created !== null && byClass(created, 'dts-ta-lg').length === 1)
ok('有自绘下拉（dts-dd）', created !== null && byClass(created, 'dts-dd').length >= 2)
ok('有折叠高级区（dts-adv）', created !== null && byClass(created, 'dts-adv').length >= 1)

console.log('\n=== [2] 新建任务默认：定时已勾选 + 每天 09:00 ===')
if (created !== null) {
  const boxes = created.nodes.filter((n) => n.type === 'input' && n.props.type === 'checkbox')
  ok('恰好两个勾选框（定时 / 自动批准）', boxes.length === 2, String(boxes.length))
  ok('「启用定时执行」默认勾选', boxes.filter((n) => n.props.checked === true).length === 1)
  ok('「自动批准」默认不勾', boxes.filter((n) => n.props.checked !== true).length === 1)
  const ddTexts = byClass(created, 'dts-dd-text').map(textOf)
  ok('频率下拉显示「每天」', ddTexts.indexOf('每天') >= 0, ddTexts.join('|'))
  ok('分类下拉显示「工作」', ddTexts.indexOf('工作') >= 0, ddTexts.join('|'))
  ok('没有出现「不自动运行」占位', ddTexts.indexOf('不自动运行（只能手动执行）') < 0, ddTexts.join('|'))
  ok('有时间输入框且默认 09:00', created.nodes.some((n) => n.props.type === 'time' && n.props.value === '09:00'))
  ok('显示人话说明', hasText(created, '每天 09:00 自动运行'))
  ok('底栏有「取消 / 保存 / 保存并立即执行」',
    hasText(created, '取消') && hasText(created, '保存') && hasText(created, '保存并立即执行'))
  ok('取消是红色实心按钮', byClass(created, 'dts-btn-danger').length === 1)
  ok('新建任务不显示创建时间', byClass(created, 'dts-foot-meta').length === 0)
  ok('新建任务不显示「上次触发」', !hasText(created, '上次触发'))
} else { ok('新建任务断言', false, '渲染失败') }

console.log('\n=== [3] 编辑已有任务：创建时间 / 下次 / 上次触发都是真数据 ===')
let edited = null
try { edited = render(EXISTING) } catch (err) { console.log('  异常：' + err.message) }
ok('TaskEditor(task=已有) 正常返回', edited !== null)
if (edited !== null) {
  const meta = byClass(edited, 'dts-foot-meta')
  ok('底栏有创建时间', meta.length === 1 && textOf(meta[0]).indexOf('创建于') === 0, meta.map(textOf).join('|'))
  ok('底栏含「上次修改」', meta.length === 1 && textOf(meta[0]).indexOf('上次修改') > 0)
  ok('显示「上次触发」', hasText(edited, '上次触发'))
  ok('上次触发带状态（成功）', hasText(edited, '成功'))
  ok('显示「下次」', hasText(edited, '下次'))
  ok('标题回填', edited.nodes.some((n) => n.props.value === EXISTING.title))
  ok('工作区回填', edited.nodes.some((n) => n.props.value === EXISTING.workspaceCwd))
  ok('停用态提示不出现', !hasText(edited, '已停用'))
} else { ok('已有任务断言', false, '渲染失败') }

console.log('\n=== [4] cron 回填：0 9 * * 2,5 → 每周 + 周二/周五选中 ===')
const weekly = render(Object.assign({}, EXISTING, { cron: '0 9 * * 2,5', nextRunAt: null }))
const ddTextsW = byClass(weekly, 'dts-dd-text').map(textOf)
ok('频率下拉显示「每周」', ddTextsW.indexOf('每周') >= 0, ddTextsW.join('|'))
const dowOn = byClass(weekly, 'dts-dow').filter((n) => n.props.className.indexOf(' on') > 0)
ok('七个星期按钮都在', byClass(weekly, 'dts-dow').length === 7, String(byClass(weekly, 'dts-dow').length))
ok('只有周二、周五选中', dowOn.length === 2 && dowOn.map(textOf).sort().join(',') === '周二,周五',
  dowOn.map(textOf).join('|'))
ok('没有 nextRunAt 时用预览兜底（不是「尚未排程」也说得通）',
  hasText(weekly, '尚未排程') || hasText(weekly, '下次'))

console.log('\n=== [5] cron 为空：诚实显示「不自动运行」，并给出可操作提示 ===')
const empty = render(Object.assign({}, EXISTING, { cron: '', nextRunAt: null }))
const ddTextsE = byClass(empty, 'dts-dd-text').map(textOf)
ok('频率下拉显示「不自动运行（只能手动执行）」', ddTextsE.indexOf('不自动运行（只能手动执行）') >= 0, ddTextsE.join('|'))
ok('提示「还没设置时间」', hasText(empty, '还没设置时间'))
ok('不谎报下次时间（显示尚未排程）', hasText(empty, '尚未排程'))

console.log('\n=== [6] 停用态：给出「已停用」提示，且不再展示频率控件 ===')
const off = render(Object.assign({}, EXISTING, { enabled: false }))
ok('提示「已停用」', hasText(off, '已停用'))
ok('停用时没有时间输入框', !off.nodes.some((n) => n.props.type === 'time'))
ok('停用时勾选框未勾选', off.nodes.filter((n) => n.type === 'input' && n.props.type === 'checkbox' && n.props.checked === true).length === 0)

console.log('\n=== [7] 渲染期无异常，且没有 undefined / NaN / [object Object] 混进界面 ===')
for (const [label, rendered] of [['新建', created], ['编辑', edited], ['每周', weekly], ['空 cron', empty], ['停用', off]]) {
  if (rendered === null) { ok(`${label} 文案干净`, false, '渲染失败'); continue }
  ok(`${label} 渲染期无组件抛异常`, rendered.errors.length === 0, rendered.errors.join(' | '))
  const dirty = rendered.texts.filter((t) => t === 'undefined' || t === 'NaN' || t.indexOf('[object') >= 0
    || t.indexOf('undefined') >= 0 || t.indexOf('NaN') >= 0)
  ok(`${label} 文案干净`, dirty.length === 0, dirty.join('|'))
}

console.log('\n=== [8] Select 组件：收起态渲染当前选中项 ===')
const dd = tree(Select({
  value: 'b',
  options: [{ value: 'a', label: '甲' }, { value: 'b', label: '乙', dot: '#123456' }, { value: 'c', label: '丙' }],
  onChange: NOOP,
}))
ok('渲染选中项文案', byClass(dd, 'dts-dd-text').length === 1 && textOf(byClass(dd, 'dts-dd-text')[0]) === '乙')
ok('渲染选中项色点', byClass(dd, 'dts-dd-dot').length === 1)
ok('有下拉箭头', byClass(dd, 'dts-dd-caret').length === 1)
ok('收起态不渲染菜单', byClass(dd, 'dts-dd-menu').length === 0)
const ddNone = tree(Select({ value: 'zzz', options: [{ value: 'a', label: '甲' }], onChange: NOOP }))
ok('值不在选项里时用占位文案', textOf(byClass(ddNone, 'dts-dd-text')[0]) === '请选择')

console.log(`\n结果：${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log('失败项：')
  for (const name of failures) console.log(`  - ${name}`)
  process.exit(1)
}
