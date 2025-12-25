import { Router } from 'express';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import { uploadToR2, getR2PresignedUrl, listR2Files, deleteR2File } from '../utils/r2.js';
import logOperation from '../utils/audit.js';

const router = Router();

// 配置 Multer: 纯内存处理
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024 // 单个文件限制 5MB
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only images are allowed!'), false);
    }
  }
});

/**
 * @route   POST /api/upload
 * @desc    上传图片到 R2 (支持单张或多张)
 * @note    前端 FormData 的 field name 必须是 'files' (注意是复数)
 */
// 🔥 修改点 1: 使用 upload.array，允许一次最多上传 10 张
router.post('/', upload.array('files', 10), async (req, res) => {
  try {
    // 兼容逻辑：如果前端误传了单文件模式或者没有文件
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        msg: 'No files uploaded.'
      });
    }

    // 🔥 修改点 2: 遍历所有文件，并发上传
    // 使用 Promise.all 并行处理，提高速度
    const uploadTasks = req.files.map(async file => {
      // 生成规范文件名
      const date = new Date();
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const fileExt = path.extname(file.originalname);
      const fileName = `uploads/${year}/${month}/${uuidv4()}${fileExt}`;

      // 执行上传
      const url = await uploadToR2(file.buffer, fileName, file.mimetype);

      // (可选) 记录单条审计日志
      // 也可以在循环外记录一条总日志 "Uploaded X images"

      logOperation({
        operatorId: req.user?.id || 'anonymous',
        action: 'UPLOAD_IMAGE',
        target: fileName,
        ip: req.ip
      });

      return url;
    });

    // 等待所有上传完成
    const urls = await Promise.all(uploadTasks);

    // 4. 返回成功结果 (数组)
    res.json({
      success: true,
      urls: urls, // 返回 URL 数组
      msg: `Successfully uploaded ${urls.length} images`
    });
  } catch (error) {
    console.error('Upload Route Error:', error);
    if (error instanceof multer.MulterError) {
      // 处理 Multer 报错，比如超过文件数量限制
      return res.status(400).json({
        msg: `Upload error: ${error.message}`
      });
    }
    res.status(500).json({
      msg: error.message || 'Server Error'
    });
  }
});

/**
 * @route   POST /api/upload/presign
 * @desc    获取大文件(视频)上传签名
 * @note    视频通常是一个个传，保持原样即可
 */
router.post('/presign', async (req, res) => {
  try {
    const { fileName, fileType } = req.body;

    if (!fileName || !fileType) {
      return res.status(400).json({
        msg: 'Missing fileName or fileType'
      });
    }

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
    res.status(500).json({
      msg: 'Failed to generate upload signature'
    });
  }
});
/**
 * @route   GET /api/upload/list
 * @desc    获取 R2 文件列表 (媒体库)
 * @query   limit (可选, 默认20), cursor (可选, 加载下一页用)
 */
router.get('/list', async (req, res) => {
    try {
      const limit = parseInt(req.query.limit) || 20;
      const cursor = req.query.cursor || undefined; // undefined 也就是第一页
  
      // 这里拿到的 result 已经是清洗过的干净数据了
      const result = await listR2Files(cursor, limit);
  
      res.json({
        success: true,
        data: result.items,       // 统一放在 data 字段里
        pagination: {             // 分页信息单独放
          nextCursor: result.nextCursor,
          hasMore: result.hasMore
        }
      });
    } catch (error) {
      console.error('List Files Error:', error);
      res.status(500).json({ msg: 'Failed to fetch file list' });
    }
  });

/**
 * @route   DELETE /api/upload
 * @desc    删除 R2 文件
 * @body    { key: "uploads/2025/12/abc.jpg" }
 */
router.delete('/', async (req, res) => {
  try {
    const { key } = req.body;

    if (!key) {
      return res.status(400).json({
        msg: 'File key is required'
      });
    }

    // 安全检查：防止删除非 uploads 目录下的核心文件 (可选)
    // if (!key.startsWith('uploads/')) {
    //   return res.status(403).json({ msg: 'Permission denied' });
    // }

    await deleteR2File(key);

    res.json({
      success: true,
      msg: 'File deleted successfully'
    });
  } catch (error) {
    console.error('Delete File Error:', error);
    res.status(500).json({
      msg: 'Failed to delete file'
    });
  }
});

export default router;
