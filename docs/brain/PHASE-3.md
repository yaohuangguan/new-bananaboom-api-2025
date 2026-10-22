# Phase 3 — local acceptance, 2026-10-23 Pacific/Auckland
实现：确定性 JSONL/ZIP 原包与附件导出；manifest/checksums；AES-256-GCM+scrypt(N=32768,r=8,p=3)默认加密；独立 Node/Python 标准库离线验证/阅读/恢复；owner校验与引用/版本链校验；预览冲突、事务添加恢复、禁止覆盖。

实际测试：后端现有49 + Vault21 = 70项全部通过；前端 typecheck/lint/Journal+Vault浏览器test/build通过；本机真实 React→Vite→Express→Mongoose→私有对象闭环通过。Node v24.21.0、MongoDB 8.2.1、WSL Ubuntu。本次未测试 Node22 容器镜像，生产 Docker仍需独立验收。
恢复fixture：2 sources / 3 documents / 1 memory / 2 revisions / 1 asset。五个JSONL与全部原包/附件字节在新空DB/对象目录恢复后完全一致；再次恢复9条记录均identical、不新增。
完全断网namespace运行独立恢复CLI；前端完整回归/构建/全栈也在仅启用lo的隔离网络运行。真实应用另外通过无任何模型key的认证/创建/检索/加密导出/恢复回归；修复旧 aiProvider 顶层抛错为调用时才报provider未配置。
Captain Cabin：使用原PrivateSpaceDashboard与CountDateWidget，粉玫瑰背景、白色玻璃面板、24px圆角、Sen/Inter字体和胶囊导航；保留全站light shell约定，未重新定义背景/节庆逻辑。截图已复核390px无溢出。
额外验收：全局guard/路由fail-closed、跨owner含*管理员、CSRF/Origin、反XSS/不自动请求图片、实际压缩ZIP bomb/重复路径/symlink/遍历、私有S3加密替身、长中文索引上界与尾部搜索、owner索引重建、敏感文本无console输出。前端检索用POST避免私密词进入URL；网关重任务进入现有限流桶；私有本地目录排除Git和Docker上下文。

已修复验证发现：provider import-time key硬依赖、网关Node Request stream duplex缺失、JSON字段顺序导致归档字节差异、跨repo预览Tailwind根路径、同步子进程阻塞测试数据库管理。失败迭代不作为最终通过证据，最终日志单独交付。
剩余：Claude缺真实脱敏官方fixture默认unsupported；ChatGPT真实官方包待确认；旧R2图片未获准读取，引用明确标missing/unverified；生产bucket/CDN/旧资源浏览器/网关日志脱敏未在线验证；云S3仅替身测试；V1有界同步作业无生产规模/分布式调度验收；索引重建仅local URI；没有生产迁移、清理旧数据、部署或push。
回滚：按阶段提交逆序revert，只停止新入口，保留Brain集合和所有原包/对象/旧Chat与Conversation。生产上线/真实数据迁移/旧UI最终清理须各自审批。
