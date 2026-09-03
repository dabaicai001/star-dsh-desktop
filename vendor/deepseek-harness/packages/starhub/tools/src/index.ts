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
    description: '在当前 SSH 会话中执行一条可自行结束的非交互命令并返回输出。只读命令自动放行,写/风险命令会请求用户确认。MFA 堡垒机资产首次连接会自动弹出验证/选机器卡片,用户完成一次后会话复用,后续命令静默执行;不要为此调用 open_connection 打开窗口。',
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
  {
    toolName: 'ssh_session_status',
    description: '查询当前绑定资产 SSH 会话的状态(不触发连接):未连接 / 已连接 / 堡垒机已选中目标机器。用于在执行命令前判断是否会弹「选机器」卡片、命令是否静默执行;MFA 堡垒机资产首次连接会自动弹验证与选机器卡片,选中后会话复用,后续命令静默执行不弹窗。',
    parameters: {},
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
  // ── AI 浏览器(无痕独立窗口,Rust 主进程执行;用户全程可见 AI 操作)──
  {
    toolName: 'browser_open',
    description: '打开(或聚焦)无痕 AI 浏览器窗口:独立 Tauri 窗口,不共用主界面登录态,用户可全程观看 AI 操作。可选初始 URL(裸域名自动补 https://;只允许 http/https)。首次操作浏览器前必须先调用本工具。',
    parameters: {
      url: { type: 'string', description: '可选初始 URL,例如 "example.com" 或 "https://a.internal:8080"' },
    },
  },
  {
    toolName: 'browser_navigate',
    description: '在 AI 浏览器中导航到指定 URL(只允许 http/https;javascript:/file: 等伪协议会被拒绝)。导航后自动等待文档就绪并返回页面标题。',
    parameters: {
      url: { type: 'string', required: true, description: '目标 URL,例如 "https://example.com/login"' },
    },
  },
  {
    toolName: 'browser_back',
    description: 'AI 浏览器后退一页(history.back),自动等待文档就绪。',
    parameters: {},
  },
  {
    toolName: 'browser_forward',
    description: 'AI 浏览器前进一页(history.forward),自动等待文档就绪。',
    parameters: {},
  },
  {
    toolName: 'browser_reload',
    description: '刷新 AI 浏览器当前页面,自动等待文档就绪。',
    parameters: {},
  },
  {
    toolName: 'browser_state',
    description: '获取 AI 浏览器当前页面状态:url、标题、readyState、滚动位置。',
    parameters: {},
  },
  {
    toolName: 'browser_extract',
    description: '提取当前页面的结构化内容:所有可见可交互元素按 1..N 编号([id] <标签> "文本" 属性…,含 open Shadow DOM 与同源 iframe 递归),附正文文本。browser_click/browser_type 等按编号定位元素;页面任何变化(导航/点击/局部刷新)后必须重新 extract,旧编号会失效。',
    parameters: {
      max_chars: { type: 'number', description: '正文文本最大字符数,默认 6000,上限 20000' },
    },
  },
  {
    toolName: 'browser_click',
    description: '点击 browser_extract 输出的编号元素(链接/按钮/复选框等)。Windows 上优先走可信输入事件;元素失效会返回错误并要求重新 extract。',
    parameters: {
      id: { type: 'string', required: true, description: 'browser_extract 输出的元素编号(纯数字)' },
    },
  },
  {
    toolName: 'browser_type',
    description: '向编号输入框(input/textarea/contenteditable)输入文本,触发完整 input/change 事件链(兼容 React/Vue 受控组件)。Windows 上走可信输入管线。',
    parameters: {
      id: { type: 'string', required: true, description: 'browser_extract 输出的元素编号(纯数字)' },
      text: { type: 'string', required: true, description: '要输入的文本' },
      clear: { type: 'boolean', description: '输入前先清空现有内容,默认 false(追加)' },
    },
  },
  {
    toolName: 'browser_press_key',
    description: '向当前焦点元素按键:Enter/Tab/Escape/Backspace/Delete/方向键/Home/End/PageUp/PageDown/空格。常用于提交表单(聚焦输入框后按 Enter)。',
    parameters: {
      key: { type: 'string', required: true, description: '按键名,例如 "Enter"、"Tab"、"ArrowDown"' },
    },
  },
  {
    toolName: 'browser_select_option',
    description: '为编号 <select> 元素选择选项(按 option 的 value 或显示文本精确匹配);不匹配时返回可选值列表。',
    parameters: {
      id: { type: 'string', required: true, description: 'browser_extract 输出的元素编号(纯数字)' },
      value: { type: 'string', required: true, description: '目标选项的 value 或显示文本' },
    },
  },
  {
    toolName: 'browser_scroll',
    description: '滚动 AI 浏览器页面:up/down(按像素,默认 600)/top/bottom。返回滚动后位置与页面总高度。',
    parameters: {
      direction: { type: 'string', description: 'up / down / top / bottom,默认 down' },
      amount: { type: 'number', description: 'up/down 时的像素数,默认 600' },
    },
  },
  {
    toolName: 'browser_screenshot',
    description: '截取 AI 浏览器当前可视区域(PNG),保存到应用缓存目录并返回文件路径与大小。截图内容暂不回灌模型上下文(文本通道),用于留档与用户核对。',
    parameters: {},
  },
  {
    toolName: 'browser_eval',
    description: '在 AI 浏览器当前页面执行任意 JavaScript(函数体形态,末尾用 return 返回结果;支持 await,结果需可 JSON 序列化,输出截断至 8000 字符)。执行会写入审计日志,但不弹确认卡。优先使用 browser_extract/click/type 等结构化工具,只在它们不够用时才用本工具。',
    parameters: {
      expression: { type: 'string', required: true, description: 'JS 函数体,例如 "return document.querySelectorAll(\'img\').length;"' },
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
  // ── 沙箱桌面(Ubuntu 容器沙箱平台,设计 docs/superpowers/specs/2026-08-28-desktop-automation-design.md)──
  // 安全模型:desktop_create_sandbox 的一次确认 = 任务级授权(60 分钟),授权期内
  // 箱内截图/键鼠全自动放行(授权由宿主在执行点强制);desktop_exec 恒确认;
  // 用户接管直播 tab 期间写操作被拒(不撤销授权)。坐标 = 最近一次截图的物理像素,
  // 界面变化后必须重新 desktop_screenshot。
  {
    toolName: 'desktop_list_templates',
    description: '列出沙箱桌面的可用模板(名称/镜像是否已构建/创建时间)。',
    parameters: {},
  },
  {
    toolName: 'desktop_build_template',
    description: '构建模板镜像(首次约 5-15 分钟,之后层缓存秒级)。desktop_create_sandbox 报「镜像未构建」时先调它。会请求用户确认。若网络过慢导致超时,工具会返回落盘的 Dockerfile 路径与手工 docker build 命令——把命令转交用户执行,完成后重调本工具即命中缓存秒过。',
    parameters: {
      template: { type: 'string', required: true, description: '模板名(desktop_list_templates 返回)' },
    },
  },
  {
    toolName: 'desktop_create_sandbox',
    description: '从模板创建一次性 Ubuntu 桌面沙箱并启动。这一次确认即授予本次任务的沙箱内全部操作权限(任务级授权,60 分钟);沙箱画面对用户全程直播可见,任务结束应 desktop_destroy_sandbox 销毁。会请求用户确认。',
    parameters: {
      template: { type: 'string', description: '模板名,默认 ubuntu-desktop' },
      task: { type: 'string', description: '任务描述,展示在确认卡与直播 tab 上' },
    },
  },
  {
    toolName: 'desktop_sandbox_status',
    description: '查询沙箱状态;不带 sandboxId 时列出全部未销毁实例。',
    parameters: {
      sandboxId: { type: 'string', description: '沙箱 id,默认当前授权沙箱' },
    },
  },
  {
    toolName: 'desktop_pause_sandbox',
    description: '暂停沙箱(≈ E2B pause)。会请求用户确认。',
    parameters: { sandboxId: { type: 'string', description: '沙箱 id,默认当前授权沙箱' } },
  },
  {
    toolName: 'desktop_resume_sandbox',
    description: '恢复已暂停的沙箱。会请求用户确认。',
    parameters: { sandboxId: { type: 'string', description: '沙箱 id,默认当前授权沙箱' } },
  },
  {
    toolName: 'desktop_destroy_sandbox',
    description: '销毁沙箱实例(回放帧归档保留);任务完成后必须调用。会请求用户确认。',
    parameters: { sandboxId: { type: 'string', description: '沙箱 id,默认当前授权沙箱' } },
  },
  {
    toolName: 'desktop_commit_sandbox',
    description: '把沙箱当前状态(含登录态/已装软件)固化为新模板,下次从它创建的沙箱自带该状态。登录完成后推荐调用。会请求用户确认。超时(commit 大层较慢)时工具返回手工核对/执行 docker commit 的命令,照指引操作后重调即可。',
    parameters: {
      name: { type: 'string', required: true, description: '新模板名(小写字母/数字/中划线)' },
      sandboxId: { type: 'string', description: '沙箱 id,默认当前授权沙箱' },
    },
  },
  {
    toolName: 'desktop_sandbox_replay',
    description: '读取沙箱的操作回放帧(每次写操作前的自动截屏留档):动作 | 时间 | 截图路径。',
    parameters: {
      sandboxId: { type: 'string', required: true, description: '沙箱 id' },
      limit: { type: 'number', description: '返回帧数,默认 50,上限 500' },
    },
  },
  {
    toolName: 'desktop_screenshot',
    description: '截取沙箱屏幕(PNG 落盘返回路径);随后调用 read_image 读取即可看到画面。坐标类操作必须基于最近一次截图;界面变化后重新截图。',
    parameters: { sandboxId: { type: 'string', description: '沙箱 id,默认当前授权沙箱' } },
  },
  {
    toolName: 'desktop_list_windows',
    description: '列出沙箱内窗口(id | 几何 | 标题),供 desktop_focus_window 选目标。',
    parameters: { sandboxId: { type: 'string', description: '沙箱 id,默认当前授权沙箱' } },
  },
  {
    toolName: 'desktop_get_foreground_window',
    description: '查询沙箱内当前前台窗口(标题与 id)。',
    parameters: { sandboxId: { type: 'string', description: '沙箱 id,默认当前授权沙箱' } },
  },
  {
    toolName: 'desktop_focus_window',
    description: '聚焦沙箱内指定窗口(置前台)。用户接管中会被拒绝。',
    parameters: {
      windowId: { type: 'string', required: true, description: '窗口 id(desktop_list_windows 返回)' },
      sandboxId: { type: 'string', description: '沙箱 id,默认当前授权沙箱' },
    },
  },
  {
    toolName: 'desktop_click',
    description: '在沙箱屏幕坐标单击。坐标基于最近一次 desktop_screenshot 的物理像素。用户接管中会被拒绝。',
    parameters: {
      x: { type: 'number', required: true, description: '横坐标(物理像素)' },
      y: { type: 'number', required: true, description: '纵坐标(物理像素)' },
      button: { type: 'string', description: 'left(默认)/middle/right' },
      sandboxId: { type: 'string', description: '沙箱 id,默认当前授权沙箱' },
    },
  },
  {
    toolName: 'desktop_double_click',
    description: '在沙箱屏幕坐标双击(坐标约定同 desktop_click)。',
    parameters: {
      x: { type: 'number', required: true }, y: { type: 'number', required: true },
      sandboxId: { type: 'string', description: '沙箱 id,默认当前授权沙箱' },
    },
  },
  {
    toolName: 'desktop_move_mouse',
    description: '移动指针到坐标(hover 触发用),不点击。',
    parameters: {
      x: { type: 'number', required: true }, y: { type: 'number', required: true },
      sandboxId: { type: 'string', description: '沙箱 id,默认当前授权沙箱' },
    },
  },
  {
    toolName: 'desktop_scroll',
    description: '在坐标处滚动。amount 为像素量,内部换算为滚轮格数。',
    parameters: {
      x: { type: 'number', required: true }, y: { type: 'number', required: true },
      direction: { type: 'string', required: true, description: 'up/down/left/right' },
      amount: { type: 'number', description: '滚动像素量,默认 600' },
      sandboxId: { type: 'string', description: '沙箱 id,默认当前授权沙箱' },
    },
  },
  {
    toolName: 'desktop_drag',
    description: '从 (fromX,fromY) 拖拽到 (toX,toY)。',
    parameters: {
      fromX: { type: 'number', required: true }, fromY: { type: 'number', required: true },
      toX: { type: 'number', required: true }, toY: { type: 'number', required: true },
      sandboxId: { type: 'string', description: '沙箱 id,默认当前授权沙箱' },
    },
  },
  {
    toolName: 'desktop_type',
    description: '向沙箱当前焦点输入文本(支持 Unicode/中文)。密码等敏感内容应由用户接管输入(desktop_request_user_action),不要代输。文本内容不进审计。',
    parameters: {
      text: { type: 'string', required: true, description: '要输入的文本' },
      sandboxId: { type: 'string', description: '沙箱 id,默认当前授权沙箱' },
    },
  },
  {
    toolName: 'desktop_press_key',
    description: '按键:Enter/Tab/Escape/Backspace/Delete/方向键/Home/End/PageUp/PageDown/Space/F1-F24,组合键用 ctrl+s / ctrl+shift+s 语法。',
    parameters: {
      key: { type: 'string', required: true, description: '键名或组合键' },
      sandboxId: { type: 'string', description: '沙箱 id,默认当前授权沙箱' },
    },
  },
  {
    toolName: 'desktop_exec',
    description: '在沙箱内执行任意 shell 命令(装软件、启进程、查状态)。是沙箱与外界逻辑的交换口,每次调用都会请求用户确认。',
    parameters: {
      command: { type: 'string', required: true, description: 'shell 命令' },
      timeoutSec: { type: 'number', description: '超时秒数,默认 60,上限 600' },
      sandboxId: { type: 'string', description: '沙箱 id,默认当前授权沙箱' },
    },
  },
  {
    toolName: 'desktop_request_user_action',
    description: '请求用户在沙箱直播 tab 中人工完成操作(扫码登录、输密码、短信验证等)。message 会横幅展示给用户,用户完成后点「已完成」你即收到结果继续。不要代输密码。',
    parameters: {
      message: { type: 'string', required: true, description: '给用户看的操作指引,如「请用手机扫描沙箱屏幕上的二维码登录微信」' },
      timeoutSeconds: { type: 'number', description: '等待秒数,默认 300' },
    },
  },
  // ── Android 实体机(adb 直连真实设备;语义层在 Rust android 模块)──
  {
    toolName: 'android_list_devices',
    description: '列出 adb 可见的 Android 设备(serial/状态/型号)。状态 unauthorized = 手机上还没点「允许 USB 调试」;未发现设备时引导用户开开发者模式。只读。',
    parameters: {},
  },
  {
    toolName: 'android_connect',
    description: '连接(绑定)一台 Android 设备并建立任务级授权(60 分钟,本次确认即授予),之后该设备的全部操作自动放行。serial 可省略(仅一台就绪设备时自动选)。会探测型号/Android 版本/分辨率。没有 adb 时会返回安装引导——可用本机工具(pwsh/bash)代用户安装 platform-tools 后重试。',
    parameters: {
      serial: { type: 'string', description: '设备 serial(android_list_devices 返回);仅一台时可省略' },
      task: { type: 'string', description: '任务描述(记录用)' },
    },
  },
  {
    toolName: 'android_disconnect',
    description: '撤销当前会话的设备授权(不改动设备本身,不关闭直播窗口)。',
    parameters: {},
  },
  {
    toolName: 'android_device_status',
    description: '设备状态:型号/Android 版本/分辨率/当前前台 Activity/电量。',
    parameters: {
      serial: { type: 'string', description: '设备 serial,默认当前授权设备' },
    },
  },
  {
    toolName: 'android_replay',
    description: '读取设备的操作回放帧(每次写操作前的自动截屏留档):动作 | 时间 | 截图路径。',
    parameters: {
      serial: { type: 'string', description: '设备 serial,默认当前授权设备' },
      limit: { type: 'number', description: '返回帧数,默认 50,上限 500' },
    },
  },
  {
    toolName: 'android_wireless',
    description: '无线调试(Android 11+):配对(用户在手机 开发者选项 → 无线调试 → 使用配对码配对 上读出 IP:端口 和 6 位配对码)与/或连接(无线调试主页的端口)。完成后用 android_list_devices + android_connect 正常绑定。配对码只能用户从手机读取,不要编造。',
    parameters: {
      host: { type: 'string', required: true, description: '手机 IP(与电脑同网段)' },
      pairPort: { type: 'number', description: '配对端口(配对码页面显示)' },
      code: { type: 'string', description: '6 位配对码(配对时必填)' },
      connectPort: { type: 'number', description: '连接端口(无线调试主页显示)' },
    },
  },
  {
    toolName: 'android_screenshot',
    description: '截取设备屏幕(PNG)并返回本机文件路径;随后调用 read_image 读取即可看到画面。截图文件是设备物理分辨率(结果里注明,如 1200x2670,不同机型/横竖屏各不相同,以当次结果为准);read_image 展示给你的图可能被按比例缩小并注明 "multiply coordinates by k"——你在显示图上量到的坐标必须乘以 k 才是 android_tap 等坐标类工具要的物理像素;未注明缩放则直接用图上坐标。坐标类操作必须基于最近一次截图;界面变化后重新截图。',
    parameters: {
      serial: { type: 'string', description: '设备 serial,默认当前授权设备' },
    },
  },
  {
    toolName: 'android_current_app',
    description: '返回当前前台 App/Activity(mCurrentFocus)与分辨率。AI 据此知道「现在在哪个 App 的哪个页面」。',
    parameters: {
      serial: { type: 'string', description: '设备 serial,默认当前授权设备' },
    },
  },
  {
    toolName: 'android_ui_tree',
    description: '导出当前界面的无障碍节点树(uiautomator dump,shell 权限,不需要手机开无障碍服务),返回可点击/有文字元素清单:每项含中心点坐标(设备物理像素,可直接传给 android_tap)、文字、desc、resource-id、类名。定位可点元素优先用它——精确坐标,不用从截图估像素;截图(read_image)用于确认视觉效果,以及锁屏/安全页/游戏等无无障碍节点的画面(此时本工具返回空并提示回退截图)。',
    parameters: {
      serial: { type: 'string', description: '设备 serial,默认当前授权设备' },
      maxNodes: { type: 'number', description: '返回节点上限,默认 200,上限 500' },
    },
  },
  {
    toolName: 'android_tap',
    description: '在设备屏幕坐标点按。坐标为设备物理像素(= 最近一次 android_screenshot 原始文件的像素,分辨率以其结果注明为准);若 read_image 提示图被缩小(multiply coordinates by k),先把图上坐标乘以 k 再传入,不要直接传显示图坐标。用户在直播窗口接管中会被拒绝。',
    parameters: {
      x: { type: 'number', required: true, description: '横坐标(设备物理像素)' },
      y: { type: 'number', required: true, description: '纵坐标(设备物理像素)' },
      serial: { type: 'string', description: '设备 serial,默认当前授权设备' },
    },
  },
  {
    toolName: 'android_double_tap',
    description: '在设备屏幕坐标双击(坐标约定同 android_tap:设备物理像素,read_image 缩图坐标需先乘其提示的倍数)。',
    parameters: {
      x: { type: 'number', required: true, description: '横坐标(设备物理像素)' },
      y: { type: 'number', required: true, description: '纵坐标(设备物理像素)' },
      serial: { type: 'string', description: '设备 serial,默认当前授权设备' },
    },
  },
  {
    toolName: 'android_swipe',
    description: '从 (fromX,fromY) 滑动到 (toX,toY)(拖拽/手势通用;durationMs 控制时长,长按拖拽用大时长)。坐标约定同 android_tap:设备物理像素,read_image 缩图坐标需先乘其提示的倍数。',
    parameters: {
      fromX: { type: 'number', required: true, description: '起点横坐标' },
      fromY: { type: 'number', required: true, description: '起点纵坐标' },
      toX: { type: 'number', required: true, description: '终点横坐标' },
      toY: { type: 'number', required: true, description: '终点纵坐标' },
      durationMs: { type: 'number', description: '滑动时长毫秒,默认 300(50-5000)' },
      serial: { type: 'string', description: '设备 serial,默认当前授权设备' },
    },
  },
  {
    toolName: 'android_scroll',
    description: '滚动:direction(up/down/left/right,指内容滚动方向)+ 像素量(默认 600),以 (x,y) 为中心(默认屏幕中心)。坐标约定同 android_tap:设备物理像素,read_image 缩图坐标需先乘其提示的倍数。',
    parameters: {
      direction: { type: 'string', description: 'up/down/left/right,默认 down' },
      amount: { type: 'number', description: '滚动像素量,默认 600' },
      x: { type: 'number', description: '中心横坐标,默认屏幕中心' },
      y: { type: 'number', description: '中心纵坐标,默认屏幕中心' },
      serial: { type: 'string', description: '设备 serial,默认当前授权设备' },
    },
  },
  {
    toolName: 'android_type',
    description: '向设备当前焦点输入文本(ASCII 直输;中文等非 ASCII 需设备已装 ADBKeyBoard,未装会返回安装引导)。密码等敏感内容应请用户在手机上亲手输入(直播窗口接管),不要代输。文本内容不进审计。',
    parameters: {
      text: { type: 'string', required: true, description: '要输入的文本' },
      serial: { type: 'string', description: '设备 serial,默认当前授权设备' },
    },
  },
  {
    toolName: 'android_press_key',
    description: '按键:back/home/recents/enter/tab/space/delete/方向键(up/down/left/right)/center/volumeup/volumedown/power/wake/sleep/menu/search,单字母与数字直映射;不支持组合键(拆成多次调用)。',
    parameters: {
      key: { type: 'string', required: true, description: '键名,例如 "back"、"home"、"enter"' },
      serial: { type: 'string', description: '设备 serial,默认当前授权设备' },
    },
  },
  {
    toolName: 'android_launch_app',
    description: '按包名启动 App(如 com.tencent.mm)。不确定包名时先用 android_exec 执行 pm list packages 查找。',
    parameters: {
      package: { type: 'string', required: true, description: '应用包名' },
      serial: { type: 'string', description: '设备 serial,默认当前授权设备' },
    },
  },
  {
    toolName: 'android_open_live',
    description: '打开(或聚焦)设备的直播独立窗口:scrcpy H.264 实时画面(不可用时截图轮询兜底),窗口内可切换「接管」让用户亲手操作(接管期间你的写操作会被拒绝)。建议长时间任务开始时打开,方便用户围观。',
    parameters: {
      serial: { type: 'string', description: '设备 serial,默认当前授权设备' },
    },
  },
  {
    toolName: 'android_pull',
    description: '把设备上的文件/目录拉到本机目录(adb pull)。每次调用都会请求用户确认。',
    parameters: {
      remotePath: { type: 'string', required: true, description: '设备上的绝对路径,如 /sdcard/DCIM/xxx.jpg' },
      localDir: { type: 'string', required: true, description: '本机目标目录(须已存在)' },
      serial: { type: 'string', description: '设备 serial,默认当前授权设备' },
    },
  },
  {
    toolName: 'android_push',
    description: '把本机文件推送到设备目录(adb push;远端只允许 /sdcard、/data/local/tmp 之下)。每次调用都会请求用户确认。',
    parameters: {
      localPaths: { type: 'array', required: true, description: '本机文件路径列表(1-20 个)' },
      remoteDir: { type: 'string', required: true, description: '设备目标目录,如 /sdcard/Download' },
      serial: { type: 'string', description: '设备 serial,默认当前授权设备' },
    },
  },
  {
    toolName: 'android_exec',
    description: '在设备上执行任意 shell 命令(adb shell;查 App 状态、pm list packages、读取系统信息等)。真实设备上的任意命令,每次调用都会请求用户确认。',
    parameters: {
      command: { type: 'string', required: true, description: 'shell 命令' },
      timeoutSec: { type: 'number', description: '超时秒数,默认 60,上限 600' },
      serial: { type: 'string', description: '设备 serial,默认当前授权设备' },
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
      + '不该存:琐碎信息、可重新查到的知识、原始数据(日志/大段代码)、会话临时状态、任何密码/密钥/令牌。'
      + '写入 user/global(跨项目作用域)时:只属于当前项目的工作区目录的事实,必须在条目内标注项目名'
      + '(取工作区目录名,例如 "[starhub] 生产库在 10.0.0.5");跨项目通用的偏好/经验可不标注。'
      + '记忆功能未在「设置 → AI 助手」配置记忆模型时本工具不可用。',
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
      '打开(或聚焦)指定 StarHub 资产的连接窗口(SSH 终端/SFTP/数据库)。仅当用户明确要求「打开/查看窗口」时才调用;'
      + '执行命令/查询不需要开窗——AI 域工具会由后端静默建立连接,不再弹额外窗口。'
      + 'MFA 堡垒机资产首次连接会自动弹出验证/选机器卡片,不要因此调用本工具。非破坏性 UI 动作,不执行任何命令。',
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
      '打开(或聚焦)指定 StarHub 资产的 SSH 终端窗口。仅当用户明确要求打开终端观察时才调用;'
      + 'AI 执行命令不需要开终端窗口,连接由后端静默建立。'
      + '适合需要用户配合观察终端输出、或要在终端里执行交互式命令的场景;非破坏性 UI 动作,不执行任何命令。',
    parameters: {
      assetId: { type: 'string', required: true, description: '要聚焦的资产 id(可用 starhub_list_assets 查询)' },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      return callUiAction(getTransport(), exec, FOCUS_TOOL_METHOD, 'terminal', args.assetId)
    },
  }))
}
