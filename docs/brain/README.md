# Orion Personal Memory Vault
更新：2026-10-23（Pacific/Auckland）。本次仅在用户指定的两个本机 WSL 原仓库实现和测试；没有读取/迁移生产个人数据、部署或推送。

## 当前交付
- 新 Mongoose 集合与 owner 隔离 API；不可变原包/文档/附件，可修订记忆和只追加修订。
- 中文/英文原文与记忆检索、类型/来源/日期/审核筛选；真实日期时间线，未知日期单列；人工确认、纠错、归档和恢复。
- ChatGPT mapping 结构 ZIP/JSON、编号 conversations JSON；Markdown/文本；schemaVersion 1 通用 JSON；owner 限定旧聊天 cursor 扫描。
- 导入预览、重复/增量/冲突/缺失报告、失败重试；所有提交使用事务，不覆盖旧原文。
- 默认加密可移植 ZIP/JSONL，原包和附件哈希、完整版本链；独立离线 CLI。
- 新首页保留 ai-space 路由和 BRAIN:USE Tab。Legacy Chats 只读、全量分页，外部图片引用不自动请求。
- AI/MCP 没有成为依赖，也没有发送私密文本到模型。

## 未验收 / 必须区分
Claude 真实官方格式未获脱敏样本验证，默认只保存原包，明确 unsupported。实验适配器仅有合成 fixture，不能称为正式官方兼容。ChatGPT 适配器也仅对已测试结构负责，仍需真实脱敏官方包验收。
生产 R2/S3 bucket、CDN/dev URL、公开资源浏览器隔离未做在线核验。S3 驱动已用替身验证独立 bucket 和加密，未连接真实云对象。
旧聊天真实图片只保留未验证引用；没有获准取得字节，不能宣称图片已备份。绝不删除旧 Chat、Conversation 或 R2 文件。
本机预览通过合成身份和真实 API/DB；不是公开预览环境或生产登录验收。Node 实际测试版本见实施报告。
V1 采用有界同步作业；超过下述限制明确拒绝，不静默截断。大归档流式分卷、分布式作业调度、存储保留/密钥轮换策略需生产规模评估。

## 文档
- [API contract](API.md)
- [运行、导入、恢复与回滚](RUNBOOK.md)
- [归档 schema](SCHEMA.md)
- [初始审计](PHASE-0.md)
- [Phase 1–2 证据](PHASE-2.md)
- tools/brain-vault/README.md：可独立分发的恢复工具说明。

## Captain Cabin 样式修正与无模型启动
前端改为实际私域粉玫瑰/白色玻璃面板主题，沿用现有外壳和节庆行为，不强制切换全站暗色。实际外壳桌面/390px验收通过。旧 aiProvider 顶层抛错已改为按调用失败，无任何模型 key 的真实应用流程已测试。最终验证详见 PHASE-3.md。
