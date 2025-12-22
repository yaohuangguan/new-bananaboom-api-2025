import User from '../models/User.js'; // 确保路径指向你的 User Model

export default async (req, res, next) => {
  try {
    // 1. 确保 auth 中间件已经运行并注入了 req.user
    if (!req.user || !req.user.id) {
      return res.status(401).json({ message: 'Unauthorized: User not identified' });
    }

    // 2. 去数据库查询最新的用户状态
    // 我们只取 vip 字段，提高查询效率
    const user = await User.findById(req.user.id).select('vip');

    // 3. 检查用户是否存在以及是否为 VIP
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    if (!user.vip) {
      // 403 Forbidden 表示已登录但权限不足
      return res.status(403).json({ message: 'Access Denied: VIP only' });
    }

    // 4. 通过验证，放行
    next();
  } catch (error) {
    console.error('CheckPrivate Middleware Error:', error);
    res.status(500).json({ message: 'Server Error during permission check' });
  }
};
