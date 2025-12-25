import { Upload } from '@aws-sdk/lib-storage';
import {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// ---------------------------------------------------------
// 1. 初始化 S3 客户端 (直连 Cloudflare R2)
// ---------------------------------------------------------
// 🔥 导出 R2 实例，方便 backup-to-r2.js 等其他脚本复用
export const R2 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
  }
});

// 🛠️ 内部辅助函数：安全拼接域名和文件路径
const getPublicUrl = (key) => {
  // 去掉环境变量末尾可能多余的斜杠
  const domain = (process.env.R2_PUBLIC_DOMAIN || '').replace(/\/$/, '');
  return `${domain}/${key}`;
};

// ---------------------------------------------------------
// 2. 核心功能函数
// ---------------------------------------------------------

/**
 * 上传文件流到 Cloudflare R2
 * @param {Buffer} fileBuffer - 文件内存 Buffer
 * @param {String} fileName - 存储路径/文件名 (e.g. "uploads/2025/abc.png")
 * @param {String} mimeType - 文件类型
 */
export const uploadToR2 = async (fileBuffer, fileName, mimeType) => {
  try {
    // 使用流式上传 (lib-storage)，适合 Cloud Run 内存受限环境
    const upload = new Upload({
      client: R2,
      params: {
        Bucket: process.env.R2_BUCKET_NAME,
        Key: fileName,
        Body: fileBuffer,
        ContentType: mimeType
      }
    });

    await upload.done();

    return getPublicUrl(fileName);
  } catch (error) {
    console.error('❌ R2 Upload Error:', error);
    throw new Error('Image upload failed');
  }
};

/**
 * 生成预签名上传 URL (用于大文件/视频 前端直传)
 * @param {String} fileName - 在 R2 中的存储路径
 * @param {String} mimeType - 文件类型
 * @returns {Promise<Object>} - { uploadUrl, publicUrl }
 */
export const getR2PresignedUrl = async (fileName, mimeType) => {
  try {
    const command = new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: fileName,
      ContentType: mimeType
      // R2 不支持 ACL，权限完全由 Bucket 设置决定
    });

    // 生成有效期为 1 小时 (3600秒) 的临时上传链接
    const uploadUrl = await getSignedUrl(R2, command, { expiresIn: 3600 });
    const publicUrl = getPublicUrl(fileName);

    return { uploadUrl, publicUrl };
  } catch (error) {
    console.error('❌ Generate Presigned URL Error:', error);
    throw error;
  }
};

/**
 * 获取 R2 文件列表 (支持文件夹模式)
 * @param {String} prefix - 完整前缀 (e.g. "db-backups/2025-01-01/")
 * @param {String} cursor - 分页游标
 * @param {Number} limit - 数量
 * @param {String} delimiter - 分隔符 (传 '/' 开启文件夹模式，不传则列出所有后代文件)
 */
export const listR2Files = async (prefix = 'uploads/', cursor, limit = 50, delimiter = '/') => {
  try {
    const command = new ListObjectsV2Command({
      Bucket: process.env.R2_BUCKET_NAME,
      Prefix: prefix,
      MaxKeys: limit,
      ContinuationToken: cursor,
      Delimiter: delimiter // 🔥 核心：告诉 R2 按斜杠分组
    });

    const data = await R2.send(command);

    // 1. 处理文件夹 (CommonPrefixes)
    // R2 返回的 Prefix 是完整路径，例如 "db-backups/2025-12-25/"
    // 我们需要解析出纯文件夹名给前端展示
    const folders = (data.CommonPrefixes || []).map(item => {
      // 技巧：移除末尾斜杠，然后取最后一个分段
      // "db-backups/2025-12-25/" -> "2025-12-25"
      const parts = item.Prefix.replace(/\/$/, '').split('/');
      const folderName = parts[parts.length - 1];
      
      return {
        name: folderName,     // 展示名称: "2025-12-25"
        path: item.Prefix,    // 完整路径: "db-backups/2025-12-25/" (点击进入下一级用)
        type: 'folder'
      };
    });

    // 2. 处理文件 (Contents)
    const files = (data.Contents || []).map(item => {
      const fileName = item.Key.split('/').pop();
      return {
        id: item.Key,
        url: getPublicUrl(item.Key),
        name: fileName,
        path: item.Key,
        size: item.Size,
        lastModified: item.LastModified,
        type: 'file' // 或者调用你之前的 getFileType(item.Key)
      };
    });

    // 过滤掉“当前文件夹本身”的占位符 (S3 有时会返回 key 等于 prefix 的 0 字节对象)
    const validFiles = files.filter(f => f.path !== prefix);

    return {
      folders: folders,      // 📁
      files: validFiles,     // 📄
      nextCursor: data.NextContinuationToken || null,
      hasMore: !!data.IsTruncated,
      totalCount: data.KeyCount
    };
  } catch (error) {
    console.error('❌ List R2 Files Error:', error);
    throw error;
  }
};

/**
 * 删除 R2 中的文件
 * @param {String} key - 文件路径 (例如 uploads/2025/01/abc.jpg)
 */
export const deleteR2File = async (key) => {
  try {
    const command = new DeleteObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: key
    });

    await R2.send(command);
    return true;
  } catch (error) {
    console.error('❌ Delete R2 File Error:', error);
    throw error;
  }
};

// ---------------------------------------------------------
// 3. 辅助小工具
// ---------------------------------------------------------

// 根据后缀名猜类型 (前端 UI 图标展示用)
const getFileType = (key) => {
  if (!key) return 'unknown';
  const lowerKey = key.toLowerCase();
  
  if (lowerKey.match(/\.(gzip|gz|zip|sql|bson)$/)) return 'archive'; // 📦 备份文件
  if (lowerKey.match(/\.(jpg|jpeg|png|gif|webp|svg)$/)) return 'image';
  if (lowerKey.match(/\.(mp4|mov|webm|avi)$/)) return 'video';
  return 'file';
};