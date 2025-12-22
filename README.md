# 🍌 Next BananaBoom API

![Status](https://img.shields.io/badge/Status-Production_Ready-success)
![Coverage](https://img.shields.io/badge/Tests-29_Passed-brightgreen)
[![Node.js](https://img.shields.io/badge/Node.js-v22+-339933?logo=node.js)](https://nodejs.org/)
[![ESM](https://img.shields.io/badge/Module-Pure_ESM-yellow)](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Modules)

> **Next-Gen Backend System for Personal Management & Content Delivery.**
> 
> 一个基于 Node.js 22+ 原生特性深度重构的现代化后端系统。移除了大量冗余依赖，实现了 100% ESM 模块化，并拥有生产级的测试覆盖。

## 🚀 核心重构与亮点 (Key Highlights)

本项目近期完成了**全栈现代化重构**，致力于“去肥增瘦”与原生性能：

* **Pure ESM Architecture**: 彻底告别 CommonJS，全项目采用 `import/export` 标准模块规范。
* **Zero-Dependency Environment**: 移除 `dotenv`，采用 Node.js 原生 `--env-file` 加载配置。
* **Native Fetch Wrapper**: 移除 `axios`，基于原生 `fetch` 封装了兼容 Axios API 的轻量级请求库（支持拦截器、超时中断）。
* **Modern Testing Stack**: 使用 Jest + `--experimental-vm-modules` 运行 ESM 测试，配合 `mongodb-memory-server` 实现隔离的集成测试。
* **Robust Security**: 集成 RBAC（基于角色的权限控制）、Rate-Limiting（接口限流）、Helmet 防护及详细的审计日志。

## 🛠️ 技术栈 (Tech Stack)

* **Runtime**: Node.js v22.11.1+ (Required)
* **Framework**: Express.js
* **Database**: MongoDB (Atlas Sharded Cluster) + Mongoose ODM
* **Testing**: Jest (ESM Mode) + Supertest + MongoDB Memory Server
* **Real-time**: Socket.io (WebSocket)
* **AI**: Google Gemini API (Stream Support)
* **Tools**: Prettier, ESLint

## 📂 功能模块 (Modules)

### 1. 🔐 核心鉴权 (Auth & Core)
* **RBAC**: 细粒度的角色 (Super Admin / Admin / User) 与权限 (Permissions) 动态管理。
* **Auth**: JWT 认证、Token 刷新机制、Session 缓存。
* **Security**: 关键接口限流 (Rate Limit)、密码剔除策略。

### 2. 📝 内容管理 (CMS)
* **Blog**: 文章发布、Markdown 支持、私有加密文章、点赞互动。
* **Projects & Resume**: 个人项目与简历数据管理。

### 3. 🧬 生活量化 (Life OS)
* **Fitness**: 健身记录追踪。
* **Todo**: 待办事项管理。
* **Footprints**: 足迹地图。

### 4. 🤖 智能与运维 (AI & Ops)
* **AI Agent**: 基于 Gemini 的流式对话接口。
* **Audit**: 全局操作审计日志 (Operator/IP/Action)。
* **Scheduler**: 定时备份与数据清洗任务。

## ⚡ 快速开始 (Getting Started)

### 1. 环境准备
确保本地 Node.js 版本 `>= 22.0.0`。

```bash
node -v
# output should be v22.x or higher

```

### 2. 安装依赖

```bash
npm install

```

### 3. 配置文件

在根目录新建 `.env` (生产/开发) 和 `.env.test` (测试)：

```properties
# .env 示例
PORT=5000
MONGODB_URI=your_mongodb_connection_string
JWT_SECRET=your_secret_key
GEMINI_API_KEY=your_ai_key
# ...

```

### 4. 运行项目

**开发模式 (Native Watch Mode):**
利用 Node 原生 Watch 机制，无需 Nodemon。

```bash
npm run dev

```

**生产模式:**

```bash
npm start

```

## 🧪 自动化测试 (Testing)

项目包含完整的集成测试，覆盖 Auth、RBAC、CRUD 等核心链路。测试环境使用**内存数据库**，不污染真实数据。

```bash
# 运行所有测试
npm run test

```

> **测试策略**:
> 1. 启动 `MongoMemoryServer`。
> 2. 自动播种 (Seed) 基础角色与权限数据。
> 3. 运行测试用例 (Jest ESM)。
> 4. 自动清理业务数据，保留系统配置。
> 
> 

## 📐 目录结构 (Structure)

```text
.
├── config/             # 静态配置 (Constants)
├── models/             # Mongoose Schemas
├── routes/             # API 路由定义 (ESM exports)
├── services/           # 业务逻辑层
├── tests/              # 集成测试 (Integration Tests)
│   ├── setup.js        # 测试环境初始化 (Global Setup)
│   └── *.test.js       # 测试用例
├── utils/              # 工具库 (HTTP, AI, Logger)
├── index.js            # 应用入口
├── jest.config.cjs     # Jest 配置
└── package.json

```

## 👤 作者 (Author)

**Sam Yao (柏杨)**

* Professional Investor @ Jinmu Capital
* Full-stack Developer

---

Copyright © 2025 BananaBoom. All rights reserved.