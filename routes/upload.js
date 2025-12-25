import { Router } from 'express';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
// 引入优化后的 R2 工具函数
// 注意：listR2Files 现在接受第一个参数 prefix
import { uploadToR2, getR2PresignedUrl, listR2Files, deleteR2File } from '../utils/r2.js';
import logOperation from '../utils/audit.js';

const router = Router();

// ==========================================
// 1. Multer 配置 (内存模式)
// ==========================================
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024 // 单个文件限制 5MB (如果是 Cloud Run，注意总内存别爆了)
  },
  fileFilter: (req, file, cb) => {
    // 允许图片
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only images are allowed!'), false);
    }
  }
});

// ==========================================
// 2. 路由定义
// ==========================================

/**
 * @route   POST /api/upload
 * @desc    上传图片到 R2 (支持单张或多张并发)
 * @note    前端 FormData 的 field name 必须是 'files'
 */
router.post('/', upload.array('files', 10), async (req, res) => {
  try {
    // 1. 基础校验
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ msg: 'No files uploaded.' });
    }

    // 2. 并发处理所有文件
    // 使用 Promise.all 极大提升多图上传速度
    const uploadTasks = req.files.map(async (file) => {
      // 生成规范文件名: uploads/2025/12/uuid.jpg
      const date = new Date();
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const fileExt = path.extname(file.originalname).toLowerCase();
      // 这里统一放到 uploads/ 目录下
      const fileName = `uploads/${year}/${month}/${uuidv4()}${fileExt}`;

      // 执行上传 (流式)
      const url = await uploadToR2(file.buffer, fileName, file.mimetype);

      // 记录审计日志
      logOperation({
        operatorId: req.user?.id || 'anonymous',
        action: 'UPLOAD_IMAGE',
        target: fileName,
        details: { size: file.size, originalName: file.originalname },
        ip: req.ip
      });

      return {
        url,
        name: file.originalname
      };
    });

    // 3. 等待全部完成
    const results = await Promise.all(uploadTasks);

    // 4. 返回结果
    res.json({
      success: true,
      msg: `Successfully uploaded ${results.length} images`,
      data: results // 返回 [{url, name}, ...] 方便前端展示
    });

  } catch (error) {
    console.error('Upload Route Error:', error);
    // 捕获 Multer 的错误 (如文件太大、数量太多)
    if (error instanceof multer.MulterError) {
      return res.status(400).json({ msg: `Upload validation failed: ${error.message}` });
    }
    res.status(500).json({ msg: error.message || 'Server Error' });
  }
});

/**
 * @route   POST /api/upload/presign
 * @desc    获取大文件(视频)上传签名 URL
 * @note    视频不走服务器流量，直接从浏览器传到 R2
 */
router.post('/presign', async (req, res) => {
  try {
    const { fileName, fileType } = req.body;

    if (!fileName || !fileType) {
      return res.status(400).json({ msg: 'Missing fileName or fileType' });
    }

    // 规范视频存储路径
    const date = new Date();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const ext = path.extname(fileName);
    const storageKey = `uploads/videos/${year}/${month}/${uuidv4()}${ext}`;

    const { uploadUrl, publicUrl } = await getR2PresignedUrl(storageKey, fileType);

    res.json({
      success: true,
      uploadUrl,
      publicUrl,
      storageKey
    });
  } catch (error) {
    console.error('Presign Error:', error);
    res.status(500).json({ msg: 'Failed to generate upload signature' });
  }
});

/**
 * @route   GET /api/upload/list
 * @desc    获取 R2 文件列表 (支持文件夹层级浏览)
 * @query   limit (默认50), cursor (分页), type ('image' | 'backup'), folder (子目录路径)
 */
router.get('/list', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50; // 调大一点，浏览文件更爽
    const cursor = req.query.cursor || undefined;
    const type = req.query.type || 'image';
    
    // 🔥 新增：获取前端想看的子文件夹，例如 "2025-12-25/"
    // 如果是根目录，这个值可能是 undefined 或空字符串
    let subFolder = req.query.folder || '';

    // 1. 确定根仓库 (Root)
    let rootPrefix = 'uploads/';
    if (type === 'backup') {
      rootPrefix = 'db-backups/';
    }

    // 2. 拼接完整查询路径 (Full Prefix)
    // 逻辑：根仓库 + 用户点的子目录
    // 比如: "db-backups/" + "2025-12-25/170xxx/"
    // 注意：我们要防止用户传入的 folder 开头带斜杠导致双斜杠
    if (subFolder.startsWith('/')) subFolder = subFolder.substring(1);
    
    const fullPrefix = subFolder ? (rootPrefix + subFolder) : rootPrefix;

    // 3. 调用 utils (关键：传入 '/' 作为 delimiter)
    // 只有传入 delimiter: '/'，S3 才会把子目录折叠成 CommonPrefixes 返回给我们
    const result = await listR2Files(fullPrefix, cursor, limit, '/');

    // 4. 返回增强后的数据结构
    res.json({
      success: true,
      data: {
        // 分开返回，前端好渲染不同图标
        folders: result.folders, // 📁 文件夹列表
        files: result.files      // 📄 文件列表
      },
      pagination: {
        nextCursor: result.nextCursor,
        hasMore: result.hasMore
      },
      meta: {
        type: type,
        currentRoot: rootPrefix, // 当前的大类根目录
        currentFolder: subFolder, // 当前所在的子目录 (用于前端面包屑导航)
        fullPrefix: fullPrefix   // 实际查询 R2 的路径
      }
    });

  } catch (error) {
    console.error('List Files Error:', error);
    res.status(500).json({ msg: 'Failed to fetch file list', error: error.message });
  }
});

/**
 * @route   DELETE /api/upload
 * @desc    删除 R2 文件
 * @body    { key: "uploads/..." }
 */
router.delete('/', async (req, res) => {
  try {
    const { key } = req.body;

    if (!key) {
      return res.status(400).json({ msg: 'File key is required' });
    }

    // 🛡️ 安全检查：防止有人恶意传 "/" 或空字符串删掉整个 Bucket
    // 只允许删除 uploads/ 或 db-backups/ 开头的文件
    if (!key.startsWith('uploads/') && !key.startsWith('db-backups/')) {
      return res.status(403).json({ msg: 'Permission denied: Invalid file path' });
    }

    await deleteR2File(key);

    // 记录删除日志
    logOperation({
      operatorId: req.user?.id || 'anonymous',
      action: 'DELETE_FILE',
      target: key,
      ip: req.ip
    });

    res.json({
      success: true,
      msg: 'File deleted successfully'
    });
  } catch (error) {
    console.error('Delete File Error:', error);
    res.status(500).json({ msg: 'Failed to delete file' });
  }
});

export default router;