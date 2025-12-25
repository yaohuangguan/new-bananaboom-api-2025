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
 * 获取 R2 文件列表 (支持分页)
 * @param {String} cursor - 分页游标 (NextContinuationToken)
 * @param {Number} limit - 每次加载数量 (默认 20)
 */
export const listR2Files = async (cursor, limit = 20) => {
  try {
    const command = new ListObjectsV2Command({
      Bucket: process.env.R2_BUCKET_NAME,
      MaxKeys: limit,
      ContinuationToken: cursor, // 如果有 cursor，说明是加载下一页
      Prefix: 'uploads/' // 可选：只列出 uploads 文件夹下的内容
    });

    const data = await R2.send(command);

    // 格式化返回数据，方便前端直接使用
    const files = (data.Contents || []).map(item => ({
      key: item.Key, // 文件路径 (用于删除)
      url: `${process.env.R2_PUBLIC_DOMAIN}/${item.Key}`, // 公开访问链接
      lastModified: item.LastModified, // 上传时间
      size: item.Size // 文件大小 (字节)
    }));

    return {
      files,
      // 如果还有下一页，R2 会返回 NextContinuationToken
      nextCursor: data.NextContinuationToken || null,
      hasMore: data.IsTruncated // 是否还有更多
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
