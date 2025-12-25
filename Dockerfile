# 1. 基础镜像 (Node 22)
FROM node:22-alpine

# ==========================================
# 🔥 新增：安装 MongoDB Tools
# ==========================================
# Alpine 下包名叫 mongodb-tools，包含了 mongodump 和 mongorestore
# --no-cache 表示安装完不保留缓存，保持镜像体积小
RUN apk add --no-cache mongodb-tools

# 2. 启用 pnpm (关键步骤)
# Corepack 是 Node 自带的工具，能直接激活 pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# 3. 工作目录
WORKDIR /app

# 4. 复制锁文件和描述文件
# pnpm 需要 pnpm-lock.yaml 才能发挥最大威力
COPY package.json pnpm-lock.yaml ./

# 5. 安装依赖 (生产模式)
# --prod: 只安装 dependencies，不装 devDependencies
# --frozen-lockfile: 严格按照 lock 文件安装
RUN pnpm install --prod --frozen-lockfile --ignore-scripts

# 6. 拷贝源代码
COPY . .

# 7. 暴露端口
EXPOSE 5000

# 8. 启动命令
CMD ["node", "index.js"]