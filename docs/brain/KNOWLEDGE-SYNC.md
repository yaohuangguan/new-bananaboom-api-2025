# Orion 个人知识同步

更新：2026-10-23（Pacific/Auckland）。沿用现有 Personal Memory Vault、Captain’s Cabin、登录、owner 隔离和私有对象存储。AI 连接是可选入口；搜索、编辑、导入、导出和离线恢复不需要模型。

## 能实现的同步

在启用了 Orion 连接的聊天中，AI 可以搜索已有知识，并通过工具保存长期事实、偏好、项目进展或纠正。每次成功写入都会保留提交原文、来源连接、修订和候选状态。相同请求重试不新增重复记录；修订必须提供当前版本。

这不是 ChatGPT/Claude 内置 Memory 的后台镜像：目前公开文档未提供可供 Orion 订阅的内置记忆变更通知，模型也可能不调用工具。不能承诺覆盖所有普通聊天、所有后台总结或完整聊天原文。界面的“最近写入”只代表成功的实际调用。历史聊天和平台已有记忆仍需官方导出/人工整理后导入。

[OpenAI 自定义 MCP 文档](https://developers.openai.com/api/docs/guides/custom-mcp-server)、
[OpenAI OAuth 文档](https://developers.openai.com/plugins/build/auth)、
[Claude 自定义连接器说明](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)。

## 一次连接

登录 Orion，进入 Second Brain → AI 同步。复制 MCP URL：

    https://api.samyao.me/api/brain/sync/mcp

ChatGPT 网页：在支持自定义 MCP 的账号/工作区中，通过 Plugins 的 Add custom MCP server 添加此地址，选择 OAuth，使用 DCR（动态注册）。安装并在对话中启用或 @ 调用 Orion。不要选择 No authentication 或混合认证。本服务要求整个 MCP 连接经过 OAuth。

Claude 网页：Customize → Connectors → Add custom connector，粘贴此地址。Authentication 选择登录；OAuth client 选择 Register automatically。本版本支持 DCR + 公共客户端 PKCE，不支持 Claude published identity/CIMD 或 client_secret_basic。

两端都会跳到 Orion 登录及授权页。核对当前账户、客户端名称和回调域名，可取消写权限只授予读取。确认后返回原客户端。Orion 不接收 AI 账号密码，也不把 Orion 登录凭证交给模型。账号/工作区的工具可用性和确认设置由平台控制。

把下面的约定加入自定义指令或项目说明，并在对话中启用 Orion：

> 当我明确提供值得长期保存的个人事实、偏好、项目进展或纠正时，先搜索 Orion 知识库，再调用同步工具新增或修订。保留日期、来源和不确定性，不把临时猜测当成事实。只有工具返回成功后，才告诉我已同步；失败时明确告知没有保存。不要把密码、密钥或验证码写入知识库。

连接后可以让 AI 搜索一条已存在的知识，检查 Orion 的实际调用时间。首次真实保存可在日常对话中明确说“把这条同步到 Orion”，再检查来源与版本。这里没有代替用户在两家网页完成授权，也没有通过生产测试写入来假装连接成功。

## 独立 API / GPT Actions

在 AI 同步 → GPT Actions / 独立 API 密钥中创建连接。密钥只显示一次，默认 30 天到期；不要放入 URL、Git 或聊天正文。撤销后立即拒绝后续调用。

OpenAPI：

    https://api.samyao.me/api/brain/sync/openapi.json

自定义 GPT 的 Actions 可导入该 URL，认证使用 API Key → Bearer。这是自定义 GPT 的工具入口，不会让所有普通 ChatGPT 聊天自动拥有连接。平台可能要求确认写操作。

所有机器请求仅使用 Authorization: Bearer <独立密钥>，不接受 cookie、query token 或 ownerId。API Key 仅能访问 REST，OAuth MCP token 仅能访问指定 MCP resource。

| 方法与路径 | 用途 |
| --- | --- |
| POST /api/brain/sync/v1/search | JSON body 搜索，避免私人搜索词进入 URL |
| GET /api/brain/sync/v1/memories/:id | 读取当前版本与来源锚点 |
| POST /api/brain/sync/v1/sync | 新增，或带 memoryId + expectedRevision 修订 |

新增示例（请求头携带密钥）：

~~~json
{
  "requestId": "client-unique-change-0001",
  "statement": "用户明确提供的、值得长期保存的一条知识",
  "type": "preference",
  "eventAt": null,
  "note": "用户在本次对话明确提供；未独立核实"
}
~~~

同一变更重试必须重用 requestId 和完全相同的内容；另一变更用新 ID。修改时先读取，再附 memoryId 和 expectedRevision。版本冲突 409 后重新读取并评估，不自动覆盖。跨 owner 读取返回 404；字段非法 400；未认证/撤销/过期 401；权限不足 403；频率限制 429。每连接每分钟 60 请求，另受现有边缘网关限制。

MCP 工具为 search_knowledge、read_knowledge、sync_knowledge；只读授权不暴露写工具。模型输入和来源文字都是数据，不作为服务端指令执行。新增与修改均为 candidate，不伪称独立核实，不允许自动降低已有敏感等级。

## 数据、权限与维护

新运行集合：BrainConnection、BrainCredential、BrainOAuthClient、BrainAuthorization、BrainAuthorizationCode、BrainSyncReceipt。只存凭据 SHA-256；access token 1 小时、轮换 refresh token 最长 30 天，OAuth 连接最长 90 天。每次调用复查 live owner 权限，撤销后凭据删除。nonce/code/凭据有到期索引。动态客户端最长 365 天。

写入沿用 BrainSource → BrainDocument → BrainMemory → BrainRevision，不变原始提交字节进入独立私有存储，版本与幂等回执同事务。运行连接元数据及密钥不进入知识备份；异机恢复后重新授权客户端。原文、来源、记忆和完整修订会进入现有可移植归档。

允许自定义部署变量：BRAIN_CONNECT_PUBLIC_URL（OAuth issuer/API 外部 HTTPS 地址），BRAIN_CONNECT_UI_URL（前端根地址），BRAIN_ALLOWED_ORIGINS（精确可信网页 origin）。默认外部 API 为 https://api.samyao.me，授权 UI 为 https://samyao.me/memory/connect。本机测试可使用 localhost；网页 AI 无法连接只在本机监听的服务。

MCP/OAuth 路由经过现有 edge-secret 保护并绕过公共 R2 hydration；不得改成公共上传、公开 CDN 或共享管理员凭据。不要轮换现有 BRAIN_STORAGE_KEY 而丢弃原密文。日常可在连接页查看时间、权限与到期，撤销不再使用的连接。

## 日期化知识文件导入

支持 UTF-8 Markdown，类别标题 Instructions、Identity、Career、Projects、Preferences；条目格式 [YYYY-MM-DD] - 内容 或 [unknown] - 内容。原始全文、精确范围和日期均保留；附件中的“Instructions”只作为知识记录，不能控制导入器或执行命令。

运维 CLI 默认只预览：

~~~sh
node scripts/import-brain-knowledge.mjs --owner-email owner@example.invalid --file /secure/knowledge.md
node scripts/import-brain-knowledge.mjs --owner-email owner@example.invalid --file /secure/knowledge.md --commit
~~~

数据库和私有存储凭据由已有安全运维环境提供。生产须有明确账户与操作授权，并额外传 --allow-production。预览展示条数、类别、未知日期和原包 SHA；相同 owner 与原包重复导入不会重复创建。CLI 不会扫描其他账户或旧聊天。不得把含个人知识的文件复制进仓库。

## 备份与离线恢复

资料与备份 → Backup & Restore 创建并下载加密归档，独立保管口令和 tools/brain-vault 四个恢复文件。无需模型、数据库、npm 或在线 Orion：

~~~sh
node brain-vault.mjs verify backup.orion --passphrase-file /secure/key.txt
node brain-vault.mjs read backup.orion --passphrase-file /secure/key.txt --output ./readable-vault
node brain-vault.mjs restore backup.orion --passphrase-file /secure/key.txt --output ./recovered-vault
~~~

需要 Node 22+、Python 3；口令文件 Unix 权限 0600；输出目录不能已存在。工具先核对全部哈希，再恢复原包、JSONL、附件及可读文本。同步的知识走同一归档格式，恢复不依赖 OAuth 连接或模型厂商。详见 [运行手册](RUNBOOK.md) 和 [离线工具](../../tools/brain-vault/README.md)。

## 验收与已知限制

协议测试使用真实官方 MCP SDK Client、真实 HTTP、临时 Mongo 副本集和私有对象字节，覆盖 owner/权限/过期/撤销、PKCE/回调/单次 code、resource 绑定、refresh 轮换、只读授权、并发重试与版本冲突。浏览器完整流程覆盖真实 React/API/数据库、授权登录保留请求、只读降权、图表全量聚合及同步数据离线恢复。均使用合成数据，没有伪造两家真实网页账号已连接的结论。

本版本不支持平台原生 Memory webhook、CIMD、自动全聊天抓取、自动后台定时全量导出；不保证 AI 每次主动调用。多连接对同一事实的语义去重由先搜索及显式修订完成，requestId 仅保证同一连接的请求重试幂等。Claude 历史导出格式的兼容限制仍见原运行手册。无需这些可选能力也能管理与恢复知识。
