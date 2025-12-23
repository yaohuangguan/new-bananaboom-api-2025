/**
 * 运行命令 (Windows PowerShell):
 * $env:MONGO_URI="你的mongodb地址"; node scripts/migrate_tags.js
 * * 运行命令 (Mac/Linux):
 * MONGO_URI="你的mongodb地址" node scripts/migrate_tags.js
 */

import mongoose from 'mongoose';
// 假设你的 Post 模型文件在 ../models/Post.js，请根据实际位置调整路径
import Post from '../models/Post.js'; 

const MONGO_URI = process.env.MONGO_URI;

if (!MONGO_URI) {
  console.error('❌ 错误: 未找到 MONGO_URI 环境变量。');
  process.exit(1);
}

// ============================================================
// 🏷️ 核心映射表 (左边是旧Tag，右边是清洗后的新Tag)
// null 代表删除该 Tag
// ============================================================
const TAG_MAP = {
  // --- 技术栈 (Tech Stack) ---
  "code": "Tech",
  "tech": "Tech",
  "architecture": "Architecture",
  "system": "Architecture",
  "iam": "Architecture",
  "security": "Architecture",
  "前端": "Frontend",
  "react-dispatch": "Frontend",
  "nextjs": "Frontend",
  "router": "Frontend",
  "browser history": "Frontend",
  "es6": "Frontend",
  "fetch": "Frontend",
  "promise": "Frontend",
  "Axios": "Frontend",
  "闭包": "Frontend",
  "后端": "Backend",
  "npm": "Backend",
  "heroku": "DevOps",
  "now": "DevOps",
  "zeit": "DevOps",
  "移动": "Mobile",
  "域名": "DevOps",
  "登录": "Tech",
  "interview": "Career",
  "update": "Project",
  "newfunction": "Project",
  "需求": "Project",
  "画板": "Project",
  "测试": "Project",
  "blog": "Tech",

  // --- 情感与记忆 (Love & Memory) ---
  "LOVE": "Love",
  "爱你": "Love",
  "想老婆": "Love",
  "老婆语录": "Love",
  "两性生活": "Love",
  "无语": "Love",   // 打情骂俏
  "傻逼": "Love",   // 打情骂俏
  "脏话": "Love",
  "屁": "Love",
  "哈哈": "Love",
  "哈哈哈": "Love",
  "hahahahahahha": "Love",
  "QAQ": "Love",
  "干干干": "Love",
  "咋没人来呢": "Love",
  "垃圾贴文": "Love", // 归档为生活点滴

  // --- 生活与美食 (Life & Food) ---
  "LIFE": "Life",
  "living": "Life",
  "daily": "Life",
  "日常": "Life",
  "生活": "Life",
  "日记": "Life",
  "随笔": "Essay", // 随笔用 Essay 更有质感
  "随便": "Essay",
  "随便写": "Essay",
  "随便写写": "Essay",
  "没啥": "Life",
  "啥也不是": "Life",
  "0": null,
  "游记": "Travel",
  "物流": "Life",
  "一起吃遍天下": "Food", // 独立出一个美食类
  "坚果选购指南": "Food",

  // --- 思考与艺术 (Thoughts & Arts) ---
  "thinking": "Thoughts",
  "思考": "Thoughts",
  "一点思考": "Thoughts",
  "idea": "Ideas",
  "Ideas": "Ideas",
  "想法": "Ideas",
  "Fantastic": "Ideas",
  "没有归类": null,
  "sharing": "Sharing",
  "beautiful": "Arts",
  "文字": "Arts",
  "唐诗": "Arts",
  "english": "Arts",
  "收藏": "Sharing"
};

const migrateTags = async () => {
  try {
    console.log('🔌 Connecting to DB...');
    await mongoose.connect(MONGO_URI);
    console.log('✅ Connected. Starting tag migration...');

    // 获取所有文章
    const posts = await Post.find({});
    let updateCount = 0;

    for (const post of posts) {
      const oldTags = post.tags || [];
      const newTagsSet = new Set();
      let hasChanges = false;

      // 遍历旧标签进行清洗
      oldTags.forEach(tag => {
        let cleanTag = tag;
        // 去除首尾空格
        if (typeof tag === 'string') cleanTag = tag.trim();

        // 查找映射
        const mappedTag = TAG_MAP[cleanTag];

        if (mappedTag === null) {
          // 明确标记为删除的，跳过
          hasChanges = true;
        } else if (mappedTag) {
          // 有映射关系的，使用新标签
          newTagsSet.add(mappedTag);
          if (mappedTag !== cleanTag) hasChanges = true;
        } else {
          // 没有映射关系的：
          // 1. 如果是空字符串，跳过
          if (!cleanTag) {
            hasChanges = true;
            return;
          }
          // 2. 这里的策略是：保留原样，但首字母大写
          const capitalized = cleanTag.charAt(0).toUpperCase() + cleanTag.slice(1);
          newTagsSet.add(capitalized);
          if (capitalized !== cleanTag) hasChanges = true;
        }
      });

      // 只有当标签发生变化时才更新数据库
      // 或者如果 Set 的大小和原数组长度不一样（说明有去重或删除）
      if (hasChanges || newTagsSet.size !== oldTags.length) {
        const finalTags = Array.from(newTagsSet);
        
        console.log(`🔄 Updating Post [${post.name}]:`);
        console.log(`   Old: ${JSON.stringify(oldTags)}`);
        console.log(`   New: ${JSON.stringify(finalTags)}`);

        // 更新数据库
        await Post.updateOne({ _id: post._id }, { $set: { tags: finalTags } });
        updateCount++;
      }
    }

    console.log(`\n🎉 迁移完成！共更新了 ${updateCount} 篇文章的标签。`);
    process.exit(0);

  } catch (err) {
    console.error('❌ Error:', err);
    process.exit(1);
  }
};

migrateTags();