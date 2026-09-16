/**
 * dsh-task-scheduler — 路径布局（宿主半侧，无第三方依赖）
 *
 * 主目录解析统一委托给 `dsh-home.mjs`（优先 `@deepseek-ai/dsh-home-paths`，按
 * docs/spec.md §11.4；拿不到时才用语义等价的本地实现）。本文件只负责**目录布局**。
 *
 * 目录布局（严格按 docs/spec.md §4；全部位于数据根 `<DSH_HOME>/dsh-task-scheduler/` 下）：
 *   tasks.json    任务清单（数组）                       —— 本任务维护
 *   runs.json     全部运行记录（数组，含 taskId）        —— 本任务维护
 *   state.json    全局状态（paused + 分类表）            —— 本任务维护
 *   logs/         shell 型完整输出（默认 logs/<taskId>.log） —— 运行器 t4 写入
 *   notify/       markdown 通知文件（默认 notify/<taskId>.md）—— 运行器 t4 写入
 */
import { join } from 'node:path'

export {
  PLUGIN_DATA_DIR_NAME,
  probeHomePaths,
  resolveDataRoot,
  resolveDshHome,
  activeBackend,
  describeBackend,
  dshHomePath,
} from './dsh-home.mjs'

/** 任务清单一文件名。 */
export const TASKS_FILE_NAME = 'tasks.json'

/** 全部运行记录的文件名。 */
export const RUNS_FILE_NAME = 'runs.json'

/** 全局状态文件名。 */
export const STATE_FILE_NAME = 'state.json'

/** shell 完整输出目录名。 */
export const LOGS_DIR_NAME = 'logs'

/** markdown 通知目录名。 */
export const NOTIFY_DIR_NAME = 'notify'

/** 进程内互斥用的锁文件名。 */
export const LOCK_FILE_NAME = 'store.lock'

/**
 * 由数据根派生子路径（不存在的尾段按普通路径拼接，不做 realpath）。
 * @param {string} dataRoot - 数据根。
 * @param {...string} child - 子路径段。
 * @returns {string} 子路径。
 */
export function dataPath(dataRoot, ...child) {
  return join(dataRoot, ...child)
}

/** 任务清单文件路径。 */
export function tasksFilePath(dataRoot) {
  return dataPath(dataRoot, TASKS_FILE_NAME)
}

/** 运行记录文件路径。 */
export function runsFilePath(dataRoot) {
  return dataPath(dataRoot, RUNS_FILE_NAME)
}

/** 全局状态文件路径。 */
export function stateFilePath(dataRoot) {
  return dataPath(dataRoot, STATE_FILE_NAME)
}

/** shell 输出目录路径。 */
export function logsDirPath(dataRoot) {
  return dataPath(dataRoot, LOGS_DIR_NAME)
}

/** 通知目录路径。 */
export function notifyDirPath(dataRoot) {
  return dataPath(dataRoot, NOTIFY_DIR_NAME)
}

/** 进程内互斥锁文件路径。 */
export function lockFilePath(dataRoot) {
  return dataPath(dataRoot, LOCK_FILE_NAME)
}

/** 某个任务的默认 shell 完整输出路径（`logFilePath` 为 null 时使用）。 */
export function defaultLogFilePath(dataRoot, taskId) {
  return dataPath(dataRoot, LOGS_DIR_NAME, `${taskId}.log`)
}

/** 某个任务的默认 markdown 通知文件路径（`notifyFile` 为 null 时使用）。 */
export function defaultNotifyFilePath(dataRoot, taskId) {
  return dataPath(dataRoot, NOTIFY_DIR_NAME, `${taskId}.md`)
}
