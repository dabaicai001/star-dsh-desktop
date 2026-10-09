/**
 * provisioning 的 patch 合并纯逻辑(去 Tauri 化 M4)。
 *
 * 单独成模块的理由:`cordis.patch.yml` 同时是 dsh 设置体系的落盘目标(GUI
 * 「通用 / 模型 / 权限」经 ConfigEditor 直接写它),所以 provisioning 只能按 id
 * **行级合并**受管行,绝不允许整体覆盖——后者会把用户设置全重置(v0.122.0
 * 回归,Rust 侧 `materialize_profile_patch` 同样的教训)。
 *
 * 也正因文件里可能有 `!!js` 表达式,不能 YAML 解析再序列化:逐行扫,命中受管
 * id 就把它原有的 `config:` 块(含其下所有更深缩进行)整块替换,其余字节原样
 * 保留。id 不存在则把整行块追加到末尾。
 *
 * 受管行有两种缩进层级,都要认:裸行(`- id: webserver`,顶层)与 insert 块里的
 * 行(`    - id: starhub-bridge`,4 空格)。合并时**保持原缩进**,否则会把
 * insert 块的结构改坏。
 *
 * @module scripts/lib/provision-patch
 */

/** 一行 `- id: <name>` 的缩进与 id。 */
const ID_LINE = /^([ ]*)- id: (\S+)[ \t]*$/

/**
 * 按 id 行级幂等合并 provisioning 行。
 * @param text - 现有 patch 文本(空串 = 首次物化)。
 * @param rows - 要写入的行:`{ id, config }`,config 是 YAML 文本块,每行相对
 *   `config:` 再缩进 2 空格(调用方给的是已含 4 空格起步的行)。
 * @returns 合并后的文本(以单个换行结尾)。
 */
export function mergePatchRows(text, rows) {
  const lines = text === '' ? [] : text.replace(/\r\n/g, '\n').split('\n')
  const managed = new Map(rows.map(row => [row.id, row]))
  const applied = new Set()
  const output = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    const match = ID_LINE.exec(line)
    const id = match?.[2]
    if (id === undefined || !managed.has(id)) {
      output.push(line)
      index += 1
      continue
    }
    const row = managed.get(id)
    const indent = match[1]
    applied.add(row.id)
    output.push(line)
    index += 1
    // 1. 行级属性(name/order/label/key)原样保留——它们在 id 行之下、config 之上
    while (index < lines.length
      && new RegExp(`^${indent} {2}(name|order|label|key):`).test(lines[index])) {
      output.push(lines[index])
      index += 1
    }
    // 2. 跳过旧的 config: 块(含其下所有更深缩进行)。必须先走这一步再写新块,
    //    否则每次合并都会在旧块后面再摞一个 config:(重跑不幂等的经典事故)。
    if (isConfigLine(lines[index] ?? '', indent)) {
      index += 1
      while (index < lines.length && isDeeper(lines[index], indent)) index += 1
    }
    // 3. 写新 config 块
    output.push(`${indent}  config:`)
    for (const configLine of splitConfig(row.config, indent)) output.push(configLine)
  }
  for (const row of rows) {
    if (applied.has(row.id)) continue
    output.push(`- id: ${row.id}`)
    output.push('  config:')
    for (const configLine of splitConfig(row.config, '')) output.push(configLine)
  }
  return `${output.join('\n').replace(/\n+$/, '')}\n`
}

/**
 * 构造 provisioning 自己负责的 `webserver` 行。
 *
 * 不取模板:端口/地址是本次调用的参数(模板里的 `port: 0` 只是文档性缺省),
 * 从模板取会让 `--port` / `--host` 静默失效。
 *
 * @param host - 监听地址。
 * @param port - 监听端口(0 = 内核分配)。
 * @returns 该行的 `{ id, config }`。
 */
export function webserverRow(host, port) {
  return { id: 'webserver', config: `    host: ${JSON.stringify(host)}\n    port: ${port}` }
}

/**
 * 该行是否属于某个 config 块(即比给定缩进**严格更深**)。
 *
 * 同级 `- id:` 行不算——它是下一个条目,config 块到它为止。这一条是全部合并
 * 正确性的关键:判宽了会把后续兄弟行吞掉,判窄了会留下旧 config 残行。
 */
function isDeeper(line, indent) {
  if (/^\s*$/.test(line)) return false
  return line.search(/\S/) > indent.length
}

/** 该行是否是某个 `- id:` 行之下的 `config:` 行(缩进只要更深就认)。 */
function isConfigLine(line, indent) {
  return isDeeper(line, indent) && /^[ ]*config:[ \t]*$/.test(line)
}

/**
 * 归一化 config 文本块:统一换行、去空行,并按行缩进重新对齐。
 *
 * `config:` 自身在 `id` 缩进 + 2,它的子行在 + 4。输入行来自模板(已是 +4 起步)
 * 或调用方手写(同样 +4),这里统一按目标缩进重排,避免不同来源的缩进打架。
 */
function splitConfig(config, indent) {
  const body = config.replace(/\r\n/g, '\n').split('\n').filter(line => line.trim() !== '')
  const target = `${indent}    `
  return body.map(line => {
    const stripped = line.replace(/^ {0,12}/, '')
    return target + stripped
  })
}

/**
 * 从渲染好的模板里抽出受管行。
 * @param rendered - 占位符已替换的 patch 文本。
 * @param managedIds - provisioning 负责维护的行 id。
 * @returns `{ id, config }` 列表(没有 config 块的行不进)。
 */
export function rowsFromTemplate(rendered, managedIds) {
  const lines = rendered.replace(/\r\n/g, '\n').split('\n')
  const rows = []
  for (let index = 0; index < lines.length; index += 1) {
    const match = ID_LINE.exec(lines[index])
    const id = match?.[2]
    if (id === undefined || !managedIds.includes(id)) continue
    const indent = match[1]
    // 行级属性(name/order/label/key)在 config 之前,先跳过
    let cursor = index + 1
    while (cursor < lines.length
      && new RegExp(`^${indent} {2}(name|order|label|key):`).test(lines[cursor])) {
      cursor += 1
    }
    const config = []
    if (isConfigLine(lines[cursor] ?? '', indent)) {
      cursor += 1
      while (cursor < lines.length && isDeeper(lines[cursor], indent)) {
        config.push(lines[cursor])
        cursor += 1
      }
    }
    if (config.length > 0) rows.push({ id, config: config.join('\n') })
  }
  return rows
}

/**
 * 校验 profile 名(与上游 `resolveProfileDir` 同款白名单)。
 * @param name - 候选 profile 名。
 * @returns 是否可接受。
 */
export function validProfileName(name) {
  return name !== '' && !name.includes('/') && !name.includes('\\')
    && name !== '.' && name !== '..' && name !== 'node_modules'
}
