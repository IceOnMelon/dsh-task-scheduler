/** verifier-2 独立验证脚本 #4 —— $DSH_HOME 解析优先级与活性（只读探测 + 环境变量注入） */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'

import {
  probeHomePaths, resolveDshHome, dshHomePath, resolveDataRoot, activeBackend, __resetBackendProbe,
} from '../lib/dsh-home.mjs'

let pass = 0
let fail = 0
const failures = []
function ok(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ok   ${name}`) }
  else { fail += 1; failures.push(name); console.log(`  FAIL ${name} ${detail}`) }
}

const tmp = await mkdtemp(join(tmpdir(), 'v2-home-'))
const savedEnv = process.env.DSH_HOME
try {
  __resetBackendProbe()
  await probeHomePaths()
  console.log(`  info 实际走的解析后端：${activeBackend()}`)

  // 1) 默认：~/.dsh
  delete process.env.DSH_HOME
  const def = resolveDshHome()
  ok('未设置 $DSH_HOME 且无显式配置 → <home>/.dsh', def === join(homedir(), '.dsh'), def)

  // 2) $DSH_HOME 生效
  process.env.DSH_HOME = tmp
  const viaEnv = resolveDshHome()
  ok('$DSH_HOME 生效', viaEnv === tmp, `${viaEnv} vs ${tmp}`)
  const dataRoot = resolveDataRoot({})
  ok('数据根 = <$DSH_HOME>/dsh-task-scheduler', dataRoot === join(tmp, 'dsh-task-scheduler'), dataRoot)

  // 3) 空白 $DSH_HOME 视为未设置
  process.env.DSH_HOME = '   '
  const blank = resolveDshHome()
  ok('纯空白 $DSH_HOME 视为未设置（回落 ~/.dsh）', blank === join(homedir(), '.dsh'), blank)

  // 4) 显式配置优先于 $DSH_HOME
  process.env.DSH_HOME = join(tmp, 'from-env')
  const explicit = join(tmp, 'from-config')
  const viaConfig = resolveDshHome(explicit)
  ok('显式配置优先于 $DSH_HOME', viaConfig === explicit, `${viaConfig} vs ${explicit}`)

  // 5) ~ 展开
  delete process.env.DSH_HOME
  const tilde = resolveDshHome('~/custom-dsh')
  ok("'~' 展开为 <home>/custom-dsh", tilde === join(homedir(), 'custom-dsh'), tilde)

  // 6) resolveDataRoot({ home }) 是否尊重 home（spec §11.4：显式配置 > $DSH_HOME）
  process.env.DSH_HOME = join(tmp, 'from-env')
  const withHome = resolveDataRoot({ home: join(tmp, 'explicit-home') })
  ok('resolveDataRoot({home}) 尊重显式 home（应 = explicit-home/dsh-task-scheduler）',
    withHome === join(tmp, 'explicit-home', 'dsh-task-scheduler'),
    `${withHome}（实际走了 $DSH_HOME：${withHome === join(tmp, 'from-env', 'dsh-task-scheduler')}）`)

  // 7) 显式 dataRoot 最高优先
  const direct = resolveDataRoot({ dataRoot: join(tmp, 'direct'), home: join(tmp, 'explicit-home') })
  ok('显式 dataRoot 最高优先', direct === join(tmp, 'direct'), direct)

  // 8) dshHomePath 拼接
  ok('dshHomePath 拼接子段', dshHomePath('a', 'b') === join(resolveDshHome(), 'a', 'b'), dshHomePath('a', 'b'))
} finally {
  if (savedEnv === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = savedEnv
  await rm(tmp, { recursive: true, force: true })
}

console.log(`\n结果：${pass} passed, ${fail} failed`)
if (failures.length > 0) console.log('失败项：\n  - ' + failures.join('\n  - '))
process.exit(fail === 0 ? 0 : 1)
