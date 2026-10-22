# 本地运行、导入、备份恢复与回滚
## 安全边界
不要使用默认生产凭证/URI；本次没有读取 .env 或 keys。以下命令由用户在明确的开发环境执行。不要对生产执行扫描、恢复或部署，先提交审批材料。

## 最小本地验收（无需生产账户）
```sh
cd /home/samyao/work/new-bananaboom-api-2025
export PATH=/home/samyao/.nvm/versions/node/v24.21.0/bin:$PATH
pnpm test:brain
CHROME_PATH=/path/to/chrome pnpm test:brain:preview
```
preview 脚本使用兄弟 orion-frontend 工程，启动临时 Mongo 副本集和临时私有对象目录、真实 Express API/Vite/浏览器，通过合成 cookie 身份执行录入、导入、加密备份和恢复。结束自动停止自身服务并删除自身临时数据；不复制仓库、不加载生产配置。ORION_FRONTEND_DIR 可指定前端路径。它是测试，不能作为生产认证启动器。

常规前端验收：
```sh
cd /home/samyao/work/orion-frontend
pnpm typecheck
pnpm lint
CHROME_PATH=/path/to/chrome pnpm test
SITE_URL=http://localhost:4173 pnpm build
```
已有 sitemap/postbuild 脚本硬编码公共生产 API。需要完全避免网络时，在 Linux 可用 unshare --user --map-root-user --net，再仅启用 lo 执行命令；测试记录使用此隔离。构建会更新本地生成的 dist，不是部署。

## 日常本地开发
必须有自己的本地 MongoDB replica set（事务必需），准备现有 Orion 的本地用户/权限。不要指向生产数据库。无需新增全站用户模型。
```sh
cd /home/samyao/work/new-bananaboom-api-2025
export NODE_ENV=development
export MONGO_URI='mongodb://127.0.0.1:27017/orion_vault_local?replicaSet=rs0'
export BRAIN_STORAGE_DRIVER=local
export BRAIN_STORAGE_ROOT="$PWD/.vault-data"
export BRAIN_ALLOWED_ORIGINS=http://localhost:5173
install -d -m 700 "$BRAIN_STORAGE_ROOT"
# SECRET_JWT 等现有认证配置由本地安全渠道提供；不要复用生产 key。
pnpm start
```
另一个终端在前端运行 pnpm dev:local，打开 /captain-cabin/ai-space。保留现有入口、Tab 和 BRAIN:USE。本地对象目录 0700、文件 0600，校验 symlink；原子写、fsync、只创建不覆盖。/.vault-data/ 已从 Git 与 Docker build context 排除，不能放到 public/。
生产本地磁盘必须是真正持久卷，且 BRAIN_LOCAL_DURABLE=1 明确确认，Cloud Run 临时磁盘不能作为唯一保存位置。

独立 S3/R2 驱动变量：BRAIN_STORAGE_DRIVER=s3、BRAIN_S3_BUCKET、BRAIN_S3_ENDPOINT、BRAIN_S3_REGION、BRAIN_S3_ACCESS_KEY_ID、BRAIN_S3_SECRET_ACCESS_KEY、BRAIN_STORAGE_KEY（至少 32 字符，使用安全随机秘密）。bucket 不得等于现有 R2_BUCKET_NAME。对象额外认证加密，即便误暴露 blob 也不是原文；仍必须关闭匿名/CDN/dev URL 公开读取，使用专门凭证。不能修改 BRAIN_STORAGE_KEY 后继续读取旧对象；轮换需单独迁移方案与独立备份。

## 导入
1. 从官方账户下载导出，不向 Orion 提供模型 API key。ChatGPT 说明：[官方导出](https://help.openai.com/en/articles/7260999-exporting-your-chatgpt-history-and-data)；Claude：[官方导出](https://support.claude.com/en/articles/9450526-export-your-claude-data)。
2. Sources 中选择 provider 和 ZIP/JSON/Markdown/文本，生成预览。ChatGPT ZIP 内识别 conversations.json / conversations-1.json / conversations_1.json 等；保持 mapping 树、父节点、角色、原始时间和原包。
3. 检查新增、重复、冲突、缺失附件、覆盖未出现项；缺失项不等于删除。只有确认后提交。unknown/Claude 默认 unsupported 可选择“仅归档原包”，不会伪称解析成功。
4. 相同包可再次预览/提交；原文版本改变会保留两个不可变版本并报告冲突，不覆盖。作业失败后从已有任务重新提交；事务无半提交。索引写入和修订与数据同事务。中断遗留的未引用 blob 不自动删除。
5. Memory/Markdown/通用 JSON 汇总一律 candidate，标明未独立证实，不编造日期。通过原文检索/来源文档可创建带引用候选，再由人确认。
6. Claude 实验适配器 BRAIN_ENABLE_EXPERIMENTAL_CLAUDE=1 仅供已确认结构的测试；在取得真实脱敏官方 fixture 并通过兼容测试之前不要把它视为正式功能。官方说明部分工作区导出不含上传文件内容，附件缺失必须保留报告。
7. 旧聊天扫描 BRAIN_ALLOW_LEGACY_SCAN 默认关闭，仅在明确批准的非生产副本启用 1。扫描 exact owner room 和所属 Conversation，无 50 条 UI 限制。原始 sender ID、孤儿和无法归属项留在原包及审计元数据；未知 sender 不伪造为用户。图片引用不自动联网，未获准取得字节的部分不算完整图片备份。

规格没有提供真实官方脱敏文件；当前 fixture 全部合成。不要将合成测试通过表述为真实账户迁移完成。

## 备份和离线恢复
Backup & Restore 输入至少 12 字符的独立高熵口令，生成后端已验证的加密备份并下载；UI 随后清空口令。口令由用户保管，丢失无法恢复。明确勾选才生成未加密 ZIP。
把四个 recovery tools 一起保留，与备份保存在独立介质。无需 npm 或线上系统：
```sh
chmod 600 /secure/vault-passphrase.txt
node brain-vault.mjs verify backup.orion --passphrase-file /secure/vault-passphrase.txt
node brain-vault.mjs read backup.orion --passphrase-file /secure/vault-passphrase.txt --output ./readable-vault
node brain-vault.mjs restore backup.orion --passphrase-file /secure/vault-passphrase.txt --output ./recovered-vault
```
目标目录必须不存在，父目录须存在。也可 --passphrase-stdin；不要把口令放进命令行。Windows 可用 --python python，Unix 默认 python3。明文 ZIP 不需口令。输出保留全部原包/附件/JSONL，并生成原文和记忆的可读 txt，避免 HTML 或 Markdown 自动加载外链。所有校验成功后才写文件；异常会保留 RECOVERY_INCOMPLETE 标记。工具校验哈希是完整性检查，不证明档案作者身份。

恢复在线数据库：针对新的空开发副本集/新私有目录，先准备同一 owner ID 的本地账户，再在 Backup & Restore 上传备份、校验预览、检查冲突并提交。相同行忽略，任一差异拒绝全笔恢复。没有模型或云服务也可正常操作；完全没有 Orion 时直接消费上述离线 txt/JSONL。

索引重建（非事实源，默认 dry-run）：
```sh
MONGO_URI='mongodb://127.0.0.1:27017/orion_vault_local?replicaSet=rs0' node scripts/rebuild-brain-search.mjs OWNER_OBJECT_ID
MONGO_URI='mongodb://127.0.0.1:27017/orion_vault_local?replicaSet=rs0' node scripts/rebuild-brain-search.mjs OWNER_OBJECT_ID --commit
```
仅允许本地 URI；不改变原文、修订或 updatedAt。n-gram 使用固定 8192 个桶控制 Mongo 多键数量，再由原文短语过滤消除碰撞误命中。索引丢失不影响可移植档案。

## 生产审批包与回滚
上线前必须提交：两仓库提交差异；现有未提交改动保护证据；真实脱敏官方包兼容测试；明确批准的数据集 dry-run（逐类数量、孤儿、图片存在性/字节核验、缺失与冲突）；私有 bucket/CDN/旧 object browser 隔离证据；加密离线恢复演练；容量/耗时/内存/限流评估；owner 账户恢复方案；可回滚发布说明。当前没有这些生产验收，不能部署。

回滚顺序：前端 Phase 3→2→1；后端 Phase 3→2→1→0。只 revert 本次提交，不能 reset/clean 或触碰已有项目改动。必要时先取消 /api/brain 挂载和切回旧页面版本。保留全部 Brain 集合、私有对象、归档和旧 Chat/Conversation/R2；回滚是停止新入口，不是删除新资料。旧聊天是否清理/隐藏，必须在真实归档及恢复验证后单独获批。Phase 4 AI/MCP 另行授权，不影响上述能力。

本机实际 Node v24.21.0 / MongoDB 8.2.1 验收；Node22生产镜像尚未构建验收。API启动不再要求模型key；仅实际调用旧AI功能时返回provider未配置错误。
