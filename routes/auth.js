import { Router } from 'express';
const router = Router();
// 🔥 定义你的管理员密钥 (建议放在环境变量中，这里保留你的默认值)
const ADMIN_SECRET = process.env.ADMIN_RESET_SECRET || 'bananaboom-666';

/**
 * POST /api/auth/verify-secret
 * 用于前端验证输入的口令是否正确
 * body: { "secret": "用户输入的字符串" }
 */
router.post('/verify-secret', (req, res) => {
  const { secret } = req.body;

  // 简单的字符串比对
  if (secret === ADMIN_SECRET) {
    return res.json({
      success: true,
      code: 200,
      message: '验证通过'
    });
  } else {
    return res.status(401).json({
      success: false,
      code: 401,
      message: '口令错误'
    });
  }
});

router.post('/subscribe', async (req, res) => {
  const { email } = req.body;
  const data = {
    members: [
      {
        email_address: email,
        status: 'subscribed'
      }
    ]
  };
  const dataString = JSON.stringify(data);
  try {
    const response = await fetch('https://us20.api.mailchimp.com/3.0/lists/4b2f990265', {
      method: 'post',
      headers: {
        Authorization: process.env.MAILCHIMP_API_KEY
      },
      body: dataString
    });
    const data = await response.json();
    console.log(data);
    if (data.status === 404) {
      return res.json({
        message: 'Server error. Please retry later.',
        message_cn: '订阅失败，请重试。',
        status: 'fail'
      });
    } else if (data.status === 403) {
      return res.json({
        message: 'Server error. Please retry later.',
        message_cn: '订阅失败，请重试。',
        status: 'fail'
      });
    }
    if (!data.total_created) {
      res.json({
        message: 'You can not subscribe my list multiple times.',
        message_cn: '这个邮箱已经订阅，请勿重复订阅。',
        status: 'fail'
      });
    } else {
      res.json({
        message: 'All good! Subscribed Successfully!',
        message_cn: '订阅成功！',
        status: 'success'
      });
    }
  } catch (error) {
    console.log(error);
    res.status(400).json({
      message: 'Something wrong. Please try again later.',
      message_cn: '订阅失败，请重试。',
      status: 'fail'
    });
  }
});

export default router;
