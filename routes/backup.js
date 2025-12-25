import { Router } from 'express';
const router = Router();

// ==========================================
// 1. 引入所有数据模型 (已根据截图补充完整)
// ==========================================
import User from '../models/User.js';
import Post from '../models/Post.js';
import Comment from '../models/Comment.js';
import Todo from '../models/Todo.js';
import Chat from '../models/Chat.js';
import Photo from '../models/Photo.js';
import Fitness from '../models/Fitness.js';
import AuditLog from '../models/AuditLog.js';

// --- 新增的模型引入 ---
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

// @route   GET /api/backup
// @desc    导出数据库备份 (支持 ?type=users 单独导出，或默认全量导出)
// @access  Private & VIP Only
router.get('/', async (req, res) => {
  const { type } = req.query; // 获取查询参数，例如: ?type=projects

  try {
    let data = {};
    let filenamePrefix = 'full';

    // ==========================================
    // 2. 定义全量查询任务
    // 使用 Promise.all 并行查询，效率最高
    // ==========================================
    const fetchAll = async () => {
      const [
        users, posts, comments, todos, chats, photos, fitness, auditLog,
        // 新增的解构变量
        conversations, externalResources, footprints, homepage, logs,
        menus, periods, permissions, permissionRequests, projects,
        resumes, roles, sessions
      ] = await Promise.all([
        // 原有查询
        User.find({}).select('-password'), // 安全起见，排除密码
        Post.find({}).sort({ createdDate: -1 }),
        Comment.find({}).sort({ date: -1 }),
        Todo.find({}).sort({ timestamp: -1 }),
        Chat.find({}).sort({ createdDate: -1 }),
        Photo.find({}).sort({ createdDate: -1 }),
        Fitness.find({}).sort({ createdDate: -1 }),
        AuditLog.find({}).sort({ createdDate: -1 }),
        
        // --- 新增查询 (默认尝试按 createdDate 倒序，如果没有该字段不影响查询结果) ---
        Conversation.find({}).sort({ updatedAt: -1 }), // 会话通常按更新时间
        ExternalResource.find({}),
        Footprint.find({}).sort({ createdDate: -1 }),
        Homepage.find({}), // 既然是首页配置，可能只有一条或几条
        Log.find({}).sort({ createdDate: -1 }), // 普通日志
        Menu.find({}), // 菜单配置
        Period.find({}), 
        Permission.find({}), // 权限配置
        PermissionRequest.find({}).sort({ createdDate: -1 }), // 权限申请
        Project.find({}).sort({ createdDate: -1 }), // 项目展示
        Resume.find({}), // 简历信息
        Role.find({}), // 角色配置
        Session.find({}).sort({ expires: -1 }) // 会话Session
      ]);

      return { 
        users, posts, comments, todos, chats, photos, fitness, auditLog,
        // 返回新增的数据
        conversations, externalResources, footprints, homepage, logs,
        menus, periods, permissions, permissionRequests, projects,
        resumes, roles, sessions
      };
    };

    // ==========================================
    // 3. 根据 type 参数决定导出内容
    // ==========================================
    if (type) {
      filenamePrefix = type; // 文件名变成 bananaboom-projects-xxx.json
      switch (type) {
        // --- 原有 Case ---
        case 'users':
          data.users = await User.find({}).select('-password');
          break;
        case 'posts':
          data.posts = await Post.find({}).sort({ createdDate: -1 });
          break;
        case 'comments':
          data.comments = await Comment.find({}).sort({ date: -1 });
          break;
        case 'todos':
          data.todos = await Todo.find({}).sort({ timestamp: -1 });
          break;
        case 'chats':
          data.chats = await Chat.find({}).sort({ createdDate: -1 });
          break;
        case 'photos':
          data.photos = await Photo.find({}).sort({ createdDate: -1 });
          break;
        case 'fitness':
          data.fitness = await Fitness.find({}).sort({ createdDate: -1 });
          break;
        case 'audit': // 注意：URL参数叫 audit，但变量叫 auditLog，保持原逻辑
          data.auditLog = await AuditLog.find({}).sort({ createdDate: -1 });
          break;

        // --- 新增 Case ---
        case 'conversations':
          data.conversations = await Conversation.find({}).sort({ updatedAt: -1 });
          break;
        case 'external': // 简化参数名为 external
          data.externalResources = await ExternalResource.find({});
          break;
        case 'footprints':
          data.footprints = await Footprint.find({}).sort({ createdDate: -1 });
          break;
        case 'homepage':
          data.homepage = await Homepage.find({});
          break;
        case 'logs':
          data.logs = await Log.find({}).sort({ createdDate: -1 });
          break;
        case 'menus':
          data.menus = await Menu.find({});
          break;
        case 'periods':
          data.periods = await Period.find({});
          break;
        case 'permissions':
          data.permissions = await Permission.find({});
          break;
        case 'requests': // 简化参数名为 requests
          data.permissionRequests = await PermissionRequest.find({}).sort({ createdDate: -1 });
          break;
        case 'projects':
          data.projects = await Project.find({}).sort({ createdDate: -1 });
          break;
        case 'resume':
          data.resumes = await Resume.find({});
          break;
        case 'roles':
          data.roles = await Role.find({});
          break;
        case 'sessions':
          data.sessions = await Session.find({}).sort({ expires: -1 });
          break;

        default:
          // 如果 type 写错了，默认导出全部
          data = await fetchAll();
          filenamePrefix = 'full';
      }
    } else {
      // 默认情况：导出全部
      data = await fetchAll();
    }

    // ==========================================
    // 4. 组装最终 JSON 并发送
    // ==========================================
    const backupJSON = {
      meta: {
        version: '2.1', // 升级版本号
        exportDate: new Date().toISOString(),
        exporter: req.user ? req.user.displayName : 'System', // 防止 req.user 不存在时报错
        type: type || 'full_backup',
        includedModels: Object.keys(data) // 记录一下这次包里有哪些数据表
      },
      data: data
    };

    // 设置下载响应头
    const dateStr = new Date().toISOString().split('T')[0];
    const filename = `bananaboom-${filenamePrefix}-${dateStr}.json`;

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    // 发送美化后的 JSON (缩进2空格)
    res.send(JSON.stringify(backupJSON, null, 2));

  } catch (error) {
    console.error('Backup error:', error);
    res.status(500).json({ message: 'Server Error during backup', error: error.message });
  }
});

export default router;