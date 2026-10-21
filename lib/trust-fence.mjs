/**
 * dsh-task-scheduler — 宿主自建路由的浏览器信任栅栏（lib 形态）
 *
 * 判据**逐行取自** `docs/snippets/host-trust-fence.js`（t7 侦察产出，规格 §11.5.1
 * 要求直接复制、不要自己重写）。差别只有两点：
 *  1. 这里另外导出 `trustedHostsOf(ctx)` —— 按 §11.4/§11.5.2 从 `ctx.webRuntime.trustedHosts`
 *     取部署声明的非回环 authority（漏了它，绑 `0.0.0.0` 时本插件全部 API 会 403）。
 *  2. 响应写出放在 `routes.mjs`（信封与状态码在那里统一，§11.5.4）。
 *
 * 为什么必须自己复刻：`@deepseek-ai/dsh-host-webserver` 明确不做任何认证/来源策略
 * （README.zh.md:113），而 `isTrustedApiRequest` / `isLoopbackHostname` **不在**
 * `@deepseek-ai/dsh-client-connection` 的公开导出里；dsh-better-sidebar 也是复刻的
 * （其 src/trust-fence.ts 头部注释明说 copied）。
 *
 * 定位：**这是 DNS-rebinding / cross-site（CSRF）防御，不是认证**。认证（浏览器 cookie）由
 * `ctx.connection.authorizeIndex()` 只施加在 index.html 上（唯一调用点
 * `dsh-host-frontend-static/lib/index.js:60`），插件自建路由拿不到也不需要它 ——
 * 因此「用户已登录」不能当作本插件 API 的保护，栅栏必须每个 handler 自己加。
 */

/** 读一个请求头（node:http 的 headers 可能是 string | string[]）。 */
function header(headers, name) {
  const value = headers[name]
  return typeof value === 'string' ? value : undefined
}

/** 把 Host 头的 authority 解析成 URL；不可解析返回 undefined。 */
function parseAuthority(authority) {
  try {
    return new URL(`http://${authority}`)
  } catch {
    return undefined
  }
}

/**
 * 主机名是否为本地回环（localhost / [::1] / 127.0.0.0/8）。
 * @param {string} hostname WHATWG URL 的 hostname（IPv6 保留方括号）
 * @returns {boolean} 是否回环。
 */
export function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** 规范化 authority 写法：没写端口时按无端口匹配。 */
function canonicalAuthority(entry, entryUrl) {
  const port = entryUrl.port !== '' ? entryUrl.port : new URL(`https://${entry}`).port
  return port === '' ? entryUrl.hostname : `${entryUrl.hostname}:${port}`
}

/** Host 的 authority 是否命中 trustedHosts（精确 host:port 或无端口 host）。 */
function isTrustedAuthority(hostUrl, trustedHosts) {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry)
    if (entryUrl === undefined) return false
    return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host
  })
}

/**
 * 判断一个插件路由请求是否可以放行。
 * @param {{headers: Record<string, string|string[]|undefined>}} request node:http 请求（只用 headers）。
 * @param {readonly string[]} trustedHosts 部署额外声明的非回环 authority（来自 ctx.webRuntime.trustedHosts）。
 * @returns {boolean} Host 属于本机/受信，且浏览器标记为同源。
 */
export function isTrustedApiRequest(request, trustedHosts) {
  const headers = request?.headers ?? {}
  const host = header(headers, 'host')
  if (host === undefined) return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts ?? [])) return false
  // 跨站浏览器请求：sec-fetch-site: cross-site 直接拒。
  if (header(headers, 'sec-fetch-site') === 'cross-site') return false
  // Origin 栅栏：浏览器带了 Origin 就必须是本主机名。
  // 比较 hostname 而不是 host（某些 Chromium 版本在非默认端口下不写端口）。
  // 没有 Origin 也放行（Host 栅栏已经绑定）；字面量 "null" 是不可信来源，拒绝。
  const origin = header(headers, 'origin')
  if (origin === undefined) return true
  try {
    return new URL(origin).hostname === hostUrl.hostname
  } catch {
    return false
  }
}

/**
 * 取部署声明的 trustedHosts（§11.4/§11.5.2）。
 *
 * 真源随 DSH 版本变过：0.2.x 是 `ctx.webStartup`（`@deepseek-ai/dsh-web-app/lib/startup.js:19,44-70`
 * 把 `--trusted-host` 写进 `webStartup.trustedHosts`），0.1.x 是 `ctx.webRuntime`。
 * 这里**按可选读取**处理 —— 两者都不在时返回 config 里写的 extras（通常为空，此时只有回环
 * Host 能通过栅栏），绝不因为缺服务让插件挂在 pending（那会让 `inject` 声明的必需服务永远不齐）。
 *
 * @param {{get?: (name: string) => unknown}} ctx - 宿主上下文。
 * @param {readonly string[]} [extra] - 插件配置里附加的 authority。
 * @returns {string[]} 合并后的信任清单。
 */
export function trustedHostsOf(ctx, extra = []) {
  const collected = []
  const push = (value) => {
    if (typeof value === 'string' && value.trim() !== '') collected.push(value.trim())
  }
  for (const entry of Array.isArray(extra) ? extra : []) push(entry)
  for (const serviceName of ['webStartup', 'webRuntime']) {
    const service = typeof ctx?.get === 'function' ? ctx.get(serviceName) : ctx?.[serviceName]
    const declared = service?.trustedHosts
    if (Array.isArray(declared)) for (const entry of declared) push(entry)
  }
  return [...new Set(collected)]
}
