import { Router } from 'express';
import User from '../models/User.js';
import Otp from '../models/Otp.js';
import { signAndSyncToken } from '../utils/authUtils.js';
import { verifyIdToken } from '../services/firebaseAdmin.js';
import permissionService from '../services/permissionService.js';
import rateLimit from 'express-rate-limit';

const router = Router();

const otpLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    message: '请求验证码太频繁，请稍后再试'
  }
});
// 🔥 定义你的管理员密钥 (建议放在环境变量中，这里保留你的默认值)
const ADMIN_SECRET = process.env.ADMIN_RESET_SECRET || 'orion';

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

/**
 * @route   POST /api/auth/send-otp
 * @desc    发送登录验证码 / Send verification code
 * @access  Public
 */
router.post('/send-otp', otpLimiter, async (req, res) => {
  try {
    const { identifier } = req.body;
    if (!identifier?.trim()) {
      return res.status(400).json({ message: 'Email or phone number cannot be empty / 邮箱或手机号不能为空' });
    }

    const cleanIdentifier = identifier.trim().toLowerCase();

    // 1. Generate 6-digit verification code
    const code = Math.floor(100000 + Math.random() * 900000).toString();

    // 2. Save code to OTP TTL collection (overwrites previous codes)
    await Otp.findOneAndUpdate(
      { identifier: cleanIdentifier },
      { code, createdAt: new Date() },
      { upsert: true, new: true }
    );

    // 3. Dev mode terminal fallback printing
    const isEmail = cleanIdentifier.includes('@');
    if (process.env.NODE_ENV !== 'production' || !process.env.RESEND_API_KEY) {
      console.log(`\n🔥 [OTP Verification Code Bypass]\nTo: ${cleanIdentifier}\nCode: ${code}\n`);
      return res.json({ success: true, message: 'Verification code sent (printed in terminal console) / 验证码已发送（本地终端控制台已打印）' });
    }

    // 4. Send email via Resend
    if (isEmail) {
      try {
        const response = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            from: process.env.EMAIL_FROM || 'Orion Login <onboarding@resend.dev>',
            to: cleanIdentifier,
            subject: 'Orion Verification Code / 登录验证码',
            html: `
              <div style="font-family: sans-serif; padding: 20px; color: #333; line-height: 1.6;">
                <h2>Orion Authentication / 身份验证</h2>
                <p>Hello! Here is your temporary verification code to log in to your account:</p>
                <p>您好！您的临时登录验证码是：</p>
                <p style="font-size: 28px; font-weight: bold; color: #f43f5e; letter-spacing: 4px; margin: 20px 0;">${code}</p>
                <p>This code is valid for 5 minutes. Please do not share it with anyone.</p>
                <p>该验证码将在 5 分钟后失效，请勿泄露给他人。</p>
              </div>
            `
          })
        });

        if (!response.ok) {
          const errData = await response.json();
          throw new Error(JSON.stringify(errData));
        }

        return res.json({ success: true, message: 'Verification code sent successfully / 验证码发送成功' });
      } catch (err) {
        console.error('Failed to send email via Resend:', err);
        return res.status(500).json({ message: 'Email service delivery failed / 邮件服务发送失败' });
      }
    } else {
      // Phone number simulation
      console.log(`\n📱 [SMS OTP Verification Code Bypass]\nTo: ${cleanIdentifier}\nCode: ${code}\n`);
      return res.json({ success: true, message: 'Verification code sent successfully (SMS Mocked) / 验证码已发送（手机短信模拟模式）' });
    }
  } catch (error) {
    console.error('Send OTP error:', error);
    res.status(500).json({ message: error.message });
  }
});

/**
 * @route   POST /api/auth/verify-otp
 * @desc    Verify OTP and log in / register
 * @access  Public
 */
router.post('/verify-otp', async (req, res) => {
  try {
    const { identifier, code } = req.body;
    if (!identifier?.trim() || !code?.trim()) {
      return res.status(400).json({ message: 'Identifier and Code are required / 标识符和验证码不能为空' });
    }

    const cleanIdentifier = identifier.trim().toLowerCase();
    const cleanCode = code.trim();

    // 1. Verify code
    const otpRecord = await Otp.findOne({ identifier: cleanIdentifier });
    if (!otpRecord || otpRecord.code !== cleanCode) {
      return res.status(400).json({ message: 'Invalid or expired verification code / 验证码错误或已过期' });
    }

    // 2. Remove code on success
    await Otp.deleteOne({ _id: otpRecord._id });

    // 3. Fetch or register user
    const isEmail = cleanIdentifier.includes('@');
    const query = isEmail ? { email: cleanIdentifier } : { phone: cleanIdentifier };

    let user = await User.findOne(query);
    let isProfileCompleted = true;

    if (!user) {
      // Auto-register new users
      const defaultName = isEmail 
        ? cleanIdentifier.split('@')[0] 
        : cleanIdentifier.replace(/\D/g, '').slice(-4) || 'User';
      
      const newUserData = {
        displayName: `User_${defaultName}`,
        isProfileCompleted: false,
        role: 'user'
      };

      if (isEmail) {
        newUserData.email = cleanIdentifier;
      } else {
        newUserData.phone = cleanIdentifier;
      }

      user = new User(newUserData);
      await user.save();
      isProfileCompleted = false;
    } else {
      // Existing user: Unconditionally mark profile as completed to bypass onboarding flow.
      isProfileCompleted = true;
      if (!user.isProfileCompleted) {
        user.isProfileCompleted = true;
        await user.save();
      }
    }

    // 4. Issue JWT Token
    const token = await signAndSyncToken(user);
    const userPayload = permissionService.buildUserPayload(user);

    res.json({
      success: true,
      token,
      isProfileCompleted,
      user: userPayload
    });
  } catch (error) {
    console.error('Verify OTP error:', error);
    res.status(500).json({ message: error.message });
  }
});

/**
 * @route   POST /api/auth/firebase-verify
 * @desc    Verify Firebase ID Token and log in / register
 * @access  Public
 */
router.post('/firebase-verify', async (req, res) => {
  try {
    const { idToken } = req.body;
    if (!idToken?.trim()) {
      return res.status(400).json({ message: 'Firebase idToken is required / 缺少 Firebase idToken' });
    }

    // 1. Verify Firebase token
    const decodedToken = await verifyIdToken(idToken.trim());
    
    // Extract phone number
    const phone = decodedToken.phone_number;
    if (!phone) {
      return res.status(400).json({ message: 'No phone number associated with this token / 此 Token 没有关联的手机号' });
    }

    // 2. Fetch or create user by phone number
    let user = await User.findOne({ phone });
    let isProfileCompleted = true;

    if (!user) {
      // Auto-register new users
      const cleanPhone = phone.replace(/\D/g, '');
      const defaultName = cleanPhone.slice(-4) || 'User';

      user = new User({
        displayName: `User_${defaultName}`,
        phone: phone,
        isProfileCompleted: false,
        role: 'user'
      });
      await user.save();
      isProfileCompleted = false;
    } else {
      // Existing user: Unconditionally mark profile as completed to bypass onboarding flow.
      isProfileCompleted = true;
      if (!user.isProfileCompleted) {
        user.isProfileCompleted = true;
        await user.save();
      }
    }

    // 3. Issue local JWT Token
    const token = await signAndSyncToken(user);
    const userPayload = permissionService.buildUserPayload(user);

    res.json({
      success: true,
      token,
      isProfileCompleted,
      user: userPayload
    });
  } catch (error) {
    console.error('Firebase token verification failed:', error);
    res.status(401).json({ message: error.message || 'Unauthorized: Invalid Firebase token / 验证未通过：Firebase Token 无效' });
  }
});

export default router;
