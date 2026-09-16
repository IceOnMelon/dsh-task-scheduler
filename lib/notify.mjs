/**
 * dsh-task-scheduler — 通知落盘（**只做 IO**，t4 交付）
 *
 * 分工（docs/spec.md §2）：
 *  - **条目格式与路径解析的唯一真源是 t2 的 `lib/notifications.mjs`**，
 *    本模块只负责「追加写入文件」这一件事，绝不另写一套格式；
 *  - 每任务一个 markdown 文件（spec §7），路径可配（`task.notifyFile`），
 *    默认 `<数据根>/notify/<taskId>.md`；
 *  - 文件首次创建时写入头部，之后每次运行**追加**一段条目
 *    （时间 / 任务名 / 状态 / 会话 id / 摘要，另附运行 id、触发来源、退出码、输出尾部）。
 *
 * 安全（spec §4）：只把 t2 渲染好的文本落盘——渲染器只吃任务标题、状态、会话 id、
 * 退出码与输出内容，**不写任务 prompt / cmd 原文**，因此不会把命令里的凭据回显到通知文件。
 *
 * 关于「会话未读标记」：DSH 0.1.5-rc.1 **没有**任何「把会话标成未读」的服务方法或事件，
 * 本模块**不假装支持** —— 事实与替代方案见 {@link SESSION_UNREAD_MARKER} 与
 * `docs/api-contract.md` 的「会话未读标记」小节。
 */
import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import {
  renderNotificationEntry,
  renderNotificationHeader,
  resolveNotificationPath,
} from './notifications.mjs'

export { resolveNotificationPath }

/** 默认的 fs 实现（可注入，便于失败路径测试）。 */
export const defaultFs = Object.freeze({ appendFile, mkdir, readFile, stat, writeFile })

/**
 * 「会话未读标记」的能力事实（实测，非猜测）。
 *
 * 结论：**做不到**。证据（只读检查用户 DSH 0.1.5-rc.1 安装）：
 *  - `SessionSummary`（会话列表投影）字段只有 sessionId/updatedAt/running/blank/parentSessionId/
 *    origin/cwd/projections —— 没有 unread/seen/readAt 一类字段；
 *  - `@deepseek-ai/dsh-session` 的事件类型枚举（assistant/attempt、assistant/message、
 *    request/context、request/header、session/end-seed、step/start、step/end、system/message、
 *    tool/call、tool/result、turn/end、turn/start、user/message）里没有「未读」事件；
 *  - 客户端会话列表（dsh-client-ui-workspace）的文案只有 status.running/idle/waitingApproval/
 *    waitingAnswer/planReview/completed，没有未读指示。
 *
 * 替代（已实现 / 已交接）：
 *  1. **每任务通知文件**（本模块）—— 用户下次打开「任务」入口即可看到每次运行的时间/状态/摘要，
 *     并可从条目里的会话 id 一键跳转（t5 的「打开会话」按钮）；
 *  2. **会话按活跃度自动上浮**：任务会话是普通顶层会话（绝不设 `meta.origin:'subagent'`），
 *     新运行会把它的 `updatedAt` 顶到列表靠前位置，这是 DSH 自带的「有新东西」信号；
 *  3. **插件自己的入口徽标**：t5 用 `GET /runs`（含 endedAt/status/sessionId）与「用户上次打开
 *     任务面板的时间」计算未读点 —— 属前端展示，宿主不新增字段（spec §9：前端不另存状态）。
 * @type {{ supported: false, reason: string, substitutes: readonly string[] }}
 */
export const SESSION_UNREAD_MARKER = Object.freeze({
  supported: false,
  reason: 'DSH 0.1.5-rc.1 没有会话未读字段 / 事件 / 服务方法（见本文件顶部证据清单）',
  substitutes: Object.freeze([
    '每任务 markdown 通知文件（appendRunNotification）',
    '任务会话按 updatedAt 在会话列表自动上浮（普通顶层会话，非 subagent 来源）',
    '侧边栏「任务」入口的未读徽标由前端按 /runs 计算（t5）',
  ]),
})

/** 文件是否存在（内部用，不抛 ENOENT）。 */
async function fileExists(fs, path) {
  try {
    await fs.stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * 追加一次运行的通知条目（首次写文件头）。
 *
 * @param {object} input
 * @param {Record<string, unknown>} input.task - 任务对象（用 title/id/category/execKind/notifyFile）。
 * @param {Record<string, unknown>} input.run - 终态运行记录。
 * @param {string} input.dataRoot - 插件数据根（用于默认路径与展示折叠）。
 * @param {number} [input.now] - 条目时间戳（默认运行记录的 endedAt，其次当前时间）。
 * @param {typeof defaultFs} [input.fs] - fs 实现（测试注入）。
 * @returns {Promise<{ path: string, created: boolean, bytes: number }>} 写入结果。
 */
export async function appendRunNotification(input) {
  const { task, run, dataRoot, fs = defaultFs } = input
  if (task === undefined || task === null) throw new Error('appendRunNotification 需要 task')
  if (run === undefined || run === null) throw new Error('appendRunNotification 需要 run')
  const path = resolveNotificationPath(String(dataRoot ?? ''), task)

  const now = input.now ?? (Number.isFinite(Date.parse(String(run.endedAt ?? '')))
    ? Date.parse(String(run.endedAt))
    : Date.now())

  await fs.mkdir(dirname(path), { recursive: true })
  const existed = await fileExists(fs, path)
  if (!existed) {
    await fs.writeFile(path, renderNotificationHeader(task, String(dataRoot ?? '')), 'utf8')
  }
  const entry = renderNotificationEntry({ task, run, dataRoot: String(dataRoot ?? ''), now })
  await fs.appendFile(path, entry, 'utf8')
  return { path, created: !existed, bytes: Buffer.byteLength(entry, 'utf8') }
}

/**
 * 读取通知文件全文（验证与诊断用；只读，不修改）。
 * @param {string} path - 文件路径。
 * @param {typeof defaultFs} [fs] - fs 实现。
 * @returns {Promise<string|null>} 文件内容；不存在时 `null`。
 */
export async function readNotificationFile(path, fs = defaultFs) {
  try {
    return await fs.readFile(path, 'utf8')
  } catch {
    return null
  }
}
