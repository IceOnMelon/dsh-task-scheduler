/**
 * verifier-2 独立验证脚本 #3 —— 调度策略与执行链路契约（只读 + 临时目录）
 *
 * 不依赖任何实现方自检脚本：直接驱动 TaskScheduler / TaskStore，用可推进的假时钟与
 * 手工闸门执行器，逐条核验 spec §6/§7 的锁定策略：
 *   并发上限 3 + 排队 / 重叠跳过 / 失败 5 分钟重试 1 次 / 超时（默认 1 小时）/
 *   漏跑补最近一次与全补 / 全局暂停语义 / 孤儿恢复 / 历史全留 / 默认路径 / 通知不入凭据。
 *
 * 每个用例使用**独立的 store + scheduler**（避免假定时器与在飞执行互相串扰）。
 */
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { TaskStore } from '../lib/store.mjs'
import {
  TaskScheduler, MAX_CONCURRENT_RUNS, RUN_TIMEOUT_MS, RETRY_DELAY_MS, MAX_RETRIES,
} from '../lib/scheduler.mjs'
import { appendRunNotification, SESSION_UNREAD_MARKER } from '../lib/notify.mjs'

let pass = 0
let fail = 0
const failures = []
function ok(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ok   ${name}`) }
  else { fail += 1; failures.push(name); console.log(`  FAIL ${name} ${detail}`) }
}

const T0 = Date.parse('2026-09-16T09:00:00+08:00')
const TERMINAL = ['ok', 'failed', 'timeout', 'skipped_overlap']
const tempRoots = []

/** 造一个隔离环境：临时数据根 + store + 假时钟 scheduler + 可手工放行的执行器。 */
async function makeEnv(options = {}) {
  const dataRoot = await mkdtemp(join(tmpdir(), 'v2-policy-'))
  tempRoots.push(dataRoot)
  const store = new TaskStore({ dataRoot })
  await store.init()
  const clock = { now: options.now ?? T0 }
  const timers = []
  const debugTimers = []
  const fakeSetTimeout = (fn, delay) => {
    const timer = { fn, at: clock.now + delay, id: timers.length + 1, cancelled: false }
    timers.push(timer)
    debugTimers.push({ delay, at: timer.at - T0 })
    return timer
  }
  const fakeClearTimeout = (timer) => { if (timer) timer.cancelled = true }
  const fireDue = (withinMs = 0) => {
    const limit = clock.now + withinMs
    for (;;) {
      const due = timers
        .filter(t => !t.cancelled && t.at <= limit)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0]
      if (due === undefined) break
      due.cancelled = true
      clock.now = due.at
      try { due.fn() } catch { /* 定时器回调异常不应打断验证 */ }
    }
  }
  const gate = { resolvers: new Map(), starters: [] }
  let impl = async () => ({ status: 'ok', summary: 'default' })
  const env = {
    dataRoot,
    store,
    clock,
    timers,
    fireDue,
    gate,
    inflight: [],
    setImpl(fn) { impl = fn },
  }
  env.scheduler = new TaskScheduler({
    store,
    execute: (input) => {
      gate.starters.push(String(input.task.id))
      return impl(input)
    },
    now: () => clock.now,
    setTimeoutImpl: fakeSetTimeout,
    clearTimeoutImpl: fakeClearTimeout,
    timeoutSetTimeout: fakeSetTimeout,
    timeoutClearTimeout: fakeClearTimeout,
    timeout: options.timeout,
    runTimeoutMs: options.runTimeoutMs,
    retryDelayMs: options.retryDelayMs,
  })
  env.debugTimers = debugTimers
  /** 手工放行所有闸门（可能因排队提升而反复出现新的闸门）。 */
  env.releaseAll = (result = { status: 'ok', summary: 'released' }) => {
    for (const resolve of [...gate.resolvers.values()]) resolve(result)
    gate.resolvers.clear()
  }
  /** 等条件成立（轮询事件循环；store 落盘链需要多个 tick）。 */
  env.waitFor = async (label, predicate, timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (predicate()) return true
      if (Date.now() > deadline) { console.log(`  info waitFor 超时：${label}`); return false }
      await new Promise(r => setTimeout(r, 5))
    }
  }
  /** 把某任务的运行记录推进到终态。 */
  env.waitTerminal = async (taskId, count = 1) => {
    await env.waitFor(`${taskId} 进终态`, () => {
      const runs = store.listRuns(taskId, { limit: 50 }).runs
      return runs.length >= count && runs.slice(0, count).every(r => TERMINAL.includes(r.status))
    })
    return store.listRuns(taskId, { limit: 50 }).runs
  }
  /** 清空在飞执行与队列，并推进排空所有假定时器（供下一个用例前的收尾）。 */
  env.settle = async () => {
    for (let round = 0; round < 10; round += 1) {
      for (let i = 0; i < 100; i += 1) {
        env.releaseAll()
        await new Promise(r => setTimeout(r, 5))
        await env.scheduler.startQueuedRuns()
        const busy = store.state().queuedCount > 0 || env.scheduler.activeRuns.size > 0 || gate.resolvers.size > 0
        if (!busy) break
      }
      env.fireDue(0)
      await new Promise(r => setTimeout(r, 5))
      const pending = env.scheduler.pendingRetries.size > 0
        || timers.some(t => !t.cancelled)
        || store.state().queuedCount > 0
        || env.scheduler.activeRuns.size > 0
      if (!pending) break
    }
    env.releaseAll()
    await Promise.race([
      Promise.allSettled([...env.inflight]),
      new Promise(resolve => setTimeout(resolve, 500)),
    ])
    env.inflight.length = 0
    env.scheduler.stop()
  }
  return env
}

// 假时钟环境里 **不能** 用真实计时器做超时：需要单独一套（见 [5]）
const dataRoot0 = await mkdtemp(join(tmpdir(), 'v2-policy-boot-'))
tempRoots.push(dataRoot0)
const store0 = new TaskStore({ dataRoot: dataRoot0 })
await store0.init()

// ── 1) 锁定常量与默认路径 ──────────────────────────────────────────────────
console.log('\n[1] 锁定常量与默认路径')
ok('并发上限常量 = 3', MAX_CONCURRENT_RUNS === 3, String(MAX_CONCURRENT_RUNS))
ok('超时常量 = 1 小时（3600000ms）', RUN_TIMEOUT_MS === 60 * 60 * 1000, String(RUN_TIMEOUT_MS))
ok('重试延迟常量 = 5 分钟（300000ms）', RETRY_DELAY_MS === 5 * 60 * 1000, String(RETRY_DELAY_MS))
ok('最多重试 1 次', MAX_RETRIES === 1, String(MAX_RETRIES))
ok('默认日志路径 = <根>/logs/<taskId>.log',
  store0.resolveLogFilePath({ id: 'tid', logFilePath: null }) === join(dataRoot0, 'logs', 'tid.log'),
  store0.resolveLogFilePath({ id: 'tid', logFilePath: null }))
ok('默认通知路径 = <根>/notify/<taskId>.md',
  store0.resolveNotifyFilePath({ id: 'tid', notifyFile: null }) === join(dataRoot0, 'notify', 'tid.md'),
  store0.resolveNotifyFilePath({ id: 'tid', notifyFile: null }))
ok('自定义路径优先生效', store0.resolveNotifyFilePath({ id: 'tid', notifyFile: 'D:\\n\\x.md' }) === 'D:\\n\\x.md')

// ── 2) 重叠跳过 ────────────────────────────────────────────────────────────
console.log('\n[2] 重叠：上一轮 running → 本轮 skipped_overlap，且不启动新执行')
{
  const env = await makeEnv()
  const t = await env.store.createTask({ title: '重叠', execKind: 'shell', cmd: 'echo a', cron: '*/5 * * * *', enabled: true })
  env.setImpl(() => new Promise(resolve => { env.gate.resolvers.set('overlap', resolve) }))
  env.inflight.push(env.scheduler.runNow({ taskId: t.id, trigger: 'manual' }))
  const started = await env.waitFor('第一轮开始执行', () => env.gate.resolvers.has('overlap'))
  ok('第一轮已真正开始执行', started, `gate=[${[...env.gate.resolvers.keys()].join(',')}]`)
  const second = await env.scheduler.runNow({ taskId: t.id, trigger: 'schedule' })
  ok('第二次触发记 skipped_overlap', second?.status === 'skipped_overlap', JSON.stringify(second)?.slice(0, 160))
  ok('skipped_overlap 记录有 endedAt 与非空摘要', typeof second?.endedAt === 'string' && String(second?.summary).length > 0, JSON.stringify(second)?.slice(0, 160))
  ok('重叠期间执行器只被调用一次（未启动新会话）', env.gate.starters.length === 1, `starters=${env.gate.starters.length}`)
  env.gate.resolvers.get('overlap')({ status: 'ok', summary: '第一轮' })
  const runs = await env.waitTerminal(t.id, 2)
  ok('第一轮正常收尾为 ok', runs.some(r => r.status === 'ok'), JSON.stringify(runs.map(r => r.status)))
  ok('该任务共 2 条运行记录（ok + skipped_overlap）', runs.length === 2, JSON.stringify(runs.map(r => r.status)))
  await env.settle()
}

// ── 3) 并发上限 3 + 排队 ───────────────────────────────────────────────────
console.log('\n[3] 并发上限 3：超出排队（queued），有空位再放行')
{
  const env = await makeEnv()
  const taskIds = []
  for (let i = 0; i < 5; i += 1) {
    // cron 留空 + 停用：本用例只验证 runNow 路径的并发/排队，不引入排期定时器干扰
    const t = await env.store.createTask({ title: `并发${i}`, execKind: 'shell', cmd: `echo ${i}`, cron: '', enabled: false })
    taskIds.push(t.id)
  }
  env.setImpl(() => new Promise(resolve => { env.gate.resolvers.set(`g${env.gate.resolvers.size}`, resolve) }))
  const fires = taskIds.map(id => env.scheduler.runNow({ taskId: id, trigger: 'manual' }))
  env.inflight.push(...fires)
  await env.waitFor('3 个同时执行', () => env.gate.starters.length >= 3)
  await new Promise(r => setTimeout(r, 150))
  ok('同时真正开始执行的只有 3 个', env.gate.starters.length === 3, `starters=${env.gate.starters.length}`)
  const statuses = taskIds.map(id => env.store.listRuns(id, { limit: 5 }).runs[0]?.status)
  ok('另外 2 个以 queued 落盘（不是静默丢弃）', statuses.filter(s => s === 'queued').length === 2, JSON.stringify(statuses))
  ok('store.state().runningCount = 3', env.store.state().runningCount === 3, String(env.store.state().runningCount))
  ok('store.state().queuedCount = 2', env.store.state().queuedCount === 2, String(env.store.state().queuedCount))
  const firstGateKey = [...env.gate.resolvers.keys()][0]
  env.gate.resolvers.get(firstGateKey)({ status: 'ok', summary: '释放一个额度' })
  for (let i = 0; i < 200 && env.gate.starters.length < 4; i += 1) {
    await new Promise(r => setTimeout(r, 5))
    if (env.scheduler.reservedSlots.size === 0) await env.scheduler.startQueuedRuns()
  }
  ok('释放一个额度后队列前项被放行（starters=4）', env.gate.starters.length === 4, `starters=${env.gate.starters.length}`)
  await env.settle()
  ok('最终无卡在 queued/running 的运行', env.store.state().queuedCount === 0 && env.store.state().runningCount === 0, JSON.stringify(env.store.state()))
  const allRuns = taskIds.flatMap(id => env.store.listRuns(id, { limit: 10 }).runs)
  ok('5 条运行全部进入终态', allRuns.length === 5 && allRuns.every(r => TERMINAL.includes(r.status)), JSON.stringify(allRuns.map(r => r.status)))
}

// ── 4) 失败重试（假时钟推进 5 分钟） ───────────────────────────────────────
console.log('\n[4] 失败后 5 分钟重试 1 次（attempt=2，同样开新执行），再失败不再重试')
{
  const env = await makeEnv()
  const t = await env.store.createTask({ title: '重试一次', execKind: 'shell', cmd: 'echo r', cron: '', enabled: false })
  let calls = 0
  env.setImpl(async () => {
    calls += 1
    return calls === 1
      ? { status: 'failed', exitCode: 1, summary: '第一次失败' }
      : { status: 'ok', summary: '重试成功' }
  })
  await env.scheduler.runNow({ taskId: t.id, trigger: 'manual' })
  await env.waitTerminal(t.id, 1)
  const afterFirst = env.store.listRuns(t.id, { limit: 10 }).runs
  ok('第一次失败即落 failed（attempt=1）', afterFirst[0]?.status === 'failed' && afterFirst[0]?.attempt === 1, JSON.stringify(afterFirst.map(r => [r.status, r.attempt])))
  ok('排入 1 条待重试计划', env.scheduler.pendingRetries.has(String(t.id)), [...env.scheduler.pendingRetries.keys()].join(','))
  const retryPlan = env.scheduler.pendingRetries.get(String(t.id))
  const retryAt = retryPlan ? retryPlan.timer.at - T0 : NaN
  ok('重试计划排在 5 分钟后（不是立刻）', retryAt === RETRY_DELAY_MS, `retryAt=${retryAt}`)
  env.clock.now = T0 + RETRY_DELAY_MS - 1000
  env.fireDue(0)
  await new Promise(r => setTimeout(r, 50))
  ok('未到 5 分钟不重试', calls === 1, `calls=${calls}`)
  env.clock.now = T0 + RETRY_DELAY_MS + 1000
  env.fireDue(0)
  const runs2 = await env.waitTerminal(t.id, 2)
  ok('到 5 分钟触发重试，attempt=2 且 trigger=retry', runs2[0]?.attempt === 2 && runs2[0]?.trigger === 'retry', JSON.stringify(runs2.map(r => [r.status, r.attempt, r.trigger])))
  ok('重试成功记 ok', runs2[0]?.status === 'ok', JSON.stringify(runs2[0]))
  await env.settle()

  const t2 = await env.store.createTask({ title: '重试两次', execKind: 'shell', cmd: 'echo r2', cron: '', enabled: false })
  calls = 0
  env.setImpl(async () => { calls += 1; return { status: 'failed', exitCode: 3, summary: `失败${calls}` } })
  await env.scheduler.runNow({ taskId: t2.id, trigger: 'manual' })
  await env.waitTerminal(t2.id, 1)
  env.clock.now += RETRY_DELAY_MS + 10
  env.fireDue()
  await env.waitTerminal(t2.id, 2)
  await env.settle()
  const two = env.store.listRuns(t2.id, { limit: 10 }).runs
  ok('两次都失败 → 共 2 条记录，不再排重试', two.length === 2 && two[0]?.attempt === 2 && !env.scheduler.pendingRetries.has(String(t2.id)), JSON.stringify(two.map(r => [r.status, r.attempt])))
  ok('第二次失败后状态为 failed（不是无限重试）', two[0]?.status === 'failed', String(two[0]?.status))
}

// ── 5) 超时（真实计时器 + 注入的短超时） ───────────────────────────────────
console.log('\n[5] 超时：到点调 onTimeout 收尾并记 timeout（默认阈值已断言为 1 小时）')
{
  const dataRoot = await mkdtemp(join(tmpdir(), 'v2-timeout-'))
  tempRoots.push(dataRoot)
  const store = new TaskStore({ dataRoot })
  await store.init()
  let onTimeoutCalls = 0
  const execute = async () => new Promise(() => { /* 永不 settle：模拟卡住的运行 */ })
  execute.onTimeout = () => { onTimeoutCalls += 1 }
  const scheduler = new TaskScheduler({
    store,
    execute,
    runTimeoutMs: 60,
    retryDelayMs: 1000,
    setTimeoutImpl: (fn, delay) => setTimeout(fn, delay),
    clearTimeoutImpl: clearTimeout,
    timeoutSetTimeout: (fn, delay) => setTimeout(fn, delay),
    timeoutClearTimeout: clearTimeout,
  })
  const t = await store.createTask({ title: '超时', execKind: 'shell', cmd: 'echo t', cron: '', enabled: false })
  scheduler.runNow({ taskId: t.id, trigger: 'manual' })
  let rec = null
  for (let i = 0; i < 200; i += 1) {
    await new Promise(r => setTimeout(r, 10))
    rec = store.listRuns(t.id, { limit: 5 }).runs[0]
    if (rec !== undefined && TERMINAL.includes(rec.status)) break
  }
  ok('到点后运行记录进入终态 timeout', rec?.status === 'timeout', `${rec?.status}`)
  ok('超时会调用执行器 onTimeout（用于杀进程树 / cancel 会话）', onTimeoutCalls >= 1, String(onTimeoutCalls))
  ok('超时摘要含「终止」', String(rec?.summary).includes('终止'), String(rec?.summary))
  ok('超时也计入 attempt=1 且 endedAt 已写', rec?.attempt === 1 && typeof rec?.endedAt === 'string', JSON.stringify([rec?.attempt, rec?.endedAt]))
}

// ── 6) 漏跑补偿 ───────────────────────────────────────────────────────────
console.log('\n[6] 漏跑：全新任务不补跑 / latest 只补最近一次 / all 全补 / 无漏跑不产生运行')
{
  const env = await makeEnv()
  env.setImpl(async () => ({ status: 'ok', summary: 'catchup' }))
  const fresh = await env.store.createTask({ title: '新任务', execKind: 'shell', cmd: 'echo n', cron: '0 * * * *', enabled: true })
  const created0 = await env.scheduler.catchUp({ nowMs: env.clock.now })
  ok('全新任务（无 nextRunAt/lastRunAt）不补跑', !created0.some(c => c.taskId === fresh.id), JSON.stringify(created0.map(c => c.taskId)))

  const latestTask = await env.store.createTask({ title: '只补最近', execKind: 'shell', cmd: 'echo l', cron: '0 * * * *', enabled: true, missedRunPolicy: 'latest' })
  await env.store.patchRuntime(latestTask.id, { nextRunAt: new Date(env.clock.now - 3 * 3600 * 1000).toISOString() })
  const created1 = await env.scheduler.catchUp({ nowMs: env.clock.now })
  const mine1 = created1.filter(c => c.taskId === latestTask.id)
  ok('policy=latest 只补最近一次（恰好 1 条）', mine1.length === 1, JSON.stringify(created1))
  ok('补跑记录 trigger=catchup', mine1.every(c => c.trigger === 'catchup'))
  await env.settle()

  const allTask = await env.store.createTask({ title: '全部补', execKind: 'shell', cmd: 'echo a', cron: '0 * * * *', enabled: true, missedRunPolicy: 'all' })
  await env.store.patchRuntime(allTask.id, { nextRunAt: new Date(env.clock.now - 3 * 3600 * 1000).toISOString() })
  const created2 = await env.scheduler.catchUp({ nowMs: env.clock.now })
  const mine2 = created2.filter(c => c.taskId === allTask.id)
  ok('policy=all 补多个错过的触发点（>1 条）', mine2.length > 1, JSON.stringify(mine2))
  await env.settle()

  const futureTask = await env.store.createTask({ title: '无漏跑', execKind: 'shell', cmd: 'echo f', cron: '0 * * * *', enabled: true })
  await env.store.patchRuntime(futureTask.id, { nextRunAt: new Date(env.clock.now + 3600 * 1000).toISOString() })
  const before = env.store.listRuns(futureTask.id, { limit: 10 }).total
  const created3 = await env.scheduler.catchUp({ nowMs: env.clock.now })
  const after = env.store.listRuns(futureTask.id, { limit: 10 }).total
  ok('nextRunAt 在未来 → 不产生任何运行', !created3.some(c => c.taskId === futureTask.id) && after === before, JSON.stringify(created3))
}

// ── 7) 孤儿恢复 / 全局暂停 / 历史全留 ─────────────────────────────────────
console.log('\n[7] 孤儿恢复、全局暂停语义、历史全留')
{
  const env = await makeEnv()
  env.setImpl(async () => ({ status: 'ok', summary: 'x' }))
  const orphanTask = await env.store.createTask({ title: '孤儿', execKind: 'shell', cmd: 'echo o', cron: '*/5 * * * *', enabled: true })
  const orphan = await env.store.startRun(orphanTask.id, { trigger: 'schedule', status: 'running' })
  const stats = await env.scheduler.start()
  const recovered = env.store.requireRun(orphanTask.id, orphan.runId)
  ok('start() 把上次进程遗留的 running 收尾为 failed（errorCode=interrupted）', recovered.status === 'failed' && recovered.errorCode === 'interrupted', JSON.stringify([recovered.status, recovered.errorCode]))
  ok('start() 回报恢复条数', stats.recoveredOrphans >= 1, JSON.stringify(stats))
  ok('start() 为 enabled+cron 任务装了排期定时器', env.scheduler.timers.size >= 1, String(env.scheduler.timers.size))

  // 全局暂停：stop() 必须清空排期
  env.scheduler.stop()
  ok('stop() 清空所有排期定时器', env.scheduler.timers.size === 0, String(env.scheduler.timers.size))

  // 暂停期间在跑的运行不能被误判为孤儿：恢复走 onTasksChanged({}) 而不是 start()
  const runTask = await env.store.createTask({ title: '暂停期间在跑', execKind: 'shell', cmd: 'echo p', cron: '*/5 * * * *', enabled: true })
  env.setImpl(() => new Promise(resolve => { env.gate.resolvers.set('paused-run', resolve) }))
  env.inflight.push(env.scheduler.runNow({ taskId: runTask.id, trigger: 'manual' }))
  await env.waitFor('暂停期间运行已开始', () => env.gate.resolvers.has('paused-run'))
  env.gate.resolvers.get('paused-run')({ status: 'ok', summary: '暂停期间仍跑完' })
  await env.waitTerminal(runTask.id, 1)
  const finished = env.store.listRuns(runTask.id, { limit: 5 }).runs[0]
  ok('暂停期间在跑的运行自然收尾为 ok（未被误判 failed）', finished.status === 'ok', JSON.stringify(finished.status))
  await env.scheduler.onTasksChanged({})
  ok('恢复排期用 onTasksChanged({}) 重装定时器（未调 start()）', env.scheduler.timers.size >= 1, String(env.scheduler.timers.size))

  // 软删除后历史保留
  const delTask = await env.store.createTask({ title: '删除但留历史', execKind: 'shell', cmd: 'echo d', cron: '', enabled: false })
  env.setImpl(async () => ({ status: 'ok', summary: 'd' }))
  await env.scheduler.runNow({ taskId: delTask.id, trigger: 'manual' })
  await env.waitTerminal(delTask.id, 1)
  await env.store.deleteTask(delTask.id)
  ok('软删除任务后运行记录仍可查', env.store.listRuns(delTask.id, { limit: 10 }).total >= 1, String(env.store.listRuns(delTask.id, { limit: 10 }).total))
  const onDisk = JSON.parse(await readFile(join(env.dataRoot, 'runs.json'), 'utf8'))
  ok('runs.json 仍含已删除任务的记录（不自动清理）', onDisk.some(r => r.taskId === delTask.id))
  ok('已删除任务不再出现在 listTasks()', !env.store.listTasks().some(x => x.id === delTask.id))
  await env.settle()
}

// ── 8) 通知文件与凭据 ─────────────────────────────────────────────────────
console.log('\n[8] 通知：每任务一个 markdown、追加式、含会话 id、凭据不回显')
{
  const env = await makeEnv()
  const nTask = await env.store.createTask({ title: '通知', execKind: 'shell', cmd: 'rem SUPERSECRET42', cron: '', enabled: false })
  const notifyPath = env.store.resolveNotifyFilePath(nTask)
  ok('默认通知路径 = <根>/notify/<taskId>.md', notifyPath === join(env.dataRoot, 'notify', `${nTask.id}.md`), notifyPath)
  const run1 = await env.store.startRun(nTask.id, { trigger: 'manual', status: 'running' })
  await env.store.finishRun(run1.runId, { status: 'ok', exitCode: 0, summary: '退出码 0', sessionId: 'session-abc', tailOutput: '正常输出\n' })
  const first = await appendRunNotification({ task: nTask, run: env.store.requireRun(nTask.id, run1.runId), dataRoot: env.dataRoot })
  ok('首次写入报告 created=true', first.created === true, JSON.stringify(first))
  const run2 = await env.store.startRun(nTask.id, { trigger: 'schedule', status: 'running' })
  await env.store.finishRun(run2.runId, { status: 'failed', exitCode: 1, summary: '退出码 1', sessionId: 'session-def', tailOutput: '出错了\n' })
  await appendRunNotification({ task: nTask, run: env.store.requireRun(nTask.id, run2.runId), dataRoot: env.dataRoot })
  const text = await readFile(notifyPath, 'utf8')
  ok('追加式：两次运行各一段（2 个 "## " 条目）', (text.match(/^## /gm) || []).length === 2, String((text.match(/^## /gm) || []).length))
  ok('条目含 ISO 时间 / 任务名 / 状态 / 会话 id / 摘要',
    /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(text) && text.includes('通知') && text.includes('成功') && text.includes('session-abc') && text.includes('摘要'), text.slice(0, 300))
  ok('通知文件不含 cmd 原文（凭据不回显）', !text.includes('SUPERSECRET42'), '致命：通知文件里出现命令原文')
  ok('每任务一个文件（不同任务不共用）', (await readdir(join(env.dataRoot, 'notify'))).every(f => f.endsWith('.md')), (await readdir(join(env.dataRoot, 'notify'))).join(','))
  ok('SESSION_UNREAD_MARKER.supported === false（不假装支持未读标记）', SESSION_UNREAD_MARKER.supported === false && SESSION_UNREAD_MARKER.substitutes.length >= 3, JSON.stringify(SESSION_UNREAD_MARKER).slice(0, 200))
}

for (const root of tempRoots) await rm(root, { recursive: true, force: true }).catch(() => {})
console.log(`\n结果：${pass} passed, ${fail} failed`)
if (failures.length > 0) console.log('失败项：\n  - ' + failures.join('\n  - '))
process.exit(fail === 0 ? 0 : 1)
