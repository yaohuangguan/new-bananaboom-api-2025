# 1. 基础镜像
FROM node:20-alpine

# 2. 工作目录
WORKDIR /app

# 3. 缓存依赖 (只拷贝 package 文件)
COPY package*.json ./

# 4. 安装依赖 (加上 --production 参数，不安装 nodemon 这种开发工具，减小体积)
RUN npm install --production

# 5. 拷贝所有源代码
COPY . .

# 6. 暴露端口
EXPOSE 5000

# 7. 启动命令
# 这会执行你 package.json 里的 "start": "node index.js"
CMD ["npm", "start"]