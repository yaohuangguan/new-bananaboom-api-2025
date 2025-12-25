import { Upload } from '@aws-sdk/lib-storage';
import {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command, // 🔥 新增
  DeleteObjectCommand // 🔥 新增
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// 1. 初始化 S3 客户端 (直连 Cloudflare R2)
const R2 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
  }
});

/**
 * 上传文件流到 Cloudflare R2
 * @param {Buffer} fileBuffer - 文件内存 Buffer
 * @param {String} fileName - 存储路径/文件名
 * @param {String} mimeType - 文件类型
 */
export const uploadToR2 = async (fileBuffer, fileName, mimeType) => {
  try {
    // 使用流式上传，适合 Cloud Run 内存环境
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

    // 拼接公开访问 URL
    // 确保你在 Cloudflare R2 后台绑定了域名，或者开启了 R2.dev
    return `${process.env.R2_PUBLIC_DOMAIN}/${fileName}`;
  } catch (error) {
    console.error('❌ R2 Upload Error:', error);
    throw new Error('Image upload failed');
  }
};

/**
 * 生成预签名上传 URL (用于大文件直传)
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
      // ACL: 'public-read' // R2 不支持 ACL，靠 Bucket 自身的公开设置
    });

    // 生成一个有效期为 1 小时 (3600秒) 的临时上传链接
    const uploadUrl = await getSignedUrl(R2, command, { expiresIn: 3600 });

    // 生成最终的公开访问链接
    const publicUrl = `${process.env.R2_PUBLIC_DOMAIN}/${fileName}`;

    return { uploadUrl, publicUrl };
  } catch (error) {
    console.error('❌ Generate Presigned URL Error:', error);
    throw error;
  }
};

/**
 * 获取 R2 文件列表 (经过清洗的标准数据)
 * @param {String} cursor - 分页游标
 * @param {Number} limit - 数量
 */
export const listR2Files = async (cursor, limit = 20) => {
  try {
    const command = new ListObjectsV2Command({
      Bucket: process.env.R2_BUCKET_NAME,
      MaxKeys: limit,
      ContinuationToken: cursor,
      Prefix: 'uploads/' // 建议只列出 uploads 目录
    });

    const data = await R2.send(command);

    // 🔥 核心步骤：数据清洗 (Data Mapping)
    // 把 S3 的原生字段映射成前端友好的字段
    const files = (data.Contents || []).map(item => {
      // 提取文件名 (去掉路径)
      // 例如: uploads/2025/01/abc.jpg -> abc.jpg
      const fileName = item.Key.split('/').pop();

      return {
        id: item.Key, // 唯一标识 (用于删除)
        url: `${process.env.R2_PUBLIC_DOMAIN}/${item.Key}`, // 拼接完整链接
        name: fileName, // 纯文件名 (前端展示用)
        path: item.Key, // 完整路径
        size: item.Size, // 大小 (字节)
        type: getFileType(item.Key), // 简单的类型判断 (见下方辅助函数)
        createdAt: item.LastModified // ISO 时间格式
      };
    });

    return {
      items: files, // 改名叫 items，比 files 更通用
      nextCursor: data.NextContinuationToken || null, // 游标
      hasMore: !!data.IsTruncated, // 是否还有更多
      totalCount: data.KeyCount // 本次返回的数量
    };
  } catch (error) {
    console.error('❌ List R2 Files Error:', error);
    throw error;
  }
};

// 辅助小函数：根据后缀名猜类型
const getFileType = key => {
  if (!key) return 'unknown';
  if (key.match(/\.(jpg|jpeg|png|gif|webp|svg)$/i)) return 'image';
  if (key.match(/\.(mp4|mov|webm|avi)$/i)) return 'video';
  return 'file';
};

/**
 * 删除 R2 中的文件
 * @param {String} key - 文件路径 (例如 uploads/2025/01/abc.jpg)
 */
export const deleteR2File = async key => {
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
