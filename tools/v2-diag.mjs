import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskStore } from '../lib/store.mjs'
import { TaskScheduler } from '../lib/scheduler.mjs'

const dataRoot = await mkdtemp(join(tmpdir(), 'v2-diag3-'))
const store = new TaskStore({ dataRoot })
await store.init()

let fakeNow = Date.parse('2026-09-16T09:00:00+08:00')
const timers = []
function fakeSetTimeout(fn, delay) {
  const timer = { fn, at: fakeNow + delay, id: timers.length + 1, cancelled: false }
  timers.push(timer)
  return timer
}
function fakeClearTimeout(timer) { if (timer) timer.cancelled = true }

const gate = { resolvers: new Map() }
let executeImpl = async () => ({ status: 'ok', summary: 'default' })

const scheduler = new TaskScheduler({
  store,
  execute: (input) => { console.log('WRAPPER CALLED'); return executeImpl(input) },
  now: () => fakeNow,
  setTimeoutImpl: fakeSetTimeout,
  clearTimeoutImpl: fakeClearTimeout,
  timeoutSetTimeout: fakeSetTimeout,
  timeoutClearTimeout: fakeClearTimeout,
})

const t = await store.createTask({ title: '重叠', execKind: 'shell', cmd: 'echo a', cron: '*/5 * * * *', enabled: true })
executeImpl = () => new Promise(resolve => { gate.resolvers.set('overlap', resolve) })
const first = scheduler.runNow({ taskId: t.id, trigger: 'manual' })
await new Promise(r => setImmediate(r))
console.log(`A activeRuns=${scheduler.activeRuns.size} pendingFires=${scheduler.pendingFires.size} reserved=${scheduler.reservedSlots.size} inflight=${scheduler.inflight} gate=[${[...gate.resolvers.keys()]}]`)
await new Promise(r => setImmediate(r))
console.log(`B activeRuns=${scheduler.activeRuns.size} pendingFires=${scheduler.pendingFires.size} reserved=${scheduler.reservedSlots.size} inflight=${scheduler.inflight} gate=[${[...gate.resolvers.keys()]}]`)
await new Promise(r => setTimeout(r, 50))
console.log(`C activeRuns=${scheduler.activeRuns.size} pendingFires=${scheduler.pendingFires.size} reserved=${scheduler.reservedSlots.size} inflight=${scheduler.inflight} gate=[${[...gate.resolvers.keys()]}]`)
console.log('timers=', timers.map(x => ({ at: x.at - fakeNow, cancelled: x.cancelled })))
gate.resolvers.get('overlap')?.({ status: 'ok', summary: 'x' })
const run = await first
console.log('run.status=', run.status, 'rec=', store.listRuns(t.id, { limit: 2 }).runs[0]?.status)
await rm(dataRoot, { recursive: true, force: true })
