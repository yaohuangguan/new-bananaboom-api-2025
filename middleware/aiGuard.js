import User from '../models/User.js';
import SystemConfig from '../models/SystemConfig.js';
import systemCache from '../cache/memoryCache.js';

/**
 * AI 服务防刷与额度验证网关
 * @param {string} projectId - 当前请求归属的 AI 项目，例如 'orion_english'
 */
export const aiGuard = (projectId) => {
  return async (req, res, next) => {
    try {
      // 1. 拦截未登录请求 (如果之前被 auth 中间件拦截则这步可省略，但加了更稳妥)
      if (!req.user || !req.user.id) {
        return res.status(401).json({ msg: '请先登录' });
      }

      const userId = req.user.id;

      // 2. 获取全局系统配置 (附带缓存机制)
      const sysCacheKey = 'sys_config_global_settings';
      let config = systemCache.get(sysCacheKey);

      if (!config) {
        config = await SystemConfig.findOne({ configKey: 'global_settings' }).lean();
        
        // 如果首次运行发现配置表为空，生成一条默认全开配置
        if (!config) {
           config = await SystemConfig.create({
              configKey: 'global_settings',
              configValue: {
                 aiServices: {
                    orion_english: true,
                    ai_rpg: true,
                    debater: true,
                    drawing: true,
                    voice2map: true 
                 }
              }
           });
        }
        // 写入缓存，TTL 60秒
        systemCache.set(sysCacheKey, config, 60);
      }

      // 3. 验证全局开关 (是否项目已被整体熔断停止)
      // 注意 configValue 因为是 Mixed 类型，要确保其存在
      const aiServicesConfig = config.configValue?.aiServices || {};
      const isProjectGloballyEnabled = aiServicesConfig[projectId] ?? true;

      // !isProjectGloballyEnabled 或整个系统正在维护
      if (!isProjectGloballyEnabled || config.configValue?.systemMaintenance) {
        return res.status(503).json({ 
          msg: '该服务正在维护中或已暂时下线，请稍后再试。' 
        });
      }

      // 4. 获取最新的用户权现实体 (使用缓存防并发刷量)
      const userCacheKey = `user_ai_services_${userId}`;
      let userAiServicesMap = systemCache.get(userCacheKey);

      if (!userAiServicesMap) {
        const user = await User.findById(userId).select('aiServices');
        if (!user) {
          return res.status(404).json({ msg: '用户不存在' });
        }
        
        userAiServicesMap = {};
        if (user.aiServices && typeof user.aiServices.forEach === 'function') {
           user.aiServices.forEach((value, key) => {
              userAiServicesMap[key] = value;
           });
        }
        // 缓存 60秒
        systemCache.set(userCacheKey, userAiServicesMap, 60);
      }

      // 确保用户的 aiServices Map 存在且初始化过该项目
      const userAiService = userAiServicesMap[projectId];

      if (!userAiService) {
        // 如果项目中没有这个服务，可能是新出的 AI 服务，先给默认放行
        // (或者选择自动帮用户在数据库中 set() 默认值)
        req.aiValidationContext = { isMember: false, quota: 1 };
        return next();
      }

      // 4.1 检查单用户维度的管理员封禁开关
      if (userAiService.enabled === false) {
        return res.status(403).json({ 
          msg: '您暂无权限使用该服务。如果您认为这是一个错误，请联系客服。' 
        });
      }

      // 4.2 优先检查当前时间是否在 VIP 时间范围内
      const now = new Date();
      let isMemberValid = false;
      if (userAiService.subscriptionEnd && new Date(userAiService.subscriptionEnd) > now) {
         isMemberValid = true;
      }
      // 防御：如果你手动改了 isMember = true，但是忘了设置订阅时间，我们也认他是一次性的会员
      if (userAiService.isMember === true) {
         // 根据实际业务而定，通常时间大于 now 才算有效。这里留一条退路
         isMemberValid = true; 
      }

      if (isMemberValid) {
         // 是会员，直接放行，并在上下文中打个标注说明后续无需扣费
         req.aiValidationContext = { isMember: true };
         return next();
      }

      // 4.3 不是会员，检查 Quota 余额
      if (userAiService.quota > 0) {
         // 有余额，放行，记录状态以便后续扣减
         req.aiValidationContext = { isMember: false, quota: userAiService.quota };
         return next();
      }

      // 4.4 次数用光，拦截
      return res.status(403).json({ 
         msg: '试用次数已用完，请弹窗引导开通会员。',
         code: 'QUOTA_EXCEEDED'
      });

    } catch (e) {
      console.error('[AI Guard] Validation failed:', e);
      return res.status(500).json({ msg: '服务器权限校验失败' });
    }
  };
};
