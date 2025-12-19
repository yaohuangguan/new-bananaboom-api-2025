const mongoose = require("mongoose");

const UserSchema = mongoose.Schema({
  googleId: {
    type: String,
  },
  displayName: {
    type: String,
    required: true
  },
  email: {
    type: String,
    required: true,
    unique: true
  },
  password: {
    type: String,
    required: true
  },
  date: {
    type: String,
    required: true
  },
  photoURL:{
    type:String,
    default:'https://cdn3.iconfinder.com/data/icons/vector-icons-6/96/256-512.png'
  },
  vip:{
    type:Boolean,
    default:false
  },
    // 🔥🔥🔥 新增：健身目标/模式
  // cut: 减脂 (Fat Loss)
  // bulk: 增重/增肌 (Muscle Gain)
  // maintain: 保持 (Maintain)
  fitnessGoal: { 
    type: String, 
    enum: ['cut', 'bulk', 'maintain'], 
    default: 'maintain' 
  }
});

module.exports = mongoose.model("users", UserSchema);
