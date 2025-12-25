import { Router } from 'express';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { glob } from 'glob'; // 确保安装: pnpm add glob
import { uploadToR2 } from '../utils/r2.js';

const router = Router();

// ==========================================
// 1. 引入所有数据模型
// ==========================================
import User from '../models/User.js';
import Post from '../models/Post.js';
import Comment from '../models/Comment.js';
import Todo from '../models/Todo.js';
import Chat from '../models/Chat.js';
import Photo from '../models/Photo.js';
import Fitness from '../models/Fitness.js';
import AuditLog from '../models/AuditLog.js';
import Conversation from '../models/Conversation.js';
import ExternalResource from '../models/ExternalResource.js';
import Footprint from '../models/Footprint.js';
import Homepage from '../models/Homepage.js';
import Log from '../models/Log.js';
import Menu from '../models/Menu.js';
import Period from '../models/Period.js';
import Permission from '../models/Permission.js';
import PermissionRequest from '../models/PermissionRequest.js';
import Project from '../models/Project.js';
import Resume from '../models/Resume.js';
import Role from '../models/Role.js';
import Session from '../models/Session.js';

// ==========================================
// 2. 通用辅助函数
// ==========================================

// 获取可读的时间字符串: HH-mm-ss (用于文件夹命名)
const getTimeString = () => {
  const now = new Date();
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  return `${hours}-${minutes}-${seconds}`;
};

// 递归删除文件夹 (用于清理临时文件)
const deleteFolderRecursive = (directoryPath) => {
  if (fs.existsSync(directoryPath)) {
    fs.readdirSync(directoryPath).forEach((file) => {
      const curPath = path.join(directoryPath, file);
      if (fs.lstatSync(curPath).isDirectory()) {
        deleteFolderRecursive(curPath);
      } else {
        fs.unlinkSync(curPath);
      }
    });
    fs.rmdirSync(directoryPath);
  }
};

// ==========================================
// 3. 接口 A: 导出 JSON (浏览器下载)
// ==========================================

// @route   GET /api/backup
// @desc    导出纯文本 JSON 备份 (浏览器直接下载)
// @access  Private & VIP Only
router.get('/', async (req, res) => {
  const { type } = req.query; 

  try {
    let data = {};
    let filenamePrefix = 'full';

    // 定义全量查询任务
    const fetchAll = async () => {
      const [
        users, posts, comments, todos, chats, photos, fitness, auditLog,
        conversations, externalResources, footprints, homepage, logs,
        menus, periods, permissions, permissionRequests, projects,
        resumes, roles, sessions
      ] = await Promise.all([
        User.find({}).select('-password'),
        Post.find({}).sort({ createdDate: -1 }),
        Comment.find({}).sort({ date: -1 }),
        Todo.find({}).sort({ timestamp: -1 }),
        Chat.find({}).sort({ createdDate: -1 }),
        Photo.find({}).sort({ createdDate: -1 }),
        Fitness.find({}).sort({ createdDate: -1 }),
        AuditLog.find({}).sort({ createdDate: -1 }),
        Conversation.find({}).sort({ updatedAt: -1 }),
        ExternalResource.find({}),
        Footprint.find({}).sort({ createdDate: -1 }),
        Homepage.find({}),
        Log.find({}).sort({ createdDate: -1 }),
        Menu.find({}),
        Period.find({}),
        Permission.find({}),
        PermissionRequest.find({}).sort({ createdDate: -1 }),
        Project.find({}).sort({ createdDate: -1 }),
        Resume.find({}),
        Role.find({}),
        Session.find({}).sort({ expires: -1 })
      ]);

      return { 
        users, posts, comments, todos, chats, photos, fitness, auditLog,
        conversations, externalResources, footprints, homepage, logs,
        menus, periods, permissions, permissionRequests, projects,
        resumes, roles, sessions
      };
    };

    // 根据 type 参数决定导出内容
    if (type) {
      filenamePrefix = type;
      switch (type) {
        case 'users': data.users = await User.find({}).select('-password'); break;
        case 'posts': data.posts = await Post.find({}).sort({ createdDate: -1 }); break;
        case 'comments': data.comments = await Comment.find({}).sort({ date: -1 }); break;
        case 'todos': data.todos = await Todo.find({}).sort({ timestamp: -1 }); break;
        case 'chats': data.chats = await Chat.find({}).sort({ createdDate: -1 }); break;
        case 'photos': data.photos = await Photo.find({}).sort({ createdDate: -1 }); break;
        case 'fitness': data.fitness = await Fitness.find({}).sort({ createdDate: -1 }); break;
        case 'audit': data.auditLog = await AuditLog.find({}).sort({ createdDate: -1 }); break;
        case 'conversations': data.conversations = await Conversation.find({}).sort({ updatedAt: -1 }); break;
        case 'external': data.externalResources = await ExternalResource.find({}); break;
        case 'footprints': data.footprints = await Footprint.find({}).sort({ createdDate: -1 }); break;
        case 'homepage': data.homepage = await Homepage.find({}); break;
        case 'logs': data.logs = await Log.find({}).sort({ createdDate: -1 }); break;
        case 'menus': data.menus = await Menu.find({}); break;
        case 'periods': data.periods = await Period.find({}); break;
        case 'permissions': data.permissions = await Permission.find({}); break;
        case 'requests': data.permissionRequests = await PermissionRequest.find({}).sort({ createdDate: -1 }); break;
        case 'projects': data.projects = await Project.find({}).sort({ createdDate: -1 }); break;
        case 'resume': data.resumes = await Resume.find({}); break;
        case 'roles': data.roles = await Role.find({}); break;
        case 'sessions': data.sessions = await Session.find({}).sort({ expires: -1 }); break;
        default: data = await fetchAll(); filenamePrefix = 'full';
      }
    } else {
      data = await fetchAll();
    }

    const backupJSON = {
      meta: {
        version: '2.1',
        exportDate: new Date().toISOString(),
        exporter: req.user ? req.user.displayName : 'System',
        type: type || 'full_backup',
        includedModels: Object.keys(data)
      },
      data: data
    };

    const dateStr = new Date().toISOString().split('T')[0];
    const filename = `bananaboom-${filenamePrefix}-${dateStr}.json`;

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(JSON.stringify(backupJSON, null, 2));

  } catch (error) {
    console.error('Backup error:', error);
    res.status(500).json({ message: 'Server Error during backup', error: error.message });
  }
});

// ==========================================
// 4. 接口 B: 系统级备份到 R2 (流式响应)
// ==========================================

// @route   POST /api/backup/database
// @desc    执行 mongodump 并上传到 R2 (流式输出日志，防止超时)
router.post('/database', async (req, res) => {
  const dateStr = new Date().toISOString().split('T')[0]; 
  const timeStr = getTimeString(); 
  
  // R2 路径: db-backups/2025-12-25/14-30-05/
  const r2FolderPrefix = `db-backups/${dateStr}/${timeStr}`;

  // 本地临时目录
  const timestamp = Date.now();
  const tempDir = path.join('/tmp', `backup-${timestamp}`);

  // 🔥 关键设置：开启流式传输，防止 Nginx/CloudRun 超时
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Transfer-Encoding', 'chunked');

  // 内部小函数：发送日志给前端
  const sendLog = (msg) => {
    res.write(`[LOG] ${msg}\n`);
  };

  try {
    sendLog(`🚀 任务启动: 数据库全量备份`);
    sendLog(`📂 目标 R2 路径: ${r2FolderPrefix}`);

    const MONGO_URI = process.env.MONGO_URI;
    if (!MONGO_URI) throw new Error('MONGO_URI 环境变量未定义');

    // 1. 执行 mongodump
    sendLog(`⏳ 正在执行 mongodump (导出到临时目录)...`);
    const child = spawn('mongodump', [
      `--uri=${MONGO_URI}`,
      `--out=${tempDir}`, // 输出文件夹结构
      '--gzip'            // 启用压缩
    ]);

    // 实时转发 mongodump 的 stderr 日志
    child.stderr.on('data', (data) => {
      // 这里的日志包含进度条，转发给前端看会很酷
      res.write(`[MONGO] ${data.toString()}`);
    });

    await new Promise((resolve, reject) => {
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`mongodump 退出代码: ${code}`));
      });
      child.on('error', (err) => reject(err));
    });

    sendLog(`✅ 数据库导出完成，准备扫描文件...`);

    // 2. 扫描文件
    const files = await glob(`${tempDir}/**/*`, { nodir: true });
    
    if (files.length === 0) {
      throw new Error('Mongodump 未生成任何文件');
    }

    sendLog(`📦 扫描到 ${files.length} 个文件，开始上传 R2...`);

    let uploadedCount = 0;

    // 3. 逐个上传
    for (const filePath of files) {
      const relativePath = path.relative(tempDir, filePath);
      const r2Key = `${r2FolderPrefix}/${relativePath}`.replace(/\\/g, '/');
      
      const fileBuffer = fs.readFileSync(filePath);
      const mimeType = filePath.endsWith('.json') || filePath.endsWith('.json.gz') 
        ? 'application/json' 
        : 'application/gzip';
      
      await uploadToR2(fileBuffer, r2Key, mimeType);
      
      uploadedCount++;
      // 每上传一个文件，通知前端进度
      sendLog(`☁️ [${uploadedCount}/${files.length}] 已上传: ${relativePath}`);
    }

    // 4. 清理
    deleteFolderRecursive(tempDir);
    sendLog(`🧹 本地临时文件已清理`);

    // 5. 发送完成信号 (包含 JSON 数据供前端解析)
    // 前端收到 [DONE] 后，解析后面的 JSON 刷新文件列表
    const resultData = JSON.stringify({
      success: true,
      folder: r2FolderPrefix,
      totalFiles: files.length
    });
    
    res.write(`[DONE] ${resultData}\n`);
    res.end(); // 结束响应流

  } catch (error) {
    console.error('[Backup] Failed:', error);
    
    // 错误处理也要流式输出
    sendLog(`❌ 错误: ${error.message}`);
    
    // 尝试清理
    try {
      if (fs.existsSync(tempDir)) deleteFolderRecursive(tempDir);
    } catch (e) { /* ignore */ }

    res.end(); // 结束响应
  }
});

export default router;