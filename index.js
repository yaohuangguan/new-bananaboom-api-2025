import express, { json, urlencoded } from 'express';
import connectDB from './config/db.js';
import { createServer } from 'http';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import compression from 'compression';
import { Server } from 'socket.io';

// ==========================================
// 📦 引入自定义模块
// ==========================================
import permissionService from './services/permissionService.js';
import corsConfig from './config/corsConfig.js';
import socketHandler from './socket/socket.js';


// 🔥 引入安检中间件 (核心改动)
import auth from './middleware/auth.js'; // 身份识别 (温和模式)
import globalGuard from './middleware/globalGuard.js'; // 权限门卫 (查表执法)
// --- CMS 内容类 ---
import resumeRoutes from './routes/resume.js';
import projectRoutes from './routes/projects.js';
import homepageRoutes from './routes/homepage.js';
import menuRoutes from './routes/menu.js';
import tagsRoutes from './routes/tags.js';

// --- 用户与鉴权类 ---
import authRoutes from './routes/auth.js';
import usersRoutes from './routes/users.js';
import rolesRoutes from './routes/roles.js';
import permissionsRoutes from './routes/permissions.js';
import permissionRequestRoutes from './routes/permissionRequest.js';

// --- 核心业务类 ---
import postsRoutes from './routes/posts.js';
import commentsRoutes from './routes/comments.js';
import photosRoutes from './routes/photos.js';
import todoRoutes from './routes/todo.js';
import fitnessRoutes from './routes/fitness.js';
import periodRoutes from './routes/period.js';
import footprintRoutes from './routes/footprint.js';
import chatRoutes from './routes/chat.js';

// --- 工具与系统类 ---
import backupRoutes from './routes/backup.js';
import auditRoutes from './routes/audit.js';
import schedulerRoutes from './routes/scheduler.js';
import cloudinaryRoutes from './routes/cloudinary.js';
import externalRoutes from './routes/external.js';
import aiRoutes from './routes/ai.js';
import readingRoutes from './routes/reading.js';
import uploadRoutes from './routes/upload.js';

// 👇👇👇【新增】全局代理配置 (仅开发环境生效) 👇👇👇
import { setGlobalDispatcher, ProxyAgent } from 'undici';

// V2Ray 端口
const PROXY_URL = process.env.PROXY_URL;

// 只有在非生产环境才挂载代理
if (process.env.NODE_ENV !== 'production') {
  try {
    const dispatcher = new ProxyAgent(PROXY_URL);
    setGlobalDispatcher(dispatcher);
    console.log(`🔌 [System] 全局代理已挂载 (Undici): ${PROXY_URL}`);
  } catch (error) {
    console.warn('⚠️ 代理设置失败:', error.message);
  }
}

// ==========================================
// 🚀 初始化 App & Server
// ==========================================
const app = express();
const server = createServer(app);

// 1. 初始化 Socket.io
const io = new Server(server, {
  cors: {
    origin: '*', // 生产环境建议改为具体的域名数组
    methods: ['GET', 'POST']
  }
});

// 2. 全局挂载 Socket (方便在 Controller 里使用 req.app.get('socketio'))
app.set('socketio', io);

// 3. 信任反向代理 (部署到云平台/Nginx 后必需)
app.set('trust proxy', 1);

// ==========================================
// 🛡️ 基础中间件 (Security & Performance)
// ==========================================
// 🔥 智能压缩配置
app.use(compression({
  filter: (req, res) => {
    // 1. 如果请求路径包含 'stream' (比如 /api/ai/ask-life/stream)，直接跳过压缩
    if (req.path.includes('/stream') || req.path.includes('stream')) {
      return false;
    }

    // 2. 也可以支持客户端手动禁用 (可选)
    if (req.headers['x-no-compression']) {
      return false;
    }

    // 3. 其他情况走默认逻辑 (只压缩 JSON, HTML, CSS 等)
    return compression.filter(req, res);
  }
}));
app.use(morgan('tiny'));
app.use(helmet());
app.options(/.*/, cors()); // ✅ 修复：把 "*" 改成 "(.*)"
app.use(cors(corsConfig));

// Body 解析 (支持大文件上传)
app.use(json({ limit: '50mb' }));
app.use(urlencoded({ limit: '50mb', extended: true }));

// 自定义安全头 (增强安全性)
app.use((_req, res, next) => {
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  res.setHeader('X-XSS-Protection', 1);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'Deny');
  next();
});

// ==========================================
// 🔌 启动 Socket & 任务调度
// ==========================================
socketHandler(io); // 启动 Socket 监听

// ==========================================
// 🌐 路由配置 (Routes)
// ==========================================

// 1. 根路径 & 健康检查 (完全公开，不走 Auth/Guard)
app.get('/', (_req, res) => res.json('API Server is running...'));
app.get('/health', (_req, res) => res.status(200).send('OK'));

// 2. 🔥🔥🔥 核心：API 网关鉴权 🔥🔥🔥
// 只要是 /api 开头的请求，必须先经过 auth (解析身份) 和 globalGuard (查权限表)
// 注意：即使是公开接口(如登录)，也要走这里，Guard 会根据 RouteMap 放行
app.use('/api', auth, globalGuard);

// 3. 挂载具体业务路由
// (注意：这里不需要再区分"公开"和"私有"，全部由 RouteMap 统一控制)

// ==========================================
// 2. 路由注册区 (Route Registration)
// ==========================================

// --- CMS 内容类 ---
app.use('/api/resumes', resumeRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/homepage', homepageRoutes);
app.use('/api/menu', menuRoutes);
app.use('/api/tags', tagsRoutes);

// --- 用户与鉴权类 ---
app.use('/api/auth', authRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/roles', rolesRoutes);
app.use('/api/permissions', permissionsRoutes);
app.use('/api/permission-requests', permissionRequestRoutes);

// --- 核心业务类 ---
app.use('/api/posts', postsRoutes);
app.use('/api/comments', commentsRoutes);
app.use('/api/photos', photosRoutes);
app.use('/api/todo', todoRoutes);
app.use('/api/fitness', fitnessRoutes);
app.use('/api/period', periodRoutes);
app.use('/api/footprints', footprintRoutes);
app.use('/api/chat', chatRoutes);

// --- 工具与系统类 ---
app.use('/api/backup', backupRoutes);
app.use('/api/audit', auditRoutes);
app.use('/api/cron', schedulerRoutes);
app.use('/api/cloudinary', cloudinaryRoutes);
app.use('/api/external', externalRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/reading', readingRoutes);
app.use('/api/upload', uploadRoutes);

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
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
};

// 🔥 核心改动：只有当不是在测试环境时，才启动服务器
if (process.env.NODE_ENV !== 'test') {
  startServer();
}

// 导出 app 供测试使用 (Supertest 需要用到 app)
export default app;
