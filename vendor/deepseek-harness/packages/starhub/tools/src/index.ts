/**
 * StarHub 宿主工具桥(内核替换 P1-4 起,Phase 2 扩展全域工具;StarHub 本地包,
 * 不在上游)。把 StarHub 能力注册为 dsh 模型工具;工具体不在 dsh 进程内执行,
 * 而是经 SDK stdio JSON-RPC 的双向 request(方法 `starhub/tool.execute`,参数
 * `{ sessionId, name, args }`,结果为模型可读文本)桥回 StarHub 主进程,
 * 再由主进程分发给拥有该会话的前端面板执行(SSH/DB/Redis/ES/Docker/Excel/MCP
 * 等域工具)或在 Rust 内直接执行(全局工具:list_capabilities / list_assets /
 * session_search / memory)。
 *
 * 确认语义:本包不做确认;`starhub-approval-bridge` 插件在 tools/pre-execute 上按
 * 只读/风险分级把调用升级为 ask,经 ctx.approval 桥到前端确认卡(方案 5.2)。
 * 依赖同组合的 sdk-jsonrpc-server 插件提供的 `sdk-transport` 服务
 * (StarHub 对 sdk/server 的本地补丁);缺失时加载即失败(fail loud)。
 *
 * @module @deepseek-ai/dsh-starhub-tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonRpcTransportPeer } from '@deepseek-ai/dsh-sdk-protocol'

export const name = 'starhub-tools'
export const inject = ['tools']

/** 桥方法名;宿主侧实现见 src-tauri/src/harness/(mod.rs 路由 + tools.rs 全局工具)。 */
const BRIDGE_METHOD = 'starhub/tool.execute'

/** UI 动作桥方法名(联动契约 §2.2 / M5);宿主侧实现见 src-tauri/src/harness/mod.rs。 */
const OPEN_ASSET_METHOD = 'starhub/open.asset'
const FOCUS_TOOL_METHOD = 'starhub/focus.tool'
const BIND_ASSET_METHOD = 'starhub/bind.asset'

/** 工具的规范输出:宿主返回的模型可读文本原样透传。 */
const TEXT_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: { type: 'string', required: true },
  },
} as const

type TextOutput = { text: string }

const renderText = (_args: never, value: TextOutput): { type: 'text'; text: string }[] => [
  { type: 'text', text: value.text },
]

const TEXT_OUTPUT = { schema: TEXT_OUTPUT_SCHEMA, render: renderText } as const

/**
 * 发起一次宿主工具调用。
 * @param transport - sdk-jsonrpc-server 暴露的 stdio transport。
 * @param exec - 工具运行上下文(取 agent 会话 id 路由到 owning 面板)。
 * @param toolName - StarHub 工具名。
 * @param args - 经 schema 校验后的模型参数。
 * @returns 宿主返回的文本结果;桥错误(宿主报错/进程断开)抛为工具失败。
 */
async function callHost(
  transport: JsonRpcTransportPeer,
  exec: ToolRunContext,
  toolName: string,
  args: object,
): Promise<TextOutput> {
  const sessionId = exec.agent?.session.id
  if (sessionId === undefined) {
    throw new Error(`starhub tool ${toolName} requires an agent session`)
  }
  const result = await transport.request(BRIDGE_METHOD, {
    sessionId: String(sessionId),
    name: toolName,
    args,
  })
  if (typeof result !== 'string') {
    throw new Error(`starhub host returned a non-string result for ${toolName}`)
  }
  return { text: result }
}

/**
 * 发起一次宿主 UI 动作调用(联动契约 §2.2 / M5:starhub/open.asset 与
 * starhub/focus.tool)。宿主 fire-and-forget 返回 `{ ok: true, action:
 * "opened"|"focused" }`,这里文本化为模型可读结果。
 * @param transport - sdk-jsonrpc-server 暴露的 stdio transport。
 * @param exec - 工具运行上下文(取 agent 会话 id)。
 * @param method - 宿主 RPC 方法名(open.asset / focus.tool)。
 * @param tool - 目标工具(open.asset 为 "auto",focus.tool 为具体工具名)。
 * @param assetId - 目标资产 id。
 * @returns 文本化结果;宿主返回非法结果(非 `{ok:true, action}`)抛为工具失败。
 */
async function callUiAction(
  transport: JsonRpcTransportPeer,
  exec: ToolRunContext,
  method: string,
  tool: string,
  assetId: string,
): Promise<TextOutput> {
  const sessionId = exec.agent?.session.id
  if (sessionId === undefined) {
    throw new Error(`starhub tool ${method} requires an agent session`)
  }
  const result: unknown = await transport.request(method, { assetId, tool, sessionId: String(sessionId) })
  const record = typeof result === 'object' && result !== null ? result as Record<string, unknown> : undefined
  const action = record?.action
  if (record?.ok !== true || (action !== 'opened' && action !== 'focused')) {
    throw new Error(`starhub host returned an invalid ${method} result for asset ${assetId}`)
  }
  return { text: `StarHub: asset ${assetId} ${action}` }
}

/**
 * Bind the current AI session to an asset without opening or focusing any UI.
 * @param transport - sdk-jsonrpc-server transport.
 * @param exec - tool run context providing the agent session id.
 * @param assetId - target asset id.
 * @returns a model-readable binding result.
 */
async function bindAssetContext(
  transport: JsonRpcTransportPeer,
  exec: ToolRunContext,
  assetId: string,
): Promise<TextOutput> {
  const sessionId = exec.agent?.session.id
  if (sessionId === undefined) {
    throw new Error(`starhub tool ${BIND_ASSET_METHOD} requires an agent session`)
  }
  const result: unknown = await transport.request(BIND_ASSET_METHOD, { assetId, sessionId: String(sessionId) })
  const record = typeof result === 'object' && result !== null ? result as Record<string, unknown> : undefined
  if (record?.ok !== true || record.action !== 'bound') {
    throw new Error(`starhub host returned an invalid ${BIND_ASSET_METHOD} result for asset ${assetId}`)
  }
  return { text: `StarHub: asset ${assetId} bound without opening a window` }
}

/** 参数 schema 的简写(与 defineTool 的 ParameterSchemaSpec 对齐)。 */
type Params = Record<string, unknown>

interface BridgedToolSpec {
  /** StarHub 工具名(桥参数 name 与注册名一致)。 */
  readonly toolName: string
  readonly description: string
  readonly parameters: Params
}

/**
 * 注册一个桥接工具:schema 在本包声明,执行统一走 callHost。
 * @param ctx - registrant context carrying the tool registry.
 * @param transport - sdk-jsonrpc-server 暴露的 stdio transport。
 * @param spec - 工具名/描述/参数 schema。
 */
function registerBridged(ctx: Context, getTransport: () => JsonRpcTransportPeer, spec: BridgedToolSpec): void {
  ctx.tools.register(defineTool({
    name: spec.toolName,
    description: spec.description,
    // 参数集在运行时按注册名分发,defineTool 的静态推断对桥接工具无增量价值。
    parameters: spec.parameters as never,
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      return callHost(getTransport(), exec, spec.toolName, args)
    },
  }))
}

/** 全域桥接工具清单(schema 移植自旧前端 src/utils/aiTools.ts 与 aiSftpTools.ts)。 */
const BRIDGED_TOOLS: readonly BridgedToolSpec[] = [
  // ── SSH(会话绑定 SSH 资产)──
  {
    toolName: 'ssh_exec',
    description: '在当前 SSH 会话中执行一条可自行结束的非交互命令并返回输出。只读命令自动放行,写/风险命令会请求用户确认。',
    parameters: {
      command: { type: 'string', required: true, description: '要执行的完整命令,例如 "ls -la /var/log"' },
    },
  },
  {
    toolName: 'ssh_exec_background',
    description: '把一条耗时较长(可能超过 10 秒)的命令写成脚本在远端 nohup 后台执行,立即返回 task_id,不阻塞终端;输出写入日志文件。适合安装、下载、编译、批量处理等场景。启动后必须调用 ssh_wait_task 轮询任务状态与日志。命令本身仍会经过风险确认。',
    parameters: {
      command: { type: 'string', required: true, description: '要后台执行的完整命令(可以是多行脚本)' },
    },
  },
  {
    toolName: 'ssh_wait_task',
    description: '查询 ssh_exec_background 启动的后台任务:内部最多等待 wait_seconds 秒(带 sleep 轮询),返回 [STATUS] RUNNING / FINISHED(含退出码) / NOT_FOUND 与日志尾部。返回 RUNNING 时稍后可再次调用继续等待。',
    parameters: {
      task_id: { type: 'string', required: true, description: 'ssh_exec_background 返回的 task_id' },
      wait_seconds: { type: 'number', description: '本次最多等待的秒数,1-55,默认 30' },
    },
  },
  // ── SFTP(复用会话绑定的 SSH 资产)──
  {
    toolName: 'sftp_list',
    description: '通过当前 SSH 连接列出远端目录内容,用于确认上传或下载路径。',
    parameters: {
      path: { type: 'string', required: true, description: '远端绝对目录路径,例如 /var/log' },
    },
  },
  {
    toolName: 'sftp_stat',
    description: '通过当前 SSH 连接查看一个远端文件或目录的大小、权限和修改时间。',
    parameters: {
      path: { type: 'string', required: true, description: '远端绝对路径' },
    },
  },
  {
    toolName: 'sftp_upload',
    description: '把一个或多个本机文件上传到当前 SSH 服务器。调用前会要求用户确认本机路径和远端目录。',
    parameters: {
      localPaths: { type: 'array', required: true, description: '本机文件的完整路径列表,最多 20 个', items: { type: 'string' } },
      remoteDir: { type: 'string', required: true, description: '远端目标目录的绝对路径' },
      speedLimit: { type: 'number', description: '可选速度限制(bytes/s),0 表示不限速' },
    },
  },
  {
    toolName: 'sftp_download',
    description: '把当前 SSH 服务器上的一个或多个文件下载到本机目录。调用前会要求用户确认远端路径和本机目录。',
    parameters: {
      remotePaths: { type: 'array', required: true, description: '远端文件的绝对路径列表,最多 20 个', items: { type: 'string' } },
      localDir: { type: 'string', required: true, description: '本机目标目录的完整路径' },
      speedLimit: { type: 'number', description: '可选速度限制(bytes/s),0 表示不限速' },
    },
  },
  // ── 数据库(会话绑定 DB 资产;写 SQL 会请求确认)──
  {
    toolName: 'db_query',
    description: '在当前数据库连接中执行一条 SQL。只读查询(SELECT/SHOW/DESCRIBE/EXPLAIN)自动放行,写操作(INSERT/UPDATE/DELETE/DDL)会请求用户确认;DROP/TRUNCATE 等高危语句必须人工确认。一次只发一条语句,大量数据查询请加 LIMIT。',
    parameters: {
      sql: { type: 'string', required: true, description: 'SQL 语句' },
    },
  },
  // ── Redis ──
  {
    toolName: 'redis_exec',
    description: '在当前 Redis 连接中执行一条命令。只读命令(GET/HGET/LRANGE/SMEMBERS/ZRANGE/SCAN/TYPE/TTL/INFO/DBSIZE 等)自动放行,写命令(SET/DEL/EXPIRE/RENAME/FLUSHDB 等)会请求用户确认。KEYS * 在生产环境禁止使用,请改用 SCAN。',
    parameters: {
      command: { type: 'string', required: true, description: 'Redis 命令,例如 "GET mykey" 或 "HGETALL user:1001"' },
    },
  },
  // ── Elasticsearch ──
  {
    toolName: 'es_list_indices',
    description: '列出 ES 集群中所有索引及其基本信息(文档数、大小、健康状态)',
    parameters: {},
  },
  {
    toolName: 'es_cluster_health',
    description: '获取 ES 集群健康状态(状态、节点数、分片数)',
    parameters: {},
  },
  {
    toolName: 'es_get_mapping',
    description: '获取指定索引的字段映射(mapping)定义',
    parameters: {
      index: { type: 'string', required: true, description: '索引名称' },
    },
  },
  {
    toolName: 'es_search',
    description: '在 ES 索引中执行搜索,使用 ES Query DSL(JSON 格式),返回匹配的文档',
    parameters: {
      index: { type: 'string', required: true, description: '索引名称,多个索引用逗号分隔' },
      query: { type: 'string', required: true, description: 'ES Query DSL JSON 字符串,例如 {"query":{"match_all":{}},"size":20}' },
      size: { type: 'string', description: '返回文档数,默认 20' },
      from: { type: 'string', description: '分页偏移,默认 0' },
    },
  },
  {
    toolName: 'es_get_document',
    description: '按 _id 获取单条文档',
    parameters: {
      index: { type: 'string', required: true, description: '索引名称' },
      id: { type: 'string', required: true, description: '文档 _id' },
    },
  },
  {
    toolName: 'es_count',
    description: '统计索引中的文档数量(支持 Query DSL 过滤)',
    parameters: {
      index: { type: 'string', required: true, description: '索引名称' },
      query: { type: 'string', description: '可选的 Query DSL JSON 过滤条件' },
    },
  },
  {
    toolName: 'es_index_document',
    description: '向索引写入一篇新文档(创建或替换),会请求用户确认',
    parameters: {
      index: { type: 'string', required: true, description: '索引名称' },
      id: { type: 'string', description: '文档 _id(可选,不填则自动生成)' },
      body: { type: 'string', required: true, description: '文档 JSON 字符串' },
    },
  },
  {
    toolName: 'es_delete_document',
    description: '按 _id 删除一篇文档,会请求用户确认',
    parameters: {
      index: { type: 'string', required: true, description: '索引名称' },
      id: { type: 'string', required: true, description: '文档 _id' },
    },
  },
  {
    toolName: 'es_delete_index',
    description: '删除整个索引(高危操作),必须经用户确认',
    parameters: {
      index: { type: 'string', required: true, description: '索引名称' },
    },
  },
  // ── Docker ──
  {
    toolName: 'docker_list_containers',
    description: '列出当前主机上的所有容器(包含运行中和已停止)',
    parameters: {
      all: { type: 'string', description: '是否包含已停止的容器,true/false,默认 true' },
    },
  },
  {
    toolName: 'docker_logs',
    description: '查看某个容器的日志',
    parameters: {
      container: { type: 'string', required: true, description: '容器 ID 或名称' },
      tail: { type: 'string', description: '查看最后多少行,默认 200' },
    },
  },
  {
    toolName: 'docker_inspect',
    description: '查看容器/镜像/网络的详细信息(JSON)',
    parameters: {
      target: { type: 'string', required: true, description: '容器 ID、镜像名或网络名' },
    },
  },
  {
    toolName: 'docker_exec',
    description: '在运行中的容器里执行一条命令。只读命令自动放行,写/风险命令会请求用户确认。',
    parameters: {
      container: { type: 'string', required: true, description: '容器 ID 或名称' },
      command: { type: 'string', required: true, description: '要执行的命令,例如 "ls /"' },
    },
  },
  // ── Excel(当前工作簿,前端执行)──
  {
    toolName: 'excel_get_context',
    description: '获取当前工作簿、活动 Sheet、列名、行数、选中单元格和筛选状态。',
    parameters: {},
  },
  {
    toolName: 'excel_write_range',
    description: '从指定数据行列开始批量写入二维区域。row 为 0-based 数据行索引,不含表头。',
    parameters: {
      row: { type: 'number', required: true, description: '起始 0-based 数据行索引,不含表头' },
      col: { type: 'number', required: true, description: '起始 0-based 列索引' },
      values: { type: 'array', required: true, description: '二维数组,每个内部数组代表一行' },
    },
  },
  {
    toolName: 'excel_fill_formula',
    description: '批量填充公式。formula 支持 {excelRow}、{row}、{colLetter} 占位符。',
    parameters: {
      startRow: { type: 'number', required: true, description: '起始 0-based 数据行索引,不含表头' },
      col: { type: 'number', required: true, description: '0-based 目标列索引' },
      rowCount: { type: 'number', required: true, description: '填充行数' },
      formula: { type: 'string', required: true, description: '公式模板,例如 =B{excelRow}*C{excelRow}' },
    },
  },
  {
    toolName: 'excel_read_range',
    description: '读取当前筛选视图中的一段数据。',
    parameters: {
      startRow: { type: 'number', description: '0-based 数据行索引,不含表头' },
      rowCount: { type: 'number', description: '读取多少行,默认 20' },
    },
  },
  {
    toolName: 'excel_set_headers',
    description: '重写当前工作表表头。headers 数组会写入第 1 行。',
    parameters: {
      headers: { type: 'array', required: true, description: '新的表头数组' },
    },
  },
  {
    toolName: 'excel_find_replace',
    description: '在当前工作表查找并替换文本。',
    parameters: {
      find: { type: 'string', required: true, description: '要查找的文本或正则' },
      replace: { type: 'string', required: true, description: '替换为' },
      matchCase: { type: 'boolean', description: '是否区分大小写' },
      entireCell: { type: 'boolean', description: '是否整格匹配' },
      useRegex: { type: 'boolean', description: '是否按正则表达式处理' },
    },
  },
  {
    toolName: 'excel_add_sheet',
    description: '新增一个 Sheet 并切换过去。',
    parameters: {
      sheetName: { type: 'string', required: true, description: 'Sheet 名称' },
    },
  },
  {
    toolName: 'excel_remove_sheet',
    description: '删除指定 Sheet。',
    parameters: {
      sheetName: { type: 'string', required: true, description: 'Sheet 名称' },
    },
  },
  {
    toolName: 'excel_rename_sheet',
    description: '重命名 Sheet。',
    parameters: {
      oldName: { type: 'string', required: true, description: '旧 Sheet 名称' },
      newName: { type: 'string', required: true, description: '新 Sheet 名称' },
    },
  },
  {
    toolName: 'excel_switch_sheet',
    description: '切换到指定 Sheet。',
    parameters: {
      sheetName: { type: 'string', required: true, description: 'Sheet 名称' },
    },
  },
  {
    toolName: 'excel_style_header',
    description: '为当前工作表第 1 行应用醒目的表头样式。CSV 中为 no-op。',
    parameters: {},
  },
  {
    toolName: 'excel_auto_filter',
    description: '为当前工作表已用区域写入 Excel 自动筛选。',
    parameters: {},
  },
  {
    toolName: 'excel_write_cell',
    description: '写入一个单元格。row 为 0-based 数据行索引,不含表头; col 为 0-based 列索引。',
    parameters: {
      row: { type: 'number', required: true, description: '0-based 数据行索引,不含表头' },
      col: { type: 'number', required: true, description: '0-based 列索引' },
      value: { type: 'string', required: true, description: '要写入的文本、数字或公式字符串' },
    },
  },
  {
    toolName: 'excel_insert_rows',
    description: '在指定数据行前插入行。',
    parameters: {
      row: { type: 'number', required: true, description: '0-based 数据行索引,在此行前插入' },
      count: { type: 'number', description: '插入行数,默认 1' },
    },
  },
  {
    toolName: 'excel_delete_rows',
    description: '删除指定数据行。',
    parameters: {
      row: { type: 'number', required: true, description: '0-based 数据行索引' },
      count: { type: 'number', description: '删除行数,默认 1' },
    },
  },
  {
    toolName: 'excel_insert_cols',
    description: '在指定列前插入列。',
    parameters: {
      col: { type: 'number', required: true, description: '0-based 列索引,在此列前插入' },
      count: { type: 'number', description: '插入列数,默认 1' },
    },
  },
  {
    toolName: 'excel_delete_cols',
    description: '删除指定列。',
    parameters: {
      col: { type: 'number', required: true, description: '0-based 列索引' },
      count: { type: 'number', description: '删除列数,默认 1' },
    },
  },
  {
    toolName: 'excel_sort',
    description: '按列排序当前工作表数据,表头保持不动。',
    parameters: {
      col: { type: 'number', required: true, description: '0-based 排序列索引' },
      descending: { type: 'boolean', description: 'true 为降序,false 为升序' },
    },
  },
  {
    toolName: 'excel_filter',
    description: '按指定列关键词筛选当前视图。col 为空表示全列搜索。',
    parameters: {
      text: { type: 'string', required: true, description: '筛选关键词' },
      col: { type: 'number', description: '0-based 列索引;不传则全列搜索' },
    },
  },
  {
    toolName: 'excel_clear_filter',
    description: '清除当前筛选。',
    parameters: {},
  },
  {
    toolName: 'excel_freeze',
    description: '设置冻结窗格。冻结表头 rows=1,冻结首列 cols=1,取消冻结 rows=0 cols=0。',
    parameters: {
      rows: { type: 'number', description: '要冻结的顶部行数' },
      cols: { type: 'number', description: '要冻结的左侧列数' },
    },
  },
  {
    toolName: 'excel_remove_duplicates',
    description: '删除重复数据行。',
    parameters: {},
  },
  {
    toolName: 'excel_dedup_to_sheet',
    description: '按指定列或当前选中列删除重复项,保留第一次出现的整行数据,并把结果写入新的 Sheet。',
    parameters: {
      columns: { type: 'array', description: '可选,0-based 列索引数组。不传则使用当前选中列/选区/单元格所在列。' },
    },
  },
  {
    toolName: 'excel_save',
    description: '保存当前文件。',
    parameters: {},
  },
  // ── MCP(设置里配置的外部 MCP server 工具)──
  {
    toolName: 'mcp_list',
    description: '列出设置中配置的 MCP server 及其工具清单。',
    parameters: {},
  },
  {
    toolName: 'mcp_call',
    description: '调用一个 MCP server 工具(外部进程,每次调用都会请求用户确认)。先用 mcp_list 查看可用的 server 与工具名。',
    parameters: {
      server: { type: 'string', required: true, description: 'MCP server 名(mcp_list 返回)' },
      tool: { type: 'string', required: true, description: '工具名(mcp_list 返回)' },
      arguments: { type: 'object', additionalProperties: true, description: '工具参数对象' },
    },
  },
  // ── 自定义 Skill 沉淀(前端执行,恒确认)──
  {
    toolName: 'skill_save',
    description: '把一套可复用的多步工作流程保存为自定义 Skill,出现在 设置 → AI → Skills 列表中并自动启用,之后所有同作用域会话都会遵循。同名 Skill 会被覆盖更新。该存:反复使用的多步流程、项目特定的操作手册、用户明确要求「记住这个做法」的套路;不该存:一次性任务、琐碎事实(事实用 memory 工具)。',
    parameters: {
      name: { type: 'string', required: true, description: 'Skill 名称,简短的动宾短语,如「MySQL 慢查询排查」' },
      description: { type: 'string', description: '一句话说明适用场景' },
      prompt: { type: 'string', required: true, description: 'Skill 正文:注入 system prompt 的具体指引,步骤化、可直接执行' },
      assetTypes: {
        type: 'array',
        items: { type: 'string', enum: ['ssh', 'db', 'docker', 'excel', 'local'] },
        description: '生效的宿主作用域,默认仅当前宿主;确需通用才传多个',
      },
    },
  },
]

/**
 * 注册 StarHub 工具:全域桥接工具 + 四个 Rust 侧全局工具
 * (starhub_list_capabilities / starhub_list_assets / session_search / memory)。
 * @param ctx - registrant context carrying the tool registry.
 */
export function apply(ctx: Context): void {
  // sdk-transport 是宿主私有服务名,不走 Context 接口声明合并,读取后窄化。
  // 延迟到每次调用时解析:web 组合里 sdk-jsonrpc-server 与 starhub-tools 各自
  // fiber 并行加载,启动期读可能取不到(服务尚未 provide);失败信息与组合缺失一致。
  const getTransport = (): JsonRpcTransportPeer => {
    const transport = ctx.get('sdk-transport') as JsonRpcTransportPeer | undefined
    if (!transport) {
      throw new Error('starhub-tools requires sdk-jsonrpc-server (sdk-transport service) in the same composition')
    }
    return transport
  }

  for (const spec of BRIDGED_TOOLS) {
    registerBridged(ctx, getTransport, spec)
  }

  ctx.tools.register(defineTool({
    name: 'starhub_list_capabilities',
    description: '列出 StarHub 可以进入的模块和功能,用于规划跨模块任务。',
    parameters: {},
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      return callHost(getTransport(), exec, 'starhub_list_capabilities', args)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'starhub_list_assets',
    description: '列出 StarHub 工作区资产(SSH / 数据库 / Docker / 本机 / Excel)。',
    parameters: {
      type: {
        type: 'string',
        enum: ['ssh', 'db', 'docker', 'local', 'excel'],
        description: '可选: ssh、db、docker、local 或 excel',
      },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      return callHost(getTransport(), exec, 'starhub_list_assets', args)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'session_search',
    description:
      '搜索 AI 助手的历史会话存档(FTS5 全文检索)。三种用法:1) 传 query 全文搜索所有历史会话,返回命中片段;'
      + '2) 传 conversation_id 浏览该会话消息;3) 传 conversation_id + before_rowid 向前翻页。',
    parameters: {
      query: { type: 'string', description: 'FTS5 搜索词,中文按字分词;多个词用空格(AND)或 OR 连接' },
      conversation_id: { type: 'string', description: '要浏览的会话 id(search 结果里返回)' },
      before_rowid: { type: 'number', description: '翻页:返回该 rowid 之前的消息' },
      limit: { type: 'number', description: '返回条数上限,默认 20' },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      return callHost(getTransport(), exec, 'session_search', args)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory',
    description:
      '管理长期记忆(跨会话持久)。三个动作:add 新增条目;replace 用 old_text 唯一子串定位并替换条目;'
      + 'remove 用 old_text 唯一子串删除条目。target:user=用户偏好与习惯;global=跨资产的通用环境事实与经验;'
      + 'asset=当前绑定资产的专属事实(如"这台是生产库,DDL 前必须备份");'
      + 'folder=当前工作区文件夹的专属事实(项目约定、构建方式、目录结构,按工作区独立)。'
      + '记忆内容会在以后的会话开始时就出现在你的上下文里。'
      + '该存:用户偏好、环境事实(系统/端口/拓扑)、用户纠正、项目约定、已完成的重要工作;'
      + '不该存:琐碎信息、可重新查到的知识、原始数据(日志/大段代码)、会话临时状态、任何密码/密钥/令牌。',
    parameters: {
      action: { type: 'string', required: true, enum: ['add', 'replace', 'remove'] },
      target: { type: 'string', required: true, enum: ['user', 'global', 'asset', 'folder'] },
      content: { type: 'string', description: 'add/replace 的新条目内容,信息密度要高,可多条事实合并成一条' },
      old_text: { type: 'string', description: 'replace/remove 用:能唯一定位目标条目的短子串' },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      // folder 目标:工作区文件夹独立记忆,scope 路径取会话 header.cwd
      // (Rust 桥不知道 web 会话的工作区,由这里解析后经 args.folder 传入)。
      if (args.target === 'folder') {
        const cwd = exec.agent?.session.header.cwd
        if (cwd === undefined) {
          return { text: '当前会话没有工作区文件夹,无法写入文件夹级记忆' }
        }
        return callHost(getTransport(), exec, 'memory', { ...args, folder: cwd })
      }
      return callHost(getTransport(), exec, 'memory', args)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'bind_asset_context',
    description:
      '只把当前 AI 会话绑定到指定 StarHub 资产,不打开、不聚焦任何窗口。'
      + '用于自动巡检、后台诊断等无需干扰当前界面的操作;绑定后可调用对应资产的域工具。',
    parameters: {
      assetId: { type: 'string', required: true, description: '要绑定的资产 id(可用 starhub_list_assets 查询)' },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      return bindAssetContext(getTransport(), exec, args.assetId)
    },
  }))

  // ── UI 动作(联动契约 §2.2 / M5:模型的手,非破坏性 UI 动作)──
  ctx.tools.register(defineTool({
    name: 'open_connection',
    description:
      '打开(或聚焦)指定 StarHub 资产的连接窗口(SSH 终端/SFTP/数据库),让后续操作有对应的工具界面。'
      + '适合「帮我看一下 xxx 的日志/状态/数据」这类需要打开对应资产界面的请求;非破坏性 UI 动作,不执行任何命令。',
    parameters: {
      assetId: { type: 'string', required: true, description: '要打开的资产 id(可用 starhub_list_assets 查询)' },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      return callUiAction(getTransport(), exec, OPEN_ASSET_METHOD, 'auto', args.assetId)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'focus_terminal',
    description:
      '打开(或聚焦)指定 StarHub 资产的 SSH 终端窗口。适合需要用户配合观察终端输出、'
      + '或要在终端里执行交互式命令的场景;非破坏性 UI 动作,不执行任何命令。',
    parameters: {
      assetId: { type: 'string', required: true, description: '要聚焦的资产 id(可用 starhub_list_assets 查询)' },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      return callUiAction(getTransport(), exec, FOCUS_TOOL_METHOD, 'terminal', args.assetId)
    },
  }))
}
