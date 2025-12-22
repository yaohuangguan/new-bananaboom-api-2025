# 1. 基础镜像
FROM node:22-alpine

# 2. 工作目录
WORKDIR /app

# 3. 缓存依赖
COPY package*.json ./

# 4. 安装依赖 (关键修改：加上 --ignore-scripts)
# 这样 npm 就不会去跑 prepare 脚本，也就不会因为找不到 husky 而报错了
RUN npm install --production --ignore-scripts

# 5. 拷贝源代码
COPY . .

# 6. 暴露端口
EXPOSE 5000

# 7. 启动命令
CMD ["npm", "start"]