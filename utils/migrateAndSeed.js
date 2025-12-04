const mongoose = require('mongoose');
const dotenv = require('dotenv');

// 加载环境变量
dotenv.config();

// ==========================================
// 1. 定义双语 Schema
// ==========================================

// A. [读取用] 旧数据的 Schema (保持不变，用于读取)
const OldSourceSchema = new mongoose.Schema({
  title: String,  // 旧中文标题
  _title: String, // 旧英文标题
  info: String,   // 旧中文简介
  _info: String,  // 旧英文简介
  url: String,
  degree: String,
  degrees: [Number]
}, { strict: false });

// B. [写入用] 新 Project Schema (支持双语)
const NewProjectSchema = new mongoose.Schema({
  title_zh: String,
  title_en: String,
  
  summary_zh: String,
  summary_en: String,
  
  description_zh: String, // 详细介绍(支持Markdown)
  description_en: String,
  
  techStack: [String], // 技术栈通常不分中英文 (React 就是 React)
  repoUrl: String,
  demoUrl: String,
  coverImage: String,
  
  order: { type: Number, default: 0 },
  isVisible: { type: Boolean, default: true }
});

// C. [写入用] 新 Resume Schema (支持双语)
const NewResumeSchema = new mongoose.Schema({
  basics: {
    name_zh: String,
    name_en: String,
    label_zh: String,
    label_en: String,
    email: String,
    phone: String,
    location_zh: String,
    location_en: String,
    summary_zh: String,
    summary_en: String,
  },
  education: [{
    institution: String,
    location: String,
    area_zh: String, // 专业中文
    area_en: String, // 专业英文
    studyType_zh: String, // 学位中文
    studyType_en: String, // 学位英文
    startDate: String,
    endDate: String,
    score_zh: String,
    score_en: String
  }],
  work: [{
    company_zh: String,
    company_en: String,
    position_zh: String,
    position_en: String,
    startDate: String,
    endDate: String,
    // 亮点/职责 (数组)
    highlights_zh: [String],
    highlights_en: [String]
  }],
  skills: [{
    name_zh: String,
    name_en: String,
    keywords: [String]
  }],
  languages: [{
    language_zh: String,
    language_en: String,
    fluency_zh: String,
    fluency_en: String
  }]
});

// ==========================================
// 2. 准备双语数据 (合并你的中英文)
// ==========================================

const bilingualResumeData = {
  basics: {
    name_zh: "姚柏杨",
    name_en: "Baiyang (Sam) Yao",
    label_zh: "资深前端开发工程师 / 全栈开发者",
    label_en: "Senior Frontend Engineer / Full Stack Developer",
    email: "719919153@qq.com",
    phone: "(+86) 189-2936-1675",
    location_zh: "中国 深圳",
    location_en: "Shenzhen, China",
    summary_zh: "拥有4年+经验的资深前端工程师，擅长构建大型Web应用、微前端架构及DevOps平台。精通React生态及Node.js服务端开发。具备跨团队领导能力，善于在敏捷环境中交付高价值结果。",
    summary_en: "Senior Frontend Engineer with over 4 years of experience in building large-scale web applications, micro-frontends, and DevOps platforms. Expert in React ecosystem and Node.js server-side development."
  },
  education: [
    {
      institution: "Miami University",
      location: "OH, USA",
      area_zh: "交互媒体研究 (Interactive Media Studies)",
      area_en: "Interactive Media Studies",
      studyType_zh: "学士学位",
      studyType_en: "Bachelor's Degree",
      startDate: "2015-08",
      endDate: "2019-05",
      score_zh: "院长名单荣誉 (Dean’s List)",
      score_en: "Dean’s List Honor"
    }
  ],
  work: [
    {
      company_zh: "货拉拉科技 (Lalamove)",
      company_en: "Lalamove",
      position_zh: "资深前端开发工程师",
      position_en: "Senior Frontend Engineer",
      startDate: "2021-06",
      endDate: "Present",
      highlights_zh: [
        "负责海外Lalamove Driver App的整体ToC Web开发(React/Vue/Webview)。优化注册接单流程，显著提升转化率与性能。",
        "负责企业客运和货运Driver CRM系统的前后端开发(React+TS+Node.js)，实现司机生命周期一站式管理。",
        "开发Node.js SDK，集成SOA框架、服务发现、监控与Apollo配置，统一后端业务标准。",
        "担任核心项目前端负责人(PIC)，跨团队沟通管理预期，带领团队达成目标。",
        "领导前端技术委员会，主导架构方向，管理需求迭代，指导新人并进行全英文跨国协作。"
      ],
      highlights_en: [
        "Led global Driver App web development (React/Vue/Webview). Optimized flows improving driver conversion rates.",
        "Architected Driver CRM system (React + TS + Node.js) for enterprise logistics.",
        "Developed Node.js SDK with SOA, Service Discovery, and Apollo Config integration.",
        "Served as Project Lead for key initiatives, managing cross-team expectations.",
        "Led Frontend Technical Committee, guiding architecture and mentoring juniors in an English-speaking environment."
      ]
    },
    {
      company_zh: "腾讯云 (CODING)",
      company_en: "Tencent Cloud (CODING)",
      position_zh: "前端开发工程师",
      position_en: "Frontend Engineer",
      startDate: "2020-04",
      endDate: "2021-06",
      highlights_zh: [
        "开发腾讯云DevOps平台核心模块（持续集成、代码管理等），服务腾讯会议、QQ等内部项目。",
        "维护微前端架构(React+Redux+TS)，提升平台综合能力与研发效能。",
        "基于Ant Design开发并维护内部React组件库。"
      ],
      highlights_en: [
        "Developed CODING DevOps platform core modules (CI/CD, Code Management).",
        "Maintained Micro-frontend architecture (React + Redux + TS) improving scalability.",
        "Built internal React Component Library based on Ant Design."
      ]
    },
    {
      company_zh: "BeeHex 3D Print",
      company_en: "BeeHex 3D Print",
      position_zh: "前端开发工程师 (实习)",
      position_en: "Frontend Engineer (Internship)",
      startDate: "2019-05",
      endDate: "2019-09",
      highlights_zh: [
        "从0到1搭建3D食品打印电商平台(React+Redux+TS)，负责页面交互与安全支付。",
        "使用Next.js开发社区系统，通过同构应用优化首屏时间与SEO。"
      ],
      highlights_en: [
        "Built 3D food printing e-commerce platform from scratch (React + Redux + TS).",
        "Developed community system using Next.js for SEO optimization."
      ]
    }
  ],
  skills: [
    { name_zh: "前端", name_en: "Frontend", keywords: ["React", "TypeScript", "Next.js", "Vue", "Redux", "Micro-frontends", "Vite"] },
    { name_zh: "后端", name_en: "Backend", keywords: ["Node.js", "Express", "MongoDB", "SOA", "Docker"] }
  ],
  languages: [
    { language_zh: "中文", language_en: "Chinese", fluency_zh: "母语", fluency_en: "Native" },
    { language_zh: "英语", language_en: "English", fluency_zh: "专业流利 (美本毕业)", fluency_en: "Professional Proficiency" }
  ]
};

// 你的新项目 (双语版)
const manualNewProjects = [
  {
    title_zh: "BananaBoom 私有云",
    title_en: "BananaBoom Private Cloud",
    summary_zh: "全栈家庭私域与量化分析系统",
    summary_en: "Full-Stack Private Domain System",
    description_zh: "基于 Next.js 和 Node.js 构建的私有云系统，集成健身追踪、Socket即时通讯和家庭相册。",
    description_en: "Personal cloud system with fitness tracking, socket chat, and portfolio management.",
    techStack: ["Next.js", "Node.js", "MongoDB", "Socket.io", "Cloud Run"],
    repoUrl: "https://github.com/samyao/next-bananaboom",
    demoUrl: "https://ps5.space",
    order: 100
  },
  {
    title_zh: "货拉拉 Node.js SDK",
    title_en: "Lalamove Node.js SDK",
    summary_zh: "企业级后端基础设施",
    summary_en: "Enterprise Backend Infrastructure",
    description_zh: "设计并实现标准化的 Node.js SDK，集成了服务发现、Apollo配置与监控系统。",
    description_en: "Standardized Node.js SDK integrating Service Discovery and Monitoring.",
    techStack: ["Node.js", "SOA", "Apollo", "gRPC"],
    order: 90
  }
];

// ==========================================
// 3. 执行迁移脚本
// ==========================================

const migrate = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI || require('../config/keys').mongoURI);
    console.log('✅ MongoDB Connected');

    // 1. 注册 Model
    const OldResumeModel = mongoose.model('old_resumes_reader', OldSourceSchema, 'resumes');
    const NewProjectModel = mongoose.model('projects', NewProjectSchema);
    // NewResumeModel 稍后注册

    // 2. 读取旧项目数据
    console.log("Reading old projects from 'resumes'...");
    const oldDocs = await OldResumeModel.find({});
    
    // 3. 转换旧数据 (Mapping)
    const migratedProjects = oldDocs.map(doc => {
      // 智能推断技术栈
      let inferredStack = ["HTML/CSS"];
      const text = (doc._info || doc.info || "").toLowerCase();
      if (text.includes("react")) inferredStack.push("React");
      if (text.includes("vue")) inferredStack.push("Vue");
      if (text.includes("node")) inferredStack.push("Node.js");

      return {
        // 映射双语字段
        title_zh: doc.title || doc._title || "未命名项目",
        title_en: doc._title || doc.title || "Untitled Project",
        
        summary_zh: doc.info || doc._info || "暂无介绍",
        summary_en: doc._info || doc.info || "No summary provided",
        
        description_zh: doc.info, 
        description_en: doc._info,
        
        demoUrl: doc.url,
        techStack: inferredStack,
        order: 10,
        isVisible: true
      };
    });

    // 4. 写入 Projects
    await NewProjectModel.deleteMany({});
    const allProjects = [...manualNewProjects, ...migratedProjects];
    await NewProjectModel.insertMany(allProjects);
    console.log(`🚀 Migrated ${allProjects.length} projects (Bilingual) to 'projects'.`);

    // 5. 写入 Resume
    delete mongoose.connection.models['old_resumes_reader'];
    await mongoose.connection.collection('resumes').deleteMany({});
    
    const NewResumeModel = mongoose.model('resumes', NewResumeSchema);
    await NewResumeModel.create(bilingualResumeData);
    console.log("📄 Seeded Bilingual Resume to 'resumes'.");

    console.log("🎉 All Done!");
    process.exit(0);

  } catch (err) {
    console.error("❌ Error:", err);
    process.exit(1);
  }
};

migrate();