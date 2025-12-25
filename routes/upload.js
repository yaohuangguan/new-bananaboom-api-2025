import { Router } from 'express';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
// 引入优化后的 R2 工具函数
// 注意：listR2Files 现在接受第一个参数 prefix
import { uploadToR2, getR2PresignedUrl, listR2Files, deleteR2File, ListObjectsV2Command, R2 } from '../utils/r2.js';
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
 * @desc    获取 R2 文件列表 (支持文件夹层级浏览，智能路径修正)
 * @query   limit (默认50), cursor (分页), type ('image' | 'backup'), folder (子目录路径)
 */
router.get('/list', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const cursor = req.query.cursor || undefined;
    const type = req.query.type || 'image';

    // 1. 确定根仓库目录 (Root Prefix)
    let rootPrefix = 'uploads/'; // 默认图片库
    if (type === 'backup') {
      rootPrefix = 'db-backups/';
    }

    // 2. 获取并清洗前端请求的 folder 参数
    // 允许前端传 "2025" 或 "2025/" 或 "uploads/2025"
    let requestFolder = req.query.folder || '';
    
    // 移除开头和结尾的斜杠，防止双斜杠干扰 (e.g. "/2025/" -> "2025")
    requestFolder = requestFolder.replace(/^\/+|\/+$/g, '');

    // 3. 智能拼接最终查询路径 (Full Prefix)
    let fullPrefix = rootPrefix;

    if (requestFolder) {
      // 场景 A: 前端传了完整路径 (e.g. "uploads/2025") -> 直接用
      if (requestFolder.startsWith(rootPrefix)) {
        fullPrefix = requestFolder;
      } 
      // 场景 B: 前端传了相对路径 (e.g. "2025") -> 拼上去
      else {
        fullPrefix = `${rootPrefix}${requestFolder}`;
      }
      
      // 保证必须以 '/' 结尾，否则 R2 无法识别为目录
      if (!fullPrefix.endsWith('/')) {
        fullPrefix += '/';
      }
    }

    // console.log(`[R2 List] Type: ${type}, Folder: "${requestFolder}", FinalPrefix: "${fullPrefix}"`);

    // 4. 调用 R2 工具函数 (传入 '/' 开启文件夹模式)
    const result = await listR2Files(fullPrefix, cursor, limit, '/');

    // 5. 组装返回数据
    // 我们需要计算出“纯净的相对路径”，方便前端面包屑导航使用
    // currentRelativeFolder: 如果 fullPrefix 是 "uploads/2025/12/"，root 是 "uploads/"，那么相对路径就是 "2025/12"
    let currentRelativePath = fullPrefix.replace(rootPrefix, '');
    if (currentRelativePath.endsWith('/')) {
        currentRelativePath = currentRelativePath.slice(0, -1);
    }

    res.json({
      success: true,
      data: {
        // 📁 文件夹列表
        folders: result.folders.map(f => ({
            ...f,
            // 💡 关键优化：给前端一个 ready-to-use 的完整参数
            // 下次点击这个文件夹时，前端直接把这个值塞给 ?folder= 即可
            // 这样前端逻辑就可以无脑一点，不需要自己拼字符串
            nextQueryParam: `${currentRelativePath ? currentRelativePath + '/' : ''}${f.name}`
        })),
        // 📄 文件列表
        files: result.files
      },
      pagination: {
        nextCursor: result.nextCursor,
        hasMore: result.hasMore
      },
      meta: {
        type: type,
        currentRoot: rootPrefix,     // e.g. "uploads/"
        currentPath: currentRelativePath, // e.g. "2025/12" (用于显示面包屑：Home > 2025 > 12)
        fullPrefix: fullPrefix       // e.g. "uploads/2025/12/" (调试用)
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

// 辅助函数：字节转更友好的格式
const formatBytes = (bytes, decimals = 2) => {
  if (!+bytes) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
};

/**
 * @route   GET /api/upload/r2/usage
 * @desc    获取 R2 存储用量统计 (类似 Cloudinary Dashboard)
 */
router.get('/r2/usage', async (req, res) => {
  try {
    let isTruncated = true;
    let continuationToken = undefined;
    
    // 统计数据结构
    const stats = {
      total: { count: 0, size: 0, sizeFormatted: '' },
      images: { count: 0, size: 0, sizeFormatted: '' }, // uploads/
      backups: { count: 0, size: 0, sizeFormatted: '' }, // db-backups/
      others: { count: 0, size: 0, sizeFormatted: '' }
    };

    // 循环分页拉取所有文件 (如果文件几十万可能会慢，但几千个很快)
    while (isTruncated) {
      const command = new ListObjectsV2Command({
        Bucket: process.env.R2_BUCKET_NAME,
        ContinuationToken: continuationToken
      });

      const response = await R2.send(command);
      
      // 遍历当页文件
      (response.Contents || []).forEach(item => {
        const size = item.Size || 0;
        const key = item.Key || '';

        // 总计
        stats.total.count++;
        stats.total.size += size;

        // 分类统计
        if (key.startsWith('uploads/')) {
          stats.images.count++;
          stats.images.size += size;
        } else if (key.startsWith('db-backups/')) {
          stats.backups.count++;
          stats.backups.size += size;
        } else {
          stats.others.count++;
          stats.others.size += size;
        }
      });

      isTruncated = response.IsTruncated;
      continuationToken = response.NextContinuationToken;
    }

    // 格式化大小
    stats.total.sizeFormatted = formatBytes(stats.total.size);
    stats.images.sizeFormatted = formatBytes(stats.images.size);
    stats.backups.sizeFormatted = formatBytes(stats.backups.size);
    stats.others.sizeFormatted = formatBytes(stats.others.size);

    // 计算百分比 (用于前端画进度条)
    const totalSize = stats.total.size || 1; // 防止除以0
    const usage = {
      ...stats,
      percentages: {
        images: ((stats.images.size / totalSize) * 100).toFixed(1),
        backups: ((stats.backups.size / totalSize) * 100).toFixed(1),
        others: ((stats.others.size / totalSize) * 100).toFixed(1),
      }
    };

    res.json({ success: true, usage });

  } catch (error) {
    console.error('Usage Stats Error:', error);
    res.status(500).json({ message: 'Failed to calculate usage', error: error.message });
  }
});

export default router;