#!/usr/bin/env node
/**
 * verify-client-css.mjs —— 前端用到的 class 必须在注入的 CSS 里有定义。
 *
 * 手写 bundle 没有构建期检查，className 打错字只会「样式悄悄失效」，肉眼很难发现。
 * 这里把所有 `dts-*` 字面量抽出来，逐一对 CSS 数组文本做存在性检查。
 *
 *   node tools/verify-client-css.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = readFileSync(path.join(here, '..', 'lib', 'client.js'), 'utf8')

// CSS 数组：从 `var CSS = [` 到 `].join('')`
const cssStart = source.indexOf('var CSS = [')
const cssEnd = source.indexOf("].join('')", cssStart)
if (cssStart < 0 || cssEnd < 0) {
  console.log('FAIL 未能定位 CSS 数组')
  process.exit(1)
}
const css = source.slice(cssStart, cssEnd)

// 用法侧：只看 className 所在行里的 dts- 字面量（name= / id= 之类不算样式）
// 同一行里的组合写法（'a b'、'a' + (cond ? ' b' : '')）都能覆盖。
const used = new Map()
for (const line of source.split('\n')) {
  if (!line.includes('className')) continue
  const literal = /'([^'\n]*)'/g
  let match
  while ((match = literal.exec(line)) !== null) {
    for (const token of match[1].split(/\s+/)) {
      if (!token.startsWith('dts-')) continue
      used.set(token, (used.get(token) || 0) + 1)
    }
  }
}

let pass = 0
let fail = 0
const missing = []

console.log('=== [1] 用到的 class 都有样式定义 ===')
for (const token of [...used.keys()].sort()) {
  // 选择器里出现 .token 且后面跟着 { , : 空格 或行尾（避免 dts-btn 命中 dts-btn-primary）
  const selector = new RegExp('\\.' + token.replace(/[-]/g, '\\-') + '(?![\\w-])')
  if (selector.test(css)) { pass += 1 } else { fail += 1; missing.push(token) }
}
console.log(`  检查 ${used.size} 个 class`)

console.log('\n=== [2] 关键新控件必须有样式（防止整块样式塌掉） ===')
for (const token of [
  'dts-title-in', 'dts-ta-lg', 'dts-grid2', 'dts-grid-freq', 'dts-meta-line',
  'dts-swatches', 'dts-swatch', 'dts-color', 'dts-dows', 'dts-dow', 'dts-chips', 'dts-chip-next',
  'dts-adv', 'dts-adv-body', 'dts-cronhelp', 'dts-legend', 'dts-code',
  'dts-inline', 'dts-inline-end', 'dts-row-between', 'dts-catpanel',
  'dts-foot', 'dts-foot-meta', 'dts-foot-actions', 'dts-btn-danger',
  'dts-dd', 'dts-dd-btn', 'dts-dd-menu', 'dts-dd-item', 'dts-dd-dot', 'dts-dd-text', 'dts-dd-caret',
]) {
  if (used.has(token) && new RegExp('\\.' + token + '(?![\\w-])').test(css)) pass += 1
  else { fail += 1; missing.push(token + '（关键控件缺失或未被使用）') }
}

console.log('\n=== [3] 交互态样式齐全（按钮/下拉的 hover、focus、禁用） ===')
for (const rule of [
  '.dts-input,.dts-textarea{', '.dts-input:focus', '.dts-input:hover',
  '.dts-radio input[type=checkbox]', '.dts-title-in{', '.dts-ta-lg{',
  '.dts-dd-btn{', '.dts-dd-btn:hover', '.dts-dd-btn.open', '.dts-dd-menu{', '.dts-dd-item:hover',
  '.dts-dd-item.on', '.dts-dd-text.empty', '.dts-dd-btn.open .dts-dd-caret',
  '.dts-meta-line{', '.dts-foot-actions{', '.dts-foot-meta{', '.dts-btn-danger{', '.dts-btn-danger:hover',
  '.dts-dow.on', '.dts-swatch.on', '.dts-seg button.on',
]) {
  if (css.includes(rule)) pass += 1
  else { fail += 1; missing.push('缺规则 ' + rule) }
}

console.log(`\n结果：${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log('问题项：')
  for (const name of missing) console.log(`  - ${name}`)
  process.exit(1)
}
