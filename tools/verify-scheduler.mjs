/**
 * dsh-task-scheduler 调度核心验证脚本（自检工具，随项目保留）
 *
 * 用法（在项目根 `dsh-task-scheduler/` 下）：
 *   node tools/verify-scheduler.mjs
 *
 * 覆盖 spec §6 的全部策略：cron 解析（含非法表达式）、跨日/跨月/跨年/闰年、日周同时受限规则、
 * 漏跑（latest/all）、重叠跳过、并发上限 3 排队、超时 1 小时、失败 5 分钟后重试 1 次、
 * 定时器按最近触发点收敛。
 *
 * 设计说明（为什么这样测）：
 *  - 时间用「可控时钟」：`now()` 由测试设置，`setTimeoutImpl` 只把回调排队，不自动触发；
 *    因此「什么时候触发」完全由测试决定（`fireNextDue()`），不存在真实等待与竞态。
 *  - 需要真正跑起来的异步（执行器、存储 I/O）一律 `await`，并用 `settle()` 让出事件循环，
 *    直到调度器自报的 `inflight` 归零。
 *  - 数据根放在项目目录下的 `.verify-scratch/`，不碰 `~/.dsh`、不碰系统临时目录。
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { TaskStore } from '../lib/store.mjs'
import { CronError, cronMatches, nextRun, nextRuns, occurrencesBetween, parseCron } from '../lib/cron.mjs'
import {
  CATCHUP_MAX_OCCURRENCES, MAX_CONCURRENT_RUNS, MAX_RETRIES, RETRY_DELAY_MS, RUN_TIMEOUT_MS, TaskScheduler,
} from '../lib/scheduler.mjs'

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

/** 本地墙钟简写（断言只看本地时间，避免时区偏移干扰）。 */
function local(date) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 本地墙钟字面量 → Date。 */
function localDate(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(text)
  if (m === null) throw new Error(`非法本地时间字面量：${text}`)
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), 0, 0)
}

/**
 * 可控时钟：`setTimeoutImpl` 只排队不自动触发；由测试用 `fireNextDue()` 决定何时触发。
 * `realDelayFrom` 以上的延迟交给真实定时器（用于 1 小时超时这类「真实等待」）。
 */
class Clock {
  constructor(startMs) {
    this.nowMs = startMs
    this.queue = []
    this.nextId = 1
  }

  now = () => this.nowMs

  setTimeoutImpl = (fn, delay) => {
    const wait = Math.max(0, delay || 0)
    const id = this.nextId
    this.nextId += 1
    this.queue.push({ id, fireAt: this.nowMs + wait, fn })
    return id
  }

  clearTimeoutImpl = (id) => {
    if (typeof id === 'object' && id !== null) { clearTimeout(id); return }
    const index = this.queue.findIndex(entry => entry.id === id)
    if (index >= 0) this.queue.splice(index, 1)
  }

  /** 当前排在下一位的虚拟延迟（毫秒）；没有则 null。 */
  nextDelayMs() {
    let best = null
    for (const entry of this.queue) {
      const delay = entry.fireAt - this.nowMs
      if (best === null || delay < best) best = delay
    }
    return best
  }

  /** 下一次排期的虚拟时刻。 */
  nextFireAt() {
    let best = null
    for (const entry of this.queue) if (best === null || entry.fireAt < best) best = entry.fireAt
    return best
  }

  /**
   * 把时间推进到 targetMs，并对 `tickTaskIds` 里的任务确定性触发一次。
   *
   * 不调用「到点定时器回调」（那个回调内部自己 trackWork，与 await 组合会自等死锁）。
   * 改为：① 丢弃所有到点的虚拟定时器（时间推进语义不变）；
   * ② `await scheduler.tick(taskId)` —— tick 内部 `#fire` 是内联 await，
   *    一次 await 就把本次执行推进到终态；
   * ③ 最后 `await waitIdle()` 兜住排队提升之类的补充工作。
   * @param {number} targetMs - 目标虚拟时刻。
   * @param {TaskScheduler} scheduler - 被测调度器。
   * @param {string[]} [tickTaskIds] - 到点后需要确定性触发的任务 id。
   */
  async advanceTo(targetMs, scheduler, tickTaskIds = []) {
    for (let guard = 0; guard < 5000; guard += 1) {
      const due = this.queue.filter(entry => entry.fireAt <= targetMs)
      if (due.length === 0) break
      for (const entry of due) {
        this.queue.splice(this.queue.indexOf(entry), 1)
        this.nowMs = Math.max(this.nowMs, entry.fireAt)
      }
    }
    this.nowMs = Math.max(this.nowMs, targetMs)
    for (const taskId of tickTaskIds) {
      if (typeof scheduler?.tick === 'function') await scheduler.tick(taskId)
    }
    await scheduler.waitIdle()
  }

  advanceMs(ms, scheduler, tickTaskIds) { return this.advanceTo(this.nowMs + ms, scheduler, tickTaskIds) }
  get pending() { return this.queue.length }
}

/**
 * 轮询等待某个条件成立。
 *
 * 用**真实短等待**（`setTimeout`）而不是只让出微任务：本机的文件 I/O（mkdir/fsync/rename）
 * 需要真实时间推进，纯 `setImmediate` 空转几十轮也未必完成，容易把「还没跑完」误判成
 * 「没跑」。同时在条件成立或超时后返回，不做无谓等待。
 * @param {() => boolean} condition - 条件。
 * @param {number} [timeoutMs] - 超时（默认 4 秒）。
 * @returns {Promise<boolean>} 条件是否成立。
 */
async function waitFor(condition, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition()) return true
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  return condition()
}

/** 让出事件循环若干轮，直到调度器自报没有在飞工作。 */
async function settle(scheduler, maxRounds = 300) {
  for (let round = 0; round < maxRounds; round += 1) {
    await new Promise(resolve => setImmediate(resolve))
    if (scheduler === undefined || scheduler.inflight === 0) return
  }
}

/** 项目根与临时数据根（放在项目目录下，进程结束前删除）。 */
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const scratchRoot = join(projectRoot, '.verify-scratch')
try { rmSync(scratchRoot, { recursive: true, force: true }) } catch { /* 忽略 */ }
mkdirSync(scratchRoot, { recursive: true })
let seq = 0
function makeRoot(tag) {
  seq += 1
  const dir = join(scratchRoot, `${tag}-${seq}`)
  mkdirSync(dir, { recursive: true })
  return dir
}
function dropRoot(dir) {
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* 忽略 */ }
}

/** 一套「存储 + 调度器 + 可控时钟」的测试夹具。 */
async function makeFixture(tag, execute, options = {}) {
  const dataRoot = makeRoot(tag)
  const store = new TaskStore({ dataRoot })
  await store.init()
  const clock = new Clock(options.startMs ?? localDate('2026-03-01T00:00').getTime())
  const scheduler = new TaskScheduler({
    store,
    now: clock.now,
    // 排期定时器：虚拟（测试可控推进）
    setTimeoutImpl: clock.setTimeoutImpl,
    clearTimeoutImpl: clock.clearTimeoutImpl,
    // 超时/重试定时器：真实（与排期解耦，避免假时钟把超时 race 挂死）
    timeoutSetTimeout: options.timeoutSetTimeout ?? setTimeout,
    timeoutClearTimeout: options.timeoutClearTimeout ?? clearTimeout,
    runTimeoutMs: options.runTimeoutMs,
    retryDelayMs: options.retryDelayMs,
    execute,
    log: options.log !== undefined ? options.log : () => {},
  })
  return { dataRoot, store, clock, scheduler }
}

// ── 1. cron 解析与 nextRun ──────────────────────────────────────────────────
console.log('\n[1] cron 解析与 nextRun（宿主本地时区）')
eq('固定时刻：每天 09:00', local(nextRun('0 9 * * *', localDate('2026-03-01T00:00'))), '2026-03-01T09:00')
eq('严格大于起点（起点命中时取下一次）', local(nextRun('0 9 * * *', localDate('2026-03-01T09:00'))), '2026-03-02T09:00')
eq('星号步进：每 15 分钟', local(nextRun('*/15 * * * *', localDate('2026-03-01T00:07'))), '2026-03-01T00:15')
eq('区间：9-11 点每小时', local(nextRun('0 9-11 * * *', localDate('2026-03-01T10:30'))), '2026-03-01T11:00')
eq('列表：0,30 分', local(nextRun('0,30 * * * *', localDate('2026-03-01T00:05'))), '2026-03-01T00:30')
eq('a/n：从 5 分起每 20 分', local(nextRun('5/20 * * * *', localDate('2026-03-01T00:21'))), '2026-03-01T00:25')
eq('区间+步进：8-18 点每 2 小时', local(nextRun('0 8-18/2 * * *', localDate('2026-03-01T09:00'))), '2026-03-01T10:00')
eq('组合列表：1,15-17,30', local(nextRun('1,15-17,30 * * * *', localDate('2026-03-01T00:00'))), '2026-03-01T00:01')
eq('月字段列表：1,7 月', local(nextRun('0 0 1 1,7 *', localDate('2026-03-15T00:00'))), '2026-07-01T00:00')
eq('周字段 0=周日', local(nextRun('0 12 * * 0', localDate('2026-03-03T00:00'))), '2026-03-08T12:00')
eq('周字段 7 等价 0', local(nextRun('0 12 * * 7', localDate('2026-03-03T00:00'))), '2026-03-08T12:00')
eq('周字段 1-5（工作日）', local(nextRun('0 9 * * 1-5', localDate('2026-03-07T00:00'))), '2026-03-09T09:00')
eq('nextRuns 递增序列', nextRuns('0 9 * * *', 3, localDate('2026-03-01T00:00')).map(local), ['2026-03-01T09:00', '2026-03-02T09:00', '2026-03-03T09:00'])
eq('cronMatches 命中', cronMatches('0 9 * * *', localDate('2026-03-01T09:00')), true)
eq('cronMatches 不命中', cronMatches('0 9 * * *', localDate('2026-03-01T09:01')), false)

// ── 2. 跨日/跨月/跨年/闰年 与 日周规则 ─────────────────────────────────────
console.log('\n[2] 跨日/跨月/跨年/闰年 与 日周规则')
eq('跨日', local(nextRun('0 9 * * *', localDate('2026-03-01T23:59'))), '2026-03-02T09:00')
eq('跨月', local(nextRun('0 9 * * *', localDate('2026-03-31T23:00'))), '2026-04-01T09:00')
eq('跨年', local(nextRun('0 9 1 1 *', localDate('2026-06-01T00:00'))), '2027-01-01T09:00')
eq('平年无 2/29 → 跳到 2028', local(nextRun('0 0 29 2 *', localDate('2027-01-01T00:00'))), '2028-02-29T00:00')
eq('闰年 2/29 命中', nextRun('0 0 29 2 *', localDate('2028-02-01T00:00')).getFullYear(), 2028)
eq('2/29 之后下一次是 4 年后', local(nextRun('0 0 29 2 *', localDate('2028-03-01T00:00'))), '2032-02-29T00:00')
eq('31 号在小月被跳过', local(nextRun('0 0 31 * *', localDate('2026-04-01T00:00'))), '2026-05-31T00:00')
eq('日周同时受限取或（日命中）', local(nextRun('0 0 1 * 1', localDate('2026-03-01T00:00'))), '2026-03-02T00:00')
eq('日周同时受限取或（周命中）', cronMatches('0 0 1 * 1', localDate('2026-03-02T00:00')), true)
eq('日受限+周通配取与', cronMatches('0 0 1 * *', localDate('2026-03-02T00:00')), false)
eq('周受限+日通配取与', cronMatches('0 0 * * 1', localDate('2026-03-02T00:00')), true)
eq('两者都通配每天命中', cronMatches('0 0 * * *', localDate('2026-03-02T00:00')), true)
eq('parseCron 暴露受限标记', (() => { const c = parseCron('0 9 * * 1-5'); return [c.hour.has(9), c.dowRestricted, c.domRestricted] })(), [true, true, false])

// ── 3. 非法 cron 表达式必须抛明确错误 ───────────────────────────────────────
console.log('\n[3] 非法 cron 表达式')
const badExpressions = [
  ['', '空串'], ['0 9 * *', '只有 4 段'], ['0 9 * * * *', '6 段'],
  ['60 9 * * *', '分钟越界'], ['0 24 * * *', '小时越界'], ['0 0 0 * *', '日越界（无 0 日）'],
  ['0 0 * 13 *', '月越界'], ['0 0 * * 8', '周越界'], ['*/0 * * * *', '步进为 0'],
  ['*/x * * * *', '步进非数字'], ['5-1 * * * *', '区间起止颠倒'], ['1,,2 * * * *', '空列表项'],
  ['a * * * *', '非数字'], ['1- * * * *', '残缺区间'],
]
for (const [expression, label] of badExpressions) {
  let code = null
  try { nextRun(expression, localDate('2026-03-01T00:00')) } catch (error) { code = error?.code }
  check(`非法表达式抛错：${label}（${JSON.stringify(expression)}）`, code === 'invalid-cron', String(code))
}
check('CronError 是 Error 子类且 code 稳定', new CronError('x').code === 'invalid-cron' && new CronError('x') instanceof Error)
check('非法表达式绝不返回 Invalid Date', (() => {
  try { return !Number.isNaN(nextRun('99 * * * *', localDate('2026-03-01T00:00')).getTime()) } catch { return false }
})() === false)

// ── 4. 启动、排期收敛、到点执行 ─────────────────────────────────────────────
console.log('\n[4] 调度器启动、排期收敛与到点执行')
const F4 = await makeFixture('fire', async ({ task, attempt }) => {
  return { status: 'ok', exitCode: 0, summary: 'ok', sessionId: `session-${String(task.id).slice(-4)}-${attempt}` }
}, { startMs: localDate('2026-03-01T08:00').getTime() })
const cronTask = await F4.store.createTask({ execKind: 'prompt', prompt: '每天九点', cron: '0 9 * * *', title: '九点任务' })
const disabledTask = await F4.store.createTask({ execKind: 'prompt', prompt: '停用', cron: '0 9 * * *', enabled: false })
const noCronTask = await F4.store.createTask({ execKind: 'prompt', prompt: '不定时' })
const stats = await F4.scheduler.start()
eq('启动统计', [stats.recoveredOrphans, stats.scheduled], [0, 1])
eq('只给启用且带 cron 的任务排期', F4.scheduler.snapshot().scheduledTaskIds, [cronTask.id])
check('停用任务未排期', !F4.scheduler.snapshot().scheduledTaskIds.includes(disabledTask.id))
check('无 cron 任务未排期', !F4.scheduler.snapshot().scheduledTaskIds.includes(noCronTask.id))
eq('排期落在 09:00（8 小时后）', F4.clock.nextDelayMs(), 60 * 60 * 1000)
check('没有任务时不会空转（定时器数 = 已排期任务数）', F4.clock.pending === 1, String(F4.clock.pending))

await F4.clock.advanceTo(localDate('2026-03-01T09:00').getTime(), F4.scheduler, [cronTask.id])
const runsAfterFire = F4.store.listRuns(cronTask.id, { limit: 10 }).runs
eq('到点产生一条运行记录', runsAfterFire.length, 1)
eq('状态 ok', runsAfterFire.map(r => r.status), ['ok'])
eq('trigger=schedule', runsAfterFire[0].trigger, 'schedule')
check('sessionId 落盘', typeof runsAfterFire[0].sessionId === 'string' && runsAfterFire[0].sessionId.startsWith('session-'))
check('scheduledFor 落盘', typeof runsAfterFire[0].scheduledFor === 'string')
check('exitCode 落盘', runsAfterFire[0].exitCode === 0)
const afterFire = F4.store.requireTask(cronTask.id)
check('lastStatus=ok', afterFire.lastStatus === 'ok')
check('runCount=1', afterFire.runCount === 1)
check('sessionIds 累积 1 个', Array.isArray(afterFire.sessionIds) && afterFire.sessionIds.length === 1)
eq('触发后重新排期到次日 09:00', F4.clock.nextDelayMs(), 24 * 60 * 60 * 1000)
check('定时器收敛（仍只有 1 个）', F4.clock.pending === 1)

await F4.clock.advanceTo(localDate('2026-03-02T09:00').getTime(), F4.scheduler, [cronTask.id])
eq('第二天再次执行', F4.store.listRuns(cronTask.id, { limit: 10 }).runs.map(r => r.status), ['ok', 'ok'])
eq('attempt 在同一任务内单调递增', F4.store.listRuns(cronTask.id, { limit: 10 }).runs.map(r => r.attempt), [2, 1])
F4.scheduler.stop()
dropRoot(F4.dataRoot)

// ── 5. 重叠：上一轮仍 running → skipped_overlap，不启动新执行 ───────────────
console.log('\n[5] 重叠跳过')
let releaseFirst = null
const started = []
const F5 = await makeFixture('overlap', async ({ task }) => {
  started.push(String(task.id))
  if (started.length === 1) await new Promise(resolve => { releaseFirst = resolve })
  return { status: 'ok', summary: 'ok' }
}, { startMs: localDate('2026-03-01T00:00').getTime() })
const overlapTask = await F5.store.createTask({ execKind: 'prompt', prompt: '每分钟', cron: '* * * * *' })
await F5.scheduler.start()
// 伪造「上一轮仍在运行」：直接落一条 running 记录并把它登记为在跑。
// （不用「不 await 的触发」来制造并发——那种悬空链在运行时可能被丢弃，测不确定。）
const inflightRun = await F5.store.startRun(overlapTask.id, { trigger: 'schedule' })
F5.scheduler.activeRuns.set(overlapTask.id, String(inflightRun.runId))
check('伪造在跑状态成立', F5.store.runningRuns().length === 1 && F5.scheduler.snapshot().activeCount === 1)
// 第二分钟到点：上一轮还没结束 → 本轮必须记 skipped_overlap 且不启动新执行
await F5.clock.advanceTo(localDate('2026-03-01T00:02').getTime(), F5.scheduler)
await F5.scheduler.tick(overlapTask.id)
eq('重叠时不启动执行器', started.length, 0)
const overlapRuns = F5.store.listRuns(overlapTask.id, { limit: 10 }).runs
eq('重叠被记为 skipped_overlap 且首轮仍 running', overlapRuns.map(r => r.status).sort(), ['running', 'skipped_overlap'])
const skipped = overlapRuns.find(r => r.status === 'skipped_overlap')
check('skipped_overlap 无会话、无退出码', skipped.sessionId === null && skipped.exitCode === null)
check('skipped_overlap 的 trigger 保留触发来源', skipped.trigger === 'schedule')
// 收尾：把伪造的在跑记录放行
F5.scheduler.activeRuns.delete(overlapTask.id)
await F5.store.finishRun(String(inflightRun.runId), { status: 'ok', summary: 'ok' })
await settle(F5.scheduler)
eq('放行后首轮收尾为 ok', F5.store.listRuns(overlapTask.id, { limit: 10 }).runs.filter(r => r.status === 'ok').length, 1)
eq('最终不再有 running', F5.store.runningRuns().length, 0)
F5.scheduler.stop()
dropRoot(F5.dataRoot)

// ── 6. 并发上限 3 与排队 ───────────────────────────────────────────────────
console.log('\n[6] 并发上限 3 与排队')
eq('并发上限常量', MAX_CONCURRENT_RUNS, 3)
/** 挂起的执行器（FIFO）：releaseOne() 放行最早的一个。 */
const waitingExecutors = []
let concurrentPeak = 0
let activeNow = 0
const F6 = await makeFixture('concurrent', async () => {
  activeNow += 1
  concurrentPeak = Math.max(concurrentPeak, activeNow)
  await new Promise(resolve => waitingExecutors.push(resolve))
  activeNow -= 1
  return { status: 'ok', summary: 'ok' }
}, { startMs: localDate('2026-03-01T00:00').getTime() })
const concTasks = []
for (let i = 0; i < 5; i += 1) {
  concTasks.push(await F6.store.createTask({ execKind: 'prompt', prompt: `并发-${i}`, cron: '0 1 * * *' }))
}
await F6.scheduler.start()
// 并发发起 5 次触发（不 await：执行器会挂起，这样才看得到排队）
const concTicks = concTasks.map(task => F6.scheduler.tick(task.id).catch(() => null))
await waitFor(() => activeNow === 3 && F6.store.queuedRuns().length === 2, 8000)
eq('同时到点 5 个：3 个开跑、2 个排队', [activeNow, F6.store.queuedRuns().length], [3, 2])
check('并发峰值不超过 3', concurrentPeak <= 3, String(concurrentPeak))
check('排队记录无会话、无退出码', F6.store.queuedRuns().every(r => r.sessionId === null && r.exitCode === null))
check('排队记录 status=queued', F6.store.queuedRuns().every(r => r.status === 'queued'))
check('3 条 running 记录', F6.store.runningRuns().length === 3, String(F6.store.runningRuns().length))
// 收尾：一边放行挂起的执行器、一边放行队列，直到 5 次运行全部进终态。
// 退出条件直接看「5 条记录全部非 pending」而不是内部计数——补位与挂起都是异步的，
// 用最终状态做条件最稳。
const promotedTotal = F6.store.queuedRuns().length
const pendingPromotions = []
const terminalCount = () => F6.store.allRuns().filter(r => r.status !== 'running' && r.status !== 'queued').length
const deadlineF6 = Date.now() + 30_000
while (Date.now() < deadlineF6 && terminalCount() < 5) {
  for (const release of [...waitingExecutors.splice(0)]) release()
  if (F6.store.queuedRuns().length > 0 || F6.store.runningRuns().length > 0) {
    pendingPromotions.push(F6.scheduler.startQueuedRuns().catch(() => null))
  }
  await new Promise(resolve => setTimeout(resolve, 20))
}
// 把剩余挂起的执行器放行，确保 concTicks 能收尾
for (const release of [...waitingExecutors.splice(0)]) release()
check('排队项被放行过（补位生效）', promotedTotal > 0 && F6.store.queuedRuns().length === 0)
await Promise.race([Promise.all(concTicks), new Promise(resolve => setTimeout(resolve, 10_000))])
await Promise.race([Promise.all(pendingPromotions), new Promise(resolve => setTimeout(resolve, 10_000))])
// 收尾断言：允许最后的持久化落盘
await waitFor(() => terminalCount() === 5, 8000)
console.log(`  INFO  并发收尾：active=${activeNow} waiting=${waitingExecutors.length} queued=${F6.store.queuedRuns().length} 状态=${JSON.stringify(F6.store.allRuns().map(r => `${r.status}@${String(r.taskId).slice(-4)}`))}`)
eq('全部收尾为 ok', F6.store.allRuns().filter(r => r.status === 'ok').length, 5)
eq('最终无排队', F6.store.queuedRuns().length, 0)
eq('最终无运行中', F6.store.runningRuns().length, 0)
eq('峰值恰为 3', concurrentPeak, 3)
F6.scheduler.stop()
dropRoot(F6.dataRoot)

// ── 7. 超时 1 小时 ─────────────────────────────────────────────────────────
console.log('\n[7] 超时 1 小时 → timeout')
eq('超时常量（生产值）', RUN_TIMEOUT_MS, 60 * 60 * 1000)
let timeoutHookCalls = 0
// 用真实的超时定时器，但把「1 小时」注入成 120ms —— 验证的是**策略**（到点终止 + 调收尾钩子），
// 生产值由上面的常量断言钉住。
const F7 = await makeFixture('timeout', Object.assign(
  () => new Promise(() => { /* 永不 resolve，模拟卡死 */ }),
  { onTimeout: () => { timeoutHookCalls += 1 } },
), { startMs: localDate('2026-03-01T01:00').getTime(), runTimeoutMs: 120 })
const tmoTask = await F7.store.createTask({ execKind: 'prompt', prompt: '卡死任务', cron: '0 2 * * *' })
await F7.scheduler.start()
// 触发（内联 await 会一直挂着，等超时定时器把它终结）
const tmoTick = F7.scheduler.tick(tmoTask.id).catch(() => null)
await waitFor(() => F7.store.runningRuns().length === 1, 2000)
check('超时前仍在运行', F7.store.runningRuns().length === 1)
await waitFor(() => F7.store.runningRuns().length === 0, 3000)
await tmoTick
const tmoRuns = F7.store.listRuns(tmoTask.id, { limit: 5 }).runs
eq('到点记 timeout', tmoRuns.map(r => r.status), ['timeout'])
eq('超时调用执行器收尾钩子', timeoutHookCalls, 1)
check('超时后无在跑', F7.store.runningRuns().length === 0)
F7.scheduler.stop()
dropRoot(F7.dataRoot)

// ── 8. 失败 5 分钟后重试 1 次 ──────────────────────────────────────────────
console.log('\n[8] 失败延迟 5 分钟重试 1 次')
eq('重试延迟常量（生产值）', RETRY_DELAY_MS, 5 * 60 * 1000)
eq('最多重试 1 次', MAX_RETRIES, 1)
const attempts8 = []
// 同 §7：注入更短的重试延迟（120ms）验证**策略**，生产值由上面的常量断言钉住。
const F8 = await makeFixture('retry', async ({ task, attempt }) => {
  attempts8.push(attempt)
  return { status: 'failed', exitCode: 1, summary: `第 ${attempt} 次失败`, errorCode: 'exit-code' }
}, { startMs: localDate('2026-03-01T02:00').getTime(), retryDelayMs: 120 })
const retryTask = await F8.store.createTask({ execKind: 'shell', cmd: 'exit 1', cron: '0 3 * * *' })
await F8.scheduler.start()
await F8.clock.advanceTo(localDate('2026-03-01T03:00').getTime(), F8.scheduler, [retryTask.id])
eq('首次失败', F8.store.listRuns(retryTask.id, { limit: 5 }).runs.map(r => r.status), ['failed'])
eq('首次 attempt=1', attempts8, [1])
check('已安排重试（pendingRetries 有 1 个）', F8.scheduler.snapshot().pendingRetryTaskIds.length === 1)
// 到点前不该重试
check('重试尚未发生', attempts8.length === 1)
await waitFor(() => attempts8.length === 2, 3000)
eq('重试延迟后重试一次（attempt=2）', attempts8, [1, 2])
const retryRuns = F8.store.listRuns(retryTask.id, { limit: 5 }).runs
eq('重试运行 trigger=retry', retryRuns.find(r => r.attempt === 2)?.trigger, 'retry')
eq('两次尝试都记 failed', retryRuns.map(r => r.status).sort(), ['failed', 'failed'])
// 再等一段时间：不应有第三次
await new Promise(resolve => setTimeout(resolve, 500))
eq('再失败不再重试（仍只有 2 次）', attempts8, [1, 2])
check('重试计划已清空', F8.scheduler.snapshot().pendingRetryTaskIds.length === 0)
F8.scheduler.stop()
dropRoot(F8.dataRoot)

// ── 9. 成功不重试 ──────────────────────────────────────────────────────────
console.log('\n[9] 成功不重试')
let okAttempts = 0
const F9 = await makeFixture('ok', async () => { okAttempts += 1; return { status: 'ok', summary: 'fine' } }, { startMs: localDate('2026-03-01T03:00').getTime() })
const okTask = await F9.store.createTask({ execKind: 'shell', cmd: 'true', cron: '0 4 * * *' })
await F9.scheduler.start()
await F9.clock.advanceTo(localDate('2026-03-01T04:00').getTime(), F9.scheduler, [okTask.id])
await new Promise(resolve => setTimeout(resolve, 200))
eq('成功只跑一次', okAttempts, 1)
eq('状态 ok', F9.store.listRuns(okTask.id, { limit: 5 }).runs.map(r => r.status), ['ok'])
check('没有安排重试', F9.scheduler.snapshot().pendingRetryTaskIds.length === 0)
F9.scheduler.stop()
dropRoot(F9.dataRoot)

// ── 10. 漏跑补跑：latest（默认）与 all ─────────────────────────────────────
console.log('\n[10] 漏跑：latest（默认）与 all')
async function catchupScenario(policy) {
  const fixture = await makeFixture(`catchup-${policy}`, async () => ({ status: 'ok', summary: 'catchup' }), {
    startMs: localDate('2026-03-01T11:30').getTime(),
  })
  const task = await fixture.store.createTask({ execKind: 'prompt', prompt: '每小时', cron: '0 * * * *', missedRunPolicy: policy })
  // 伪造历史：上次运行 09:00，已排期到 10:00 → 10:00 与 11:00 两个漏点
  await fixture.store.patchRuntime(task.id, {
    lastRunAt: localDate('2026-03-01T09:00').toISOString(),
    nextRunAt: localDate('2026-03-01T10:00').toISOString(),
    runCount: 1,
  })
  const created = await fixture.scheduler.catchUp({ nowMs: fixture.clock.now() })
  await settle(fixture.scheduler)
  const result = {
    created,
    runs: fixture.store.listRuns(task.id, { limit: 20 }).runs,
    runCount: fixture.store.requireTask(task.id).runCount,
  }
  fixture.scheduler.stop()
  dropRoot(fixture.dataRoot)
  return result
}
const latest = await catchupScenario('latest')
eq('latest：只补 1 次', latest.created.length, 1)
eq('latest：补的是最近的漏点 11:00', local(new Date(latest.created[0].scheduledFor)), '2026-03-01T11:00')
eq('latest：trigger=catchup', latest.runs.map(r => r.trigger), ['catchup'])
eq('latest：状态 ok', latest.runs.map(r => r.status), ['ok'])
const all = await catchupScenario('all')
eq('all：补窗口内全部漏点（10:00、11:00）', all.created.length, 2)
eq('all：按时间升序补', all.created.map(c => local(new Date(c.scheduledFor))), ['2026-03-01T10:00', '2026-03-01T11:00'])
eq('all：都记 catchup', all.runs.map(r => r.trigger), ['catchup', 'catchup'])
eq('all：补跑上限常量存在', CATCHUP_MAX_OCCURRENCES > 0, true)

// 没有漏跑时不产生运行
const F10 = await makeFixture('nocatchup', async () => ({ status: 'ok' }), { startMs: localDate('2026-03-01T11:30').getTime() })
const freshTask = await F10.store.createTask({ execKind: 'prompt', prompt: '全新任务', cron: '0 * * * *' })
eq('全新任务：没有任何漏跑补偿', (await F10.scheduler.catchUp({ nowMs: F10.clock.now() })).length, 0)
eq('全新任务没有运行记录', F10.store.listRuns(freshTask.id, { limit: 5 }).total, 0)
await F10.store.patchRuntime(freshTask.id, { nextRunAt: localDate('2026-03-01T12:00').toISOString() })
eq('已排到未来：再次补跑为空', (await F10.scheduler.catchUp({ nowMs: F10.clock.now() })).length, 0)
F10.scheduler.stop()
dropRoot(F10.dataRoot)

// ── 11. 未装载执行器：可见地失败，不静默跳过 ────────────────────────────────
console.log('\n[11] 未装载执行器时的行为')
const F11 = await makeFixture('norunner', undefined, { startMs: localDate('2026-03-01T04:00').getTime() })
const bareTask = await F11.store.createTask({ execKind: 'prompt', prompt: '无执行器', cron: '0 5 * * *' })
await F11.scheduler.start()
await F11.clock.advanceTo(localDate('2026-03-01T05:00').getTime(), F11.scheduler, [bareTask.id])
const bareRuns = F11.store.listRuns(bareTask.id, { limit: 5 }).runs
eq('到点仍然产生运行记录', bareRuns.length, 1)
eq('状态 failed 且注明原因', [bareRuns[0].status, bareRuns[0].errorCode], ['failed', 'runner-unavailable'])
check('随后安排一次重试（不静默丢弃）', F11.scheduler.snapshot().pendingRetryTaskIds.length === 1)
F11.scheduler.stop()
dropRoot(F11.dataRoot)

// ── 12. 手动触发 runNow ────────────────────────────────────────────────────
console.log('\n[12] runNow 手动触发')
let manualCount = 0
const F12 = await makeFixture('runnow', async () => { manualCount += 1; return { status: 'ok', summary: 'manual' } }, { startMs: localDate('2026-03-01T08:30').getTime() })
const manualTask = await F12.store.createTask({ execKind: 'prompt', prompt: '手动', cron: '0 9 * * *' })
await F12.scheduler.start()
const manualRun = await F12.scheduler.runNow({ taskId: manualTask.id, trigger: 'manual' })
await settle(F12.scheduler)
check('runNow 返回运行记录', typeof manualRun.runId === 'string')
eq('runNow 记录 trigger=manual', F12.store.requireRun(manualTask.id, manualRun.runId).trigger, 'manual')
eq('runNow 真的执行了一次', manualCount, 1)
eq('runNow 收尾为 ok', F12.store.requireRun(manualTask.id, manualRun.runId).status, 'ok')
eq('手动触发不影响定时排期', F12.scheduler.snapshot().scheduledTaskIds, [manualTask.id])
let missingCode = null
try { await F12.scheduler.runNow({ taskId: 'no-such-task' }) } catch (error) { missingCode = error?.code }
eq('runNow 未知任务抛 not-found', missingCode, 'not-found')
F12.scheduler.stop()
dropRoot(F12.dataRoot)

// ── 13. 孤儿运行恢复 ───────────────────────────────────────────────────────
console.log('\n[13] 进程重启后的孤儿 running 恢复')
const F13 = await makeFixture('orphan', async () => ({ status: 'ok' }), { startMs: localDate('2026-03-01T05:00').getTime() })
const orphanTask = await F13.store.createTask({ execKind: 'prompt', prompt: '孤儿', cron: '0 6 * * *' })
const orphanRun = await F13.store.startRun(orphanTask.id, { trigger: 'schedule' })
check('伪造一条 running 记录', F13.store.runningRuns().length === 1 && orphanRun.status === 'running')
const reviveStats = await F13.scheduler.start()
eq('启动时恢复 1 条孤儿运行', reviveStats.recoveredOrphans, 1)
eq('孤儿被记为 failed', F13.store.requireRun(orphanTask.id, orphanRun.runId).status, 'failed')
eq('孤儿失败原因可读', F13.store.requireRun(orphanTask.id, orphanRun.runId).errorCode, 'interrupted')
eq('恢复后不再有 running', F13.store.runningRuns().length, 0)
F13.scheduler.stop()
dropRoot(F13.dataRoot)

// ── 14. 任务变更钩子与 occurrencesBetween ──────────────────────────────────
console.log('\n[14] 任务变更钩子与辅助 API')
const F14 = await makeFixture('hook', async () => ({ status: 'ok' }), { startMs: localDate('2026-03-01T08:00').getTime() })
await F14.scheduler.start()
eq('启动时没有排期', F14.scheduler.snapshot().scheduledTaskIds, [])
const hookTask = await F14.store.createTask({ execKind: 'prompt', prompt: '后加的任务', cron: '0 10 * * *' })
await F14.scheduler.onTasksChanged({ reason: 'created', taskId: hookTask.id })
eq('新建任务后立刻进入排期', F14.scheduler.snapshot().scheduledTaskIds, [hookTask.id])
await F14.store.updateTask(hookTask.id, { cron: '0 11 * * *' })
await F14.scheduler.onTasksChanged({ reason: 'updated', taskId: hookTask.id })
eq('改 cron 后排期更新到 3 小时后', F14.clock.nextDelayMs(), 3 * 60 * 60 * 1000)
await F14.store.updateTask(hookTask.id, { enabled: false })
await F14.scheduler.onTasksChanged({ reason: 'updated', taskId: hookTask.id })
eq('停用后移出排期', F14.scheduler.snapshot().scheduledTaskIds, [])
await F14.store.deleteTask(hookTask.id)
await F14.scheduler.onTasksChanged({ reason: 'deleted', taskId: hookTask.id })
eq('删除后仍不在排期', F14.scheduler.snapshot().scheduledTaskIds, [])
eq('occurrencesBetween 区间内每小时 3 点', occurrencesBetween('0 * * * *', localDate('2026-03-01T09:00'), localDate('2026-03-01T12:00')).map(local), ['2026-03-01T10:00', '2026-03-01T11:00', '2026-03-01T12:00'])
eq('occurrencesBetween 空区间', occurrencesBetween('0 * * * *', localDate('2026-03-01T12:00'), localDate('2026-03-01T12:00')).length, 0)
eq('occurrencesBetween 跨日', occurrencesBetween('0 0 * * *', localDate('2026-03-01T12:00'), localDate('2026-03-03T00:00')).map(local), ['2026-03-02T00:00', '2026-03-03T00:00'])
F14.scheduler.stop()
dropRoot(F14.dataRoot)

// ── 15. 端到端：cron 预览 API 形状（与 index 接线一致） ─────────────────────
console.log('\n[15] cron 预览的接线形状')
const preview = nextRuns('0 9 * * *', 5, localDate('2026-03-01T00:00')).map(date => date.toISOString())
eq('预览返回 5 个 ISO 时间', preview.length, 5)
check('预览时间是递增 ISO 串', preview.every((value, index) => index === 0 || Date.parse(value) > Date.parse(preview[index - 1])))
let previewError = null
try { nextRuns('bad cron', 5, localDate('2026-03-01T00:00')) } catch (error) { previewError = error?.code }
eq('预览非法表达式抛 invalid-cron', previewError, 'invalid-cron')

// 收尾
try { rmSync(scratchRoot, { recursive: true, force: true }) } catch { /* 忽略 */ }
console.log(`\n结果：${pass} passed, ${fail} failed`)
// 强制退出：调度器可能还留着未到点的重试/超时真实定时器，不必等它们。
process.exit(fail === 0 ? 0 : 1)








