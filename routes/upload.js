import { Router } from 'express';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
// 引入优化后的 R2 工具函数
// 注意：listR2Files 现在接受第一个参数 prefix
import { uploadToR2, getPresignedUrl, listR2Files, deleteR2File, R2 } from '../utils/r2.js';
import { ListObjectsV2Command } from '@aws-sdk/client-s3';
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
 * @desc    上传图片到 R2 (强制在 uploads/ 下，支持自定义子目录)
 */
router.post('/', upload.array('files', 10), async (req, res) => {
  try {
    // 1. 基础校验
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ msg: 'No files uploaded.' });
    }

    // ============================================================
    // 2. 核心路径逻辑修改
    // ============================================================
    
    // 根目录固定为 'uploads/'
    const rootDir = 'uploads/'; 
    let subDirectory = '';

    if (req.body.folder) {
      // 🟢 情况 A: 前端指定了文件夹 (例如 "journal" 或 "works/design")
      // 我们只取它的值，去掉开头结尾的斜杠，防止双斜杠
      subDirectory = req.body.folder.replace(/^\/+|\/+$/g, '');
    } else {
      // 🟠 情况 B: 前端没传，使用日期归档 (例如 "2025/12")
      const date = new Date();
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      subDirectory = `${year}/${month}`;
    }

    // 最终前缀: uploads/ + 子目录 + /
    // 结果 A: uploads/journal/
    // 结果 B: uploads/2025/12/
    const finalFolderPrefix = `${rootDir}${subDirectory}/`;

    // ============================================================

    // 3. 并发处理所有文件
    const uploadTasks = req.files.map(async file => {
      const fileExt = path.extname(file.originalname).toLowerCase();
      
      // 拼接文件名: uploads/journal/uuid.jpg
      const fileName = `${finalFolderPrefix}${uuidv4()}${fileExt}`;

      // 执行上传
      const url = await uploadToR2(file.buffer, fileName, file.mimetype);

      // 记录日志
      logOperation({
        operatorId: req.user?.id || 'anonymous',
        action: 'UPLOAD_IMAGE',
        target: fileName,
        details: { size: file.size, originalName: file.originalname, folder: finalFolderPrefix },
        ip: req.ip
      });

      return {
        url,
        name: file.originalname,
        key: fileName
      };
    });

    // 4. 等待完成
    const results = await Promise.all(uploadTasks);

    res.json({
      success: true,
      msg: `Successfully uploaded ${results.length} images`,
      folder: finalFolderPrefix, // 返回给前端看一眼最终存哪了
      data: results
    });

  } catch (error) {
    console.error('Upload Route Error:', error);
    if (error instanceof multer.MulterError) {
      return res.status(400).json({ msg: `Upload validation failed: ${error.message}` });
    }
    res.status(500).json({ msg: error.message || 'Server Error' });
  }
});

// 🛠️ 辅助函数：生成紧凑的时间后缀 (YYYYMMDD-HHmmssSSS)
const getTimeSuffix = () => {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const h = String(now.getHours()).padStart(2, '0');
  const min = String(now.getMinutes()).padStart(2, '0');
  const s = String(now.getSeconds()).padStart(2, '0');
  const ms = String(now.getMilliseconds()).padStart(3, '0'); 
  return `${y}${m}${d}-${h}${min}${s}${ms}`; // 示例: 20251225-203005123
};

/**
 * @route   POST /api/upload/presign
 * @desc    获取上传签名 (支持前端直传 R2)
 * @logic   强制存放在 uploads/ 下，文件名默认追加时间戳以防重名
 */
router.post('/presign', async (req, res) => {
  try {
    // folder: 前端指定的子目录 (e.g., "journal", "works/ui")
    // useOriginalName: true=完全保留原名(慎用，会覆盖), false=原名+时间戳(默认)
    const { fileName, fileType, folder, useOriginalName } = req.body;

    // 1. 基础参数校验
    if (!fileName || !fileType) {
      return res.status(400).json({ msg: 'Missing fileName or fileType' });
    }

    // ============================================================
    // 2. 路径逻辑 (强制在 uploads/ 下)
    // ============================================================
    const rootDir = 'uploads/';
    let subDirectory = '';

    if (folder) {
      // 🟢 情况 A: 前端指定了文件夹
      // 去掉开头和结尾的斜杠，防止路径出现 //
      subDirectory = folder.replace(/^\/+|\/+$/g, '');
    } else {
      // 🟠 情况 B: 前端没传，按日期归档
      const date = new Date();
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      subDirectory = `${year}/${month}`;
    }
    
    // 组合最终文件夹路径: uploads/journal/
    const targetFolder = `${rootDir}${subDirectory}/`;

    // ============================================================
    // 3. 文件名逻辑 (默认使用时间戳，拒绝不可读的 UUID)
    // ============================================================
    let finalKey;
    
    if (useOriginalName) {
      // 🅰️ 强行保留原名 (适合网盘模式，或者你明确想覆盖旧文件)
      // Key: uploads/journal/report.pdf
      finalKey = `${targetFolder}${fileName}`;
    } else {
      // 🅱️ 默认模式：原名 + 时间戳 (推荐)
      // 既保留了文件名的可读性，又防止了重名覆盖
      const ext = path.extname(fileName); // .jpg
      const baseName = path.basename(fileName, ext); // report
      const timeStr = getTimeSuffix(); // 20251225-203005999
      
      // Key: uploads/journal/report-20251225-203005999.jpg
      finalKey = `${targetFolder}${baseName}-${timeStr}${ext}`;
    }

    // 4. 获取 R2 签名
    // 调用 utils/r2.js 中的 helper，返回 uploadUrl 和 publicUrl
    const urlData = await getPresignedUrl(finalKey, fileType);

    // 5. 返回结果给前端
    res.json({
      success: true,
      // 前端用这个 PUT 上传
      uploadUrl: urlData.uploadUrl, 
      // 前端存数据库用这个
      publicUrl: urlData.publicUrl, 
      // 文件的 Key (路径)
      key: finalKey,
      // 告诉前端最终存到哪个文件夹了
      folder: targetFolder
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
        currentRoot: rootPrefix, // e.g. "uploads/"
        currentPath: currentRelativePath, // e.g. "2025/12" (用于显示面包屑：Home > 2025 > 12)
        fullPrefix: fullPrefix // e.g. "uploads/2025/12/" (调试用)
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
        others: ((stats.others.size / totalSize) * 100).toFixed(1)
      }
    };

    res.json({ success: true, usage });
  } catch (error) {
    console.error('Usage Stats Error:', error);
    res.status(500).json({ message: 'Failed to calculate usage', error: error.message });
  }
});

export default router;
