# 🍌 Next BananaBoom API

![Status](https://img.shields.io/badge/Status-Production_Ready-success)
![Node](https://img.shields.io/badge/Node.js-v22+-339933?logo=node.js)
![Manager](https://img.shields.io/badge/pnpm-v9+-orange?logo=pnpm)
![Linter](https://img.shields.io/badge/ESLint-v9_Flat_Config-4B32C3?logo=eslint)
![Module](https://img.shields.io/badge/Module-Pure_ESM-yellow)

> **Next-Gen Backend System for Personal Management & Content Delivery.**
> 
> 基于 Node.js 22 原生特性深度重构的现代化后端系统。采用 pnpm 高效管理依赖，全链路 ESM 模块化，并拥有生产级的自动化测试与容器化配置。

## 🚀 核心重构与亮点 (Highlights)

本项目已完成全栈现代化重构，致力于极致的性能与开发体验：

* **⚡️ High Performance**: 切换至 **pnpm**，利用 Hard Links 机制极速安装，杜绝幽灵依赖。
* **📦 Pure ESM Architecture**: 彻底移除 CommonJS，全项目采用 `import/export` 标准规范。
* **🛠 Modern Tooling**: 
    * **ESLint v9**: 采用最新的 Flat Config (`eslint.config.js`)。
    * **Jest (ESM)**: 原生支持 ESM 测试，配合 `mongodb-memory-server` 实现隔离测试。
* **☁️ Cloud Native**: 
    * **Docker**: 针对 pnpm 优化的多阶段构建，镜像体积更小。
    * **Zero-Dependency**: 移除 `dotenv`/`axios`，使用 Node 原生 `--env-file` 和 `fetch`。
* **🛡 Robust Security**: 集成 RBAC 权限控制、Rate-Limiting 限流及完整的审计日志。

## 🛠️ 技术栈 (Tech Stack)

* **Runtime**: Node.js v22.11.1+
* **Package Manager**: **pnpm** (Required)
* **Framework**: Express.js
* **Database**: MongoDB (Atlas Sharded Cluster) + Mongoose ODM
* **Testing**: Jest + Supertest
* **Linting**: ESLint v9 + Prettier
* **AI**: Google Gemini API (Stream Support)

## ⚡ 快速开始 (Getting Started)

### 1. 环境准备

确保本地 Node.js 版本 `>= 22.0.0`，并启用 pnpm。

```bash
# 启用 Node 自带的 corepack (推荐)
corepack enable
corepack prepare pnpm@latest --activate

# 验证
node -v  # v22+
pnpm -v  # v9+

```

### 2. 安装依赖

```bash
pnpm install

```

### 3. 配置文件

在根目录新建 `.env` (生产/开发) 和 `.env.test` (测试)：

```properties
# .env 示例
NODE_ENV=development
PORT=5000
MONGODB_URI=your_mongodb_connection_string
JWT_SECRET=your_jwt_secret
GEMINI_API_KEY=your_ai_key
# ...

```

### 4. 运行项目

**开发模式 (Native Watch Mode):**

```bash
pnpm dev

```

**生产模式:**

```bash
pnpm start

```

## 🧪 测试与质量 (Testing & Quality)

项目包含完整的集成测试与代码质量检查。

```bash
# 运行所有测试 (Jest ESM)
pnpm test

# 代码风格检查 (ESLint v9)
pnpm lint

# 自动格式化 (Prettier)
pnpm format

```

## 🐳 Docker 部署 (Containerization)

Dockerfile 已针对 pnpm 进行深度优化（利用 `pnpm fetch` 缓存依赖）。

```bash
# 构建镜像
docker build -t bananaboom-api .

# 运行容器
docker run -d -p 5000:5000 --env-file .env bananaboom-api

```

## 📂 目录结构 (Structure)

```text
.
├── config/             # 静态配置
├── models/             # Mongoose Schemas
├── routes/             # API 路由 (ESM exports)
├── services/           # 业务逻辑层
├── tests/              # 集成测试
│   ├── setup.js        # 测试环境初始化 (Globals)
│   └── *.test.js       # 测试用例
├── utils/              # 工具库 (HTTP, AI, Logger)
├── eslint.config.js    # ✨ ESLint v9 Flat Config
├── index.js            # 应用入口
├── pnpm-lock.yaml      # ✨ pnpm 锁文件
└── package.json

```

## 👤 作者 (Author)

**Sam Yao (柏杨)**

* Professional Investor @ Jinmu Capital
* Full-stack Developer

---

Copyright © 2025 BananaBoom. All rights reserved.
