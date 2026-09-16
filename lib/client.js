/**
 * dsh-task-scheduler —— 浏览器半侧（t5 交付物）
 *
 * 手写产物，**不使用打包工具、不使用 JSX**（一律 React.createElement）：
 *   - 平台模块只用 factory 的同步 require 获取（`require('react')`）；
 *   - 模块体只注册 factory，副作用（这里只有一次样式注入）在物化时运行；
 *   - 数据结构与放置方式完全照 `docs/api-contract.md`（宿主 t2）：
 *     数据一律走 `/dsh-task-scheduler/api`，前端不另存状态。
 *
 * 已锁定的侧边栏契约（docs/spec.md §10/§11，t1 侦察结论）：
 *   - `sidebar.panellist` 是 root 作用域 **list** 槽：
 *     `{ name, id, order, label }` + 图标组件，外壳以 `{ size, active }` 调用；
 *   - `main` 是 root 作用域 **keyed** 槽：`{ name: 'main', key }` + 面板组件，
 *     `key` 必须与上面的 `id` 同名，否则 `ctx.layout.selectPanel(id)` 抛错；
 *   - 注册一律包在 `ctx.slots.inject(槽名, () => ctx.slots.register(选项, 组件))` 里。
 *
 * 跳转会话（docs/spec.md §11.3）：`await ctx.sessions.refresh()` 之后
 * `ctx.uiWorkspace.openSession(sessionId)`。
 * 这两个服务用 `ctx.get()` 惰性获取：即使某个组合里没有提供方，面板也照常渲染
 * （只有「打开会话」按钮会给出明确提示），不会因为服务缺失而整个入口挂掉。
 *
 * 样式全部走 DSH 主题 CSS 变量（`--dsw-*` / `--ds-*`），无写死颜色；
 * 任务/分类里的颜色是**数据**（宿主返回的分类色），不是样式常量。
 */

window.__ModuleLoader__.load({
  id: 'dsh-task-scheduler',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    // ── 平台模块（只能用 factory 的同步 require） ───────────────────────────
    var reactModule = require('react')
    var React = reactModule && reactModule.default ? reactModule.default : reactModule
    var h = React && React.createElement
    if (typeof h !== 'function') {
      throw new Error('dsh-task-scheduler: 平台模块表未提供 react.createElement')
    }

    /** 取一个 react 能力（hook），缺失时抛出可读错误而不是 undefined 调用。 */
    function hook(name) {
      var fn = React[name]
      if (typeof fn !== 'function') {
        throw new Error('dsh-task-scheduler: 平台模块 react 未提供 ' + name)
      }
      return fn
    }
    function useState(initial) { return hook('useState')(initial) }
    function useEffect(effect, deps) { return hook('useEffect')(effect, deps) }
    function useRef(initial) { return hook('useRef')(initial) }

    // ── 常量：与宿主契约一字对应 ────────────────────────────────────────────
    var API_PREFIX = '/dsh-task-scheduler/api'
    /** 侧边栏入口 id；同时也是 `main` keyed 槽的 key（两者必须同名）。 */
    var PANEL_ID = 'task-scheduler'
    var PANEL_ORDER = 50
    /** 列表/状态轮询间隔（self-scheduling：前一次 settle 之后再排下一次）。 */
    var POLL_INTERVAL_MS = 5000
    /** 运行记录轮询间隔。 */
    var RUN_POLL_INTERVAL_MS = 3000
    var STYLE_TAG_ID = 'dsh-task-scheduler/styles.css'
    var DEFAULT_READ_TIMEOUT_MS = 10000

    /** 执行类型（spec §3）。 */
    var EXEC_KINDS = [
      { id: 'prompt', label: 'Prompt', hint: '到点在全新 Agent 会话里执行这段提示词' },
      { id: 'shell', label: 'shell', hint: '以工作区为目录执行这条命令，取退出码与输出' },
    ]
    /** 权限三档（spec §3/§7 + §11.2 的真实映射）。 */
    var PERMISSIONS = [
      { id: 'readonly', label: '只读', hint: '沙箱 read-only：任何写入都会被拒绝' },
      { id: 'workspace-write', label: '工作区内可写', hint: '沙箱 workspace-write：写入边界 = 该任务的工作区目录' },
      { id: 'full', label: '完全放行', hint: '沙箱 danger-full-access：不限制写入范围，谨慎使用' },
    ]
    /** 漏跑策略（spec §6）。 */
    var MISSED_POLICIES = [
      { id: 'latest', label: '只补最近一次', hint: '进程没跑时错过多个触发点，只补最近的那一次' },
      { id: 'all', label: '全部补跑', hint: '补跑最近 24 小时内错过的全部触发点（单次上限 25）' },
    ]
    /** 运行状态（spec §3 + 契约 §2.4 的 queued 扩展）。 */
    var STATUS_META = {
      queued: { label: '排队中', cls: 'dts-status-queued' },
      running: { label: '运行中', cls: 'dts-status-running' },
      ok: { label: '成功', cls: 'dts-status-ok' },
      failed: { label: '失败', cls: 'dts-status-failed' },
      timeout: { label: '超时', cls: 'dts-status-failed' },
      skipped_overlap: { label: '重叠跳过', cls: 'dts-status-warn' },
    }
    var STATUS_COLUMNS = ['running', 'queued', 'failed', 'timeout', 'skipped_overlap', 'ok', 'none']
    var TRIGGER_LABELS = {
      schedule: '定时',
      manual: '手动',
      retry: '失败重试',
      catchup: '漏跑补跑',
    }
    /** 界面上的策略提示（spec §6 的锁定策略，原样展示给用户）。 */
    var POLICY_HINTS = [
      '并发上限 3，超出排队（queued）',
      '单次运行超时 1 小时后终止并记 timeout',
      '失败后延迟 5 分钟在新会话重试 1 次，仍失败记 failed',
      '漏跑默认只补最近一次，可按任务切「全部补跑」',
      '上一轮仍在运行时本轮记 skipped_overlap，不启动新会话',
      '历史运行记录全部保留，不自动清理',
    ]
    /** cron 预设（点选），最后一项是「高级手写」。 */
    var CRON_PRESETS = [
      { label: '每天 09:00', expr: '0 9 * * *' },
      { label: '每天 18:00', expr: '0 18 * * *' },
      { label: '每 30 分钟', expr: '*/30 * * * *' },
      { label: '每小时整点', expr: '0 * * * *' },
      { label: '工作日 09:00', expr: '0 9 * * 1-5' },
      { label: '每周一 09:00', expr: '0 9 * * 1' },
      { label: '每月 1 日 09:00', expr: '0 9 1 * *' },
    ]
    /** 线上错误码 → 中文说明（docs/api-contract.md §5）。 */
    var ERROR_TEXT = {
      'bad-request': '请求参数不合法，请检查表单',
      // spec §5 冻结码（正式键）
      'cron-invalid': 'cron 表达式不合法（需要 5 段：分 时 日 月 周）',
      'storage': '宿主存储层出错（数据可能损坏）',
      'not-found': '对象不存在，可能已被删除',
      'method-error': '接口不支持该请求方法',
      'conflict': '冲突（id 前缀歧义或运行记录已结束）',
      'paused': '全局暂停中，已拒绝立即执行；请先关闭「全局暂停」',
      'forbidden': '宿主信任栅栏拒绝（403）',
      'too-large': '请求体超过 1 MiB 上限',
      'busy': '并发已满（上限 3），请稍后重试',
      'runner-unavailable': '宿主运行器尚未装载，无法执行',
      // 旧码仅作兼容别名（宿主已在信封层归一，正常不会出现）
      'invalid-task': '任务本身不可执行',
      'invalid-cron': 'cron 表达式不合法（需要 5 段：分 时 日 月 周）',
      'storage-error': '宿主存储层出错（数据可能损坏）',
      'internal': '宿主内部错误',
      network: '无法连接宿主（网络错误）',
      timeout: '请求超时',
      'bad-json': '宿主返回的不是合法 JSON',
      http: 'HTTP 错误',
    }

    // ── 样式：全部使用 DSH 主题变量，无写死颜色 ─────────────────────────────
    var CSS = [
      '.dts-root{display:flex;flex-direction:column;height:100%;min-height:0;box-sizing:border-box;',
      'background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary);',
      'font-family:var(--dsw-font-family,inherit);font-size:13px;line-height:1.5}',
      '.dts-root *{box-sizing:border-box}',
      '.dts-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 14px;',
      'border-bottom:1px solid var(--dsw-alias-border-l2);flex:none}',
      '.dts-title{font-size:14px;font-weight:600;margin-right:auto;white-space:nowrap}',
      '.dts-tabs{display:flex;gap:2px;background:var(--dsw-alias-bg-layer-2);border-radius:6px;padding:2px}',
      '.dts-tab{border:none;background:transparent;color:var(--dsw-alias-label-secondary);',
      'padding:4px 10px;border-radius:4px;cursor:pointer;font-size:12px;font-family:inherit}',
      '.dts-tab.dts-on{background:var(--dsw-alias-interactive-bg-active,var(--dsw-alias-bg-layer-3));',
      'color:var(--dsw-alias-label-primary)}',
      '.dts-btn{display:inline-flex;align-items:center;gap:4px;border:1px solid var(--dsw-alias-border-l3);',
      'background:var(--dsw-alias-button-tool-bar-fill,transparent);color:var(--dsw-alias-label-primary);',
      'border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer;font-family:inherit;white-space:nowrap}',
      '.dts-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.dts-btn:disabled{opacity:.5;cursor:not-allowed}',
      '.dts-btn-primary{border-color:transparent;background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary));',
      'color:var(--dsw-alias-label-primary-foreground)}',
      '.dts-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}',
      '.dts-btn-quiet{border-color:transparent;background:transparent;color:var(--dsw-alias-label-secondary)}',
      '.dts-btn-danger{color:var(--dsw-alias-state-error-primary)}',
      '.dts-btn-danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}',
      '.dts-hint{flex:none;padding:6px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);',
      'color:var(--dsw-alias-label-tertiary);font-size:12px}',
      '.dts-banner{margin:8px 14px 0;padding:6px 10px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);',
      'background:var(--dsw-alias-bg-layer-2);display:flex;gap:8px;align-items:flex-start}',
      '.dts-banner-error{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}',
      '.dts-banner-text{flex:1;min-width:0;word-break:break-word}',
      '.dts-body{flex:1;min-height:0;overflow:auto;padding:12px 14px}',
      '.dts-search{width:100%;max-width:320px}',
      '.dts-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px}',
      '.dts-switch{display:inline-flex;align-items:center;gap:6px;cursor:pointer;color:var(--dsw-alias-label-secondary);font-size:12px}',
      '.dts-empty{padding:28px 12px;text-align:center;color:var(--dsw-alias-label-tertiary)}',
      '.dts-list{display:flex;flex-direction:column;gap:8px}',
      '.dts-card{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;',
      'background:var(--dsw-alias-bg-layer-1);padding:10px 12px;display:flex;flex-direction:column;gap:6px;min-width:0}',
      '.dts-card-off{opacity:.6}',
      '.dts-card-top{display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap}',
      '.dts-card-title{font-weight:600;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}',
      '.dts-card-desc{color:var(--dsw-alias-label-secondary);font-size:12px;word-break:break-word}',
      '.dts-meta{display:flex;gap:12px;flex-wrap:wrap;color:var(--dsw-alias-label-tertiary);font-size:12px;min-width:0}',
      '.dts-meta span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}',
      '.dts-actions{display:flex;gap:6px;flex-wrap:wrap}',
      '.dts-dot{width:8px;height:8px;border-radius:50%;flex:none;background:currentColor}',
      '.dts-chip{display:inline-flex;align-items:center;gap:4px;padding:1px 6px;border-radius:4px;',
      'border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);font-size:11px;white-space:nowrap}',
      '.dts-status{font-size:11px;white-space:nowrap}',
      '.dts-status-ok{color:var(--dsw-alias-state-success-primary)}',
      '.dts-status-failed{color:var(--dsw-alias-state-error-primary)}',
      '.dts-status-warn{color:var(--dsw-alias-state-warn-primary)}',
      '.dts-status-running{color:var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary))}',
      '.dts-status-queued{color:var(--dsw-alias-label-tertiary)}',
      '.dts-board{display:flex;gap:10px;align-items:flex-start;overflow-x:auto;padding-bottom:8px}',
      '.dts-col{flex:0 0 260px;min-width:200px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;',
      'background:var(--dsw-alias-bg-layer-1);padding:8px;display:flex;flex-direction:column;gap:6px}',
      '.dts-col-head{display:flex;align-items:center;gap:6px;font-size:12px;font-weight:600;padding-bottom:4px;',
      'border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.dts-col-count{color:var(--dsw-alias-label-tertiary);font-weight:400}',
      '.dts-mask{position:fixed;inset:0;background:var(--dsw-alias-bg-mask-1);display:flex;align-items:center;',
      'justify-content:center;padding:20px;z-index:40}',
      '.dts-modal{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;',
      'box-shadow:var(--dsw-elevation-prominent);width:100%;max-width:720px;max-height:88vh;display:flex;flex-direction:column;overflow:hidden}',
      '.dts-modal-head{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l2)}',
      '.dts-modal-title{font-weight:600;margin-right:auto}',
      '.dts-modal-body{flex:1;min-height:0;overflow:auto;padding:12px 14px;display:flex;flex-direction:column;gap:12px}',
      '.dts-modal-foot{display:flex;gap:8px;justify-content:flex-end;padding:10px 14px;border-top:1px solid var(--dsw-alias-border-l2);flex-wrap:wrap}',
      '.dts-field{display:flex;flex-direction:column;gap:4px;min-width:0}',
      '.dts-field-label{font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.dts-field-hint{font-size:11px;color:var(--dsw-alias-label-tertiary)}',
      '.dts-grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px}',
      '.dts-input,.dts-select,.dts-textarea{border:1px solid var(--dsw-alias-border-l3);border-radius:6px;',
      'background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);padding:5px 8px;font-size:13px;',
      'font-family:inherit;width:100%;min-width:0}',
      '.dts-textarea{min-height:96px;resize:vertical;font-family:var(--dsw-font-markdown-code-font-family,var(--ds-font-family-code,monospace))}',
      '.dts-radio-row{display:flex;gap:12px;flex-wrap:wrap}',
      '.dts-radio{display:inline-flex;align-items:center;gap:5px;font-size:12px;cursor:pointer}',
      '.dts-pre{margin:0;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;',
      'padding:8px;font-family:var(--dsw-font-markdown-code-font-family,var(--ds-font-family-code,monospace));font-size:12px;',
      'white-space:pre-wrap;word-break:break-all;max-height:240px;overflow:auto;color:var(--dsw-alias-label-secondary)}',
      '.dts-run{border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-1)}',
      '.dts-run-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:6px 8px;cursor:pointer}',
      '.dts-run-body{padding:0 8px 8px;display:flex;flex-direction:column;gap:6px}',
      '.dts-next{display:flex;gap:8px;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.dts-warn{color:var(--dsw-alias-state-warn-label,var(--dsw-alias-state-warn-primary))}',
      '.dts-link{border:none;background:transparent;color:var(--dsw-alias-link);cursor:pointer;padding:0;font:inherit}',
      '.dts-kv{display:grid;grid-template-columns:max-content 1fr;gap:4px 10px;font-size:12px}',
      '.dts-kv dt{color:var(--dsw-alias-label-tertiary)}',
      '.dts-kv dd{margin:0;min-width:0;word-break:break-all}',
      '@media (max-width:560px){.dts-col{flex-basis:200px}.dts-head{padding:8px 10px}.dts-body{padding:10px}}',
    ].join('')

    /** 只在模块物化时注入一次样式（带 data-plugin-css 归属，HMR 会按它清理）。 */
    function injectStyles() {
      try {
        if (typeof document === 'undefined' || !document.head) return
        var selector = 'style[data-plugin-css=' + JSON.stringify(STYLE_TAG_ID) + ']'
        if (document.querySelector(selector) !== null) return
        var tag = document.createElement('style')
        tag.setAttribute('data-plugin', 'dsh-task-scheduler')
        tag.setAttribute('data-plugin-css', STYLE_TAG_ID)
        tag.textContent = CSS
        document.head.appendChild(tag)
      } catch (error) {
        // 样式注入失败不影响功能：面板仍可读，只是外观退化。
      }
    }
    injectStyles()

    // ── 工具函数 ───────────────────────────────────────────────────────────
    function pad2(value) { return value < 10 ? '0' + value : String(value) }

    /** ISO → 本地 `YYYY-MM-DD HH:mm`（无法解析时返回空串）。 */
    function fmtTime(iso) {
      if (typeof iso !== 'string' || iso === '') return ''
      var date = new Date(iso)
      if (isNaN(date.getTime())) return ''
      return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate())
        + ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes())
    }

    /** ISO → 本地 `YYYY-MM-DD HH:mm:ss`。 */
    function fmtTimeSec(iso) {
      var base = fmtTime(iso)
      if (base === '') return ''
      var date = new Date(iso)
      return base + ':' + pad2(date.getSeconds())
    }

    /** 相对时间（用于「下次运行」「上次运行」）。 */
    function fmtRelative(iso) {
      if (typeof iso !== 'string' || iso === '') return ''
      var date = new Date(iso)
      if (isNaN(date.getTime())) return ''
      var diff = date.getTime() - Date.now()
      var past = diff < 0
      var ms = Math.abs(diff)
      var text
      if (ms < 60000) text = '不到 1 分钟'
      else if (ms < 3600000) text = Math.round(ms / 60000) + ' 分钟'
      else if (ms < 86400000) text = Math.round(ms / 3600000) + ' 小时'
      else text = Math.round(ms / 86400000) + ' 天'
      if (text === '不到 1 分钟') return '刚刚'
      return past ? text + '前' : text + '后'
    }

    /** 目录末段（工作区显示用）。 */
    function basename(path) {
      if (typeof path !== 'string' || path.trim() === '') return ''
      var parts = path.replace(/[\\/]+$/, '').split(/[\\/]/)
      return parts[parts.length - 1] || path
    }

    function shorten(value, max) {
      if (typeof value !== 'string') return ''
      return value.length > max ? value.slice(0, max - 1) + '…' : value
    }

    function statusMeta(status) {
      return STATUS_META[status] || { label: status ? String(status) : '未运行', cls: 'dts-status-queued' }
    }

    function triggerLabel(trigger) { return TRIGGER_LABELS[trigger] || String(trigger || '') }

    /** 权限档位的中文名（界面上不直接暴露 `workspace-write` 这类内部枚举）。 */
    function permissionLabel(id) {
      for (var i = 0; i < PERMISSIONS.length; i += 1) {
        if (PERMISSIONS[i].id === id) return PERMISSIONS[i].label
      }
      return String(id || '')
    }

    function describeError(error) {
      if (error === null || error === undefined) return '未知错误'
      var code = error.code ? String(error.code) : ''
      var known = code !== '' ? ERROR_TEXT[code] : ''
      var detail = error.message ? String(error.message) : ''
      if (known) return (code === 'cron-invalid' || code === 'invalid-cron') && detail ? known + '（' + detail + '）' : known + '（' + code + '）'
      if (detail) return detail
      return '未知错误'
    }

    function categoryOf(categories, id) {
      for (var i = 0; i < categories.length; i += 1) {
        if (categories[i].id === id) return categories[i]
      }
      return { id: id, name: id || '未分类', color: '' }
    }

    /** 从主题变量里取一个十六进制颜色（分类色选择器的默认值，避免写死颜色）。 */
    function themeHex(fallbackColor) {
      try {
        if (typeof document === 'undefined' || !document.body) return fallbackColor || ''
        var raw = ''
        if (typeof getComputedStyle === 'function') {
          raw = String(getComputedStyle(document.body).getPropertyValue('--dsw-alias-brand-primary') || '').trim()
        }
        if (/^#[0-9a-f]{6}$/i.test(raw)) return raw.toLowerCase()
        var rgb = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(raw)
        if (rgb) {
          return '#' + [1, 2, 3].map(function (index) {
            var part = Number(rgb[index])
            return (part < 16 ? '0' : '') + part.toString(16)
          }).join('')
        }
      } catch (error) { /* 取不到就用兜底 */ }
      return fallbackColor || ''
    }

    // ── HTTP 封装（结构照 docs/snippets/client-api.js，方法名映射到真实路由） ──
    function TaskApiError(code, message, status) {
      var error = new Error(message)
      error.name = 'TaskApiError'
      error.code = code
      error.status = status === undefined ? 0 : status
      return error
    }

    function delay(ms) {
      return new Promise(function (resolve) { setTimeout(resolve, ms) })
    }

    function withTimeout(signal, timeoutMs) {
      if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
        var timeout = AbortSignal.timeout(timeoutMs)
        if (signal === undefined || signal === null) return timeout
        if (typeof AbortSignal.any === 'function') return AbortSignal.any([signal, timeout])
        return signal
      }
      return signal
    }

    async function readEnvelope(response) {
      var parsed = null
      try {
        parsed = await response.json()
      } catch (error) {
        parsed = null
      }
      if (!response.ok || parsed === null || parsed.ok !== true) {
        var code = (parsed && parsed.error && parsed.error.code) || 'http'
        var message = (parsed && parsed.error && parsed.error.message) || ('HTTP ' + response.status)
        throw TaskApiError(code, message, response.status)
      }
      return parsed.value
    }

    async function requestOnce(method, path, body, options) {
      var timeoutMs = (options && options.timeoutMs) || DEFAULT_READ_TIMEOUT_MS
      var signal = withTimeout(options && options.signal, timeoutMs)
      var init = { method: method, signal: signal, headers: {} }
      if (body !== null && body !== undefined) {
        init.headers['content-type'] = 'application/json'
        init.body = JSON.stringify(body)
      }
      var response
      try {
        response = await fetch(API_PREFIX + path, init)
      } catch (error) {
        var aborted = error && (error.name === 'AbortError' || error.name === 'TimeoutError')
        throw TaskApiError(
          aborted ? 'timeout' : 'network',
          aborted ? ('请求超时（' + timeoutMs + 'ms）') : (error instanceof Error ? error.message : String(error)),
        )
      }
      return readEnvelope(response)
    }

    /** 只读请求：只对网络层失败重试 1 次，4xx/5xx 不重试。 */
    async function requestRead(path, options) {
      var retries = options && options.retries !== undefined ? options.retries : 1
      var attempt = 0
      for (;;) {
        try {
          return await requestOnce('GET', path, null, options)
        } catch (error) {
          var transient = error && (error.code === 'network' || error.code === 'timeout')
          if (!transient || attempt >= retries) throw error
          attempt += 1
          await delay(150 * attempt)
        }
      }
    }

    /** 写请求：**永不自动重试**（避免重复创建 / 重复执行）。 */
    function requestWrite(path, body, options) {
      return requestOnce('POST', path, body === undefined ? {} : body, options)
    }

    function apiPath(id, suffix) {
      return '/tasks/' + encodeURIComponent(id) + (suffix || '')
    }

    var api = {
      /** GET /state —— 全局状态 + 分类表 + 统计。 */
      getState: function (options) { return requestRead('/state', options) },
      /** GET /tasks —— 任务列表（按 createdAt 降序）。 */
      listTasks: function (options) { return requestRead('/tasks', options) },
      /** POST /tasks —— 新建（body = Task 可写字段）。 */
      createTask: function (fields, options) { return requestWrite('/tasks', fields, options) },
      /** PATCH /tasks/:id —— 更新（spec §5 冻结路由；宿主**不**接受 POST 别名）。 */
      updateTask: function (id, patch, options) {
        return requestOnce('PATCH', apiPath(id), patch === undefined ? {} : patch, options)
      },
      /** DELETE /tasks/:id —— 软删除（历史运行记录保留；无 body，故传 null）。 */
      deleteTask: function (id, options) { return requestOnce('DELETE', apiPath(id), null, options) },
      /** POST /tasks/:id/run —— 立即执行，返回 { run }（可能是 running 或 queued）。 */
      runNow: function (id, options) { return requestWrite(apiPath(id, '/run'), {}, options) },
      /** GET /tasks/:id/runs —— 该任务的运行记录。 */
      listRuns: function (id, query, options) {
        var search = ''
        if (query) {
          var params = []
          if (query.limit !== undefined) params.push('limit=' + encodeURIComponent(String(query.limit)))
          if (query.offset !== undefined) params.push('offset=' + encodeURIComponent(String(query.offset)))
          if (query.status) params.push('status=' + encodeURIComponent(String(query.status)))
          search = params.length > 0 ? '?' + params.join('&') : ''
        }
        return requestRead(apiPath(id, '/runs') + search, options)
      },
      /** GET /tasks/:id/runs/:runId —— 单条运行记录，返回 { taskId, run }。 */
      getRun: function (id, runId, options) {
        return requestRead(apiPath(id, '/runs/' + encodeURIComponent(runId)), options)
      },
      /** POST /cron/preview —— {cron, from?} → {cron, from, next}（next = 未来 5 次 ISO）。 */
      previewCron: function (cron, from, options) {
        return requestWrite('/cron/preview', from ? { cron: cron, from: from } : { cron: cron }, options)
      },
      /** POST /state —— 全局暂停开关。 */
      setPaused: function (paused, options) { return requestWrite('/state', { paused: paused }, options) },
      /** GET /categories —— 分类表。 */
      getCategories: function (options) { return requestRead('/categories', options) },
      /** POST /categories —— 整表替换。 */
      setCategories: function (categories, options) {
        return requestWrite('/categories', { categories: categories }, options)
      },
      /**
       * 轮询一条运行记录直到它进入终态。
       * self-scheduling：前一次请求 settle 之后才排下一次，任何时刻至多一个在飞请求。
       * 返回终态记录；超出总时限返回 null。
       */
      pollRun: function (taskId, runId, onUpdate, options) {
        var intervalMs = (options && options.intervalMs) || RUN_POLL_INTERVAL_MS
        var totalMs = (options && options.timeoutMs) || (66 * 60 * 1000)
        var deadline = Date.now() + totalMs
        var signal = options && options.signal
        function step() {
          if (signal !== undefined && signal !== null && signal.aborted) return Promise.resolve(null)
          return api.getRun(taskId, runId, { signal: signal, timeoutMs: 8000 }).then(function (value) {
            var run = value && value.run ? value.run : null
            if (run !== null && typeof onUpdate === 'function') onUpdate(run)
            if (run !== null && run.status !== 'running' && run.status !== 'queued') return run
            if (Date.now() >= deadline) return null
            return delay(intervalMs).then(step)
          }, function () {
            if (Date.now() >= deadline) return null
            return delay(intervalMs).then(step)
          })
        }
        return step()
      },
    }

    // ── 侧边栏入口图标（外壳以 { size, active } 调用） ──────────────────────
    function TaskIcon(props) {
      var size = props && typeof props.size === 'number' ? props.size : 16
      var active = props && props.active === true
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: active ? 2 : 1.6,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        style: { display: 'block', opacity: active ? 1 : 0.9 },
        'aria-hidden': 'true',
        focusable: 'false',
      }, [
        h('circle', { key: 'c', cx: 12, cy: 13, r: 7 }),
        h('path', { key: 'h', d: 'M12 9.5 V13 l2.5 1.6' }),
        h('path', { key: 'l1', d: 'M5 3.5 L7.5 6' }),
        h('path', { key: 'l2', d: 'M19 3.5 L16.5 6' }),
      ])
    }

    /** 入口标签：字符串或函数（函数形式由外壳在语言变化时重新解析）。 */
    function panelLabel() {
      var lang = ''
      try {
        if (typeof document !== 'undefined' && document.documentElement) {
          lang = String(document.documentElement.getAttribute('lang') || '')
        }
      } catch (error) { lang = '' }
      if (lang === '') {
        try {
          if (typeof navigator !== 'undefined') {
            lang = String(navigator.language
              || (navigator.languages && navigator.languages.length > 0 ? navigator.languages[0] : '')
              || '')
          }
        } catch (error2) { lang = '' }
      }
      if (lang === '') return '定时任务'
      return /^zh/i.test(lang) ? '定时任务' : 'Tasks'
    }

    // ── 通用小部件 ─────────────────────────────────────────────────────────
    function StatusBadge(props) {
      var meta = statusMeta(props.status)
      return h('span', { className: 'dts-status ' + meta.cls }, meta.label)
    }

    function CategoryDot(props) {
      var category = props.category
      var color = category && category.color ? category.color : 'currentColor'
      return h('span', { className: 'dts-dot', style: { color: color }, title: category ? category.name : '' })
    }

    function Modal(props) {
      return h('div', {
        className: 'dts-mask',
        onMouseDown: function (event) { if (event.target === event.currentTarget && props.onClose) props.onClose() },
      }, h('div', { className: 'dts-modal', role: 'dialog', 'aria-label': props.title },
        h('div', { className: 'dts-modal-head' },
          h('div', { className: 'dts-modal-title' }, props.title),
          props.headExtra || null,
          h('button', { type: 'button', className: 'dts-btn dts-btn-quiet', onClick: props.onClose }, '关闭')),
        h('div', { className: 'dts-modal-body' }, props.children),
        props.footer ? h('div', { className: 'dts-modal-foot' }, props.footer) : null))
    }

    function Field(props) {
      return h('div', { className: 'dts-field' },
        h('div', { className: 'dts-field-label' }, props.label),
        props.children,
        props.hint ? h('div', { className: 'dts-field-hint' }, props.hint) : null)
    }

    function Banner(props) {
      var notice = props.notice
      if (!notice) return null
      var isError = notice.kind === 'error'
      return h('div', { className: 'dts-banner' + (isError ? ' dts-banner-error' : '') },
        h('div', { className: 'dts-banner-text' }, (isError ? '⚠️ ' : '') + notice.text),
        h('button', { type: 'button', className: 'dts-btn dts-btn-quiet', onClick: props.onDismiss }, '知道了'))
    }

    /**
     * 面板组件工厂：组件树闭包在 `ctx` 上（apply 只跑一次）。
     * @param {object} ctx - 客户端插件上下文。
     * @returns {Function} main keyed 槽的面板组件。
     */
    function createPanel(ctx) {
      /** 惰性取服务：缺失时返回 undefined 而不是抛错。 */
      function service(name) {
        try {
          if (typeof ctx.get === 'function') return ctx.get(name)
          return ctx[name]
        } catch (error) {
          return undefined
        }
      }

      /** 「打开会话」：先刷新会话列表，再用 uiWorkspace 做完整导航。 */
      function openSession(sessionId, notify) {
        var sessions = service('sessions')
        var uiWorkspace = service('uiWorkspace')
        if (typeof sessionId !== 'string' || sessionId === '') {
          notify({ kind: 'error', text: '该运行记录没有会话（shell 型任务或执行失败）' })
          return
        }
        if (sessions === undefined || typeof sessions.refresh !== 'function'
          || uiWorkspace === undefined || typeof uiWorkspace.openSession !== 'function') {
          notify({ kind: 'error', text: '当前客户端没有提供会话导航服务，无法跳转：' + sessionId })
          return
        }
        Promise.resolve(sessions.refresh())
          .then(function () { uiWorkspace.openSession(sessionId) })
          .catch(function (error) {
            notify({ kind: 'error', text: '跳转会话失败：' + describeError(error) + '（' + sessionId + '）' })
          })
      }

      // ── 运行记录列表（任务详情里用；自身按间隔轮询在跑的那几条） ──────────
      function RunsList(props) {
        var taskId = props.taskId
        var [runs, setRuns] = useState([])
        var [total, setTotal] = useState(0)
        var [loading, setLoading] = useState(true)
        var [error, setError] = useState(null)
        var [expanded, setExpanded] = useState({})
        var [reloadKey, setReloadKey] = useState(0)
        var alive = useRef(true)

        useEffect(function () {
          alive.current = true
          return function () { alive.current = false }
        }, [])

        useEffect(function () {
          var stopped = false
          var timer = null
          function tick() {
            api.listRuns(taskId, { limit: 20 }).then(function (value) {
              if (stopped || !alive.current) return
              setRuns(value.runs || [])
              setTotal(typeof value.total === 'number' ? value.total : (value.runs || []).length)
              setError(null)
              setLoading(false)
            }, function (err) {
              if (stopped || !alive.current) return
              setError(err)
              setLoading(false)
            }).then(function () {
              if (stopped || !alive.current) return
              timer = setTimeout(tick, RUN_POLL_INTERVAL_MS)
            })
          }
          tick()
          return function () { stopped = true; if (timer !== null) clearTimeout(timer) }
        }, [taskId, reloadKey])

        return h('div', { className: 'dts-field' },
          h('div', { className: 'dts-field-label' },
            '运行记录' + (total > 0 ? '（共 ' + total + ' 条，显示最近 ' + Math.min(total, runs.length) + ' 条）' : ''),
            ' ',
            h('button', {
              type: 'button',
              className: 'dts-link',
              onClick: function () { setLoading(true); setReloadKey(reloadKey + 1) },
            }, '刷新')),
          error ? h('div', { className: 'dts-banner dts-banner-error' },
            h('div', { className: 'dts-banner-text' }, describeError(error))) : null,
          loading ? h('div', { className: 'dts-empty' }, '加载运行记录…')
            : (runs.length === 0 ? h('div', { className: 'dts-empty' }, '还没有运行记录')
              : h('div', { className: 'dts-list' }, runs.map(function (run) {
                var open = expanded[run.runId] === true
                var duration = run.startedAt && run.endedAt
                  ? Math.max(0, Math.round((new Date(run.endedAt).getTime() - new Date(run.startedAt).getTime()) / 1000)) + 's'
                  : ''
                return h('div', { key: run.runId, className: 'dts-run' },
                  h('div', {
                    className: 'dts-run-head',
                    onClick: function () {
                      setExpanded(function (prev) {
                        var next = Object.assign({}, prev)
                        next[run.runId] = !open
                        return next
                      })
                    },
                  },
                    h('span', null, open ? '▾' : '▸'),
                    h(StatusBadge, { status: run.status }),
                    h('span', { className: 'dts-chip' }, '#' + String(run.attempt)),
                    h('span', { className: 'dts-chip' }, triggerLabel(run.trigger)),
                    h('span', { className: 'dts-meta' }, h('span', null,
                      fmtTimeSec(run.startedAt) + (duration ? ' · ' + duration : ''))),
                    run.summary ? h('span', { className: 'dts-card-desc' }, shorten(String(run.summary), 80)) : null),
                  open ? h('div', { className: 'dts-run-body' },
                    h('dl', { className: 'dts-kv' },
                      h('dt', null, '运行 id'), h('dd', null, run.runId),
                      h('dt', null, '结束时间'), h('dd', null, fmtTimeSec(run.endedAt) || '—'),
                      h('dt', null, '退出码'), h('dd', null, run.exitCode === null || run.exitCode === undefined ? '—' : String(run.exitCode)),
                      h('dt', null, '会话 id'), h('dd', null,
                        run.sessionId
                          ? h('span', null,
                            run.sessionId,
                            ' ',
                            h('button', {
                              type: 'button',
                              className: 'dts-link',
                              onClick: function () { openSession(run.sessionId, props.notify) },
                            }, '打开会话'))
                          : '—'),
                      h('dt', null, '日志文件'), h('dd', null, run.logFilePath || '—'),
                      h('dt', null, '错误码'), h('dd', null, run.errorCode || '—'),
                      h('dt', null, '计划时刻'), h('dd', null, fmtTimeSec(run.scheduledFor) || '—')),
                    h('div', { className: 'dts-field-label' }, '摘要'),
                    h('div', { className: 'dts-card-desc' }, run.summary ? String(run.summary) : '—'),
                    h('div', { className: 'dts-field-label' }, '输出尾部（最多末 200 行）'),
                    h('pre', { className: 'dts-pre' },
                      run.tailOutput && String(run.tailOutput).length > 0 ? String(run.tailOutput) : '（无输出）'))
                    : null)
              }))))
      }

      // ── 任务详情（含运行记录 + 打开会话） ────────────────────────────────
      function TaskDetail(props) {
        var task = props.task
        var category = categoryOf(props.categories, task.category)
        var permission = null
        for (var i = 0; i < PERMISSIONS.length; i += 1) {
          if (PERMISSIONS[i].id === task.permission) permission = PERMISSIONS[i]
        }
        var policy = null
        for (var j = 0; j < MISSED_POLICIES.length; j += 1) {
          if (MISSED_POLICIES[j].id === task.missedRunPolicy) policy = MISSED_POLICIES[j]
        }
        var latestSession = task.sessionIds && task.sessionIds.length > 0
          ? task.sessionIds[task.sessionIds.length - 1] : ''
        return h(Modal, {
          title: '任务详情',
          onClose: props.onClose,
          footer: [
            h('button', {
              key: 'run',
              type: 'button',
              className: 'dts-btn dts-btn-primary',
              disabled: props.running === true,
              onClick: function () { props.onRun(task) },
            }, props.running === true ? '执行中…' : '立即执行'),
            latestSession ? h('button', {
              key: 'open',
              type: 'button',
              className: 'dts-btn',
              onClick: function () { openSession(latestSession, props.notify) },
            }, '打开最近会话') : null,
            h('button', {
              key: 'edit',
              type: 'button',
              className: 'dts-btn',
              onClick: function () { props.onEdit(task) },
            }, '编辑'),
            h('button', {
              key: 'close',
              type: 'button',
              className: 'dts-btn dts-btn-quiet',
              onClick: props.onClose,
            }, '关闭'),
          ],
        },
        h('dl', { className: 'dts-kv' },
          h('dt', null, '标题'), h('dd', null, task.title),
          h('dt', null, '描述'), h('dd', null, task.description || '—'),
          h('dt', null, '执行类型'), h('dd', null,
            task.execKind === 'shell' ? 'shell（子进程）' : 'prompt（全新 Agent 会话）'),
          h('dt', null, task.execKind === 'shell' ? '命令' : 'Prompt'),
          h('dd', null, h('pre', { className: 'dts-pre' }, task.execKind === 'shell' ? (task.cmd || '') : (task.prompt || ''))),
          h('dt', null, '分类'), h('dd', null, category.name),
          h('dt', null, '工作区'), h('dd', null, task.workspaceCwd || '（沿用宿主默认）'),
          h('dt', null, 'cron'), h('dd', null, task.cron || '不定时'),
          h('dt', null, '启用'), h('dd', null, task.enabled ? '是' : '否'),
          h('dt', null, '权限档位'), h('dd', null, (permission ? permission.label : task.permission)
            + '（' + (permission ? permission.hint : '') + '）'),
          h('dt', null, '自动批准'), h('dd', null, task.autoApprove
            ? '开（策略保持 ask + 该会话专属的审批应答者返回 allowed-once；自动批准不等于忽略档位）'
            : '关（需要批准时会弹框）'),
          h('dt', null, '漏跑策略'), h('dd', null, policy ? policy.label + '（' + policy.hint + '）' : task.missedRunPolicy),
          h('dt', null, '下次运行'), h('dd', null, task.nextRunAt ? fmtTimeSec(task.nextRunAt) + '（' + fmtRelative(task.nextRunAt) + '）' : '—'),
          h('dt', null, '上次运行'), h('dd', null,
            task.lastRunAt ? fmtTimeSec(task.lastRunAt) + ' · ' + statusMeta(task.lastStatus).label : '—'),
          h('dt', null, '运行次数'), h('dd', null, String(task.runCount)),
          h('dt', null, '日志文件'), h('dd', null, task.logFilePath || '（默认 logs/<taskId>.log）'),
          h('dt', null, '通知文件'), h('dd', null, task.notifyFile || '（默认 notify/<taskId>.md）'),
          h('dt', null, '会话数'), h('dd', null,
            task.sessionIds && task.sessionIds.length > 0
              ? String(task.sessionIds.length) + ' 个（最近：' + latestSession + '）'
              : '—'),
          h('dt', null, '任务 id'), h('dd', null, task.id)),
        h('div', { className: 'dts-field-label' }, '策略提示：' + POLICY_HINTS.join('；')),
        h(RunsList, { taskId: task.id, notify: props.notify }))
      }

      // ── 任务编辑器 ──────────────────────────────────────────────────────
      function TaskEditor(props) {
        var task = props.task
        var categories = props.categories
        var [form, setForm] = useState(function () {
          return {
            title: task ? task.title : '',
            description: task ? task.description : '',
            execKind: task ? task.execKind : 'prompt',
            prompt: task ? task.prompt : '',
            cmd: task ? task.cmd : '',
            category: task ? task.category : (categories.length > 0 ? categories[0].id : 'other'),
            workspaceCwd: task ? task.workspaceCwd : '',
            cron: task ? task.cron : '',
            enabled: task ? task.enabled === true : true,
            permission: task ? task.permission : 'workspace-write',
            autoApprove: task ? task.autoApprove === true : false,
            missedRunPolicy: task ? task.missedRunPolicy : 'latest',
            logFilePath: task && task.logFilePath ? task.logFilePath : '',
            notifyFile: task && task.notifyFile ? task.notifyFile : '',
          }
        })
        var [preview, setPreview] = useState({ state: 'empty' })
        var [saving, setSaving] = useState(false)
        var [error, setError] = useState(null)
        var [showCategoryForm, setShowCategoryForm] = useState(false)
        var [newCategoryName, setNewCategoryName] = useState('')
        var [newCategoryColor, setNewCategoryColor] = useState(function () {
          return themeHex(categories.length > 0 ? categories[0].color : '')
        })

        function patch(partial) {
          setForm(function (prev) { return Object.assign({}, prev, partial) })
        }

        // cron 预览：输入稳定 350ms 后才请求（self-scheduling，一次一个在飞请求）。
        useEffect(function () {
          var stopped = false
          var timer = null
          var cron = String(form.cron || '').trim()
          if (cron === '') {
            setPreview({ state: 'empty' })
            return function () { stopped = true }
          }
          if (cron.split(/\s+/).length !== 5) {
            setPreview({ state: 'invalid', message: 'cron 需要 5 段：分 时 日 月 周' })
            return function () { stopped = true }
          }
          setPreview({ state: 'loading' })
          timer = setTimeout(function () {
            api.previewCron(cron).then(function (value) {
              if (stopped) return
              // 判据以宿主真实返回值 next 数组为准；available 只作未升级旧宿主的兼容兜底。
              var next = value && Array.isArray(value.next) ? value.next : null
              var legacyOk = value && value.available === true
              if (next !== null || legacyOk) {
                setPreview({ state: 'ok', next: next || [] })
              } else {
                setPreview({ state: 'invalid', message: '宿主未返回下次运行时间（响应缺少 next 数组）' })
              }
            }, function (err) {
              if (!stopped) setPreview({ state: 'invalid', message: describeError(err) })
            })
          }, 350)
          return function () { stopped = true; if (timer !== null) clearTimeout(timer) }
        }, [form.cron])

        function buildFields() {
          return {
            title: String(form.title || '').trim(),
            description: String(form.description || ''),
            execKind: form.execKind,
            prompt: form.execKind === 'prompt' ? String(form.prompt || '') : String(form.prompt || ''),
            cmd: String(form.cmd || ''),
            category: form.category,
            workspaceCwd: String(form.workspaceCwd || '').trim(),
            cron: String(form.cron || '').trim(),
            enabled: form.enabled === true,
            permission: form.permission,
            autoApprove: form.autoApprove === true,
            missedRunPolicy: form.missedRunPolicy,
            logFilePath: String(form.logFilePath || '').trim() === '' ? null : String(form.logFilePath).trim(),
            notifyFile: String(form.notifyFile || '').trim() === '' ? null : String(form.notifyFile).trim(),
          }
        }

        function validate(fields) {
          if (fields.execKind === 'prompt' && fields.prompt.trim() === '') return 'Prompt 型任务必须填写执行 Prompt'
          if (fields.execKind === 'shell' && fields.cmd.trim() === '') return 'shell 型任务必须填写命令'
          if (fields.cron !== '' && fields.cron.split(/\s+/).length !== 5) return 'cron 需要 5 段：分 时 日 月 周'
          return ''
        }

        function submit() {
          var fields = buildFields()
          var invalid = validate(fields)
          if (invalid !== '') { setError(invalid); return }
          setSaving(true)
          setError(null)
          var request = task
            ? api.updateTask(task.id, fields)
            : api.createTask(fields)
          request.then(function (value) {
            var saved = value && value.task ? value.task : null
            props.onSaved(saved, task ? 'upd' : 'created')
          }).catch(function (err) {
            setError(describeError(err))
          }).then(function () { setSaving(false) })
        }

        function addCategory() {
          var name = String(newCategoryName || '').trim()
          if (name === '') { setError('分类名称不能为空'); return }
          var color = String(newCategoryColor || '').trim()
          if (!/^#[0-9a-fA-F]{6}$/.test(color) && !/^#[0-9a-fA-F]{3}$/.test(color)) {
            setError('分类颜色必须是 #RRGGBB 或 #RGB 形式')
            return
          }
          var next = categories.map(function (item) {
            return { id: item.id, name: item.name, color: item.color }
          })
          next.push({ name: name, color: color })
          setSaving(true)
          setError(null)
          api.setCategories(next).then(function (value) {
            var list = value && value.categories ? value.categories : next
            props.onCategories(list)
            var created = list[list.length - 1]
            if (created && created.id) patch({ category: created.id })
            setShowCategoryForm(false)
            setNewCategoryName('')
          }).catch(function (err) {
            setError(describeError(err))
          }).then(function () { setSaving(false) })
        }

        var cronIsPreset = false
        for (var p = 0; p < CRON_PRESETS.length; p += 1) {
          if (CRON_PRESETS[p].expr === form.cron) cronIsPreset = true
        }

        return h(Modal, {
          title: task ? '编辑任务' : '新建任务',
          onClose: props.onClose,
          footer: [
            h('button', {
              key: 'save',
              type: 'button',
              className: 'dts-btn dts-btn-primary',
              disabled: saving,
              onClick: submit,
            }, saving ? '保存中…' : '保存'),
            h('button', {
              key: 'cancel',
              type: 'button',
              className: 'dts-btn dts-btn-quiet',
              onClick: props.onClose,
            }, '取消'),
          ],
        },
        error ? h('div', { className: 'dts-banner dts-banner-error' },
          h('div', { className: 'dts-banner-text' }, error)) : null,
        h(Field, { label: '标题（留空则按执行内容自动派生）' },
          h('input', {
            className: 'dts-input',
            value: form.title,
            maxLength: 500,
            onChange: function (event) { patch({ title: event.target.value }) },
          })),
        h(Field, { label: '描述 / 备注' },
          h('textarea', {
            className: 'dts-textarea',
            value: form.description,
            onChange: function (event) { patch({ description: event.target.value }) },
          })),
        h(Field, { label: '执行类型', hint: 'Prompt 型会开一个全新 Agent 会话；shell 型跑子进程' },
          h('div', { className: 'dts-radio-row' }, EXEC_KINDS.map(function (kind) {
            return h('label', { key: kind.id, className: 'dts-radio', title: kind.hint },
              h('input', {
                type: 'radio',
                name: 'dts-execKind',
                checked: form.execKind === kind.id,
                onChange: function () { patch({ execKind: kind.id }) },
              }),
              kind.label)
          }))),
        h(Field, {
          label: form.execKind === 'shell' ? '命令（shell）' : '执行 Prompt',
          hint: form.execKind === 'shell'
            ? '以工作区为工作目录执行；退出码 0 = ok，非 0 = failed；完整输出写任务日志文件'
            : '作为新会话的首条用户消息；正常跑完 = ok，报错或超时 = failed',
        },
          h('textarea', {
            className: 'dts-textarea',
            value: form.execKind === 'shell' ? form.cmd : form.prompt,
            onChange: function (event) {
              if (form.execKind === 'shell') patch({ cmd: event.target.value })
              else patch({ prompt: event.target.value })
            },
          })),
        h('div', { className: 'dts-grid2' },
          h(Field, { label: '分类' },
            h('select', {
              className: 'dts-select',
              value: form.category,
              onChange: function (event) { patch({ category: event.target.value }) },
            }, categories.map(function (item) {
              return h('option', { key: item.id, value: item.id }, item.name + '（' + item.color + '）')
            })),
            h('div', null,
              h('button', {
                type: 'button',
                className: 'dts-link',
                onClick: function () { setShowCategoryForm(!showCategoryForm) },
              }, showCategoryForm ? '收起新分类' : '＋ 新建分类')),
            showCategoryForm ? h('div', { className: 'dts-grid2' },
              h('input', {
                className: 'dts-input',
                placeholder: '分类名称',
                value: newCategoryName,
                onChange: function (event) { setNewCategoryName(event.target.value) },
              }),
              h('input', {
                className: 'dts-input',
                type: 'color',
                value: newCategoryColor,
                onChange: function (event) { setNewCategoryColor(event.target.value) },
              }),
              h('button', {
                type: 'button',
                className: 'dts-btn',
                disabled: saving,
                onClick: addCategory,
              }, '添加分类（整表提交）')) : null),
          h(Field, { label: '工作区目录（绝对路径）', hint: 'Prompt 型会话的 cwd，也是 workspace-write 的写入边界' },
            h('input', {
              className: 'dts-input',
              value: form.workspaceCwd,
              placeholder: 'D:\\AI_agent\\work',
              onChange: function (event) { patch({ workspaceCwd: event.target.value }) },
            }))),
        h(Field, {
          label: 'cron（5 段：分 时 日 月 周，留空 = 不定时）',
          hint: '到点执行；漏跑按下面的策略补偿',
        },
          h('div', { className: 'dts-grid2' },
            h('select', {
              className: 'dts-select',
              value: cronIsPreset ? form.cron : '__custom__',
              onChange: function (event) {
                if (event.target.value === '__custom__') return
                patch({ cron: event.target.value })
              },
            }, CRON_PRESETS.map(function (preset) {
              return h('option', { key: preset.expr, value: preset.expr }, preset.label + '（' + preset.expr + '）')
            }).concat([h('option', { key: '__custom__', value: '__custom__' }, '高级手写 / 自定义')])),
            h('input', {
              className: 'dts-input',
              value: form.cron,
              placeholder: '0 9 * * *',
              onChange: function (event) { patch({ cron: event.target.value }) },
            })),
          h('div', { className: 'dts-next' },
            preview.state === 'empty' ? '未设置 cron，不会定时运行'
              : preview.state === 'loading' ? '正在预览下次运行时间…'
                : preview.state === 'invalid' ? h('span', { className: 'dts-warn' }, '⚠️ ' + preview.message)
                  : preview.state === 'unavailable' ? h('span', { className: 'dts-warn' }, '⚠️ ' + preview.message)
                    : h('span', null, '接下来 5 次：' + (preview.next || []).map(fmtTime).join('、')))),
        h('div', { className: 'dts-grid2' },
          h(Field, { label: '权限档位（逐任务）' },
            h('div', null, PERMISSIONS.map(function (item) {
              return h('label', { key: item.id, className: 'dts-radio', title: item.hint },
                h('input', {
                  type: 'radio',
                  name: 'dts-permission',
                  checked: form.permission === item.id,
                  onChange: function () { patch({ permission: item.id }) },
                }),
                item.label)
            })),
            h('div', { className: 'dts-field-hint' },
              (function () {
                for (var k = 0; k < PERMISSIONS.length; k += 1) {
                  if (PERMISSIONS[k].id === form.permission) return PERMISSIONS[k].hint
                }
                return ''
              })())),
          h(Field, {
            label: '自动批准工具调用',
            hint: '开启后审批策略保持 ask，并在该任务会话内注册专属应答者返回 allowed-once；'
              + '自动批准 ≠ 忽略档位，档位仍决定升权上限（宿主无 allow-always）',
          },
            h('label', { className: 'dts-radio' },
              h('input', {
                type: 'checkbox',
                checked: form.autoApprove === true,
                onChange: function (event) { patch({ autoApprove: event.target.checked }) },
              }),
              form.autoApprove ? '开（到点任务不弹批准框）' : '关（需要时弹批准框）'))),
        h(Field, { label: '漏跑策略' },
          h('div', null, MISSED_POLICIES.map(function (item) {
            return h('label', { key: item.id, className: 'dts-radio', title: item.hint },
              h('input', {
                type: 'radio',
                name: 'dts-missed',
                checked: form.missedRunPolicy === item.id,
                onChange: function () { patch({ missedRunPolicy: item.id }) },
              }),
              item.label)
          }))),
        h(Field, { label: '启用', hint: '停用后不再排期；历史记录保留' },
          h('label', { className: 'dts-radio' },
            h('input', {
              type: 'checkbox',
              checked: form.enabled === true,
              onChange: function (event) { patch({ enabled: event.target.checked }) },
            }),
            form.enabled ? '启用中' : '已停用')),
        h('div', { className: 'dts-grid2' },
          h(Field, { label: 'shell 日志文件（留空 = 默认 logs/<taskId>.log）' },
            h('input', {
              className: 'dts-input',
              value: form.logFilePath,
              onChange: function (event) { patch({ logFilePath: event.target.value }) },
            })),
          h(Field, { label: '通知文件（留空 = 默认 notify/<taskId>.md）' },
            h('input', {
              className: 'dts-input',
              value: form.notifyFile,
              onChange: function (event) { patch({ notifyFile: event.target.value }) },
            }))),
        h('div', { className: 'dts-field-label' }, '锁定策略：' + POLICY_HINTS.join('；')))
      }

      // ── 任务卡片（列表与看板共用） ───────────────────────────────────────
      function TaskCard(props) {
        var task = props.task
        var category = categoryOf(props.categories, task.category)
        var active = props.activeRun || null
        var running = task.lastStatus === 'running' || task.lastStatus === 'queued'
          || (active !== null && (active.status === 'running' || active.status === 'queued'))
        var nextText = task.enabled === false
          ? '已停用'
          : (task.cron === '' ? '不定时' : (task.nextRunAt ? fmtTime(task.nextRunAt) + '（' + fmtRelative(task.nextRunAt) + '）' : '待排期'))
        return h('div', { className: 'dts-card' + (task.enabled === false ? ' dts-card-off' : '') },
          h('div', { className: 'dts-card-top' },
            h(CategoryDot, { category: category }),
            h('div', { className: 'dts-card-title', title: task.title }, task.title),
            h('span', { className: 'dts-chip' }, category.name),
            h('span', { className: 'dts-chip' }, task.execKind === 'shell' ? 'shell' : 'prompt'),
            h('span', { className: 'dts-chip', title: '沙箱档位' }, permissionLabel(task.permission)),
            task.autoApprove ? h('span', { className: 'dts-chip' }, '自动批准') : null,
            running ? h('span', { className: 'dts-chip' }, active && active.status === 'queued' ? '排队中' : '运行中') : null),
          task.description ? h('div', { className: 'dts-card-desc' }, shorten(task.description, props.compact ? 60 : 160)) : null,
          h('div', { className: 'dts-meta' },
            h('span', { title: task.workspaceCwd || '沿用宿主默认' },
              '工作区：' + (task.workspaceCwd ? basename(task.workspaceCwd) : '宿主默认')),
            h('span', null, 'cron：' + (task.cron || '—')),
            h('span', null, '下次：' + nextText),
            h('span', null, '上次：' + (task.lastRunAt
              ? fmtTime(task.lastRunAt) + ' · ' + statusMeta(task.lastStatus).label
              : '—')),
            h('span', null, '运行次数：' + String(task.runCount))),
          h('div', { className: 'dts-actions' },
            h('button', {
              type: 'button',
              className: 'dts-btn dts-btn-primary',
              disabled: active !== null && (active.status === 'running' || active.status === 'queued'),
              onClick: function () { props.onRun(task) },
            }, active !== null && (active.status === 'running' || active.status === 'queued') ? '执行中…' : '立即执行'),
            h('button', {
              type: 'button',
              className: 'dts-btn',
              onClick: function () { props.onDetail(task) },
            }, '详情 / 运行记录'),
            h('button', {
              type: 'button',
              className: 'dts-btn',
              onClick: function () { props.onEdit(task) },
            }, '编辑'),
            h('button', {
              type: 'button',
              className: 'dts-btn',
              onClick: function () { props.onToggle(task) },
            }, task.enabled === false ? '启用' : '停用'),
            h('button', {
              type: 'button',
              className: 'dts-btn dts-btn-danger',
              onClick: function () { props.onDelete(task) },
            }, '删除')))
      }

      /** 看板分列：按分类或按状态。 */
      function groupTasks(tasks, categories, groupBy) {
        var columns = []
        var index = {}
        if (groupBy === 'status') {
          STATUS_COLUMNS.forEach(function (id) {
            var label = id === 'none' ? '未运行' : statusMeta(id).label
            columns.push({ id: id, label: label, color: '', tasks: [] })
          })
        } else {
          categories.forEach(function (item) {
            columns.push({ id: item.id, label: item.name, color: item.color, tasks: [] })
          })
          columns.push({ id: '__unknown__', label: '未分类', color: '', tasks: [] })
        }
        columns.forEach(function (column) { index[column.id] = column })
        tasks.forEach(function (task) {
          if (groupBy === 'status') {
            var key = task.lastStatus ? String(task.lastStatus) : 'none'
            if (!index[key]) key = 'none'
            index[key].tasks.push(task)
            return
          }
          var column = index[task.category]
          if (!column) column = index.__unknown__
          column.tasks.push(task)
        })
        if (groupBy === 'category') {
          // 分类列只显示有任务的那些；空分类不占版面。
          return columns.filter(function (column) { return column.tasks.length > 0 })
        }
        return columns
      }

      // ── 面板主体 ────────────────────────────────────────────────────────
      return function TaskPanel() {
        var [tasks, setTasks] = useState([])
        var [globalState, setGlobalState] = useState({
          paused: false, categories: [], updatedAt: null, taskCount: 0, runningCount: 0, queuedCount: 0,
        })
        var [loading, setLoading] = useState(true)
        var [error, setError] = useState(null)
        var [notice, setNotice] = useState(null)
        var [tab, setTab] = useState('list')
        var [groupBy, setGroupBy] = useState('category')
        var [query, setQuery] = useState('')
        var [activeRuns, setActiveRuns] = useState({})
        var [editing, setEditing] = useState(null)
        var [detailId, setDetailId] = useState(null)
        var [pausing, setPausing] = useState(false)
        var alive = useRef(true)

        useEffect(function () {
          alive.current = true
          return function () { alive.current = false }
        }, [])

        // 任务列表 + 全局状态：self-scheduling 轮询（前一次 settle 再排下一次）。
        useEffect(function () {
          var stopped = false
          var timer = null
          function tick() {
            Promise.all([api.getState(), api.listTasks()]).then(function (values) {
              if (stopped || !alive.current) return
              setGlobalState(values[0])
              setTasks(values[1].tasks || [])
              setError(null)
              setLoading(false)
            }, function (err) {
              if (stopped || !alive.current) return
              setError(err)
              setLoading(false)
            }).then(function () {
              if (stopped || !alive.current) return
              timer = setTimeout(tick, POLL_INTERVAL_MS)
            })
          }
          tick()
          return function () { stopped = true; if (timer !== null) clearTimeout(timer) }
        }, [])

        function notify(next) { setNotice(next) }

        function reload() {
          return Promise.all([api.getState(), api.listTasks()]).then(function (values) {
            setGlobalState(values[0])
            setTasks(values[1].tasks || [])
            setError(null)
          }, function (err) {
            setError(err)
          })
        }

        function setActiveRun(taskId, run) {
          setActiveRuns(function (prev) {
            var next = Object.assign({}, prev)
            if (run === null) delete next[taskId]
            else next[taskId] = run
            return next
          })
        }

        function submitRun(task) {
          setActiveRun(task.id, { status: 'running', runId: '' })
          api.runNow(task.id).then(function (value) {
            var run = value && value.run ? value.run : null
            if (run === null) {
              setActiveRun(task.id, null)
              notify({ kind: 'info', text: '已提交执行：' + task.title })
              return reload()
            }
            setActiveRun(task.id, run)
            notify({ kind: 'info', text: '已提交执行：' + task.title + '（' + statusMeta(run.status).label + '）' })
            return api.pollRun(task.id, run.runId, function (current) {
              setActiveRun(task.id, current)
            }).then(function (final) {
              setActiveRun(task.id, null)
              if (final === null) {
                notify({ kind: 'error', text: '「' + task.title + '」运行记录轮询超时，请点「详情 / 运行记录」查看' })
              } else {
                notify({
                  kind: final.status === 'ok' ? 'info' : 'error',
                  text: '「' + task.title + '」执行结束：' + statusMeta(final.status).label
                    + (final.summary ? ' — ' + final.summary : ''),
                })
              }
              return reload()
            })
          }, function (err) {
            setActiveRun(task.id, null)
            notify({ kind: 'error', text: describeError(err) })
          })
        }

        function toggleTask(task) {
          api.updateTask(task.id, { enabled: task.enabled !== true }).then(function () {
            notify({ kind: 'info', text: (task.enabled === true ? '已停用：' : '已启用：') + task.title })
            return reload()
          }, function (err) {
            notify({ kind: 'error', text: describeError(err) })
          })
        }

        function removeTask(task) {
          var confirmed = true
          try {
            if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
              confirmed = window.confirm('删除任务「' + task.title + '」？运行记录与通知文件会保留（软删除）。')
            }
          } catch (errorConfirm) { confirmed = true }
          if (confirmed !== true) return
          api.deleteTask(task.id).then(function () {
            notify({ kind: 'info', text: '已删除：' + task.title })
            return reload()
          }, function (err) {
            notify({ kind: 'error', text: describeError(err) })
          })
        }

        function togglePause() {
          var next = globalState.paused !== true
          setPausing(true)
          api.setPaused(next).then(function () {
            notify({ kind: 'info', text: next ? '已全局暂停：到点不再放行新运行' : '已恢复：调度继续' })
            return reload()
          }, function (err) {
            notify({ kind: 'error', text: describeError(err) })
          }).then(function () { setPausing(false) })
        }

        function onSaved(savedTask, mode) {
          setEditing(null)
          notify({ kind: 'info', text: mode === 'created' ? '任务已创建' : '任务已更新' })
          return reload()
        }

        function updateCategories(list) {
          setGlobalState(function (prev) { return Object.assign({}, prev, { categories: list }) })
        }

        var categories = globalState.categories || []
        var filtered = tasks.filter(function (task) {
          if (query.trim() === '') return true
          var needle = query.trim().toLowerCase()
          return [task.title, task.description, task.prompt, task.cmd, task.category]
            .some(function (value) { return typeof value === 'string' && value.toLowerCase().indexOf(needle) >= 0 })
        })
        var detailTask = null
        for (var d = 0; d < tasks.length; d += 1) {
          if (tasks[d].id === detailId) detailTask = tasks[d]
        }
        var columns = groupTasks(filtered, categories, groupBy)

        var cardProps = {
          categories: categories,
          onRun: submitRun,
          onEdit: function (task) { setDetailId(null); setEditing({ task: task }) },
          onDetail: function (task) { setDetailId(task.id) },
          onToggle: toggleTask,
          onDelete: removeTask,
        }

        return h('div', { className: 'dts-root' },
          h('div', { className: 'dts-head' },
            h('div', { className: 'dts-title' }, '定时任务'),
            h('div', { className: 'dts-tabs' },
              h('button', {
                type: 'button',
                className: 'dts-tab' + (tab === 'list' ? ' dts-on' : ''),
                onClick: function () { setTab('list') },
              }, '列表'),
              h('button', {
                type: 'button',
                className: 'dts-tab' + (tab === 'board' ? ' dts-on' : ''),
                onClick: function () { setTab('board') },
              }, '看板')),
            h('span', { className: 'dts-chip' }, '运行中 ' + String(globalState.runningCount || 0)
              + ' · 排队 ' + String(globalState.queuedCount || 0) + ' / 上限 3'),
            h('label', { className: 'dts-switch', title: '暂停后到点的任务不再放行新运行（已排期的仍会记录 skipped）' },
              h('input', {
                type: 'checkbox',
                checked: globalState.paused === true,
                disabled: pausing,
                onChange: togglePause,
              }),
              globalState.paused === true ? '全局冻结' : '调度中'),
            h('button', {
              type: 'button',
              className: 'dts-btn',
              onClick: function () { setLoading(true); reload().then(function () { setLoading(false) }) },
            }, '刷新'),
            h('button', {
              type: 'button',
              className: 'dts-btn dts-btn-primary',
              onClick: function () { setEditing({ task: null }) },
            }, '新建任务')),
          h('div', { className: 'dts-hint' }, '策略：' + POLICY_HINTS.slice(0, 5).join(' · ')),
          h(Banner, { notice: notice, onDismiss: function () { setNotice(null) } }),
          error ? h('div', { className: 'dts-banner dts-banner-error' },
            h('div', { className: 'dts-banner-text' }, '与宿主通信失败：' + describeError(error)),
            h('button', {
              type: 'button',
              className: 'dts-btn dts-btn-quiet',
              onClick: function () { setError(null); reload() },
            }, '重试')) : null,
          h('div', { className: 'dts-body' },
            h('div', { className: 'dts-toolbar' },
              h('input', {
                className: 'dts-input dts-search',
                placeholder: '搜索标题 / 描述 / Prompt / 命令 / 分类',
                value: query,
                onChange: function (event) { setQuery(event.target.value) },
              }),
              tab === 'board' ? h('div', { className: 'dts-tabs' },
                h('button', {
                  type: 'button',
                  className: 'dts-tab' + (groupBy === 'category' ? ' dts-on' : ''),
                  onClick: function () { setGroupBy('category') },
                }, '按分类分列'),
                h('button', {
                  type: 'button',
                  className: 'dts-tab' + (groupBy === 'status' ? ' dts-on' : ''),
                  onClick: function () { setGroupBy('status') },
                }, '按状态分列')) : null,
              h('span', { className: 'dts-meta' }, h('span', null, '共 ' + String(filtered.length) + ' 个任务'
                + (tasks.length !== filtered.length ? '（筛选自 ' + String(tasks.length) + ' 个）' : '')))),
            loading && tasks.length === 0
              ? h('div', { className: 'dts-empty' }, '正在读取任务…')
              : (tasks.length === 0
                ? h('div', { className: 'dts-empty' },
                  '还没有定时任务。点右上角「新建任务」，或用下面的模板快速开始：',
                  h('div', { className: 'dts-actions', style: { justifyContent: 'center', marginTop: '10px' } },
                    h('button', {
                      type: 'button',
                      className: 'dts-btn',
                      onClick: function () { setEditing({ task: null }) },
                    }, '新建任务')))
                : (filtered.length === 0
                  ? h('div', { className: 'dts-empty' }, '没有匹配的任务')
                  : (tab === 'list'
                    ? h('div', { className: 'dts-list' }, filtered.map(function (task) {
                      return h(TaskCard, Object.assign({ key: task.id, task: task, activeRun: activeRuns[task.id] || null }, cardProps))
                    }))
                    : h('div', { className: 'dts-board' }, columns.map(function (column) {
                      return h('div', { key: column.id, className: 'dts-col' },
                        h('div', { className: 'dts-col-head' },
                          column.color ? h(CategoryDot, { category: { color: column.color, name: column.label } }) : null,
                          column.label,
                          h('span', { className: 'dts-col-count' }, ' ' + String(column.tasks.length))),
                        column.tasks.length === 0
                          ? h('div', { className: 'dts-empty' }, '空')
                          : column.tasks.map(function (task) {
                            return h(TaskCard, Object.assign({
                              key: task.id, task: task, activeRun: activeRuns[task.id] || null, compact: true,
                            }, cardProps))
                          }))
                    })))))),
          editing ? h(TaskEditor, {
            task: editing.task,
            categories: categories,
            onClose: function () { setEditing(null) },
            onSaved: onSaved,
            onCategories: updateCategories,
          }) : null,
          detailTask ? h(TaskDetail, {
            task: detailTask,
            categories: categories,
            running: activeRuns[detailTask.id] !== undefined,
            onClose: function () { setDetailId(null) },
            onRun: submitRun,
            onEdit: function (task) { setDetailId(null); setEditing({ task: task }) },
            notify: notify,
          }) : null)
      }
    }

    // ── 插件体 ─────────────────────────────────────────────────────────────
    /** 至少需要 `slots`（侧边栏契约）。其余服务用 ctx.get 惰性取，缺失也不影响入口。 */
    var inject = ['slots']

    function apply(ctx) {
      var TaskPanel = createPanel(ctx)
      ctx.slots.inject('sidebar.panellist', function () {
        return ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: PANEL_ORDER,
          label: panelLabel,
        }, TaskIcon)
      })
      ctx.slots.inject('main', function () {
        return ctx.slots.register({ name: 'main', key: PANEL_ID }, TaskPanel)
      })
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
