const fs = require('fs')
const path = process.argv[2]
const t = fs.readFileSync(path, 'utf8')
const lines = t.split(/\r?\n/)
console.log('总行数', lines.length, '字符数', t.length)
console.log('--- 标题 ---')
lines.forEach((l, i) => { if (/^#{1,3} /.test(l)) console.log((i + 1) + ' ' + l) })
const fences = (t.match(/^```/gm) || []).length
console.log('代码围栏数（应为偶数）:', fences)
const bad = []
lines.forEach((l, i) => {
  if (/^\|/.test(l) === false) return
  const count = (l.match(/\|/g) || []).length
  if (count < 3) bad.push((i + 1) + ' 可疑表格行: ' + l.slice(0, 80))
})
console.log('可疑表格行:', bad.length === 0 ? '无' : '\n' + bad.join('\n'))
