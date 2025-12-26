import { Router } from 'express';
const router = Router();
import Chat from '../models/Chat.js';
import Conversation from '../models/Conversation.js'; // 🔥 引用新模型
import { Types } from 'mongoose';
import { generateTitle } from '../utils/aiProvider.js';

// =========================================================================
// 🤖 系统配置区域
// =========================================================================

// 🔥🔥🔥【重要】请确保此 ID 与数据库中真实的 Bot 用户 ID 一致
const AI_USER_ID = '6946005372b6aea1602bf390';

/**
 * 🛡️ 防缓存中间件
 * ----------------------------------------
 * 强制浏览器不缓存 API 响应，确保聊天记录实时刷新
 */
router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

// =========================================================================
// 🛸 第一部分：原有星际聊天室接口 (LEGACY - 保持不动) 🛸
// =========================================================================

/**
 * @route   GET api/chat/public/:roomName
 * @desc    获取公共聊天室/群聊的历史记录
 * @access  Private
 */
router.get('/public/:roomName', async (req, res) => {
  try {
    const { roomName } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const query = {
      room: roomName,
      toUser: null
    };

    const messages = await Chat.find(query)
      .sort({
        createdDate: -1
      })
      .skip(skip)
      .limit(limit);

    res.json(messages.reverse());
  } catch (err) {
    console.error('获取群聊记录失败:', err);
    res.status(500).json({
      msg: 'Server Error'
    });
  }
});

/**
 * @route   GET api/chat/private/:targetUserId
 * @desc    获取私聊历史记录
 * @access  Private
 */
router.get('/private/:targetUserId', async (req, res) => {
  try {
    const targetUserId = req.params.targetUserId;
    const currentUserId = (req.user && req.user.id) || req.userId;

    if (!currentUserId)
      return res.status(401).json({
        msg: '用户未授权'
      });
    if (!Types.ObjectId.isValid(targetUserId))
      return res.status(400).json({
        msg: '无效ID'
      });

    const myId = new Types.ObjectId(currentUserId);
    const targetId = new Types.ObjectId(targetUserId);

    const query = {
      room: 'private',
      $or: [
        {
          'user.id': myId,
          toUser: targetId
        },
        {
          'user.id': targetId,
          toUser: myId
        }
      ]
    };

    const messages = await Chat.find(query)
      .sort({
        createdDate: -1
      })
      .populate('toUser', 'displayName photoURL')
      .populate('user.id', 'displayName photoURL');

    // 数据清洗：确保 displayName 正确显示
    const formattedMessages = messages.map((msg) => {
      const m = msg.toObject();
      if (m.user && m.user.id) {
        const senderInfo = m.user.id;
        m.user.displayName = senderInfo.displayName;
        m.user.photoURL = senderInfo.photoURL;
        m.user.id = senderInfo._id;
      }
      return m;
    });

    res.json(formattedMessages.reverse());
  } catch (err) {
    console.error('❌ 私聊接口报错:', err);
    res.status(500).json({
      msg: 'Server Error'
    });
  }
});

// =========================================================================
// 🧠 第二部分：AI 会话管理接口 (NEW & UPDATED) 🧠
// =========================================================================

/**
 * 🚀 接口 1: 获取会话列表 (侧边栏)
 * ------------------------------------------------------------------
 * @route   GET /api/chat/ai/conversations
 * @desc    获取当前用户所有的 AI 会话列表 (用于渲染左侧侧边栏)
 * @access  Private
 * @return  [ { sessionId, title, lastActiveAt }, ... ]
 */
router.get('/ai/conversations', async (req, res) => {
  try {
    const conversations = await Conversation.find({
      user: req.user.id
    })
      .sort({
        lastActiveAt: -1
      }) // 核心逻辑：按活跃时间倒序，最近聊的排最前
      .limit(50); // 性能优化：限制返回最近 50 个会话
    res.json(conversations);
  } catch (err) {
    console.error('获取会话列表失败:', err);
    res.status(500).json({
      msg: '获取列表失败'
    });
  }
});

/**
 * 🚀 接口 2: 获取具体会话记录 (详情页)
 * ------------------------------------------------------------------
 * @route   GET /api/chat/ai
 * @desc    获取某个特定 Session 的所有聊天记录
 * @query   sessionId (String) - 必填，指定要查看哪个会话
 * @query   page, limit - 分页参数
 * @access  Private
 */
router.get('/ai', async (req, res) => {
  try {
    const userId = req.user.id;
    const { sessionId } = req.query; // 🔥 必须从前端传过来

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    // 基础安全隔离：确保只查该用户的 AI 房间
    const query = {
      room: `ai_session_${userId}`
    };

    // 🔥 核心过滤：只看特定 sessionId 的记录
    // 这样切换侧边栏时，屏幕上就不会显示其他话题的消息
    if (sessionId) {
      query.sessionId = sessionId;
    }

    const messages = await Chat.find(query)
      .sort({
        createdDate: -1
      })
      .skip(skip)
      .limit(limit);

    // 🎭 数据伪装：
    // 数据库存的是真实的 Bot ID (为了数据一致性)，
    // 但前端通过 'ai_assistant' 来判断是否在左侧显示头像，
    // 所以这里临时把 ID 替换一下，保持前端兼容性。
    const formattedMessages = messages.map((msg) => {
      const m = msg.toObject();
      if (m.user && m.user.id && m.user.id.toString() === AI_USER_ID) {
        m.user.id = 'ai_assistant';
      }
      return m;
    });

    res.json(formattedMessages.reverse()); // 翻转数组，让旧消息在上，新消息在下
  } catch (err) {
    console.error('获取AI记录失败:', err);
    res.status(500).json({
      msg: 'Server Error'
    });
  }
});


/**
 * 🚀 接口: 保存消息 + 自动维护会话 + 自动生成标题
 * ------------------------------------------------------------------
 * @route   POST /api/chat/ai/save
 * @desc    1. 保存消息到 Chat 表 (只存 R2 URL，拒绝 Base64)
 * 2. 维护 Conversation 表（创建会话、更新活跃时间）
 * 3. (后台异步) 触发 AI 根据上下文生成简短标题
 * @body    { text, role, sessionId, image }
 * @access  Private
 */
router.post('/ai/save', async (req, res) => {
  try {
    // 确保 req.user 存在 (通常由中间件 auth 设置)
    const userId = req.user ? req.user.id : null;
    if (!userId) {
      return res.status(401).json({ msg: 'Unauthorized' });
    }

    // 参数解构
    // image 预期是 R2 的 URL 字符串
    const { text, content, role, sessionId, image } = req.body;
    
    // 兼容 text 和 content 字段，优先取有值的
    // 如果没有文本但有图片，给个默认提示
    const msgContent = text || content || (image ? '[图片消息]' : '');

    // 1. 基础校验
    if (!sessionId) {
      return res.status(400).json({ msg: '缺少 sessionId，无法保存消息' });
    }
    
    if (!msgContent && !image) {
       return res.status(400).json({ msg: '消息内容不能为空' });
    }

    // 2. 处理图片存储 (只接受 URL)
    const imagesToSave = [];
    if (image) {
      if (typeof image === 'string') {
        if (image.startsWith('http')) {
          // ✅ 情况 A: 是正常的 URL，保存
          imagesToSave.push(image);
        } else if (image.startsWith('data:')) {
          // ❌ 情况 B: 前端发来了 Base64
          // 策略：如果太长就拒绝存入，防止数据库爆炸；如果很短(图标)可以存
          if (image.length > 5000) {
            console.warn('⚠️ [Chat Save] 拒绝存储过大的 Base64 图片，请前端上传 R2 后传 URL');
            // 这里选择不存，或者你可以存一个占位符
          } else {
             imagesToSave.push(image);
          }
        }
      } else if (image.url) {
        // ✅ 情况 C: 对象格式 { url: '...' }
        imagesToSave.push(image.url);
      }
      // 注意：这里不再处理 Gemini 的 inlineData，因为那个是 Base64，太大了
    }

    // 生成 Room ID
    const aiRoomName = `ai_session_${userId}`;

    // 3. 构造发送者对象
    let userObj;
    if (role === 'user') {
      userObj = {
        id: userId,
        displayName: req.user.name || '我',
        photoURL: req.user.photoURL || req.user.avatar || ''
      };
    } else {
      userObj = {
        id: 'ai_assistant', // 固定 ID
        displayName: 'Second Brain',
        photoURL: 'https://cdn-icons-png.flaticon.com/512/4712/4712027.png'
      };
    }

    // 4. 保存具体消息到 Chat 表
    const newMsg = new Chat({
      room: aiRoomName,
      user: userObj,
      content: msgContent,
      toUser: null,
      sessionId: sessionId, // 关联会话 ID
      images: imagesToSave  // 存入干净的 URL 数组
    });

    await newMsg.save();

    // ==========================================================
    // 🔥 核心逻辑：维护 Conversation 表 (侧边栏目录)
    // ==========================================================

    // 5. 查找或创建 Conversation
    let conversation = await Conversation.findOne({ sessionId });

    if (!conversation) {
      // 如果是新会话，创建目录记录
      // 默认标题先取前 15 个字
      const initialTitle = role === 'user' 
        ? (msgContent.substring(0, 15) || '新图片对话')
        : '新对话';

      conversation = new Conversation({
        user: userId,
        sessionId: sessionId,
        title: initialTitle,
        isTitleAutoGenerated: false // 标记为未生成
      });
    }

    // 6. 更新最后活跃时间 (让该会话跳到列表顶部)
    conversation.lastActiveAt = new Date();
    await conversation.save(); 

    // ==========================================================
    // 🤖 AI 自动生成标题逻辑 (异步执行，不阻塞响应)
    // ==========================================================

    // 触发条件：AI 回复了消息 (role !== 'user') 且 标题还未自动生成过
    if (role !== 'user' && !conversation.isTitleAutoGenerated) {
      // 使用立即执行函数进行后台处理
      (async () => {
        try {
          console.log(`🤖 [AutoTitle] 正在后台为会话 ${sessionId} 生成标题...`);

          // A. 查出最近的 3 条消息作为上下文
          const recentChats = await Chat.find({ sessionId })
            .sort({ createdDate: 1 }) // 注意检查你的 Model 是 createdDate 还是 createdAt
            .limit(3);

          if (recentChats.length > 0) {
            // B. 拼接对话文本
            const historyText = recentChats
              .map((m) => `${m.user.displayName}: ${m.content}`)
              .join('\n');

            // C. 调用 Gemini 生成标题 (需确保 generateTitle 已 import)
            const newTitle = await generateTitle(historyText);

            // D. 更新数据库
            if (newTitle) {
              await Conversation.updateOne(
                { sessionId },
                { 
                  title: newTitle, 
                  isTitleAutoGenerated: true // ✅ 标记已完成，以后不再改
                }
              );
              console.log(`✅ [AutoTitle] 标题更新成功: "${newTitle}"`);
            }
          }
        } catch (err) {
          console.error('❌ [AutoTitle] 标题生成失败:', err.message);
        }
      })();
    }

    // 7. 返回结果给前端
    // 为了方便前端使用，把 _id 映射为 id
    const resObj = newMsg.toObject();
    resObj.id = resObj._id.toString();

    res.json(resObj);

  } catch (err) {
    console.error('❌ 保存AI消息失败:', err);
    res.status(500).json({
      msg: 'Server Error',
      error: err.message
    });
  }
});

/**
 * 🚀 接口 4: 删除会话
 * ------------------------------------------------------------------
 * @route   DELETE /api/chat/ai/conversation/:sessionId
 * @desc    删除整个会话（包括目录和所有聊天记录）
 * @access  Private
 */
router.delete('/ai/conversation/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const userId = req.user.id;

    // 1. 删除侧边栏目录项
    await Conversation.deleteOne({
      sessionId,
      user: userId
    });

    // 2. 删除该 ID 下所有的聊天详情
    await Chat.deleteMany({
      sessionId,
      'user.id': userId
    });

    res.json({
      msg: '会话已删除'
    });
  } catch (err) {
    console.error('删除会话失败:', err);
    res.status(500).json({
      msg: 'Server Error'
    });
  }
});

/**
 * 🧹 管理员/测试接口: 清空所有 AI 历史
 * ------------------------------------------------------------------
 * @route   DELETE /api/chat/ai
 */
router.delete('/ai', async (req, res) => {
  try {
    const userId = req.user.id;
    const aiRoomName = `ai_session_${userId}`;

    // 危险操作：清空该用户所有表数据
    await Chat.deleteMany({
      room: aiRoomName
    });
    await Conversation.deleteMany({
      user: userId
    });

    res.json({
      msg: '所有 AI 对话历史已清空'
    });
  } catch (err) {
    res.status(500).json({
      msg: 'Server Error'
    });
  }
});

export default router;
