import { Router } from 'express';
import Stripe from 'stripe';
import User from '../models/User.js';
import systemCache from '../cache/memoryCache.js';

const router = Router();

// 注意：在没有配置环境变量的开发环境里，可以预留一个 Fallback 
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder_key', {
  apiVersion: '2023-10-16' // 尽量锁定最新的常用版本
});

// 以不同的 AI 项目来细化商品 Price ID
const PRICE_MAP = {
  orion_english: {
    monthly: process.env.STRIPE_ORION_MONTHLY || 'price_orion_monthly_placeholder',
    quarterly: process.env.STRIPE_ORION_QUARTERLY || 'price_orion_quarterly_placeholder',
    yearly: process.env.STRIPE_ORION_YEARLY || 'price_orion_yearly_placeholder',
  },
  ai_rpg: {
    monthly: process.env.STRIPE_RPG_MONTHLY || 'price_rpg_monthly_placeholder',
    quarterly: process.env.STRIPE_RPG_QUARTERLY || 'price_rpg_quarterly_placeholder',
    yearly: process.env.STRIPE_RPG_YEARLY || 'price_rpg_yearly_placeholder',
  },
  debater: {
    monthly: process.env.STRIPE_DEBATER_MONTHLY || 'price_debater_monthly_placeholder',
    quarterly: process.env.STRIPE_DEBATER_QUARTERLY || 'price_debater_quarterly_placeholder',
    yearly: process.env.STRIPE_DEBATER_YEARLY || 'price_debater_yearly_placeholder',
  }
};

/**
 * @route   POST /api/payments/create-checkout-session
 * @desc    生成结账跳转链接
 * @access  Private (需经过 auth 中间件)
 */
router.post('/create-checkout-session', async (req, res) => {
  const { projectId, tier } = req.body;
  
  if (!req.user || !req.user.id) {
    return res.status(401).json({ msg: '请先登录' });
  }

  // 1. 验证传入的档次信息和项目名
  if (!PRICE_MAP[projectId]) {
    return res.status(400).json({ msg: '未知的 AI 项目，无法发起订阅' });
  }

  if (!['monthly', 'quarterly', 'yearly'].includes(tier)) {
    return res.status(400).json({ msg: '无效的订阅方案' });
  }
  
  const priceId = PRICE_MAP[projectId][tier];

  try {
    // 2. 调用 Stripe 创建一个结账页面 Session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription', // 这里我们用订阅模式
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      // 🔥 核心：在这里把我们的业务字段藏进去，等 Stripe 收到钱了会原封不动发回给我们
      metadata: {
        userId: req.user.id,
        projectId: projectId, 
        tier: tier
      },
      // 支付成功后的落地页
      success_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
      // 支付取消后的页面
      cancel_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/payment-cancelled`,
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error('[Stripe] Checkout Session Error:', error);
    res.status(500).json({ msg: '生成结账页面失败，请稍后再试' });
  }
});

/**
 * @route   POST /api/payments/webhook
 * @desc    Stripe 回调黑盒接口 (此接口绝对不能被 express.json() 污染)
 * @access  Public (Stripe 发来的，但我们要验证它的官方签名)
 */
router.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_placeholder';

  let event;

  try {
    // 1. 验签 (确保请求确实是 Stripe 发的假不了)
    // ⚠️ 注意：这里要求 req.body 必须是原始 Buffer 格式 (express.raw())
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.error(`[Stripe Webhook] Signature verification failed:`, err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // 2. 处理支付成功事件
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    
    // 取出我们当时塞进去的业务黑话
    const metadata = session.metadata;
    if (metadata && metadata.userId && metadata.projectId && metadata.tier) {
       console.log(`[Stripe Webhook] Processing successful payment for User: ${metadata.userId}, Project: ${metadata.projectId}, Tier: ${metadata.tier}`);
       
       try {
         const user = await User.findById(metadata.userId);
         if (user) {
           // 确保该项目结构存在
           if (!user.aiServices.has(metadata.projectId)) {
             user.aiServices.set(metadata.projectId, { quota: 1, isMember: false, subscriptionTier: 'none', enabled: true });
           }
           
           const serviceObj = user.aiServices.get(metadata.projectId);
           
           // 计算增加的时间 (Date.now() 或者在原有过期时间上累加)
           const baseDate = (serviceObj.subscriptionEnd && serviceObj.subscriptionEnd > new Date()) 
                           ? new Date(serviceObj.subscriptionEnd) 
                           : new Date();
                           
           // 根据 tier 无脑加时间
           if (metadata.tier === 'monthly') baseDate.setMonth(baseDate.getMonth() + 1);
           else if (metadata.tier === 'quarterly') baseDate.setMonth(baseDate.getMonth() + 3);
           else if (metadata.tier === 'yearly') baseDate.setFullYear(baseDate.getFullYear() + 1);

           // 写入凭证
           serviceObj.isMember = true;
           serviceObj.subscriptionTier = metadata.tier;
           serviceObj.subscriptionEnd = baseDate;
           serviceObj.stripeSubscriptionId = session.subscription || null; // 存入包月ID
           
           user.markModified(`aiServices.${metadata.projectId}`);
           await user.save();
           
           // 🔥🔥 关键：自动到账后，把他在系统里的缓存扬了，这样他回到界面马上就能随便用了
           const userCacheKey = `user_ai_services_${metadata.userId}`;
           systemCache.del(userCacheKey);
           
           console.log(`[Stripe Webhook] User ${metadata.userId}'s ${metadata.projectId} subscription extended to ${baseDate}`);
         }
       } catch (dbErr) {
         console.error(`[Stripe Webhook] DB Update Failed:`, dbErr);
       }
    }
  }

  // 3. 返回 200 给 Stripe，示意俺们收到了
  res.status(200).send('Received');
});

export default router;
