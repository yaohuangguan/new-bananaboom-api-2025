import { Schema, model } from 'mongoose';

const ResumeSchema = new Schema(
  {
    // 🔥 新增这个字段，用来区分是谁的简历
    // unique: true 确保每个人只有一个标识
    slug: {
      type: String,
      required: true,
      unique: true,
      default: 'sam'
    },
    user: {
      type: Schema.Types.ObjectId,
      ref: 'users',
      required: true
    },
    title: {
      type: String,
      required: true,
      default: '默认简历'
    },
    isHomepage: {
      type: Boolean,
      default: false
    },
    // 🔥 Custom section ordering
    sectionOrder: {
      type: [String],
      default: ['profile', 'work', 'projects', 'education', 'skills', 'volunteer', 'interest']
    },
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
      visaStatus_zh: String,
      visaStatus_en: String,
      summary_zh: String, // 个人简介
      summary_en: String,
      website: String,
      linkedin: String
    },

    // 2. 教育经历
    education: [
      {
        institution: String, // 学校名通常不分，或者你可以自己加 _zh/_en
        location: String,
        area_zh: String, // 专业 (中文)
        area_en: String, // 专业 (英文)
        studyType_zh: String, // 学位 (中文)
        studyType_en: String, // 学位 (英文)
        startDate: String,
        endDate: String,
        score_zh: String, // 荣誉/成绩
        score_en: String,
        pageBreakBefore: {
          type: Boolean,
          default: false
        }
      }
    ],

    // 3. 工作经历
    work: [
      {
        company_zh: String,
        company_en: String,
        position_zh: String,
        position_en: String,
        startDate: String,
        endDate: String,
        // 工作亮点/职责 (数组)
        highlights_zh: [String],
        highlights_en: [String],
        location_zh: String,
        location_en: String,
        weight: Number,
        isProject: Boolean,
        pageBreakBefore: {
          type: Boolean,
          default: false
        }
      }
    ],

    // 4. 技能清单
    skills: [
      {
        name_zh: String, // 技能分类 (如: 前端)
        name_en: String, // (Frontend)
        keywords: [String], // 具体技能 (React, Vue...)
        pageBreakBefore: {
          type: Boolean,
          default: false
        }
      }
    ],

    // 5. 志愿活动
    volunteer: [
      {
        organization_zh: String,
        organization_en: String,
        position_zh: String,
        position_en: String,
        startDate: String,
        endDate: String,
        highlights_zh: [String],
        highlights_en: [String],
        pageBreakBefore: {
          type: Boolean,
          default: false
        }
      }
    ],

    // 6. 兴趣爱好
    interest: [
      {
        name_zh: String,
        name_en: String,
        keywords: [String],
        pageBreakBefore: {
          type: Boolean,
          default: false
        }
      }
    ],

    // 7. 语言能力
    languages: [
      {
        language_zh: String,
        language_en: String,
        fluency_zh: String, // 母语/流利
        fluency_en: String
      }
    ],
    // 🔥 Styling Settings & Page limits
    styleSettings: {
      fontSize: { type: String, default: 'normal' },
      lineHeight: { type: String, default: 'normal' },
      themeColor: { type: String, default: 'slate' },
      margin: { type: String, default: 'normal' },
      sectionGap: { type: String, default: 'normal' },
      pdfMode: { type: String, default: 'single-page' },
      paperSize: { type: String, default: 'a4' },
      customStyles: { type: Map, of: Schema.Types.Mixed, default: {} }
    },
    pageLimit: {
      type: Number,
      default: 0 // 0 means no limit
    },
    sectionTitles: {
      profile_zh: { type: String, default: '个人简介' },
      profile_en: { type: String, default: 'Profile' },
      work_zh: { type: String, default: '工作经历' },
      work_en: { type: String, default: 'Work Experience' },
      projects_zh: { type: String, default: '作品项目' },
      projects_en: { type: String, default: 'Featured Projects' },
      education_zh: { type: String, default: '教育经历' },
      education_en: { type: String, default: 'Education' },
      skills_zh: { type: String, default: '专业技能' },
      skills_en: { type: String, default: 'Skills' },
      volunteer_zh: { type: String, default: '志愿活动' },
      volunteer_en: { type: String, default: 'Volunteer' },
      interest_zh: { type: String, default: '兴趣爱好' },
      interest_en: { type: String, default: 'Interests' }
    }
  },
  { timestamps: true }
);

export default model('resumes', ResumeSchema);
