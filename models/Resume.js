const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const ResumeSchema = new Schema({
  // 1. 基础信息
  basics: {
    name_zh: String,
    name_en: String,
    label_zh: String, // 职位 (如: 资深前端)
    label_en: String,
    email: String,
    phone: String,
    location_zh: String,
    location_en: String,
    summary_zh: String, // 个人简介
    summary_en: String,
  },

  // 2. 教育经历
  education: [{
    institution: String, // 学校名通常不分，或者你可以自己加 _zh/_en
    location: String,
    area_zh: String,      // 专业 (中文)
    area_en: String,      // 专业 (英文)
    studyType_zh: String, // 学位 (中文)
    studyType_en: String, // 学位 (英文)
    startDate: String,
    endDate: String,
    score_zh: String,     // 荣誉/成绩
    score_en: String
  }],

  // 3. 工作经历
  work: [{
    company_zh: String,
    company_en: String,
    position_zh: String,
    position_en: String,
    startDate: String,
    endDate: String,
    // 工作亮点/职责 (数组)
    highlights_zh: [String],
    highlights_en: [String]
  }],

  // 4. 技能清单
  skills: [{
    name_zh: String, // 技能分类 (如: 前端)
    name_en: String, // (Frontend)
    keywords: [String] // 具体技能 (React, Vue...)
  }],

  // 5. 语言能力
  languages: [{
    language_zh: String,
    language_en: String,
    fluency_zh: String, // 母语/流利
    fluency_en: String
  }]

}, { timestamps: true });

module.exports = mongoose.model("resumes", ResumeSchema);