const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const ProjectSchema = new Schema({
  // --- 双语标题 ---
  title_zh: { type: String, required: true },
  title_en: { type: String, required: true },

  // --- 双语简介 (卡片上显示的一句话) ---
  summary_zh: { type: String },
  summary_en: { type: String },

  // --- 双语详情 (支持 Markdown 长文本) ---
  description_zh: { type: String },
  description_en: { type: String },

  // --- 通用字段 ---
  techStack: [{ type: String }], // 技术栈 (如: ["React", "Node.js"])
  
  repoUrl: { type: String },     // GitHub 仓库链接
  demoUrl: { type: String },     // 演示/上线链接
  coverImage: { type: String },  // 封面图 URL

  // --- 管理字段 ---
  order: { type: Number, default: 0 },       // 排序权重 (数字越大越靠前)
  isVisible: { type: Boolean, default: true } // 是否公开展示

}, { timestamps: true });

module.exports = mongoose.model("projects", ProjectSchema);