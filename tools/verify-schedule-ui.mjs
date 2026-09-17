#!/usr/bin/env node
/**
 * verify-schedule-ui.mjs —— 「多久跑一次」到 cron 的往返自检。
 *
 * 只验纯函数，不打桩 React：把 lib/client.js 里的 normDow / parseCron / buildCronOf /
 * describeSchedule 原文抽出来在 vm 里执行，再交给宿主自己的 lib/cron.mjs 验收。
 * 判据是「前端生成的表达式宿主一定认」+「宿主已有的表达式能回填到界面」。
 *
 *   node tools/verify-schedule-ui.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import vm from 'node:vm'
import { parseCron as hostParse, nextRuns as hostNextRuns } from '../lib/cron.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const clientPath = path.join(here, '..', 'lib', 'client.js')
const source = readFileSync(clientPath, 'utf8')

let pass = 0
let fail = 0
const failures = []

function ok(name, condition, detail) {
  if (condition) { pass += 1; console.log(`  ok   ${name}`) }
  else { fail += 1; failures.push(name); console.log(`  FAIL ${name}${detail === undefined ? '' : ' → ' + detail}`) }
}

/** 抽出纯函数区（色板/常量 + normDow … 到 ScheduleField 之前），顺序变了就直接报错，不静默跳过。 */
function loadHelpers() {
  const start = source.indexOf('var CATEGORY_COLORS')
  const end = source.indexOf('function ScheduleField(')
  if (start < 0 || end < 0 || end <= start) throw new Error('未能在 lib/client.js 中定位调度纯函数区')
  const body = source.slice(start, end)
  const wrap = new vm.Script(
    `(function(){ ${body}\n; return { normDow, parseCron, buildCronOf, describeSchedule, DOW_LABELS, FREQ_OPTIONS, CATEGORY_COLORS } })()`,
  )
  return wrap.runInNewContext({ pad2: (n) => (String(n).length < 2 ? '0' + String(n) : String(n)) })
}

const { normDow, parseCron, buildCronOf, describeSchedule, DOW_LABELS, FREQ_OPTIONS, CATEGORY_COLORS } = loadHelpers()

console.log('=== [1] 界面生成 → 宿主解析（每个频率都必须被接受） ===')
const cases = [
  { name: '每天 09:00', form: { freq: 'daily', time: '09:00' }, expect: '0 9 * * *' },
  { name: '工作日 18:30', form: { freq: 'weekdays', time: '18:30' }, expect: '30 18 * * 1-5' },
  { name: '每周二、周五 09:00', form: { freq: 'weekly', time: '09:00', dows: ['2', '5'] }, expect: '0 9 * * 2,5' },
  { name: '每周日 08:05', form: { freq: 'weekly', time: '08:05', dows: ['0'] }, expect: '5 8 * * 0' },
  { name: '每月 1 日 09:00', form: { freq: 'monthly', time: '09:00', dom: '1' }, expect: '0 9 1 * *' },
  { name: '每月 28 日 23:00', form: { freq: 'monthly', time: '23:00', dom: '28' }, expect: '0 23 28 * *' },
  { name: '每小时第 15 分钟', form: { freq: 'hourly', min: '15' }, expect: '15 * * * *' },
  { name: '每 30 分钟', form: { freq: 'minutes', every: '30' }, expect: '*/30 * * * *' },
]
for (const item of cases) {
  const built = buildCronOf(item.form)
  ok(`${item.name} → ${item.expect}`, built === item.expect, built)
  let accepted = true
  let detail = ''
  try {
    const parsed = hostParse(built)
    detail = JSON.stringify(parsed.fields ?? null)
  } catch (err) {
    accepted = false
    detail = err.message
  }
  ok(`${item.name} 被宿主 cron 接受`, accepted, detail)
  ok(`${item.name} 能算 5 次`, hostNextRuns(built, 5).length === 5)
}

console.log('\n=== [2] 语义正确（不只是字符串相等） ===')
const weekdays = hostNextRuns('30 18 * * 1-5', 10)
ok('工作日任务不会落在周六/周日', weekdays.every((d) => d.getDay() >= 1 && d.getDay() <= 5),
  weekdays.map((d) => d.getDay()).join(','))
const tueFri = hostNextRuns('0 9 * * 2,5', 6)
ok('每周二/周五只落在 2 与 5', tueFri.every((d) => d.getDay() === 2 || d.getDay() === 5),
  tueFri.map((d) => d.getDay()).join(','))
const mondays = hostNextRuns('0 9 1 * *', 4)
ok('每月 1 日只落在 1 号', mondays.every((d) => d.getDate() === 1), mondays.map((d) => d.getDate()).join(','))
const hourly = hostNextRuns('15 * * * *', 3)
ok('每小时任务间隔 3600 秒', hourly[1] - hourly[0] === 3600000 && hourly[2] - hourly[1] === 3600000)
const every30 = hostNextRuns('*/30 * * * *', 3)
ok('每 30 分钟间隔 1800 秒', every30[1] - every30[0] === 1800000)

console.log('\n=== [3] 界面回填（已有的任务表达式要能读回来） ===')
const backfill = [
  ['0 9 * * *', 'daily', '09:00'],
  ['30 18 * * 1-5', 'weekdays', '18:30'],
  ['0 9 1 * *', 'monthly', '09:00'],
  ['15 * * * *', 'hourly', null],
  ['*/30 * * * *', 'minutes', null],
  ['0 9 * * 0', 'weekly', '09:00'],
]
for (const [expr, freq, time] of backfill) {
  const form = parseCron(expr)
  ok(`回填 ${expr} → ${freq}`, form.freq === freq, form.freq)
  if (time !== null) ok(`回填 ${expr} 的时间 = ${time}`, form.time === time, form.time)
  ok(`回填 ${expr} 再生成 === 原式`, buildCronOf(form) === expr, buildCronOf(form))
}

console.log('\n=== [4] 周日两种写法等价（0 与 7） ===')
const sundayZero = parseCron('0 9 * * 0')
const sundaySeven = parseCron('0 9 * * 7')
ok('周日的 7 归一成 0', String(sundaySeven.dows) === '0', String(sundaySeven.dows))
ok('0 与 7 生成同一条表达式', buildCronOf(sundayZero) === buildCronOf(sundaySeven),
  buildCronOf(sundayZero) + ' vs ' + buildCronOf(sundaySeven))

console.log('\n=== [5] 认不出来的一律进「自定义」，原样保留 ===')
for (const expr of ['5 4 3 2 1', '0 0 1,15 * *', '0 */2 * * *', '0 9 * 1 *']) {
  const form = parseCron(expr)
  ok(`${expr} → custom`, form.freq === 'custom', form.freq)
  ok(`${expr} 原样保留`, buildCronOf(form) === expr, buildCronOf(form))
}
// 反例：星期多选是「每周」的正常表达，不该退化成自定义
const multiDow = parseCron('0 9 * * 1,3,5')
ok('星期多选 1,3,5 → weekly（不是 custom）', multiDow.freq === 'weekly', multiDow.freq)
ok('星期多选原样往返', buildCronOf(multiDow) === '0 9 * * 1,3,5', buildCronOf(multiDow))

console.log('\n=== [6] 每周多选的边界 ===')
ok('一个都不选时兜底周一', buildCronOf({ freq: 'weekly', time: '09:00', dows: [] }) === '0 9 * * 1')
ok('多选乱序也排好序', buildCronOf({ freq: 'weekly', time: '09:00', dows: ['5', '1', '3'] }) === '0 9 * * 1,3,5')
ok('七天全选可用', buildCronOf({ freq: 'weekly', time: '09:00', dows: ['0', '1', '2', '3', '4', '5', '6'] }) === '0 9 * * 0,1,2,3,4,5,6')
ok('normDow 把 7 变 0', normDow('7') === '0' && normDow(7) === '0')

console.log('\n=== [7] 人话说明 ===')
for (const [form, must] of [
  [{ freq: 'daily', time: '09:00' }, '每天 09:00'],
  [{ freq: 'weekdays', time: '18:30' }, '每个工作日 18:30'],
  [{ freq: 'weekly', time: '09:00', dows: ['1', '5'] }, '周一'],
  [{ freq: 'monthly', time: '09:00', dom: '1' }, '每月 1 日'],
  [{ freq: 'hourly', min: '15' }, '每小时第 15 分钟'],
  [{ freq: 'minutes', every: '30' }, '每 30 分钟'],
]) {
  const text = describeSchedule(form)
  ok(`说明含「${must}」：${text}`, text.indexOf(must) >= 0, text)
}
ok('不定时的说明不是空话', describeSchedule({ freq: 'none' }).indexOf('手动执行') >= 0)

console.log('\n=== [8] 空表达式 ===')
ok('空串 → none', parseCron('').freq === 'none')
ok('none 生成空串（宿主按不定时处理）', buildCronOf({ freq: 'none' }) === '')

console.log('\n=== [9] 界面常量自洽 ===')
ok('色板 8 个且都是 #RRGGBB', CATEGORY_COLORS.length === 8
  && CATEGORY_COLORS.every((c) => /^#[0-9a-fA-F]{6}$/.test(c)), CATEGORY_COLORS.join(','))
ok('星期选项 7 个且互不重复', DOW_LABELS.length === 7
  && new Set(DOW_LABELS.map((d) => d.v)).size === 7, DOW_LABELS.map((d) => d.v).join(','))
const freqIds = FREQ_OPTIONS.map((o) => o.id)
ok('频率选项覆盖 6 类且都带中文名', freqIds.length === 6
  && freqIds.every((id) => ['daily', 'weekdays', 'weekly', 'monthly', 'hourly', 'minutes'].includes(id))
  && FREQ_OPTIONS.every((o) => typeof o.label === 'string' && o.label.length > 0), freqIds.join(','))
for (const id of freqIds) {
  const seed = { freq: id, time: '09:00', dows: ['1'], dom: '1', min: '0', every: '30' }
  const built = buildCronOf(seed)
  let accepted = true
  let detail = ''
  try { hostParse(built) } catch (err) { accepted = false; detail = err.message }
  ok(`频率「${id}」生成的 ${built} 被宿主接受`, accepted && built !== '', detail)
}
ok('界面所有频率都能算出下次时间', freqIds.every((id) => hostNextRuns(
  buildCronOf({ freq: id, time: '09:00', dows: ['1'], dom: '1', min: '0', every: '30' }), 1,
).length === 1))

console.log(`\n结果：${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log('失败项：')
  for (const name of failures) console.log(`  - ${name}`)
  process.exit(1)
}
