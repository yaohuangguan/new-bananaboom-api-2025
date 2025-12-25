import mongoose from 'mongoose';


const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/your_database_name';

const cleanup = async () => {
  try {
    console.log('🗑️  Connecting to MongoDB for cleanup...');
    await mongoose.connect(MONGO_URI);
    console.log('✅ Connected.');

    const collection = mongoose.connection.collection('posts');

    console.log('🚀 Removing old "createdDate" and "updatedDate" fields...');

    // 🔥 核心操作：$unset
    // 这会将这两个字段从所有文档中物理移除
    const result = await collection.updateMany(
      {}, // 匹配所有文档
      {
        $unset: {
          'createdDate': "", // 值设为空字符串或 1 都可以，效果一样
          'updatedDate': ""
        }
      }
    );

    console.log('------------------------------------------------');
    console.log(`🎉 Cleanup Complete!`);
    console.log(`   Matched Documents: ${result.matchedCount}`);
    console.log(`   Modified Documents: ${result.modifiedCount}`);
    console.log('------------------------------------------------');

  } catch (error) {
    console.error('❌ Cleanup Error:', error);
  } finally {
    await mongoose.disconnect();
    console.log('👋 Connection closed.');
    process.exit();
  }
};

cleanup();