# 1. 基础镜像 (Node 22)
FROM node:22-alpine

# 2. 启用 pnpm (关键步骤)
# Corepack 是 Node 自带的工具，能直接激活 pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# 3. 工作目录
WORKDIR /app

# 4. 复制锁文件和描述文件
# pnpm 需要 pnpm-lock.yaml 才能发挥最大威力
COPY package.json pnpm-lock.yaml ./

# 5. 安装依赖 (生产模式)
# --prod: 只安装 dependencies，不装 devDependencies (如 eslint/jest)
# --frozen-lockfile: 严格按照 lock 文件安装，不更新版本 (类似 npm ci)
RUN pnpm install --prod --frozen-lockfile --ignore-scripts

# 6. 拷贝源代码
COPY . .

# 7. 暴露端口
EXPOSE 5000

# 8. 启动命令
# 建议直接用 node 启动，比 npm start 少一层进程消耗，信号转发更准
CMD ["node", "index.js"]