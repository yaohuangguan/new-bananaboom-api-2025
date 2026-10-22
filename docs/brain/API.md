# Vault API v1
Base /api/brain。复用现有认证解析；路由同时独立检查登录和 BRAIN:USE 或 *。管理员通配符不越过 owner。缺失认证 401、权限/来源不允许 403，外来资源与不存在资源统一 404。

所有响应 private/no-store。写请求使用 X-Brain-Request: 1；cookie 请求还必须提供精确白名单 Origin。BRAIN_ALLOWED_ORIGINS 不能配置通配域名。JSON 256 KiB。非法 ObjectId / limit / 查询类型 400。字段白名单防止 owner/actor 注入。无通用 DELETE。
分页 items / nextCursor，默认 30、最大 100。常规游标为 ObjectId；时间线为 ISO日期|ObjectId，作为不透明字符串使用。

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| GET | /stats | 本人的记忆/来源/文档/待审核数和最近记忆修改 |
| GET, POST | /memories | 列表/手动创建 |
| GET, PATCH | /memories/:id | 详情/事务修订 |
| GET | /memories/:id/revisions | 分页历史 |
| GET, POST | /search?kind=memories或documents | 双层检索，结果类型明确 |
| GET | /sources、/sources/:id | 来源与覆盖报告 |
| GET | /sources/:id/original | 原始文件安全下载 |
| GET | /sources/:id/assets | 分页附件与缺失项 |
| GET | /documents、/documents/:id | 原文、父节点、原始时间和来源 |
| POST | /imports | multipart file + provider，生成预览 |
| GET | /imports、/imports/:id | 分页作业/状态 |
| POST | /imports/:id/commit | 确认预览后添加资料，安全重试 |
| POST | /legacy/preview | 获准数据集的全量只读扫描；默认禁用 |
| GET | /legacy/conversations、/legacy/messages | owner 旧聊天只读分页 |
| GET | /assets/:id | owner 代理下载，支持单区间 Range |
| POST | /exports | passphrase 或明确 unencrypted:true |
| GET | /exports、/exports/:id | 本人备份列表/状态 |
| GET | /exports/:id/download | 仅 complete 可下载 |
| POST | /restore/preview | multipart file + 可选 passphrase；校验和冲突预览 |
| GET | /restore/:id | 本人恢复任务 |
| POST | /restore/commit | JSON jobId；冲突时整笔拒绝 |
| GET | /recovery-tools/:name | 固定白名单离线工具下载 |

记忆列表支持 query、type、reviewStatus、source、from、to、cursor、limit。archived=true 单独查看已归档；timeline=true 按真实 eventAt+ID 分页；undated=true 单独查询未知日期。搜索使用 NFKC、小写、固定桶 n-gram 多键索引和转义短语校验；桶冲突只影响性能，不改变结果。maxTimeMS 5000，索引可以离线重建。

POST /memories 示例：
```json
{"statement":"合成示例：偏好中文资料","type":"preference","reviewStatus":"candidate","sensitivity":"normal","tags":["示例"],"eventAt":null}
```
PATCH 必须带 expectedRevision；冲突 409。archived:true/false 分别归档/恢复。允许字段详见 services/brain/core.js；sourceAnchors 只允许同 owner 文档，引用及字符范围必须匹配原文。所有确认/纠错/归档都追加 revision。任何 actor/owner 字段由服务器确定。

通用 JSON 输入：
```json
{"schemaVersion":1,"documents":[{"id":"sample-1","text":"合成原文","timestamp":null}]}
```
provider=other；人工/AI 汇总导入产生 candidate，不推断事实日期，不自动确认为真。

限制：导入 25 MiB；ZIP 展开 100 MiB、2000 entries、单 entry 32 MiB、压缩比 200；文档 128000 字符及 512000 字节元数据预算；10000 文档/作业。恢复上传 128 MiB；导出同 ZIP 展开限制、每集合 10000 条及 64 MiB BSON 快照预算。达到限制 413/429，绝不导出截断包。
每实例每 owner 120 请求/分钟；重备份操作 20/小时，持久化备份/恢复作业 10/小时；导入预览待处理 20、每天作业 50、原始上传预算 1 GiB。最多每实例 2 个重任务且每 owner 一个。多实例全局限流需网关配置验收。下载 GET 不占重操作额度。

下载仅 octet-stream + attachment + nosniff + sandbox；不返回存储 key、签名、公网 URL。Range 不支持多区间，错误区间 416。原文以文本显示，外链图片不自动加载。异常只返回固定代码，不序列化 Mongo 错误值或原文。

前端搜索词仅放 POST /search JSON 请求体，避免请求 URL 携带个人内容。GET 保留兼容；生产仍需核验平台请求日志的查询参数脱敏。网关将 Vault 导入/导出/恢复的写请求纳入现有 EXPENSIVE_LIMITER，读取走普通桶。
