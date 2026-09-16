/**
 * dsh-task-scheduler — 数据模型与校验（宿主半侧，无外部依赖）
 *
 * **权威来源**：`docs/spec.md` §3（字段名已冻结）。本文件是 spec 的唯一代码投影，
 * `store.mjs`、`routes.mjs`、`index.js` 与 `docs/api-contract.md` 必须与之一致；
 * 任何同义改名都算破坏契约。
 *
 * 安全约定：
 *  - 任务只存「要做什么」（prompt / cmd）与调度参数，**绝不**写入任何凭据、令牌或密码；
 *    本模块不读取环境凭据，store 也不记录任何环境变量。
 *  - prompt / cmd 原样存储（不做脱敏改写），只在 API 响应与运行记录里返回；不进日志。
 */
import { randomBytes } from 'node:crypto'

// ── 枚举（spec §3） ────────────────────────────────────────────────────────

/** 执行类型。 */
export const EXEC_KINDS = Object.freeze(['prompt', 'shell'])

/** 权限三档（逐任务沙箱档位）。 */
export const PERMISSIONS = Object.freeze(['readonly', 'workspace-write', 'full'])

/** 漏跑补偿策略：`latest` 只补最近一次；`all` 全部补跑（spec §6）。 */
export const MISSED_RUN_POLICIES = Object.freeze(['latest', 'all'])

/**
 * 运行记录状态（spec §3 的 RunStatus）。
 * `queued` 为并发上限（3）排队引入的等待态：已放行但尚未真正启动（无会话、无输出）。
 * 这是对 spec 的最小扩展，已在 docs/api-contract.md 的「偏离与扩展」小节登记。
 */
export const RUN_STATUSES = Object.freeze(['queued', 'running', 'ok', 'failed', 'timeout', 'skipped_overlap'])

/** 终态（不再变化）。 */
export const TERMINAL_RUN_STATUSES = Object.freeze(['ok', 'failed', 'timeout', 'skipped_overlap'])

/** 运行记录的非终态（还会变化）。 */
export const PENDING_RUN_STATUSES = Object.freeze(['queued', 'running'])

/**
 * 触发来源（spec §3 列了 schedule/manual/retry；`catchup` 是 spec §6「漏跑补跑」
 * 策略要求的第四种来源，属最小必要扩展，已登记）。
 */
export const RUN_TRIGGERS = Object.freeze(['schedule', 'manual', 'retry', 'catchup'])

/** 全局暂停开关默认值。 */
export const DEFAULT_GLOBAL_PAUSED = false

/** 分类默认四档（spec §8：工作蓝 / 学习紫 / 生活绿 / 其他灰）。 */
export const DEFAULT_CATEGORIES = Object.freeze([
  Object.freeze({ id: 'work', name: '工作', color: '#4c8dff' }),
  Object.freeze({ id: 'study', name: '学习', color: '#9a6bff' }),
  Object.freeze({ id: 'life', name: '生活', color: '#36b37e' }),
  Object.freeze({ id: 'other', name: '其他', color: '#8a94a6' }),
])

/** 新建任务未指定分类时落到的分类 id（spec §8 的 `other`）。 */
export const DEFAULT_CATEGORY = 'other'

/** 运行记录 `tailOutput` 的行数上限（spec §7：末 200 行）。 */
export const TAIL_OUTPUT_MAX_LINES = 200

/** 运行记录 `tailOutput` 的字节兜底上限（防止单行超长把记录文件撑爆）。 */
export const TAIL_OUTPUT_LIMIT_BYTES = 64 * 1024

// ── 稳定错误码 ─────────────────────────────────────────────────────────────

/**
 * **线上**稳定错误码（`error.code` 的取值，小写 kebab-case）。
 *
 * 取值与 `docs/spec.md` §11.5.3/§11.5.4、「405/404 用同一信封」以及 t7 产出的可复制片段
 * （`docs/snippets/host-trust-fence.js` 的 `writeError(res, code, ...)`）一致：
 * 栅栏拒绝恒为 `forbidden`，body 超限为 `too-large`，坏 JSON 为 `bad-request`。
 * 前端只需按这一套码分支（`docs/snippets/client-api.js` 的 `TaskApiError.code`）。
 */
export const WIRE_ERROR_CODES = Object.freeze([
  'forbidden',
  'method-error',
  'not-found',
  'too-large',
  'bad-request',
  'cron-invalid',
  'storage',
  'busy',
  'runner-unavailable',
  'conflict',
  'paused',
  'internal',
])

/**
 * t2 早期用过的、**已废弃**的线上码别名（t9 收敛）。
 *
 * 它们不是 spec §5 冻结集的成员，任何一条都不得再出现在响应体里；这里保留的唯一目的，
 * 是让 `PluginError` 把仍在用的旧码**归一化**成冻结码，而不是静默降级成 `internal`
 * （降级会让「cron 非法」和「磁盘损坏」这两类原因在线上不可区分）。
 *
 *  - `invalid-cron` → `cron-invalid`
 *  - `storage-error` → `storage`
 *  - `invalid-task` → `bad-request`（无抛出点，仅为收敛早期术语）
 */
export const LEGACY_ERROR_CODES = Object.freeze([
  'invalid-cron',
  'storage-error',
  'invalid-task',
])

/**
 * 旧码 → 冻结码。**只用于兼容归一化**：新代码请直接使用 {@link WIRE_ERROR_CODES}。
 */
export const WIRE_ALIAS_OF = Object.freeze({
  'invalid-cron': 'cron-invalid',
  'storage-error': 'storage',
  'invalid-task': 'bad-request',
})

/**
 * 把任意码（含旧别名）归一到 spec §5 冻结的线上码；不认识的一律落 `internal`。
 * @param {unknown} code - 期望是线上码或旧别名。
 * @returns {string} 冻结集里的线上码。
 */
export function wireCodeOf(code) {
  if (typeof code !== 'string') return 'internal'
  if (WIRE_ERROR_CODES.includes(code)) return code
  return WIRE_ALIAS_OF[code] ?? 'internal'
}

/**
 * spec §5 冻结的五个错误码。它们**不是**线上 `code`，而是 `error.specCode` 的取值，
 * 用于让「按 spec 五码逐条验收」仍然可断言；细分映射见 {@link SPEC_CODE_OF}.
 */
export const SPEC_ERROR_CODES = Object.freeze([
  'E_VALIDATION',
  'E_NOT_FOUND',
  'E_CRON_INVALID',
  'E_STORAGE',
  'E_BUSY',
])

/**
 * 线上码 → spec §5 口径码（§5 的「wire code / specCode」表**逐行**落地）。
 *
 * spec 表只列了 5 个 `E_*` 值，因此多个线上码会落到同一个口径码；
 * 这张表是 `PluginError.specCode` 的唯一来源，也是 `docs/api-contract.md` §5 右列的比对依据。
 */
export const SPEC_CODE_OF = Object.freeze({
  'bad-request': 'E_VALIDATION',
  'not-found': 'E_NOT_FOUND',
  'cron-invalid': 'E_CRON_INVALID',
  'storage': 'E_STORAGE',
  'busy': 'E_BUSY',
  'forbidden': 'E_FORBIDDEN',
  'too-large': 'E_VALIDATION',
  'method-error': 'E_VALIDATION',
  'runner-unavailable': 'E_BUSY',
  'conflict': 'E_BUSY',
  'paused': 'E_BUSY',
  'internal': 'E_STORAGE',
  // 旧码别名（`LEGACY_ERROR_CODES`）：只为让归一化前后的 specCode 一致。
  'invalid-cron': 'E_CRON_INVALID',
  'storage-error': 'E_STORAGE',
  'invalid-task': 'E_VALIDATION',
})

/**
 * 线上码 → HTTP 状态码。
 *
 * §11 的消息里出现过两种说法（「业务失败 200 + 信封」与「状态码由错误码决定」）。
 * 本实现的取舍，并在 docs/api-contract.md §5 明确写死：
 *  - 栅栏 403、方法错 405、未找到 404 —— 用真实状态码（前端/运维依赖它们）；
 *  - 其余**业务失败一律 HTTP 200**，错误信息只在 `{ok:false,error:{code,message}}` 里，
 *    前端不需要尝试/捕获非 2xx（`docs/snippets/client-api.js` 的 readEnvelope 对两者都兼容，
 *    但 200 + 信封是 t7 片段与本层的共同约定）。
 */
export const ERROR_STATUS = Object.freeze({
  'forbidden': 403,
  'method-error': 405,
  'not-found': 404,
})

/** 业务失败统一用的 HTTP 状态。 */
export const BUSINESS_ERROR_STATUS = 200

/** 全部线上错误码（与 {@link WIRE_ERROR_CODES} 相同，保留旧名以兼容引用）。 */
export const ERROR_CODES = WIRE_ERROR_CODES

/**
 * 对外统一的插件错误：携带线上码、spec 码与 HTTP 状态。
 *
 * `code` 会被 {@link wireCodeOf} **归一化到 spec §5 冻结集**：旧别名（`invalid-cron` /
 * `storage-error` / `invalid-task`）自动收敛，不认识的码落 `internal`。因此
 * `error.code` 恒是冻结码，响应体里绝不可能出现旧码或 `E_*`。
 */
export class PluginError extends Error {
  /**
   * @param {string} code - WIRE_ERROR_CODES 之一（线上码；旧别名会被归一化）。
   * @param {string} message - 面向调用方的人类可读说明（绝不包含凭据）。
   * @param {object} [options]
   * @param {number} [options.status] - 覆盖默认 HTTP 状态。
   * @param {Record<string, unknown>} [options.details] - 结构化补充信息（仅本层内部使用，不上线）。
   * @param {number} [options.retryAfterMs] - 建议重试间隔（响应头 Retry-After）。
   */
  constructor(code, message, options = {}) {
    super(message)
    this.name = 'PluginError'
    this.code = wireCodeOf(code)
    this.specCode = SPEC_CODE_OF[this.code] ?? 'E_INTERNAL_EXT'
    this.status = options.status ?? ERROR_STATUS[this.code] ?? BUSINESS_ERROR_STATUS
    if (options.details !== undefined) this.details = options.details
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs
  }
}

// ── 基础工具 ───────────────────────────────────────────────────────────────

/** 判断是否普通对象（排除 null 与数组）。 */
export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 判断是否合法 ISO 时间字符串。 */
function isIsoTimestamp(value) {
  return typeof value === 'string' && value !== '' && !Number.isNaN(Date.parse(value))
}

/** 统一成 `toISOString()` 形态。 */
function toIso(value) {
  return new Date(value).toISOString()
}

/** id 生成用的单调递增序列（同一毫秒内创建多个任务时保证 id 互不相同、互不为前缀）。 */
let idSequence = 0

/**
 * 生成可排序 id：`<13 位毫秒时间戳>-<4 位十六进制序号>-<6 位随机十六进制>`。
 *
 * 中间那一段既有「单调递增」又有「互不为前缀」的性质，因此：
 *  - 按字符串排序 ≈ 按创建时间排序；
 *  - 前端用短前缀定位任务时，同一毫秒内创建的任务不会互相把前缀匹配成歧义。
 * @param {number} [now] - 注入时间戳（测试用）。
 * @returns {string} id 字符串。
 */
export function createId(now = Date.now()) {
  idSequence = (idSequence + 1) % 0xffff
  return `${String(now).padStart(13, '0')}-${idSequence.toString(16).padStart(4, '0')}-${randomBytes(3).toString('hex')}`
}

/**
 * 保留文本的最后 `maxLines` 行，并按 UTF-8 字节兜底上限截尾（不切断多字节字符）。
 * @param {string} value - 原文本。
 * @param {object} [options]
 * @param {number} [options.maxLines] - 行数上限。
 * @param {number} [options.maxBytes] - 字节上限。
 * @returns {string} 截断后的文本。
 */
export function truncateTail(value, options = {}) {
  if (typeof value !== 'string') return ''
  const { maxLines = TAIL_OUTPUT_MAX_LINES, maxBytes = TAIL_OUTPUT_LIMIT_BYTES } = options
  let text = value
  const lines = text.split('\n')
  if (lines.length > maxLines) text = lines.slice(lines.length - maxLines).join('\n')
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  let bytes = 0
  let index = text.length
  while (index > 0) {
    const codePoint = text.codePointAt(index - 1)
    const charLength = codePoint > 0xffff ? 2 : 1
    const char = text.slice(index - charLength, index)
    const size = Buffer.byteLength(char, 'utf8')
    if (bytes + size > maxBytes) break
    bytes += size
    index -= charLength
  }
  return text.slice(index)
}

/** 校验取值必须落在枚举内，否则抛 bad-request（线上码）。 */
function assertEnum(value, allowed, field) {
  if (!allowed.includes(value)) {
    throw new PluginError(
      'bad-request',
      `"${field}" 必须是 ${allowed.join(' | ')} 之一，实际为 ${JSON.stringify(value)}`,
      { details: { field, allowed: [...allowed] } },
    )
  }
  return value
}

/** 读取字符串字段（`null` 视为「使用默认值」，返回 fallback）。 */
function readString(source, field, options = {}) {
  const { fallback = '', maxLength = 200_000, label = field } = options
  if (!(field in source) || source[field] === undefined || source[field] === null) return fallback
  const value = source[field]
  if (typeof value !== 'string') {
    throw new PluginError('bad-request', `"${label}" 必须是字符串或 null`, { details: { field: label } })
  }
  if (value.length > maxLength) {
    throw new PluginError('bad-request', `"${label}" 过长（上限 ${maxLength} 字符）`, { details: { field: label } })
  }
  return value
}

/**
 * 路径字段（`logFilePath` / `notifyFile`）里绝不允许出现的字符。
 *
 * 这些是 Windows 文件名保留字符：写进磁盘路径只会在运行器打开文件时失败；
 * 控制字符（见 {@link CONTROL_CHAR_RE}）在 Windows 与 POSIX 上都不可作为文件名。
 * `\` 与 `/` 是分隔符，`:` 只在盘符后允许（见 {@link assertUsablePath}），因此都不在此列。
 */
export const ILLEGAL_PATH_CHARS = Object.freeze(['<', '>', '"', '|', '?', '*'])

/** 控制字符（C0 + DEL）：路径里出现即视为损坏输入。 */
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/

/** 盘符前缀（`C:` / `d:`）——只有这里允许出现冒号。 */
const DRIVE_PREFIX_RE = /^[A-Za-z]:/

/**
 * 校验路径字段的值确实是一条可用的本地路径（spec §3/§7 的「路径可配」）。
 *
 * 规则（冻结在 docs/api-contract.md §2.1.2，与 `tools/verify-paths.mjs` 一一对应）：
 *  - 空串 / 纯空白 → 拒绝。要回到默认路径请**显式传 `null`**，避免「空串」同时被读成
 *    「用默认路径」与「用户填漏了」两种意思；
 *  - 控制字符（C0 + DEL，含 `\0`、`\n`、`\t`）→ 拒绝；
 *  - `< > " | ? *` → 拒绝（Windows 保留字符；`\\?\` 长路径前缀因此也不被接受）；
 *  - `:` 只允许作为**盘符前缀**出现（`D:\...`），其余位置一律拒绝。
 *
 * 不受影响：UNC（`\\server\share\a.md`）、POSIX（`/home/u/a.md`）与相对路径
 * （相对路径是否可用由运行器按任务 `workspaceCwd` 决定，本层不禁止）。
 * @param {string} value - 已确认是字符串的原始值。
 * @param {string} field - 字段名（错误信息用）。
 * @returns {string} 去空白后的值。
 * @throws {PluginError} 线上码 `bad-request`（= spec §5 的 `E_VALIDATION`）。
 */
export function assertUsablePath(value, field) {
  const trimmed = value.trim()
  if (trimmed === '') {
    throw new PluginError('bad-request', `"${field}" 不能是空字符串；要使用默认路径请显式传 null`, {
      details: { field, reason: 'empty' },
    })
  }
  if (CONTROL_CHAR_RE.test(trimmed)) {
    throw new PluginError('bad-request', `"${field}" 含控制字符，不能作为路径`, {
      details: { field, reason: 'control-char' },
    })
  }
  const illegal = ILLEGAL_PATH_CHARS.find(char => trimmed.includes(char))
  if (illegal !== undefined) {
    throw new PluginError('bad-request', `"${field}" 含非法字符 ${JSON.stringify(illegal)}`, {
      details: { field, reason: 'illegal-char', char: illegal },
    })
  }
  if (trimmed.replace(DRIVE_PREFIX_RE, '').includes(':')) {
    throw new PluginError('bad-request', `"${field}" 里的冒号只能作为盘符前缀出现`, {
      details: { field, reason: 'illegal-colon' },
    })
  }
  return trimmed
}

/**
 * 读取「可空字符串」字段：缺省 → `null`，显式 null → `null`，
 * 非空且**可用**的字符串 → 去空白后的字符串（spec §3 的 `logFilePath`/`notifyFile` 形态）。
 *
 * 非法值（非字符串 / 空串 / 超长 / 含非法字符）一律抛 `bad-request`（= `E_VALIDATION`），
 * 绝不静默落成 `null` —— 静默会把手填错的路径伪装成「用默认路径」。
 * @param {unknown} source - 输入对象。
 * @param {string} field - 字段名。
 * @param {number} [maxLength] - 长度上限。
 * @returns {string|null} 规范化值。
 * @throws {PluginError} E_VALIDATION。
 */
export function readNullablePath(source, field, maxLength = 4000) {
  if (!isPlainObject(source) || !(field in source) || source[field] === undefined || source[field] === null) {
    return null
  }
  const value = source[field]
  if (typeof value !== 'string') {
    throw new PluginError('bad-request', `"${field}" 必须是字符串或 null`, { details: { field } })
  }
  if (value.length > maxLength) {
    throw new PluginError('bad-request', `"${field}" 过长（上限 ${maxLength} 字符）`, { details: { field } })
  }
  return assertUsablePath(value, field)
}

/** 读取布尔字段。 */
function readBoolean(source, field, fallback) {
  if (!(field in source) || source[field] === undefined || source[field] === null) return fallback
  const value = source[field]
  if (typeof value !== 'boolean') {
    throw new PluginError('bad-request', `"${field}" 必须是布尔值`, { details: { field } })
  }
  return value
}

/** 读取可空时间戳（ISO 字符串或 null），输出统一 ISO 形态。 */
function readTimestamp(source, field, fallback = null) {
  if (!(field in source) || source[field] === undefined) return fallback
  const value = source[field]
  if (value === null) return null
  if (!isIsoTimestamp(value)) {
    throw new PluginError('bad-request', `"${field}" 必须是 ISO 时间字符串或 null`, { details: { field } })
  }
  return toIso(value)
}

/** 读取可空整数（如 exitCode）。 */
function readIntegerOrNull(source, field, fallback = null) {
  if (!(field in source) || source[field] === undefined) return fallback
  const value = source[field]
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new PluginError('bad-request', `"${field}" 必须是整数或 null`, { details: { field } })
  }
  return value
}

/**
 * cron 表达式的**结构性**校验：必须是 5 段（分 时 日 月 周），字符集受限。
 * 语义级解析（步进/区间/列表的合法性与取值域）由 `lib/cron.mjs`（t3）负责；
 * 本层只保证「形状正确」，避免把明显的脏数据写进磁盘。
 * @param {unknown} expression - 原始表达式。
 * @returns {string} 去空白后的表达式（空串表示「不定时」）。
 * @throws {PluginError} E_CRON_INVALID。
 */
export function validateCronShape(expression) {
  if (expression === null || expression === undefined) return ''
  if (typeof expression !== 'string') {
    throw new PluginError('cron-invalid', 'cron 必须是字符串')
  }
  const trimmed = expression.trim()
  if (trimmed === '') return ''
  const fields = trimmed.split(/\s+/)
  if (fields.length !== 5) {
    throw new PluginError('cron-invalid', `cron 必须是 5 段（分 时 日 月 周），实际 ${fields.length} 段`, {
      details: { field: 'cron', expectedFields: 5, actualFields: fields.length },
    })
  }
  for (const [index, field] of fields.entries()) {
    if (!/^[0-9*,\-/]+$/.test(field)) {
      throw new PluginError('cron-invalid', `cron 第 ${index + 1} 段含非法字符：${JSON.stringify(field)}`, {
        details: { field: 'cron', segment: index + 1 },
      })
    }
  }
  return trimmed
}

// ── 任务模型（spec §3 Task） ───────────────────────────────────────────────

/**
 * 任务对象的字段顺序 = `docs/spec.md` §3 表格顺序（契约文档与前端按此顺序消费）。
 * 注意：spec 表格没有 `notifyFile`/`updatedAt`，但它把两者分别写在字段说明与
 * `createdAt / updatedAt` 里；契约文档负责仲裁（见 docs/api-contract.md §2.1）。
 */
export const TASK_FIELDS = Object.freeze([
  'id',
  'title',
  'description',
  'execKind',
  'prompt',
  'cmd',
  'category',
  'workspaceCwd',
  'cron',
  'enabled',
  'permission',
  'autoApprove',
  'missedRunPolicy',
  'logFilePath',
  'notifyFile',
  'nextRunAt',
  'lastRunAt',
  'lastStatus',
  'runCount',
  'createdAt',
  'updatedAt',
  'sessionIds',
])

/**
 * 新建/更新请求体允许出现的字段（用户可配置）。
 *
 * `logFilePath` 与 `notifyFile` 按 spec §3/§7 是**用户可配置**的：
 * POST/PATCH 接受它们，且允许显式 `null`（= 回到默认 `logs/<taskId>.log` /
 * `notify/<taskId>.md`）。两者也允许运行器（t4）通过 `patchRuntime` 写回。
 */
export const TASK_WRITABLE_FIELDS = Object.freeze([
  'title',
  'description',
  'execKind',
  'prompt',
  'cmd',
  'category',
  'workspaceCwd',
  'cron',
  'enabled',
  'permission',
  'autoApprove',
  'missedRunPolicy',
  'logFilePath',
  'notifyFile',
])

/**
 * 运行时字段：由 scheduler / runner 通过 `patchRuntime` 写入。
 * 其中 `notifyFile` 同时是用户可配置字段（见上），因此它同时出现在两张表里。
 */
export const TASK_RUNTIME_FIELDS = Object.freeze([
  'notifyFile',
  'nextRunAt',
  'lastRunAt',
  'lastStatus',
  'runCount',
  'sessionIds',
  'updatedAt',
])

/**
 * 只读字段（创建后不可变）。
 */
export const TASK_IMMUTABLE_FIELDS = Object.freeze(['id', 'createdAt'])

/**
 * 服务端管理字段：只能由 scheduler / runner 经 `patchRuntime` 写，HTTP 层一律拒写。
 * （`id`/`createdAt` 是不可变字段，这里一并列出便于文档与前端对照。）
 */
export const TASK_SERVER_MANAGED_FIELDS = Object.freeze([
  'id',
  'createdAt',
  'updatedAt',
  'nextRunAt',
  'lastRunAt',
  'lastStatus',
  'runCount',
  'sessionIds',
])

/** 未知字段直接拒绝——避免前端把拼错的字段误当成生效。 */
function rejectUnknownKeys(source, allowed, kind) {
  const unknown = Object.keys(source).filter(key => !allowed.includes(key))
  if (unknown.length > 0) {
    throw new PluginError('bad-request', `${kind}不接受字段：${unknown.join(', ')}`, {
      details: { unknown, allowed: [...allowed] },
    })
  }
}

/**
 * 规范化一份任务输入（新建与更新的公共部分）。
 * @param {unknown} input - 只含可写字段的对象。
 * @param {object} [options]
 * @param {'create'|'update'} [options.mode] - create 时缺省字段取内置默认。
 * @param {boolean} [options.lenientDefaults] - 磁盘恢复路径：缺失的枚举取默认值而不是报错。
 * @returns {Record<string, unknown>} 规范化后的可写字段。
 * @throws {PluginError} E_VALIDATION / E_CRON_INVALID。
 */
export function normalizeTaskInput(input, options = {}) {
  const { mode = 'create', lenientDefaults = false } = options
  if (!isPlainObject(input)) {
    throw new PluginError('bad-request', '任务体必须是 JSON 对象')
  }
  rejectUnknownKeys(input, TASK_WRITABLE_FIELDS, '任务体')
  const relax = mode === 'create' || lenientDefaults

  const execKind = assertEnum(
    input.execKind === undefined || input.execKind === null
      ? (relax ? 'prompt' : undefined)
      : input.execKind,
    EXEC_KINDS,
    'execKind',
  )
  const permission = assertEnum(
    input.permission === undefined || input.permission === null
      ? (relax ? 'workspace-write' : undefined)
      : input.permission,
    PERMISSIONS,
    'permission',
  )
  const missedRunPolicy = assertEnum(
    input.missedRunPolicy === undefined || input.missedRunPolicy === null
      ? (relax ? 'latest' : undefined)
      : input.missedRunPolicy,
    MISSED_RUN_POLICIES,
    'missedRunPolicy',
  )

  const prompt = readString(input, 'prompt', { label: 'prompt' })
  const cmd = readString(input, 'cmd', { label: 'cmd' })
  if (execKind === 'prompt' && prompt.trim() === '') {
    throw new PluginError('bad-request', 'execKind=prompt 时 "prompt" 不能为空', { details: { field: 'prompt' } })
  }
  if (execKind === 'shell' && cmd.trim() === '') {
    throw new PluginError('bad-request', 'execKind=shell 时 "cmd" 不能为空', { details: { field: 'cmd' } })
  }

  const category = readString(input, 'category', { label: 'category', maxLength: 100 }).trim()
  return {
    title: readString(input, 'title', { label: 'title', maxLength: 500 }).trim(),
    description: readString(input, 'description', { label: 'description', maxLength: 20_000 }),
    execKind,
    prompt,
    cmd,
    category: category === '' ? DEFAULT_CATEGORY : category,
    workspaceCwd: readString(input, 'workspaceCwd', { label: 'workspaceCwd', maxLength: 4000 }).trim(),
    cron: validateCronShape(input.cron === undefined ? '' : input.cron),
    enabled: readBoolean(input, 'enabled', relax ? true : false),
    permission,
    autoApprove: readBoolean(input, 'autoApprove', false),
    missedRunPolicy,
    logFilePath: readNullablePath(input, 'logFilePath'),
    notifyFile: readNullablePath(input, 'notifyFile'),
  }
}

/** 未填标题时按执行类型给一个可读默认标题。 */
function defaultTitleOf(writable) {
  const raw = writable.execKind === 'shell' ? writable.cmd : writable.prompt
  const firstLine = String(raw).split(/\r?\n/)[0].trim()
  if (firstLine === '') return '未命名任务'
  return firstLine.length > 60 ? `${firstLine.slice(0, 57)}...` : firstLine
}

/**
 * 按契约字段顺序重排任务对象（保证持久化与 API 响应的字段顺序稳定）。
 * @param {Record<string, unknown>} task - 任务对象。
 * @returns {Record<string, unknown>} 排序后的任务对象。
 */
export function orderTask(task) {
  /** @type {Record<string, unknown>} */
  const ordered = {}
  for (const field of TASK_FIELDS) ordered[field] = task[field]
  if (task.deletedAt !== undefined && task.deletedAt !== null) ordered.deletedAt = task.deletedAt
  return ordered
}

/**
 * 创建一条完整任务对象（含 id、时间戳与运行时字段初值）。
 * @param {unknown} input - 新建请求体。
 * @param {object} [options]
 * @param {number} [options.now] - 注入时间戳（测试用）。
 * @returns {Record<string, unknown>} 任务对象。
 */
export function createTaskRecord(input, options = {}) {
  const now = options.now ?? Date.now()
  const iso = new Date(now).toISOString()
  const writable = normalizeTaskInput(input, { mode: 'create' })
  return orderTask({
    id: createId(now),
    title: writable.title === '' ? defaultTitleOf(writable) : writable.title,
    description: writable.description,
    execKind: writable.execKind,
    prompt: writable.prompt,
    cmd: writable.cmd,
    category: writable.category,
    workspaceCwd: writable.workspaceCwd,
    cron: writable.cron,
    enabled: writable.enabled,
    permission: writable.permission,
    autoApprove: writable.autoApprove,
    missedRunPolicy: writable.missedRunPolicy,
    logFilePath: writable.logFilePath,
    notifyFile: writable.notifyFile,
    nextRunAt: null,
    lastRunAt: null,
    lastStatus: null,
    runCount: 0,
    createdAt: iso,
    updatedAt: iso,
    sessionIds: [],
  })
}

/**
 * 应用一次任务更新（PATCH 语义：请求体里未出现的字段保持当前值）。
 * @param {Record<string, unknown>} current - 现有任务（完整对象）。
 * @param {unknown} patch - 请求体。
 * @param {object} [options]
 * @param {number} [options.now] - 注入时间戳。
 * @returns {Record<string, unknown>} 新任务对象（不修改入参）。
 */
export function applyTaskPatch(current, patch, options = {}) {
  if (!isPlainObject(patch)) {
    throw new PluginError('bad-request', '更新体必须是 JSON 对象')
  }
  rejectUnknownKeys(patch, TASK_WRITABLE_FIELDS, '更新体')
  /** @type {Record<string, unknown>} */
  const base = {}
  for (const field of TASK_WRITABLE_FIELDS) {
    if (current[field] !== undefined) base[field] = current[field]
  }
  const writable = normalizeTaskInput({ ...base, ...patch }, { mode: 'create' })
  return orderTask({
    ...current,
    ...writable,
    title: writable.title === '' ? defaultTitleOf(writable) : writable.title,
    updatedAt: new Date(options.now ?? Date.now()).toISOString(),
  })
}

/**
 * 规范化一个「来自磁盘」的任务对象（读取路径上的防御）。
 * 字段缺失按默认值补齐（兼容早期版本）；字段非法抛 E_STORAGE，绝不静默丢弃。
 * @param {unknown} raw - 原始对象。
 * @param {object} [options]
 * @param {string} [options.source] - 来源描述（错误信息用）。
 * @returns {Record<string, unknown>} 规范化任务。
 */
export function reviveTask(raw, options = {}) {
  const { source = 'tasks.json' } = options
  if (!isPlainObject(raw)) {
    throw new PluginError('storage', `${source} 中存在非对象任务项`)
  }
  const writableOnly = {}
  for (const field of TASK_WRITABLE_FIELDS) {
    if (raw[field] !== undefined) writableOnly[field] = raw[field]
  }
  let writable
  try {
    writable = normalizeTaskInput(writableOnly, { mode: 'create', lenientDefaults: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new PluginError('storage', `${source} 中任务 ${String(raw.id)} 非法：${message}`)
  }
  const runCountRaw = raw.runCount
  return orderTask({
    id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : createId(),
    ...writable,
    title: writable.title === '' ? defaultTitleOf(writable) : writable.title,
    notifyFile: writable.notifyFile,
    nextRunAt: readTimestamp(raw, 'nextRunAt'),
    lastRunAt: readTimestamp(raw, 'lastRunAt'),
    lastStatus: RUN_STATUSES.includes(raw.lastStatus) ? raw.lastStatus : null,
    runCount: typeof runCountRaw === 'number' && Number.isInteger(runCountRaw) && runCountRaw >= 0 ? runCountRaw : 0,
    createdAt: isIsoTimestamp(raw.createdAt) ? toIso(raw.createdAt) : new Date(0).toISOString(),
    updatedAt: isIsoTimestamp(raw.updatedAt) ? toIso(raw.updatedAt) : (isIsoTimestamp(raw.createdAt) ? toIso(raw.createdAt) : new Date(0).toISOString()),
    sessionIds: Array.isArray(raw.sessionIds)
      ? raw.sessionIds.filter(value => typeof value === 'string' && value !== '')
      : [],
    ...(isIsoTimestamp(raw.deletedAt) ? { deletedAt: toIso(raw.deletedAt) } : {}),
  })
}

// ── 运行记录模型（spec §3 Run） ────────────────────────────────────────────

/** 运行记录的字段顺序（spec §3 表格顺序）。 */
export const RUN_FIELDS = Object.freeze([
  'runId',
  'taskId',
  'attempt',
  'trigger',
  'startedAt',
  'endedAt',
  'status',
  'sessionId',
  'exitCode',
  'tailOutput',
  'summary',
  'logFilePath',
])

/** 运行记录的调度补充字段（排队引入，非 spec 表格字段）。 */
export const RUN_EXTRA_FIELDS = Object.freeze(['queuedAt', 'scheduledFor', 'errorCode'])

/**
 * 校验运行记录状态。
 * @param {unknown} status - 待校验状态。
 * @returns {string} 合法状态。
 */
export function assertRunStatus(status) {
  return assertEnum(status, RUN_STATUSES, 'status')
}

/**
 * 校验触发来源。
 * @param {unknown} trigger - 待校验来源。
 * @returns {string} 合法来源。
 */
export function assertRunTrigger(trigger) {
  return assertEnum(trigger, RUN_TRIGGERS, 'trigger')
}

/**
 * 构造一条运行记录（字段顺序固定）。
 * @param {object} input
 * @param {string} input.taskId - 所属任务 id。
 * @param {string|number} input.attempt - 第几次运行（1=首次，2=重试）。
 * @param {string} [input.status] - 初始状态，默认 running。
 * @param {string} [input.trigger] - 触发来源，默认 manual。
 * @param {string} [input.startedAt] - 开始时间（ISO），默认当前时间。
 * @param {string|null} [input.sessionId] - 会话 id。
 * @param {number|null} [input.exitCode] - 退出码。
 * @param {string} [input.tailOutput] - 输出尾部（自动按 200 行截断）。
 * @param {string} [input.summary] - 一句话摘要。
 * @param {string|null} [input.logFilePath] - 完整输出路径。
 * @param {string} [input.runId] - 指定 runId（默认生成）。
 * @param {number} [input.now] - 注入时间戳。
 * @returns {Record<string, unknown>} 运行记录。
 */
export function createRunRecord(input) {
  const now = input.now ?? Date.now()
  return orderRun({
    runId: input.runId ?? createId(now),
    taskId: input.taskId,
    attempt: input.attempt,
    trigger: input.trigger === undefined ? 'manual' : assertRunTrigger(input.trigger),
    startedAt: input.startedAt ?? new Date(now).toISOString(),
    endedAt: null,
    status: input.status === undefined ? 'running' : assertRunStatus(input.status),
    sessionId: input.sessionId ?? null,
    exitCode: input.exitCode ?? null,
    tailOutput: truncateTail(input.tailOutput ?? ''),
    summary: input.summary ?? '',
    logFilePath: input.logFilePath === undefined ? null : input.logFilePath,
    ...(input.queuedAt !== undefined ? { queuedAt: input.queuedAt } : {}),
    ...(input.scheduledFor !== undefined ? { scheduledFor: input.scheduledFor } : {}),
    ...(input.errorCode !== undefined ? { errorCode: input.errorCode } : {}),
  })
}

/**
 * 按契约字段顺序重排运行记录（补充字段追加在后）。
 * @param {Record<string, unknown>} run - 运行记录。
 * @returns {Record<string, unknown>} 排序后的运行记录。
 */
export function orderRun(run) {
  /** @type {Record<string, unknown>} */
  const ordered = {}
  for (const field of RUN_FIELDS) ordered[field] = run[field]
  for (const field of RUN_EXTRA_FIELDS) {
    if (run[field] !== undefined) ordered[field] = run[field]
  }
  return ordered
}

/**
 * 规范化磁盘上读到的运行记录；损坏项抛 E_STORAGE。
 * @param {unknown} raw - 原始对象。
 * @param {object} [options]
 * @param {string} [options.source] - 来源描述。
 * @returns {Record<string, unknown>} 规范化运行记录。
 */
export function reviveRun(raw, options = {}) {
  const { source = '运行记录' } = options
  if (!isPlainObject(raw)) {
    throw new PluginError('storage', `${source} 不是对象`)
  }
  if (typeof raw.runId !== 'string' || raw.runId === '') {
    throw new PluginError('storage', `${source} 缺少 runId`)
  }
  if (typeof raw.taskId !== 'string' || raw.taskId === '') {
    throw new PluginError('storage', `${source} 缺少 taskId`)
  }
  assertEnum(raw.status, RUN_STATUSES, 'status')
  return orderRun({
    runId: raw.runId,
    taskId: raw.taskId,
    attempt: typeof raw.attempt === 'number' && Number.isFinite(raw.attempt) ? raw.attempt : 1,
    trigger: RUN_TRIGGERS.includes(raw.trigger) ? raw.trigger : 'manual',
    startedAt: isIsoTimestamp(raw.startedAt) ? toIso(raw.startedAt) : new Date(0).toISOString(),
    endedAt: readTimestamp(raw, 'endedAt'),
    status: raw.status,
    sessionId: typeof raw.sessionId === 'string' && raw.sessionId !== '' ? raw.sessionId : null,
    exitCode: readIntegerOrNull(raw, 'exitCode'),
    tailOutput: truncateTail(typeof raw.tailOutput === 'string' ? raw.tailOutput : ''),
    summary: typeof raw.summary === 'string' ? raw.summary : '',
    logFilePath: readNullablePath(raw, 'logFilePath', 8000),
    ...(isIsoTimestamp(raw.queuedAt) ? { queuedAt: toIso(raw.queuedAt) } : {}),
    ...(isIsoTimestamp(raw.scheduledFor) ? { scheduledFor: toIso(raw.scheduledFor) } : {}),
    ...(typeof raw.errorCode === 'string' ? { errorCode: raw.errorCode } : {}),
  })
}

/**
 * 计算下次运行记录的 attempt 序号（同一任务内单调递增，从 1 开始）。
 * @param {Array<Record<string, unknown>>} runs - 该任务的运行记录（任意顺序）。
 * @returns {number} 下一个 attempt。
 */
export function nextAttempt(runs) {
  let max = 0
  for (const run of runs) {
    const attempt = typeof run.attempt === 'number' && Number.isFinite(run.attempt) ? run.attempt : 0
    if (attempt > max) max = attempt
  }
  return max + 1
}

/**
 * 比较两条运行记录的先后（降序比较器：a 更新则返回负数）。
 * @param {Record<string, unknown>} a - 记录 A。
 * @param {Record<string, unknown>} b - 记录 B。
 * @returns {number} 排序值。
 */
export function compareRunsDesc(a, b) {
  const left = Date.parse(String(a.startedAt ?? '')) || 0
  const right = Date.parse(String(b.startedAt ?? '')) || 0
  if (left !== right) return right - left
  return String(b.runId).localeCompare(String(a.runId))
}

/**
 * 取最近一次运行记录（按 startedAt 降序，其次按 runId 降序）。
 * @param {Array<Record<string, unknown>>} runs - 运行记录列表。
 * @returns {Record<string, unknown>|null} 最近一次；空列表返回 null。
 */
export function latestRun(runs) {
  let best = null
  for (const run of runs) {
    if (best === null || compareRunsDesc(run, best) < 0) best = run
  }
  return best
}

// ── 全局状态与分类（spec §3 全局状态 / §8 分类） ───────────────────────────

/** 由分类名派生一个稳定 id（非 ASCII 名称退化为随机 id，避免非法文件名）。 */
export function slugifyCategoryId(name) {
  const ascii = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return ascii === '' ? `cat-${randomBytes(3).toString('hex')}` : ascii
}

/**
 * 校验并规范化一个分类项 `{ id, name, color }`。
 * @param {unknown} raw - 原始分类。
 * @param {object} [options]
 * @param {string} [options.fallbackId] - 缺 id 时由名称派生。
 * @returns {{id: string, name: string, color: string}} 规范化分类。
 */
export function normalizeCategory(raw, options = {}) {
  if (!isPlainObject(raw)) {
    throw new PluginError('bad-request', '分类必须是对象 { id?, name, color }')
  }
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  if (name === '') throw new PluginError('bad-request', '分类缺少 name', { details: { field: 'name' } })
  const id = typeof raw.id === 'string' && raw.id.trim() !== ''
    ? raw.id.trim()
    : (options.fallbackId ?? slugifyCategoryId(name))
  const color = typeof raw.color === 'string' ? raw.color.trim() : ''
  if (!/^#[0-9a-fA-F]{6}$/.test(color) && !/^#[0-9a-fA-F]{3}$/.test(color)) {
    throw new PluginError('bad-request', `分类 "${name}" 的 color 必须是 #RRGGBB 或 #RGB 形式`, {
      details: { field: 'color' },
    })
  }
  return { id, name, color: color.toLowerCase() }
}

/**
 * 校验分类表：数组、非空、id 唯一。
 * @param {unknown} raw - 原始分类表。
 * @returns {Array<{id: string, name: string, color: string}>} 规范化分类表。
 */
export function normalizeCategories(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new PluginError('bad-request', 'categories 必须是非空数组')
  }
  const list = []
  const seen = new Set()
  for (const item of raw) {
    const category = normalizeCategory(item)
    if (seen.has(category.id)) {
      throw new PluginError('bad-request', `分类 id 重复：${category.id}`, { details: { field: 'id' } })
    }
    seen.add(category.id)
    list.push(category)
  }
  return list
}

/**
 * 规范化全局状态对象（磁盘或注入来源）。
 * @param {unknown} raw - 原始对象。
 * @param {object} [options]
 * @param {string} [options.source] - 来源描述。
 * @returns {{paused: boolean, categories: Array<object>, updatedAt: string|null}} 全局状态。
 */
export function normalizeGlobalState(raw, options = {}) {
  const { source = 'state.json' } = options
  const record = isPlainObject(raw) ? raw : {}
  let categories = DEFAULT_CATEGORIES.map(category => ({ ...category }))
  if ('categories' in record && record.categories !== null) {
    try {
      categories = normalizeCategories(record.categories)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new PluginError('storage', `${source} 中 categories 非法：${message}`)
    }
  }
  return {
    paused: typeof record.paused === 'boolean' ? record.paused : DEFAULT_GLOBAL_PAUSED,
    categories,
    updatedAt: isIsoTimestamp(record.updatedAt) ? toIso(record.updatedAt) : null,
  }
}
