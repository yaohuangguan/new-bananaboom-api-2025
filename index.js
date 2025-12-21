const dotenv = require('dotenv');
dotenv.config(); // 这行代码会把 .env 里的内容加载到 process.env 里

const express = require("express");
const connectDB = require("./config/db");
const http = require("http");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const compression = require("compression");

const permissionService = require('./services/permissionService');

const app = express();


const corsConfig = require("./corsConfig");
const server = http.createServer(app);
// 引入刚刚改好的 socket 模块
const socketHandler = require("./socket/socket");
const { Server } = require("socket.io");

// 2. 初始化 Socket.io，配置跨域
const io = new Server(server, {
  cors: {
    // 允许你的前端域名连接
    origin: "*", // 开发阶段先允许所有，上线后建议改成 ["https://ps5.space"]
    methods: ["GET", "POST"]
  }
});

// 🔥 把 io 挂载到 app 上，这样所有路由都能用 req.app.get('io') 拿到它
app.set('socketio', io);
// 🔥 告诉 Express 相信反向代理传过来的 X-Forwarded-For 头
// 如果你在 Heroku/Vercel/AWS LB 上，这行是必须的！
app.set('trust proxy', 1);

app.use(compression());
app.use(morgan("tiny"));
app.use(helmet());
app.use(helmet.hidePoweredBy());
app.options("*", cors());
app.use(cors(corsConfig));

app.use(express.json({ limit: '50mb' })); 
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use((_req, res, next) => {
  res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
  res.setHeader("X-XSS-Protection", 1);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("X-Frame-Options", "Deny");
  next();
});

// 🔥 关键一步：把 io 传给 socketHandler
socketHandler(io);

// 🔥🔥🔥 新增：启动定时任务调度器 🔥🔥🔥
// 必须放在 socketHandler 之后，server.listen 之前
const startScheduler = require("./utils/scheduler");
startScheduler(io);

app.get("/", (_req, res) => {
  res.json("api server");
});

app.get('/health', (_req, res) => res.status(200).send('OK'));
app.use("/api/auth", require("./routes/auth"));
app.use("/api/posts", require("./routes/posts"));
app.use("/api/resumes", require("./routes/resume"));
app.use("/api/projects", require("./routes/projects"));
app.use("/api/homepage", require("./routes/homepage"));
app.use("/api/comments", require("./routes/comments"));
app.use("/api/users", require("./routes/users"));
app.use("/api/todo", require("./routes/todo"));
app.use("/api/backup", require("./routes/backup"));
app.use("/api/photos", require("./routes/photos"));
app.use("/api/cloudinary", require("./routes/cloudinary"));
app.use("/api/audit", require("./routes/audit"));
app.use("/api/chat", require("./routes/chat"));
app.use("/api/fitness", require("./routes/fitness"));
app.use("/api/period", require("./routes/period"));
app.use("/api/footprints", require("./routes/footprint"));
app.use("/api/menu", require("./routes/menu"));
app.use("/api/external", require("./routes/external"));
app.use("/api/ai", require("./routes/ai"));
app.use("/api/permission-requests", require("./routes/permissionRequest"));
app.use("/api/cron", require("./routes/scheduler"))
app.use("/api/permissions", require("./routes/permissions"))
app.use("/api/roles", require("./routes/roles"))




//port
const PORT = process.env.PORT || 5000;

// 创建一个启动函数
const startServer = async () => {
  try {
    // 1. 先等待数据库连接成功
    await connectDB();
    // 🔥🔥🔥 核心步骤：启动前先加载权限 🔥🔥🔥
    await permissionService.load();
    
    // 2. 数据库连接成功后，再启动服务器
    server.listen(PORT, () => console.log(`Server listening on ${PORT}`));
    
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
};

// 执行启动
startServer();

module.exports = io;
