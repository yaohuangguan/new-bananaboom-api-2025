# 可移植归档 schemaVersion 1
标准 ZIP 中直接存放下列文件（不要求特定顶层目录名）：
```text
README.md
manifest.json
checksums.sha256
sources.jsonl
documents.jsonl
memories.jsonl
revisions.jsonl
assets.jsonl
originals/<原包SHA256>
assets/<附件SHA256>
offline-recovery/brain-vault.mjs
offline-recovery/crypto.mjs
offline-recovery/archive.py
```

manifest 必需字段：schemaVersion=1，owner（24 位 ObjectId 字符串），exportedAt（UTC ISO），counts（sources/documents/memories/revisions/assets 精确条数），hashes（除 manifest/checksums 外的每个文件），missingAssets。checksums.sha256 再覆盖 manifest 与所有 payload。每行 SHA256 + 两个空格 + 相对路径。不得有未知/遗漏文件、重复路径或目录穿越。

JSONL 为 UTF-8、每行一条确定性排序 JSON（对象 key 排序；数组顺序不改变）。_id、ownerId、sourceId 等 ObjectId 以字符串保存，Mongoose Date 转 UTC ISO；rawTimestamp 保持源值包括 0/null，不推断日期。搜索字段可再生成，不在归档中保存；私有对象 key 转成相对 originalPath/archivePath，不泄露部署布局。

| 数据集 | 核心字段 |
| --- | --- |
| sources | _id, ownerId, provider, sourceType, originalFilename, originalSha256, originalPath, formatVersion, importedAt, status, metadata |
| documents | _id, ownerId, sourceId, stableKey, externalConversationId, externalMessageId, parentId, role, rawText, rawTimestamp, order, assetIds, rawJsonRef, contentSha256, metadata |
| memories | _id, ownerId, sourceId, type, statement, verbatim?, sourceAnchors, eventAt?, observedAt?, capturedAt, reviewStatus, sensitivity, tags, entityKeys, validFrom/validTo?, supersedesId?, revision, createdAt, updatedAt, deletedAt? |
| revisions | _id, ownerId, memoryId, action, before?, after, reason?, actorId, editedAt, revisionNumber |
| assets | _id, ownerId, sourceId, sha256?, size, mimeType, originalName, archivePath?, availability, createdAt |

数据模型定义是 models/brain.js，包含可复制的 Schema/索引。source 的 (owner,provider,hash) 和 document 的 (owner,stableKey,contentHash) 唯一。增量修改作为新的不可变文档版本保存，metadata.conflictOf 指向之前版本；重复版本不会生成新文档。来源 metadata.documentIds 记录覆盖，包括之前版本已导入的文档。附件 availability=missing 指“归档没有字节”，不宣称远端文件一定不存在。

恢复验证全包哈希、条数、行 owner、跨表引用、附件字节、原包字节、引用片段与范围、修订序列与最后状态、模型类型/枚举。冲突时拒绝整笔恢复；相同行忽略、新行插入，不进行更新。当前要求目标账户 ID 与归档 owner 相同；不会自动把他人的备份绑定给当前账户。离线 reader 不依赖账户服务。

加密 envelope 详见 tools/brain-vault/README.md。AES-256-GCM；随机 salt/nonce；scrypt N=32768,r=8,p=3；固定版本防止参数降级。参数组合参考 [OWASP scrypt 表](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html#scrypt)，认证加密使用 [Node crypto 标准 API](https://nodejs.org/api/crypto.html)。这是实现选择与文档来源，不代表外部安全审计认证。密钥不进 manifest/DB/日志，未加密 ZIP 仅由用户明确选择。

交付 sample-brain-export.zip 和 sample-manifest.json 全部是合成资料，可用于验收，无个人生产内容。
