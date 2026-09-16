/**
 * dsh-task-scheduler — 5 段 cron 解析与下次运行时间计算（宿主本地时区）
 *
 * 规格（docs/spec.md §6）：
 *  - 5 段：分 时 日 月 周（`minute hour dayOfMonth month dayOfWeek`）
 *  - 支持星号、星号斜杠步进（如 星号 斜杠 5）、a-b 区间、a,b 列表及它们的组合
 *    （含 a-b/n、a/n、a-b,c-d）
 *  - **导出名与路径固定**：`lib/cron.mjs` → `nextRun(expr, fromDate) → Date`
 *  - 按**宿主本地时区**计算（`Date` 的本地字段），非法表达式**抛明确错误**、绝不静默返回
 *
 * 日/周同时受限时的取舍规则（照 Vixie cron 语义，已在 docs/api-contract.md 写死）：
 *  - 若「日」与「周」**都**不是宽松写法（即都不是单个星号，也没有用带步进的星号覆盖全域），
 *    则两者**取或**：任一天字段命中即算命中（这是 crontab 的经典行为）；
 *  - 否则两者**取与**（另一个视为通配）。
 *
 * 取值域：分 0-59；时 0-23；日 1-31；月 1-12；周 0-7（0 与 7 都表示周日）。
 * 单字面量形式的周字段 7 会被归一化为 0，避免 0,7 这类写法把候选集撑成「每天都命中」。
 */

/** 各字段的取值域（周的上界写 7，解析后统一把 7 映射成 0）。 */
const FIELDS = Object.freeze([
  Object.freeze({ name: 'minute', label: '分', min: 0, max: 59 }),
  Object.freeze({ name: 'hour', label: '时', min: 0, max: 23 }),
  Object.freeze({ name: 'dayOfMonth', label: '日', min: 1, max: 31, alias: null }),
  Object.freeze({ name: 'month', label: '月', min: 1, max: 12, alias: null }),
  Object.freeze({ name: 'dayOfWeek', label: '周', min: 0, max: 7, alias: { 7: 0 } }),
])

/** 搜索下次运行时间时的硬上限（分钟）：约 5 年，足以覆盖闰年与所有合法表达式。 */
const MAX_SEARCH_MINUTES = 5 * 366 * 24 * 60

/** 解析结果里用于表示「该字段是宽松写法」的区间阈值（见文件头日/周规则）。 */
const DAY_OF_MONTH_INDEX = 2
const DAY_OF_WEEK_INDEX = 4

/** cron 解析/取值错误；code 固定为 invalid-cron（与 HTTP 层错误码一致）。 */
export class CronError extends Error {
  /**
   * @param {string} message - 人类可读说明。
   * @param {object} [meta] - 补充信息（字段名、非法片段）。
   */
  constructor(message, meta = {}) {
    super(message)
    this.name = 'CronError'
    this.code = 'invalid-cron'
    Object.assign(this, meta)
  }
}

/** 把 n 归一到 [min,max] 循环区间内（不做循环，只用于别名映射）。 */
function aliasOf(field, value) {
  if (field.alias !== null && field.alias !== undefined && field.alias[value] !== undefined) {
    return field.alias[value]
  }
  return value
}

/**
 * 解析单个字段为一个「取值集合 + 是否完全通配」的结果。
 *
 * 完全通配（bare）只指整段就是单个星号（或 星号,星号）：此时该字段对判定没有约束。
 * 带步进的星号写法（如 星号 斜杠 2）、区间（1-31）、全周（0-7）这类写法都算**受限**，
 * 因为调度器要用它判断「日/周是否都受限 → 取或而非取与」这条 Vixie 规则。
 *
 * @param {string} raw - 原始字段文本。
 * @param {object} field - 字段定义。
 * @returns {{ values: Set<number>, bare: boolean }} 解析结果。
 */
function parseField(raw, field) {
  if (raw === '') {
    throw new CronError(`cron 的「${field.label}」字段为空`, { field: field.name })
  }
  const values = new Set()
  let allBare = true

  for (const part of raw.split(',')) {
    if (part === '') {
      throw new CronError(`cron 的「${field.label}」字段里有空的列表项（连续逗号）`, { field: field.name })
    }
    const slashIndex = part.indexOf('/')
    let base = part
    let step = 1
    if (slashIndex >= 0) {
      base = part.slice(0, slashIndex)
      const stepText = part.slice(slashIndex + 1)
      if (!/^\d+$/.test(stepText)) {
        throw new CronError(`cron 的「${field.label}」字段步进非法：${JSON.stringify(part)}`, { field: field.name })
      }
      step = Number(stepText)
      if (step === 0) {
        throw new CronError(`cron 的「${field.label}」字段步进不能为 0：${JSON.stringify(part)}`, { field: field.name })
      }
    }

    let from
    let to
    if (base === '*') {
      from = field.min
      to = field.max
      // 只有不带步进的裸星号才算「无约束」。
      if (slashIndex >= 0) allBare = false
    } else {
      allBare = false
      if (base.includes('-')) {
        const [fromText, toText, ...rest] = base.split('-')
        if (rest.length > 0 || !/^\d+$/.test(fromText) || !/^\d+$/.test(toText)) {
          throw new CronError(`cron 的「${field.label}」字段区间非法：${JSON.stringify(part)}`, { field: field.name })
        }
        from = Number(fromText)
        to = Number(toText)
        if (from > to) {
          throw new CronError(`cron 的「${field.label}」字段区间起止颠倒：${JSON.stringify(part)}`, { field: field.name })
        }
      } else {
        if (!/^\d+$/.test(base)) {
          throw new CronError(`cron 的「${field.label}」字段含非法字符：${JSON.stringify(part)}`, { field: field.name })
        }
        const value = Number(base)
        if (slashIndex >= 0) {
          // `a/n` 语义：从 a 起按步长 n 走到字段上界
          from = value
          to = field.max
        } else {
          from = value
          to = value
        }
      }
    }

    if (from < field.min || to > field.max) {
      throw new CronError(
        `cron 的「${field.label}」字段超出范围 ${field.min}-${field.max}：${JSON.stringify(part)}`,
        { field: field.name },
      )
    }
    for (let value = from; value <= to; value += step) {
      values.add(aliasOf(field, value))
    }
  }

  if (values.size === 0) {
    throw new CronError(`cron 的「${field.label}」字段没有匹配到任何取值：${JSON.stringify(raw)}`, {
      field: field.name,
    })
  }
  return { values, bare: allBare }
}

/**
 * 解析一个 5 段 cron 表达式。
 * @param {unknown} expression - 表达式文本。
 * @returns {{
 *   expression: string,
 *   minute: Set<number>, hour: Set<number>, dayOfMonth: Set<number>,
 *   month: Set<number>, dayOfWeek: Set<number>,
 *   domRestricted: boolean, dowRestricted: boolean,
 * }} 解析结果（集合供判定用，两个 restricted 标记供日/周规则用）。
 * @throws {CronError} 表达式非法。
 */
export function parseCron(expression) {
  if (typeof expression !== 'string') {
    throw new CronError('cron 表达式必须是字符串')
  }
  const trimmed = expression.trim()
  if (trimmed === '') {
    throw new CronError('cron 表达式不能为空')
  }
  const parts = trimmed.split(/\s+/)
  if (parts.length !== 5) {
    throw new CronError(`cron 必须是 5 段（分 时 日 月 周），实际 ${parts.length} 段`, {
      expectedFields: 5,
      actualFields: parts.length,
    })
  }
  const parsed = parts.map((part, index) => parseField(part, FIELDS[index]))
  const dayOfMonth = parsed[DAY_OF_MONTH_INDEX]
  const dayOfWeek = parsed[DAY_OF_WEEK_INDEX]
  return {
    expression: trimmed,
    minute: parsed[0].values,
    hour: parsed[1].values,
    dayOfMonth: dayOfMonth.values,
    month: parsed[3].values,
    dayOfWeek: dayOfWeek.values,
    // 「受限」= 不是裸星号（含带步进的星号、1-31、0-7 等显式写法）
    domRestricted: !dayOfMonth.bare,
    dowRestricted: !dayOfWeek.bare,
  }
}

/**
 * 判断一个时刻是否命中表达式（供调度器与自检使用）。
 * @param {unknown} expression - cron 表达式。
 * @param {Date} date - 待判定时刻（按宿主本地时区取字段）。
 * @returns {boolean} 是否命中。
 */
export function cronMatches(expression, date) {
  const cron = parseCron(expression)
  return matchesParsed(cron, date)
}

/** 用已解析的表达式判断命中（内部热路径）。 */
function matchesParsed(cron, date) {
  if (!cron.minute.has(date.getMinutes())) return false
  if (!cron.hour.has(date.getHours())) return false
  if (!cron.month.has(date.getMonth() + 1)) return false
  const dayOfMonthHit = cron.dayOfMonth.has(date.getDate())
  const parsedDow = date.getDay() // 0 = 周日
  const dayOfWeekHit = cron.dayOfWeek.has(parsedDow)
  // 日/周同时受限 → 取或（Vixie cron 语义）；否则取与。
  if (cron.domRestricted && cron.dowRestricted) return dayOfMonthHit || dayOfWeekHit
  return dayOfMonthHit && dayOfWeekHit
}

/**
 * 计算 `fromDate` 之后**严格大于**该时刻的下一次运行时间。
 *
 * 语义：从 `fromDate` 起按分钟向前搜索（含下一分钟），返回第一个命中时刻；
 * 时间按**宿主本地时区**解释（用 `Date` 的本地字段，不受 DST 时区库影响）。
 *
 * @param {string} expression - 5 段 cron 表达式。
 * @param {Date|string|number} [fromDate] - 起算时刻（默认当前时间）。
 * @returns {Date} 下一次运行时间（本地时刻）。
 * @throws {CronError} 表达式非法（绝不静默返回 Invalid Date）。
 */
export function nextRun(expression, fromDate = new Date()) {
  const cron = parseCron(expression)
  const from = fromDate instanceof Date ? fromDate : new Date(fromDate)
  if (Number.isNaN(from.getTime())) {
    throw new CronError('nextRun 的 fromDate 不是合法时间')
  }
  // 从下一分钟开始；秒/毫秒清零，保证结果落在分钟边界上。
  const cursor = new Date(from.getTime())
  cursor.setSeconds(0, 0)
  cursor.setMinutes(cursor.getMinutes() + 1)

  for (let step = 0; step < MAX_SEARCH_MINUTES; step += 1) {
    if (matchesParsed(cron, cursor)) return new Date(cursor.getTime())
    cursor.setMinutes(cursor.getMinutes() + 1)
  }
  throw new CronError(`cron 表达式在 ${MAX_SEARCH_MINUTES} 分钟内没有下一次运行时间：${cron.expression}`, {
    expression: cron.expression,
  })
}

/**
 * 计算 `fromDate` 之后的前 `count` 次运行时间（cron 预览用）。
 * @param {string} expression - 5 段 cron 表达式。
 * @param {number} [count] - 需要的次数（默认 5）。
 * @param {Date|string|number} [fromDate] - 起算时刻。
 * @returns {Date[]} 依次递增的运行时间。
 */
export function nextRuns(expression, count = 5, fromDate = new Date()) {
  if (!Number.isInteger(count) || count < 1 || count > 100) {
    throw new CronError('nextRuns 的 count 必须是 1..100 的整数')
  }
  const runs = []
  let cursor = fromDate instanceof Date ? fromDate : new Date(fromDate)
  for (let index = 0; index < count; index += 1) {
    const next = nextRun(expression, cursor)
    runs.push(next)
    cursor = next
  }
  return runs
}

/**
 * 计算 `(from, to]` 区间内的触发时刻（漏跑补跑用）。
 * 区间可能跨多天，因此用「粗扫天 + 精确扫分钟」的方式：只对可能命中的天做分钟级搜索。
 * @param {string} expression - cron 表达式。
 * @param {Date|string|number} from - 开区间起点（不含）。
 * @param {Date|string|number} to - 闭区间终点（含）。
 * @param {number} [limit=2000] - 最多返回多少个（防止极端表达式产生海量结果）。
 * @returns {Date[]} 按时间升序的触发时刻。
 */
export function occurrencesBetween(expression, from, to, limit = 2000) {
  const cron = parseCron(expression)
  const start = from instanceof Date ? from : new Date(from)
  const end = to instanceof Date ? to : new Date(to)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new CronError('occurrencesBetween 的时间参数非法')
  }
  if (end.getTime() <= start.getTime()) return []

  const results = []
  const cursor = new Date(start.getTime())
  cursor.setSeconds(0, 0)
  cursor.setMinutes(cursor.getMinutes() + 1)
  const last = new Date(end.getTime())
  last.setSeconds(0, 0)

  while (cursor.getTime() <= last.getTime()) {
    if (matchesParsed(cron, cursor)) {
      results.push(new Date(cursor.getTime()))
      if (results.length >= limit) break
      // 命中后跳到下一分钟，避免同一分钟被重复计入
      cursor.setMinutes(cursor.getMinutes() + 1)
      continue
    }
    // 未命中：跳到下一分钟；同一天内继续，跨天自然继续（实现简单且正确）
    cursor.setMinutes(cursor.getMinutes() + 1)
  }
  return results
}
