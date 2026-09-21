import Project from '../models/Project.js';

const MAC_CLEAN_REPO_URL = 'https://github.com/yaohuangguan/mac-clean';

const MAC_CLEAN_PROJECT = {
  title_zh: 'Mac Clean · macOS 清理工具',
  title_en: 'Mac Clean',
  summary_zh:
    '面向开发者的安全、交互式 macOS 清理脚本，专注清理可再生成的缓存、日志与构建产物。',
  summary_en:
    'A safe, interactive macOS cleanup tool for developers that targets disposable caches, logs and build artifacts.',
  description_zh:
    'Mac Clean 是一个以安全边界为核心的 macOS CLI 清理工具。它会扫描用户缓存、日志、Xcode DerivedData、npm/pnpm/pip/Gradle/Homebrew 等可再生成数据，逐项展示占用并通过 [Y/n] 交互确认后再清理。脚本刻意避开源码、Git 仓库、Xcode Archives、模拟器数据、Docker 数据、设备备份、Time Machine 快照以及其他持久用户数据。每项操作都会记录清理前后大小，最后汇总逻辑释放空间、磁盘可用空间变化和执行耗时。支持直接通过 curl | bash 运行，同时从 /dev/tty 读取交互输入，避免管道执行时失去确认能力。',
  description_en:
    'Mac Clean is a safety-first macOS CLI cleanup tool for developers. It scans disposable user caches, logs, Xcode DerivedData, npm/pnpm/pip/Gradle/Homebrew data and asks for [Y/n] confirmation before each cleanup. It deliberately avoids source code, Git repositories, Xcode Archives, simulator data, Docker data, device backups, Time Machine snapshots and other persistent user data. Each cleanup is measured before and after, followed by a summary of logical data removed, filesystem free-space change and elapsed time. It also remains interactive when run through curl | bash by reading confirmations from /dev/tty.',
  techStack: ['Bash', 'macOS', 'Shell', 'CLI'],
  repoUrl: MAC_CLEAN_REPO_URL,
  demoUrl: '',
  coverImage: '',
  category: 'tools',
  categories: ['tools'],
  order: 95,
  isVisible: true
};

export const seedPortfolioProjects = async () => {
  const existing = await Project.findOne({ repoUrl: MAC_CLEAN_REPO_URL }).lean();
  if (existing) {
    console.log('🧰 Portfolio seed already exists: Mac Clean');
    return existing;
  }

  const created = await Project.create(MAC_CLEAN_PROJECT);
  console.log(`🧰 Seeded portfolio project: Mac Clean (${created._id})`);
  return created;
};
