import { Upload } from '@aws-sdk/lib-storage';
import {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand
} from '@aws-sdk/client-s3';
// 🔥 必须引入这个包用来生成签名
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// ---------------------------------------------------------
// 1. 初始化 S3 客户端 (直连 Cloudflare R2)
// ---------------------------------------------------------
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
  const domain = (process.env.R2_PUBLIC_DOMAIN || '').replace(/\/$/, '');
  return `${domain}/${key}`;
};

// ---------------------------------------------------------
// 2. 核心功能函数
// ---------------------------------------------------------

/**
 * 上传文件流到 Cloudflare R2 (服务器中转上传)
 */
export const uploadToR2 = async (fileBuffer, fileName, mimeType) => {
  try {
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
 * 生成预签名上传 URL (前端直传专用)
 * @param {String} fileName - 在 R2 中的存储路径
 * @param {String} mimeType - 文件类型
 * @returns {Promise<{uploadUrl: string, publicUrl: string}>}
 */
// ⚡️ 名字统一修改为 getPresignedUrl，方便外部调用
export const getPresignedUrl = async (fileName, mimeType) => {
  try {
    const command = new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: fileName,
      ContentType: mimeType
    });

    // 生成有效期为 1 小时 (3600秒) 的临时上传链接
    const uploadUrl = await getSignedUrl(R2, command, { expiresIn: 3600 });
    const publicUrl = getPublicUrl(fileName);

    // 返回两个地址：
    // uploadUrl: 给前端 PUT 用 (带签名)
    // publicUrl: 给前端存数据库用 (干净链接)
    return { uploadUrl, publicUrl };
  } catch (error) {
    console.error('❌ Generate Presigned URL Error:', error);
    throw error;
  }
};

/**
 * 获取 R2 文件列表 (支持文件夹模式)
 */
export const listR2Files = async (prefix = 'uploads/', cursor, limit = 50, delimiter = '/') => {
  try {
    const command = new ListObjectsV2Command({
      Bucket: process.env.R2_BUCKET_NAME,
      Prefix: prefix,
      MaxKeys: limit,
      ContinuationToken: cursor,
      Delimiter: delimiter // 开启文件夹模式
    });

    const data = await R2.send(command);

    // 1. 处理文件夹 (CommonPrefixes)
    const folders = (data.CommonPrefixes || []).map(item => {
      // "uploads/2025/12/" -> "12"
      const parts = item.Prefix.replace(/\/$/, '').split('/');
      const folderName = parts[parts.length - 1];
      
      return {
        name: folderName,     
        path: item.Prefix,    // 完整路径，用于下钻点击
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
        type: getFileType(item.Key) // 使用下方辅助函数
      };
    });

    // 过滤掉当前目录本身的占位符
    const validFiles = files.filter(f => f.path !== prefix);

    return {
      folders: folders,
      files: validFiles,
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
// 3. 辅助小工具 (内部使用)
// ---------------------------------------------------------

const getFileType = (key) => {
  if (!key) return 'unknown';
  const lowerKey = key.toLowerCase();
  
  if (lowerKey.match(/\.(gzip|gz|zip|sql|bson|tar)$/)) return 'archive';
  if (lowerKey.match(/\.(jpg|jpeg|png|gif|webp|svg|bmp|ico)$/)) return 'image';
  if (lowerKey.match(/\.(mp4|mov|webm|avi|mkv)$/)) return 'video';
  if (lowerKey.match(/\.(pdf|doc|docx|xls|xlsx|ppt|pptx|txt|md)$/)) return 'document';
  return 'file';
};