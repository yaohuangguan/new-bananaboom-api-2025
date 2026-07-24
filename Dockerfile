# 1. 基础镜像 (Node 22)
FROM node:22-alpine

# ==========================================
# 🔥 新增：安装 Chromium、中文字体与 MongoDB Tools (支持 GCP Cloud Run PDF 导出)
# ==========================================
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    font-noto-cjk \
    mongodb-tools

# 设置 Puppeteer 跳过重复下载，直接使用 Alpine 系统原生 Chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

# 2. 启用 pnpm (关键步骤)
RUN npm install -g pnpm@latest

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