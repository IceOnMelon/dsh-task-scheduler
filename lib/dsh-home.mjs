/**
 * dsh-task-scheduler — DSH 主目录解析（宿主半侧）
 *
 * 规格要求（docs/spec.md §11.4）：用 `@deepseek-ai/dsh-home-paths` 的
 * `resolveDshHome()` / `dshHomePath()`，不要自己拼环境变量。
 *
 * 实现策略（为什么不是一行静态 import）：
 *  - `@deepseek-ai/dsh-home-paths` 是宿主侧的库依赖，装在**用户 profile** 的
 *    `node_modules` 下，不在本插件目录树内；本插件的自检脚本 `tools/verify.mjs` 需要
 *    脱离宿主、在任意工作目录用 `node` 直接加载数据层。静态 import 会让自检在
 *    「没有该包」的环境里直接 ERR_MODULE_NOT_FOUND。
 *  - 因此这里做**动态优先**解析：能 `import('@deepseek-ai/dsh-home-paths')` 就用官方实现
 *    （`resolveDshHome` / `dshHomePath`），拿不到才回退到语义等价的本地实现。
 *  - 两条路径的语义完全一致（显式配置 > `$DSH_HOME` > `~/.dsh`；空/纯空白 `$DSH_HOME`
 *    视为未设置；支持 `~`、`~/`、`~\` 展开；输出规范化绝对路径），并且**用了哪条会在
 *    日志与 `describeBackend()` 里明确写出来**，绝不静默变行为。
 *
 * 该包的实际 API（`lib/types/index.d.ts`）：
 *   resolveDshHome(configured?: string, env?): string
 *   dshHomePath(...segments: string[]): string
 */
import { homedir } from 'node:os'
import { isAbsolute, join, normalize, resolve } from 'node:path'

/** 插件数据根目录名（与插件 id 一致）。 */
export const PLUGIN_DATA_DIR_NAME = 'dsh-task-scheduler'

/** 官方包名（必须在宿主 profile 里可解析）。 */
export const HOME_PATHS_PACKAGE = '@deepseek-ai/dsh-home-paths'

/** @type {'@deepseek-ai/dsh-home-paths' | 'local-fallback' | null} */
let backend = null
/** @type {{ resolveDshHome: (configured?: string) => string, dshHomePath: (...segments: string[]) => string } | null} */
let official = null
/** 动态解析的 promise（模块级只做一次）。 */
let probePromise = null

/**
 * 尝试加载官方主目录解析包（只探一次，结果缓存）。
 * @returns {Promise<void>} 探测完成后 resolve（失败也 resolve，只是走回退路径）。
 */
export async function probeHomePaths() {
  if (probePromise !== null) return probePromise
  probePromise = (async () => {
    try {
      const mod = await import(HOME_PATHS_PACKAGE)
      if (typeof mod.resolveDshHome === 'function' && typeof mod.dshHomePath === 'function') {
        official = { resolveDshHome: mod.resolveDshHome, dshHomePath: mod.dshHomePath }
        backend = HOME_PATHS_PACKAGE
        return
      }
    } catch {
      /* 包不可解析：走回退路径 */
    }
    backend = 'local-fallback'
  })()
  return probePromise
}

/**
 * 同步探测结果：宿主加载时建议 `await probeHomePaths()`；未探测时首次解析会走回退，
 * 因此 `apply()` 里会先 await 一次。
 * @returns {'@deepseek-ai/dsh-home-paths' | 'local-fallback'} 当前生效的实现。
 */
export function activeBackend() {
  return backend ?? 'local-fallback'
}

/** 供日志分诊：说明当前用的是官方包还是本地等价实现。 */
export function describeBackend() {
  return activeBackend() === HOME_PATHS_PACKAGE
    ? `主目录解析：${HOME_PATHS_PACKAGE}（官方）`
    : `主目录解析：本地等价实现（未能加载 ${HOME_PATHS_PACKAGE}）`
}

/**
 * 展开开头的 `~` / `~/` / `~\`（仅当前用户形式；`~alice/...` 原样保留）。
 * @param {string} value - 待展开路径。
 * @returns {string} 展开后的路径。
 */
export function expandHomePath(value) {
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return join(homedir(), value.slice(2))
  }
  return value
}

/**
 * 解析 DSH 主目录（不抛错，永远返回规范化绝对路径）。
 *
 * 优先官方 `resolveDshHome(configured)`；未探测到官方包时用本地等价实现
 * （显式配置 > 非空 `$DSH_HOME` > `~/.dsh`）。
 * @param {string} [configured] - 显式配置路径（最高优先级）。
 * @returns {string} 绝对路径。
 */
export function resolveDshHome(configured) {
  if (official !== null) return normalize(official.resolveDshHome(configured))
  const candidates = [configured, process.env.DSH_HOME]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') {
      return normalize(expandHomePath(candidate.trim()))
    }
  }
  return normalize(join(homedir(), '.dsh'))
}

/**
 * 把路径段拼到解析后的 DSH 主目录上（优先官方 `dshHomePath`）。
 * @param {...string} segments - 子路径段。
 * @returns {string} 规范化绝对路径。
 */
export function dshHomePath(...segments) {
  if (official !== null) return normalize(official.dshHomePath(...segments))
  return normalize(join(resolveDshHome(), ...segments))
}

/**
 * 解析插件数据根 `<DSH_HOME>/dsh-task-scheduler`。
 * @param {object} [options]
 * @param {string} [options.home] - 显式 DSH 主目录（宿主已解析的结果优先）。
 * @param {string} [options.dataRoot] - 直接指定插件数据根（测试/自定义部署用，最高优先级）。
 * @returns {string} 绝对路径。
 */
export function resolveDataRoot(options = {}) {
  const { dataRoot, home } = options
  if (typeof dataRoot === 'string' && dataRoot.trim() !== '') {
    return normalize(isAbsolute(dataRoot) ? dataRoot : resolve(dataRoot))
  }
  // 显式 `home` 必须**优先于** `$DSH_HOME`（spec §11.4：显式配置 > `$DSH_HOME` > `~/.dsh`）。
  // 这条以前被漏掉：解构出来的 `home` 从未使用，于是宿主传进来的显式主目录会被环境变量压过
  // （t6 的 F4）。这里显式走一次 `resolveDshHome(configured)`，两条后端（官方包 / 本地回退）
  // 都遵守同一优先级；没给显式 `home` 时保持原有 `dshHomePath()` 行为不变。
  const configured = typeof home === 'string' && home.trim() !== '' ? home.trim() : undefined
  if (configured !== undefined) {
    return normalize(join(resolveDshHome(configured), PLUGIN_DATA_DIR_NAME))
  }
  return dshHomePath(PLUGIN_DATA_DIR_NAME)
}

/** 测试辅助：重置探测结果（仅自检脚本使用，宿主路径不会调用）。 */
export function __resetBackendProbe() {
  backend = null
  official = null
  probePromise = null
}
