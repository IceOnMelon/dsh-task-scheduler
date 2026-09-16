/**
 * dsh-task-scheduler —— 宿主自建路由的浏览器信任栅栏（宿主半侧用）。
 *
 * 为什么必须自己复刻：`@deepseek-ai/dsh-host-webserver` 明确**不做**任何认证/来源策略
 * （README.zh.md:113「不提供服务器级 TLS、认证或来源策略」），而
 * `isTrustedApiRequest` / `isLoopbackHostname` **不在** `@deepseek-ai/dsh-client-connection`
 * 的公开导出里（该包只导出 API_PATH/Config/HostConnectionService/RpcId/apply/name/几个 schema）。
 * dsh-better-sidebar 因此把这两个判据原样复刻进了自己的 `src/trust-fence.ts`
 * （其头部注释明说「copied here because the package does not export these helpers」）。
 * 本文件是同一份判据的等价实现，行为与 `/api` 网关一致。
 *
 * 定位：**这是 DNS-rebinding / cross-site（CSRF）防御，不是认证**。
 * 认证（浏览器 cookie）由 `ctx.connection.authorizeIndex()` 只施加在 index.html 上，
 * 插件自建路由拿不到也不需要它（见 docs/client-host-api.md 第 2 节）。
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
 * @returns {boolean}
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
 * @param {{headers: Record<string, string|string[]|undefined>}} request node:http 请求（只用 headers）
 * @param {readonly string[]} trustedHosts 部署额外声明的非回环 authority（来自 ctx.webRuntime.trustedHosts）
 * @returns {boolean} Host 属于本机/受信，且浏览器标记为同源
 */
export function isTrustedApiRequest(request, trustedHosts) {
  const host = header(request.headers, 'host')
  if (host === undefined) return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false
  // 跨站浏览器请求：sec-fetch-site: cross-site 直接拒
  if (header(request.headers, 'sec-fetch-site') === 'cross-site') return false
  // Origin 栅栏：浏览器带了 Origin 就必须是本主机名。
  // 比较 hostname 而不是 host（某些 Chromium 版本在非默认端口下不写端口）。
  // 没有 Origin 也放行（Host 栅栏已经绑定）；字面量 "null" 是不可信来源，拒绝。
  const origin = header(request.headers, 'origin')
  if (origin === undefined) return true
  try {
    return new URL(origin).hostname === hostUrl.hostname
  } catch {
    return false
  }
}

/** JSON 响应（含统一信封）。 */
export function writeJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/** 成功信封。 */
export function writeOk(res, value) {
  writeJson(res, 200, { ok: true, value })
}

/** 失败信封（`error.code` 是稳定错误码，前端按码分支）。 */
export function writeError(res, code, message, status = 400) {
  writeJson(res, status, { ok: false, error: { code, message } })
}

/** 有上限的 JSON body 读取（默认 1 MiB）。 */
export async function readJsonBody(req, maxBytes = 1 << 20) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk)
    total += buffer.length
    if (total > maxBytes) throw Object.assign(new Error('request body too large'), { code: 'too-large', status: 413 })
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text)
  } catch {
    throw Object.assign(new Error('request body is not valid JSON'), { code: 'bad-request', status: 400 })
  }
}
