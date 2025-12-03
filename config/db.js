const mongoose = require('mongoose');
const MONGO_URI = process.env.MONGO_URI || require('./keys').mongoURI;

const connectDB = async () => {
  try {
    const conn = await mongoose.connect(MONGO_URI);
    console.log(`MongoDB Connected: ${conn.connection.host}`);
    return conn;
  } catch (err) {
    console.error('Error connecting to MongoDB:', err);
    // 🔥 重要：如果连不上数据库，直接杀掉进程，让 Cloud Run 自动重启，
    // 而不是让它挂在那里处理不了请求。
    process.exit(1); 
  }
};

module.exports = connectDB;