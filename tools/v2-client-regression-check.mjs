/** verifier-2 独立核验 #5 —— 前端 4 处回归的精确取证（只读，不改任何 lib 文件）
 *
 * 两种模式（与 tools/v2-client-pairing-check.mjs 对称）：
 *   默认（--pre-fix）：t10/t11/t13 落地**前**，断言「旧契约仍被引用」这一事实成立；
 *   --post-fix      ：t10/t11/t13 落地**后**，断言「新契约已生效」。
 *
 * 设计口径（避免实现相关指标造成误红，实现方已就此与我共识）：
 *   - **不**把 `requestWrite` 的出现次数当验收断言（那是实现相关指标，换方案会误红）；
 *   - 只断言**行为可观测**的事实：前端发出的 method/path（见 v2-client-pairing-check）、
 *     前端消费的响应字段、错误码表的键集合、以及 describeError 的分支条件。
 *
 * 用法：
 *   node tools/v2-client-regression-check.mjs            # = --pre-fix（当前基线应全绿）
 *   node tools/v2-client-regression-check.mjs --post-fix # t13/t11/t10 落地后应全绿
 */
import { readFileSync } from 'node:fs'

const postFix = process.argv.includes('--post-fix')
const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const lines = src.split(/\r?\n/)
/** 仅代码行（剔除整行注释），避免注释里的字样造成误红。 */
const codeLines = lines.filter(l => !/^\s*(\*|\/\*|\/\/)/.test(l))
const code = codeLines.join('\n')

let pass = 0
let fail = 0
const failures = []
function ok(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ok   ${name}`) }
  else { fail += 1; failures.push(name); console.log(`  FAIL ${name} ${detail}`) }
}
function hits(re) {
  const out = []
  lines.forEach((l, i) => { if (re.test(l)) out.push({ line: i + 1, text: l.trim() }) })
  return out
}
function show(label, re) {
  const found = hits(re)
  console.log(`\n[${label}] 命中 ${found.length} 处`)
  for (const h of found) console.log(`   ${h.line}: ${h.text.slice(0, 120)}`)
  return found
}
function lineOf(re) { const h = hits(re); return h.length > 0 ? h[0].line : null }

console.log(`模式：${postFix ? '--post-fix（断言新契约已生效）' : '--pre-fix（断言旧契约仍被引用，当前基线）'}`)

const rw = show('requestWrite 定义', /function requestWrite\(/)
const avail = show('value.available', /value\.available/)
const note = show('value.note', /value\.note/)
const errText = show('ERROR_TEXT 旧码键', /'(invalid-cron|storage-error|invalid-task)':/)
const frozenKeys = hits(/^\s*'([a-z-]+)':\s*'/)
const detailCond = show('describeError 详情透传条件', /code === '(invalid-cron|cron-invalid)'/)
const patchDelete = show('PATCH / DELETE 字面量', /'(PATCH|DELETE)'/)
const unavail = show("state: 'unavailable' 写入点", /state: 'unavailable'/)
const render = show('该警告的渲染点', /preview\.state === 'unavailable'/)
const staleDoc = hits(/\{next/)

if (!postFix) {
  // ── 落地前：旧契约仍被引用（当前的客观事实） ─────────────────────────────
  console.log('\n=== R-A 根因：requestWrite 硬编码 POST（仅作定位，不作验收计数） ===')
  ok('requestWrite 定义唯一', rw.length === 1, JSON.stringify(rw.map(h => h.line)))
  const rwBody = lines[rw.length > 0 ? rw[0].line : 0] ?? '' // 定义行的下一行（0-based → 定义行 index+1）
  ok("requestWrite 函数体硬编码 'POST'（定位用）", /requestOnce\('POST'/.test(rwBody), JSON.stringify(rwBody.trim()))
  ok('全文件尚无 PATCH / DELETE 字面量（旧契约）', patchDelete.length === 0, JSON.stringify(patchDelete.map(h => h.line)))

  console.log('\n=== R-1 CRUD：updateTask / deleteTask（旧契约） ===')
  const upd = hits(/updateTask: function/)
  const del = hits(/deleteTask: function/)
  ok("updateTask 现为 requestWrite(apiPath(id), …) ⇒ POST（应为 PATCH）", upd.length === 1 && /requestWrite\(apiPath\(id\),/.test(upd[0].text), JSON.stringify(upd))
  ok("deleteTask 现为 requestWrite(apiPath(id, '/delete')) ⇒ POST（应为 DELETE）", del.length === 1 && /'\/delete'/.test(del[0].text), JSON.stringify(del))
  console.log('   三个用户可见调用点：')
  for (const [name, re] of [['编辑器保存', /api\.updateTask\(task\.id, fields\)/], ['启用/停用开关', /api\.updateTask\(task\.id, \{ enabled/], ['软删除', /api\.deleteTask\(task\.id\)/]]) {
    const h = hits(re)
    console.log(`     ${name}: ${h.length === 1 ? h[0].line + ' 行' : JSON.stringify(h.map(x => x.line))}`)
  }
  ok('三个调用点各恰好 1 处', hits(/api\.updateTask\(/).length === 2 && hits(/api\.deleteTask\(/).length === 1)

  console.log('\n=== R-4 cron 预览判据读已废弃字段（旧契约） ===')
  ok('仍读 value.available（唯一判据点，第 853 行）', avail.length === 1 && avail[0].line === 853, JSON.stringify(avail.map(h => h.line)))
  ok('仍读 value.note（第 858 行）', note.length === 1 && note[0].line === 858, JSON.stringify(note.map(h => h.line)))
  ok("state:'unavailable' 写入点唯一（第 857 行）", unavail.length === 1 && unavail[0].line === 857, JSON.stringify(unavail.map(h => h.line)))
  ok('警告渲染点唯一（第 1067 行）', render.length === 1 && render[0].line === 1067, JSON.stringify(render.map(h => h.line)))
  ok('第 460 行 JSDoc 仍写 {next, available}', staleDoc.some(h => h.line === 460), JSON.stringify(staleDoc.map(h => h.line)))

  console.log('\n=== R-2 ERROR_TEXT / describeError（旧契约） ===')
  ok('ERROR_TEXT 仍有 3 个旧码键', errText.length === 3, JSON.stringify(errText.map(h => h.text.slice(0, 24))))
  const keys = frozenKeys.map(h => (/'([a-z-]+)'/.exec(h.text) ?? [])[1])
  ok('缺 cron-invalid 主键', !keys.includes('cron-invalid'), JSON.stringify(keys))
  ok('缺 storage 主键', !keys.includes('storage'), JSON.stringify(keys))
  ok("describeError 条件仍是 'invalid-cron'（应为 'cron-invalid'）", detailCond.length === 1 && /'invalid-cron'/.test(detailCond[0].text) && detailCond[0].line === 315, JSON.stringify(detailCond))
} else {
  // ── 落地后：新契约已生效 ────────────────────────────────────────────────
  console.log('\n=== 新契约断言（t13：CRUD 走 PATCH / DELETE） ===')
  ok('updateTask 不再使用 requestWrite(POST)', !/updateTask: function[^}]*requestWrite/.test(code), 'updateTask 仍走 requestWrite')
  ok('deleteTask 不再使用 requestWrite / 不再打 /delete 别名', !/deleteTask: function[^}]*requestWrite/.test(code) && !/'\/delete'/.test(code), 'deleteTask 仍打旧别名')
  ok("代码里已出现 'PATCH' 字面量", /'PATCH'/.test(code), '未找到')
  ok("代码里已出现 'DELETE' 字面量", /'DELETE'/.test(code), '未找到')

  console.log('\n=== 新契约断言（t11：cron 预览判据改 next） ===')
  ok('不再出现 value.available', !/value\.available/.test(code), '仍在读 available')
  ok('不再出现 value.note', !/value\.note/.test(code), '仍在读 note')
  ok('出现 Array.isArray(value.next) 判据', /Array\.isArray\(\s*value\.next\s*\)/.test(code), '未找到 next 数组判据')
  ok('不再出现误导文案「宿主尚未装载 cron 解析器」', !/宿主尚未装载 cron 解析器/.test(code), '误导文案仍在代码里')
  ok('第 460 行 JSDoc 已与 {cron, from, next} 对齐', !staleDoc.some(h => h.line === 460 && /available/.test(h.text)), JSON.stringify(staleDoc.map(h => h.line + ':' + h.text.slice(0, 40))))

  console.log('\n=== 新契约断言（t10：ERROR_TEXT 与 describeError） ===')
  const keys = frozenKeys.map(h => (/'([a-z-]+)'/.exec(h.text) ?? [])[1])
  const FROZEN = ['forbidden', 'method-error', 'not-found', 'too-large', 'bad-request', 'cron-invalid', 'storage', 'busy', 'runner-unavailable', 'conflict', 'paused', 'internal']
  const missing = FROZEN.filter(k => !keys.includes(k))
  ok('ERROR_TEXT 覆盖 §5 冻结的全部 12 个 wire 码', missing.length === 0, `缺 ${JSON.stringify(missing)}`)
  ok("describeError 条件已改为 'cron-invalid'", /code === 'cron-invalid'/.test(code), '未改成新码')
  ok("describeError 不再依赖旧码 'invalid-cron' 作分支条件", !/code === 'invalid-cron'/.test(code), '旧码条件仍在')
  console.log('   info t10 的「需要关注」徽标（判据 activeIds ∪ {failed,timeout}，skipped_overlap 不算）不做正则断言——'
    + 't15 里我改为**读实现**确认语义，并把结论写进报告，避免用脆弱的字面量匹配代替代码审查。')
}

console.log(`\n结果：${pass} passed, ${fail} failed（${postFix ? '--post-fix' : '--pre-fix'}）`)
if (failures.length > 0) console.log('失败项：\n  - ' + failures.join('\n  - '))
process.exit(fail === 0 ? 0 : 1)
