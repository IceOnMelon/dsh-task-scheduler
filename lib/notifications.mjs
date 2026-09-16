/**
 * dsh-task-scheduler — 通知文件（每任务一个 markdown 文件）
 *
 * spec §7：每任务一个 markdown 文件，**追加式**写「时间 / 任务名 / 状态 / 会话 id / 摘要」；
 * 同时给该次执行产生的会话打未读标记（未读标记由运行器 t4 通过宿主会话服务完成）。
 * 目录与默认文件名按 spec §4：`notify/<taskId>.md`（数据根之下）。
 *
 * 本文件只负责**文件位置与内容格式的唯一定义**，避免运行器与路由各自拼路径/各写一套格式。
 */
import { defaultNotifyFilePath, notifyDirPath } from './paths.mjs'

/** 面向用户展示的挂载路径前缀（写入 markdown 正文，不泄露机器绝对路径）。 */
export const NOTIFY_HOME_DISPLAY = '$DSH_HOME/dsh-task-scheduler'

/** 运行状态 → 中文标签。 */
export const RUN_STATUS_LABELS = Object.freeze({
  queued: '排队中',
  running: '运行中',
  ok: '成功',
  failed: '失败',
  timeout: '超时终止',
  skipped_overlap: '重叠跳过',
})

/** 触发来源 → 中文标签。 */
export const RUN_TRIGGER_LABELS = Object.freeze({
  schedule: '定时触发',
  manual: '手动立即执行',
  retry: '失败重试',
  catchup: '漏跑补跑',
})

/** 单行单元格转义（markdown 表格里不允许裸 `|` 与换行）。 */
function cell(value) {
  if (value === null || value === undefined || value === '') return '-'
  return String(value).replace(/\r?\n/g, ' ').replace(/\|/g, '\\|')
}

/** 把机器绝对路径折叠成 `$DSH_HOME/...` 展示形式。 */
export function displayNotificationPath(dataRoot, filePath) {
  if (typeof filePath !== 'string' || filePath === '') return filePath
  const normalizedRoot = dataRoot.replace(/[\\/]+$/, '')
  if (filePath.startsWith(normalizedRoot)) {
    return `${NOTIFY_HOME_DISPLAY}${filePath.slice(normalizedRoot.length).replace(/\\/g, '/')}`
  }
  return filePath
}

/** 通知目录路径（供运行器建目录）。 */
export function notificationsDir(dataRoot) {
  return notifyDirPath(dataRoot)
}

/** 默认通知文件路径（`notifyFile` 为 null 时使用）。 */
export function defaultNotificationPath(dataRoot, taskId) {
  return defaultNotifyFilePath(dataRoot, taskId)
}

/**
 * 解析任务实际使用的通知文件路径：优先任务自定义 `notifyFile`，否则默认位置。
 * @param {string} dataRoot - 插件数据根。
 * @param {{id: string, notifyFile?: string|null}} task - 任务对象。
 * @returns {string} markdown 通知文件绝对路径。
 */
export function resolveNotificationPath(dataRoot, task) {
  const custom = typeof task.notifyFile === 'string' ? task.notifyFile.trim() : ''
  return custom === '' ? defaultNotifyFilePath(dataRoot, String(task.id)) : custom
}

/** 通知文件的首行标题（首次创建文件时写入）。 */
export function renderNotificationHeader(task, dataRoot) {
  return [
    `# 定时任务：${task.title}`,
    '',
    `- 任务 id：\`${task.id}\``,
    `- 分类：${task.category}`,
    `- 执行类型：${task.execKind}`,
    `- 通知文件：\`${displayNotificationPath(dataRoot, resolveNotificationPath(dataRoot, task))}\``,
    '',
    '> 由 dsh-task-scheduler 自动追加，请勿手工改动结构。',
    '',
  ].join('\n')
}

/**
 * 生成一次运行对应的 markdown 片段（追加到任务通知文件）。
 * 必备四要素（spec §7）：时间 / 任务名 / 状态 / 会话 id / 摘要。
 * @param {object} input
 * @param {Record<string, unknown>} input.task - 任务对象。
 * @param {Record<string, unknown>} input.run - 运行记录。
 * @param {number} [input.now] - 注入时间戳。
 * @returns {string} markdown 片段（以换行结尾，便于直接追加）。
 */
export function renderNotificationEntry(input) {
  const { task, run } = input
  const now = input.now ?? Date.now()
  const statusLabel = RUN_STATUS_LABELS[run.status] ?? String(run.status)
  const triggerLabel = RUN_TRIGGER_LABELS[run.trigger] ?? String(run.trigger ?? 'manual')
  const lines = []
  lines.push(`## ${new Date(now).toISOString()} — ${statusLabel}`)
  lines.push('')
  lines.push('| 字段 | 值 |')
  lines.push('| --- | --- |')
  lines.push(`| 任务 | ${cell(task.title)} (\`${cell(task.id)}\`) |`)
  lines.push(`| 状态 | ${cell(statusLabel)} (\`${cell(run.status)}\`) |`)
  lines.push(`| 触发 | ${cell(triggerLabel)} |`)
  lines.push(`| 运行 | \`${cell(run.runId)}\`（第 ${cell(run.attempt)} 次） |`)
  lines.push(`| 开始 | ${cell(run.startedAt)} |`)
  lines.push(`| 结束 | ${cell(run.endedAt)} |`)
  lines.push(`| 会话 | ${cell(run.sessionId)} |`)
  lines.push(`| 退出码 | ${cell(run.exitCode)} |`)
  lines.push(`| 输出文件 | ${cell(displayNotificationPath(String(input.dataRoot ?? ''), run.logFilePath))} |`)
  lines.push('')
  lines.push(`摘要：${typeof run.summary === 'string' && run.summary.trim() !== '' ? run.summary.trim() : '（无）'}`)
  if (typeof run.tailOutput === 'string' && run.tailOutput !== '') {
    lines.push('')
    lines.push('<details><summary>输出尾部</summary>')
    lines.push('')
    lines.push('```text')
    lines.push(run.tailOutput.replace(/```/g, '`\u200b``'))
    lines.push('```')
    lines.push('')
    lines.push('</details>')
  }
  lines.push('')
  return `${lines.join('\n')}\n`
}
