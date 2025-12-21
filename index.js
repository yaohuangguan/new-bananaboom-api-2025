const dotenv = require('dotenv');
dotenv.config(); // 0. 最先加载环境变量

const express = require("express");
const connectDB = require("./config/db");
const http = require("http");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const compression = require("compression");
const { Server } = require("socket.io");

// ==========================================
// 📦 引入自定义模块
// ==========================================
const permissionService = require('./services/permissionService');
const corsConfig = require("./corsConfig");
const socketHandler = require("./socket/socket");
const startScheduler = require("./utils/scheduler");

// 🔥 引入安检中间件 (核心改动)
const auth = require("./middleware/auth");         // 身份识别 (温和模式)
const globalGuard = require("./middleware/globalGuard"); // 权限门卫 (查表执法)

// ==========================================
// 🚀 初始化 App & Server
// ==========================================
const app = express();
const server = http.createServer(app);

// 1. 初始化 Socket.io
const io = new Server(server, {
  cors: {
    origin: "*", // 生产环境建议改为具体的域名数组
    methods: ["GET", "POST"]
  }
});

// 2. 全局挂载 Socket (方便在 Controller 里使用 req.app.get('socketio'))
app.set('socketio', io);

// 3. 信任反向代理 (部署到云平台/Nginx 后必需)
app.set('trust proxy', 1);

// ==========================================
// 🛡️ 基础中间件 (Security & Performance)
// ==========================================
app.use(compression()); // Gzip 压缩
app.use(morgan("tiny")); // 日志记录
app.use(helmet()); // 基础安全头
app.use(helmet.hidePoweredBy()); // 隐藏 Express 特征
app.options("*", cors()); // 处理预检请求
app.use(cors(corsConfig)); // 跨域配置

// Body 解析 (支持大文件上传)
app.use(express.json({ limit: '50mb' })); 
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// 自定义安全头 (增强安全性)
app.use((_req, res, next) => {
  res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
  res.setHeader("X-XSS-Protection", 1);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("X-Frame-Options", "Deny");
  next();
});

// ==========================================
// 🔌 启动 Socket & 任务调度
// ==========================================
socketHandler(io); // 启动 Socket 监听
// 🔥🔥🔥 核心修复：只有在“非测试环境”下才启动定时任务
// 否则 Jest 跑完测试后，Cron Job 还在后台读秒，导致 Jest 关不掉
if (process.env.NODE_ENV !== 'test') {
  startScheduler(io);
}

// ==========================================
// 🌐 路由配置 (Routes)
// ==========================================

// 1. 根路径 & 健康检查 (完全公开，不走 Auth/Guard)
app.get("/", (_req, res) => res.json("API Server is running..."));
app.get('/health', (_req, res) => res.status(200).send('OK'));

// 2. 🔥🔥🔥 核心：API 网关鉴权 🔥🔥🔥
// 只要是 /api 开头的请求，必须先经过 auth (解析身份) 和 globalGuard (查权限表)
// 注意：即使是公开接口(如登录)，也要走这里，Guard 会根据 RouteMap 放行
app.use("/api", auth, globalGuard);

// 3. 挂载具体业务路由
// (注意：这里不需要再区分"公开"和"私有"，全部由 RouteMap 统一控制)

// --- CMS 内容类 ---
app.use("/api/resumes", require("./routes/resume"));
app.use("/api/projects", require("./routes/projects"));
app.use("/api/homepage", require("./routes/homepage"));
app.use("/api/menu", require("./routes/menu"));

// --- 用户与鉴权类 ---
app.use("/api/auth", require("./routes/auth")); // 登录鉴权
app.use("/api/users", require("./routes/users")); // 用户管理
app.use("/api/roles", require("./routes/roles")); // 角色定义
app.use("/api/permissions", require("./routes/permissions")); // 权限定义
app.use("/api/permission-requests", require("./routes/permissionRequest")); // 申请审批

// --- 核心业务类 ---
app.use("/api/posts", require("./routes/posts"));
app.use("/api/comments", require("./routes/comments"));
app.use("/api/photos", require("./routes/photos"));
app.use("/api/todo", require("./routes/todo"));
app.use("/api/fitness", require("./routes/fitness"));
app.use("/api/period", require("./routes/period"));
app.use("/api/footprints", require("./routes/footprint"));
app.use("/api/chat", require("./routes/chat"));

// --- 工具与系统类 ---
app.use("/api/backup", require("./routes/backup"));
app.use("/api/audit", require("./routes/audit"));
app.use("/api/cron", require("./routes/scheduler")); // 注意文件名对应
app.use("/api/cloudinary", require("./routes/cloudinary"));
app.use("/api/external", require("./routes/external"));
app.use("/api/ai", require("./routes/ai"));

// ==========================================
// 🏁 启动服务器
// ==========================================
const PORT = process.env.PORT || 5000;

const startServer = async () => {
  try {
    // 1. 连接数据库
    await connectDB();
    
    // 2. 🔥 加载权限配置到内存 (确保 Guard 能立刻工作)
    await permissionService.load();
    
    // 3. 启动 HTTP 服务
    server.listen(PORT, () => console.log(`🚀 Server listening on port ${PORT}`));
    
  } catch (error) {
    console.error("❌ Failed to start server:", error);
    process.exit(1);
  }
};

// 🔥 核心改动：只有当不是在测试环境时，才启动服务器
if (process.env.NODE_ENV !== 'test') {
  startServer();
}

// 导出 app 供测试使用 (Supertest 需要用到 app)
module.exports = app;