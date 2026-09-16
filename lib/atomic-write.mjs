/**
 * dsh-task-scheduler — 原子写文件工具（宿主半侧，纯 Node 内置能力，无外部依赖）
 *
 * 契约：`$DSH_HOME/dsh-task-scheduler/` 下的任何持久化文件都只通过本模块落盘。
 * 写路径固定为「同目录临时文件 → flush → rename 覆盖」，因此进程在任意时刻被杀死
 * 都不会留下半截 JSON：目标文件要么是旧内容，要么是新内容。
 *
 * 参考实现（只读）：
 *  - @deepseek-ai/dsh-host-webserver：宿主侧唯一 HTTP 载体，插件在其中注册前缀路由。
 *  - dsh-better-sidebar/src/fs-operations.ts：上传同样走「临时文件再 rename」。
 */
import { mkdir, open, rename, rm, stat } from 'node:fs/promises'
import { constants as FS } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'

/** 同一目录内临时文件名的随机后缀长度（十六进制字符数）。 */
const TEMP_SUFFIX_BYTES = 6

/**
 * Windows 上 `rename` 覆盖一个正被其他句柄打开的目标可能抛 EPERM/EBUSY；
 * 这是短暂的共享冲突，重试即可，重试仍失败则如实抛出（绝不静默吞掉）。
 */
const RENAME_RETRIES = 5
const RENAME_RETRY_DELAY_MS = 20

/** 同步阻塞等待若干毫秒（Node 无内置同步 sleep，这里只用于重试退避）。 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** 判断一个错误是否属于「重命名共享冲突」这一可重试类别。 */
function isRetryableRenameError(error) {
  const code = error && typeof error === 'object' ? error.code : undefined
  return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES' || code === 'EEXIST'
}

/**
 * 确保目录存在（递归创建），已存在时不报错。
 * @param {string} dir - 绝对或相对目录路径。
 */
export async function ensureDir(dir) {
  await mkdir(dir, { recursive: true })
}

/**
 * 原子写入一个 UTF-8 文本文件。
 *
 * 步骤：确保父目录存在 → 写 `.<basename>.<随机>.tmp` → fsync 文件 → rename 覆盖目标
 * → 尽力 fsync 父目录（目录项落盘；部分平台不支持，失败忽略）。
 *
 * @param {string} filePath - 目标文件的绝对路径。
 * @param {string} content - 要写入的完整文本内容（UTF-8）。
 * @returns {Promise<void>} 落盘完成后 resolve。
 */
export async function writeFileAtomic(filePath, content) {
  const dir = dirname(filePath)
  await ensureDir(dir)
  const tempPath = join(
    dir,
    `.${filePath.split(/[\\/]/).pop()}.${randomBytes(TEMP_SUFFIX_BYTES).toString('hex')}.tmp`,
  )
  let handle
  try {
    handle = await open(tempPath, FS.O_CREAT | FS.O_TRUNC | FS.O_WRONLY, 0o600)
    await handle.writeFile(content, 'utf8')
    // fsync 保证内容先于 rename 落到磁盘；崩溃后不会出现「目录项已更新、内容为空」。
    await handle.sync()
    await handle.close()
    handle = undefined
    await renameWithRetry(tempPath, filePath)
  } catch (error) {
    if (handle !== undefined) {
      try { await handle.close() } catch { /* 关闭失败不掩盖原始错误 */ }
    }
    try { await rm(tempPath, { force: true }) } catch { /* 清理失败不掩盖原始错误 */ }
    throw error
  }
  await syncDirBestEffort(dir)
}

/** 带退避重试的 rename（覆盖已存在目标）。 */
async function renameWithRetry(from, to) {
  let lastError
  for (let attempt = 0; attempt < RENAME_RETRIES; attempt += 1) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      lastError = error
      if (!isRetryableRenameError(error)) throw error
      sleepSync(RENAME_RETRY_DELAY_MS * (attempt + 1))
    }
  }
  throw lastError
}

/** 尽力 fsync 一个目录；平台/权限不支持时静默跳过（不影响已完成的 rename）。 */
async function syncDirBestEffort(dir) {
  let handle
  try {
    handle = await open(dir, FS.O_RDONLY)
    await handle.sync()
  } catch {
    /* 目录 fsync 是加固而非正确性前提 */
  } finally {
    if (handle !== undefined) {
      try { await handle.close() } catch { /* 忽略 */ }
    }
  }
}

/**
 * 原子写入一个 JSON 文件（缩进 2 空格 + 末尾换行，便于人工 diff 与灾难恢复）。
 * @param {string} filePath - 目标文件绝对路径。
 * @param {unknown} value - 任意可序列化值。
 * @returns {Promise<string>} 实际写入的文本内容（供调用方计算摘要/长度）。
 */
export async function writeJsonAtomic(filePath, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`
  await writeFileAtomic(filePath, text)
  return text
}

/** 文件是否存在（不抛错）。 */
export async function fileExists(filePath) {
  try {
    const info = await stat(filePath)
    return info.isFile()
  } catch {
    return false
  }
}

/** 读取 UTF-8 文本文件；不存在返回 `undefined`，读取失败抛出。 */
export async function readTextIfExists(filePath) {
  if (!(await fileExists(filePath))) return undefined
  const { readFile } = await import('node:fs/promises')
  return await readFile(filePath, 'utf8')
}

// ── 跨进程互斥（可选加固） ──────────────────────────────────────────────────

/** 锁文件被判定为「陈旧」的年龄上限（毫秒）：超过它则视为持有者已崩溃并抢占。 */
const STALE_LOCK_MS = 60_000

/** 等待锁的默认上限（毫秒）。 */
const DEFAULT_LOCK_TIMEOUT_MS = 5_000

/** 等待锁时的轮询间隔（毫秒）。 */
const LOCK_POLL_MS = 25

/**
 * 以「独占创建锁文件」的方式在多个进程之间互斥（**可选加固**，默认关闭）。
 *
 * ⚠️ 现状说明（务必读完再决定是否启用）：
 *  本函数默认**不被调用**。原因是在本机（Windows + 本会话沙箱）实测：当调用链
 *  不是从 `await` 顶层进入时（例如调度器定时器回调里发起的后台 promise 链），
 *  第二次 `open(lockPath, 'wx')` 会**挂住不返回**，既不给 EEXIST 也不给 ENOENT —
 *  一次运行会永久卡住在 `startRun`。这是平台级行为，不是本文件的逻辑问题，但
 *  在排查清楚之前**不能**把它放在默认路径上（宁可少一层保护，也不能让运行卡死）。
 *
 *  正确性并不依赖它：跨进程并发时，`writeFileAtomic`（同目录 tmp + rename）已保证
 *  「不会读到半截文件、不会两个进程互相覆盖到损坏状态」，最坏情况是后写者覆盖先写者
 *  的一次更新——对「用户自己的 dsh web 单实例」而言可以接受。
 *
 *  因此 `TaskStore` 默认用**进程内串行队列**（`#serialize`）保证一致；需要跨进程
 *  硬化时用 `new TaskStore({ fileLock: true })` 显式开启，并在真实宿主上先验证
 *  上述挂起现象不存在（`tools/verify.mjs` 会打印当前是否启用）。
 *
 * @template T
 * @param {string} lockPath - 锁文件路径（位于数据根内）。
 * @param {() => Promise<T>} work - 持锁期间执行的异步工作。
 * @param {object} [options]
 * @param {number} [options.timeoutMs] - 获取锁的最长等待时间（真实时间）。
 * @param {number} [options.maxAttempts] - 兜底尝试次数（防时钟不前进时死循环）。
 * @returns {Promise<T>} `work` 的返回值。
 * @throws {Error & {code?: string}} 超时未取到锁时抛 `code === 'ELOCKED'`。
 */
export async function withFileLock(lockPath, work, options = {}) {
  const { timeoutMs = DEFAULT_LOCK_TIMEOUT_MS, maxAttempts = Math.ceil(timeoutMs / LOCK_POLL_MS) + 20 } = options
  await ensureDir(dirname(lockPath))
  const deadline = Date.now() + timeoutMs
  let handle
  let attempts = 0
  for (;;) {
    attempts += 1
    try {
      handle = await open(lockPath, FS.O_CREAT | FS.O_EXCL | FS.O_WRONLY, 0o600)
      break
    } catch (error) {
      const code = error && typeof error === 'object' ? error.code : undefined
      if (code !== 'EEXIST' && code !== 'ENOENT') throw error
      if (code === 'EEXIST' && await stealStaleLock(lockPath)) continue
      if (attempts >= maxAttempts || Date.now() >= deadline) {
        const timeout = new Error(`获取数据根写锁超时：${lockPath}`)
        timeout.code = 'ELOCKED'
        throw timeout
      }
      await delay(LOCK_POLL_MS)
    }
  }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), 'utf8')
    return await work()
  } finally {
    // 先确保锁文件被删掉（真实 I/O 循环），再关闭句柄。
    await releaseLockFile(lockPath)
    try { await handle.close() } catch { /* 忽略 */ }
  }
}

/**
 * 删除锁文件并确认它真的不在了。
 * Windows 上 unlink 一个刚被写入的文件可能短暂报 EPERM/EBUSY，因此带重试；
 * 但**绝不吞掉最终失败**——删不掉就抛，避免下一个持有者拿到「假锁」。
 */
async function releaseLockFile(lockPath) {
  let lastError
  for (let attempt = 0; attempt < RENAME_RETRIES; attempt += 1) {
    try {
      await rm(lockPath, { force: true })
      return
    } catch (error) {
      const code = error && typeof error === 'object' ? error.code : undefined
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') {
        if (code === 'ENOENT') return
        lastError = error
        break
      }
      lastError = error
      await delay(RENAME_RETRY_DELAY_MS * (attempt + 1))
    }
  }
  // 最后再确认一次：文件真的不在就当作成功（可能已被别的路径删掉）。
  if (!(await fileExists(lockPath))) return
  throw lastError ?? new Error(`无法删除锁文件：${lockPath}`)
}

/** 锁文件过旧则删除并返回 true（允许调用方立即重试获取）。 */
async function stealStaleLock(lockPath) {
  try {
    const info = await stat(lockPath)
    if (Date.now() - info.mtimeMs <= STALE_LOCK_MS) return false
    await rm(lockPath, { force: true })
    return true
  } catch {
    // 锁在检查期间已被释放：让调用方重试即可。
    return true
  }
}

/** 异步等待。 */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
