# @deepseek-ai/dsh-starhub-commit-message

StarHub 本地 host 包(不在上游):会话头部 git 分支胶囊的「AI」按钮背后的 one-shot LLM 端点。

- 路由:在 dsh web server 上认领 exact 路由 `POST /starhub/git/commit-message`;请求体 `{ status, diffStat, recentSubjects }`(`git status --porcelain` / `git diff HEAD --stat` / 近期提交主题,客户端采集并截断),响应 `{ message }` 草稿,用户在输入框确认/编辑后再提交。
- 模型路由:缺省取 `agentDefaultModel.currentSelection()`(跟随 GUI 设置 → 模型 的默认选择);cordis.yml 可用 `provider`/`model` 对固定(必须成对)。
- 预算:`maxInputBytes`(请求体字节上限,超出 413)/ `maxOutputTokens` / `timeoutMs` 都是 cordis.yml 必填 config;体错误 400,方法错误 405,生成失败 502。
- 不做 git 操作:变更摘要完全由客户端带来,端点只做文本生成。

## Model Experience

### One-shot commit-message draft

#### What the model sees

One system instruction (drafting rules: subject ≤72 characters, match recent-commit style, never invent changes) plus one JSON-framed user message carrying `status` / `diffStat` / `recentSubjects`.

#### Token effect

One short call per click; input bounded by `maxInputBytes` and output by `maxOutputTokens`, with `temperature` fixed at 0.3.

#### KV Cache effect

Single-shot call; no session-history reuse.

## Known Limitations and Deferred Work

- 路由不绑定会话(无 sessionId),不计入任何会话日志;调用不展示在对话里,也不消耗会话上下文。
- 变更摘要只含 status + diffstat(不含完整 diff),新文件的具体内容由模型按文件名推断,可能偏泛;需要更精确草稿时未来可加 `diffPreview`(截断的 unified diff)字段。
