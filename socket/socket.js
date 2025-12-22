import Chat from '../models/Chat.js';
import {
  CONFIRM_USER,
  USER_CONNECTED,
  LOGOUT,
  ROOM_WELCOME,
  MESSAGE_SENT,
  MESSAGE_RECEIVED,
  PRIVATE_MESSAGE,
  TYPING,
  STOP_TYPING,
  NEW_NOTIFICATION
} from './events.js';

let connectedUsers = {};

// 辅助函数：添加用户
function addUser(userList, user) {
  const newList = Object.assign({}, userList);
  newList[user.name] = user;
  return newList;
}

// 辅助函数：移除用户
function removeUser(userList, username) {
  const newList = Object.assign({}, userList);
  delete newList[username];
  return newList;
}

// 🔥 修复点 1：创建用户对象时，必须包含完整信息 (Email, Photo, DB ID)
function createUser({ name = '', socketId = '', userId = '', email = '', photoURL = '' } = {}) {
  return {
    id: userId, // 对应 MongoDB 的 _id
    socketId, // socket 连接 ID
    name, // 对应 displayName
    email,
    photoURL
  };
}

export default (io) => {
  console.log('⚡ Socket.io Service Started');

  io.on('connection', (socket) => {
    // ===================================
    // 1. 验证用户 (登录前的检查)
    // ===================================
    socket.on(CONFIRM_USER, (nickname, callback) => {
      if (Object.values(connectedUsers).some((u) => u.name === nickname)) {
        callback({
          isUser: true,
          user: null
        });
      } else {
        callback({
          isUser: false,
          // 这里只是临时创建，真正的数据在 USER_CONNECTED 补全
          user: createUser({
            name: nickname,
            socketId: socket.id
          })
        });
      }
    });

    // ===================================
    // 2. 用户上线 (修复版：同时保证私聊和群聊)
    // ===================================
    socket.on(USER_CONNECTED, (user) => {
      // 1. 整理用户信息 (防止前端传参不统一)
      // 这里的 user 是前端传过来的原始数据
      const finalUser = {
        name: user.name,
        socketId: socket.id,
        // 🔥 关键：确保拿到数据库 ID，无论前端传的是 id 还是 _id
        id: user.id || user._id,
        email: user.email,
        photoURL: user.photoURL
      };

      // 2. 挂载到 Socket 和在线列表
      socket.user = finalUser;
      connectedUsers = addUser(connectedUsers, finalUser);

      // ===========================================
      // 🔥 房间管理 (这里是核心)
      // ===========================================

      // A. 加入【私聊】房间 (必须加入自己的 ID 房间，否则收不到私聊)
      if (finalUser.id) {
        socket.join(finalUser.id);
        console.log(`✅ 私聊准备就绪: User ${finalUser.name} joined room ${finalUser.id}`);
      } else {
        console.error(`❌ 私聊不可用: User ${finalUser.name} 缺少 ID!`);
      }

      // B. 加入【群聊】房间 (解决群聊收不到的问题)
      socket.join('public');

      // ===========================================

      // 3. 广播给所有人
      io.emit(USER_CONNECTED, connectedUsers);

      // 4. 欢迎消息
      socket.emit(ROOM_WELCOME, {
        user: '系统管家',
        message: `欢迎回来，${finalUser.name}！`
      });

      console.log(`🟢 ${finalUser.name} is Online`);
    });
    // ===================================
    // 3. 处理群发消息 (已修复：统一字段格式)
    // ===================================
    socket.on(MESSAGE_SENT, async (data) => {
      // 1. 安全校验：强制使用当前 Socket 的用户信息，防止前端伪造
      const sender = socket.user;
      if (!sender) return;

      const targetRoom = data.room || 'public';
      console.log(`📨 Public Message: ${sender.name} -> ${targetRoom}`);

      // 2. 先存入 MongoDB
      let savedChat = null;
      try {
        if (sender.id && data.message) {
          const newChat = new Chat({
            user: {
              displayName: sender.name,
              id: sender.id,
              photoURL: sender.photoURL
            },
            content: data.message, // 数据库字段是 content
            room: targetRoom,
            createdDate: new Date()
          });
          savedChat = await newChat.save();
        }
      } catch (err) {
        console.error('❌ Save public chat error:', err);
      }

      // 3. 构造广播 Payload (关键！)
      // 必须同时包含 message(旧前端用) 和 content(数据库用)，以及完整的 user 对象
      const payload = {
        _id: savedChat ? savedChat._id : new Date().getTime(), // 有 ID 最好传 ID
        message: data.message, // 兼容前端旧写法
        content: data.message, // 标准写法
        room: targetRoom,
        user: {
          id: sender.id,
          displayName: sender.name,
          photoURL: sender.photoURL
        },
        // 使用存库的时间
        createdDate: savedChat ? savedChat.createdDate : new Date()
      };

      // 4. 广播给房间内的所有人
      io.to(targetRoom).emit(MESSAGE_RECEIVED, payload);
    });
    // ===================================
    // 4. 处理私聊消息 (Private)
    // ===================================
    socket.on(PRIVATE_MESSAGE, async ({ receiverName, message }) => {
      const senderUser = socket.user;
      const receiverUser = connectedUsers[receiverName];

      // 校验：发送者必须已登录
      if (!senderUser || !senderUser.id) {
        return console.error('❌ 发送失败：发送者信息不完整');
      }

      // A. 存入 MongoDB (不管对方在不在线都存)
      try {
        // 查找接收者的 ID (如果在线直接拿，不在线可能需要去 DB 查，这里简化为在线才发)
        // 如果你的业务允许给离线发，你需要在这里查 User 表获取 receiverUser ID
        if (receiverUser && receiverUser.id) {
          const newPrivateChat = new Chat({
            user: {
              displayName: senderUser.name,
              id: senderUser.id,
              photoURL: senderUser.photoURL
            },
            toUser: receiverUser.id,
            content: message,
            room: 'private', // 必须标记为 private
            createdDate: new Date()
          });
          await newPrivateChat.save();
        }
      } catch (err) {
        console.error('❌ Save private chat error:', err);
      }

      // B. 实时推送
      if (receiverUser) {
        console.log(`🤫 Private Message: ${senderUser.name} -> ${receiverName}`);

        const newMsgPayload = {
          message,
          isPrivate: true,
          timestamp: new Date(),
          // 统一结构：user 代表发送者
          user: {
            id: senderUser.id,
            displayName: senderUser.name,
            photoURL: senderUser.photoURL
          },
          fromUserId: senderUser.id // 冗余一个 ID 方便前端逻辑
        };

        // 1. 发给接收者 (通过 User ID 房间)
        io.to(receiverUser.id).emit(PRIVATE_MESSAGE, newMsgPayload);

        // 2. 🔥 修复点 5：发送全局通知 (补全 fromUser 里的 ID)
        // 这样前端点击通知跳转时，就有 ID 了
        io.to(receiverUser.id).emit(NEW_NOTIFICATION, {
          type: 'private_message',
          content: `收到来自 ${senderUser.name} 的新消息`,
          fromUser: {
            displayName: senderUser.name,
            email: senderUser.email,
            id: senderUser.id, // <--- 确保这个 ID 存在！
            photoURL: senderUser.photoURL
          },
          timestamp: new Date()
        });

        // 3. 发给自己 (即时反馈)
        socket.emit(PRIVATE_MESSAGE, newMsgPayload);
      } else {
        console.log(`⚠️ User ${receiverName} is offline.`);
        // 可选：回传离线提示
        socket.emit(MESSAGE_RECEIVED, {
          user: {
            displayName: '系统'
          },
          message: `用户 ${receiverName} 当前不在线，消息已保存。`,
          isSystem: true
        });
      }
    });

    // ===================================
    // 5. 正在输入 / 停止输入
    // ===================================
    socket.on(TYPING, ({ chatId, isTyping }) => {
      socket.broadcast.emit(TYPING, {
        user: socket.user.name,
        isTyping
      });
    });

    socket.on(STOP_TYPING, ({ chatId }) => {
      socket.broadcast.emit(STOP_TYPING, {
        user: socket.user.name,
        isTyping: false
      });
    });

    // ===================================
    // 6. 登出 & 断开
    // ===================================
    socket.on(LOGOUT, () => {
      if (socket.user) {
        console.log(`👋 ${socket.user.name} Logged out`);
        socket.leave(socket.user.id);
        connectedUsers = removeUser(connectedUsers, socket.user.name);
        io.emit(USER_CONNECTED, connectedUsers);
        delete socket.user;
      }
    });

    socket.on('disconnect', () => {
      if (socket.user) {
        connectedUsers = removeUser(connectedUsers, socket.user.name);
        io.emit(USER_CONNECTED, connectedUsers);
        console.log(`🔴 ${socket.user.name} Disconnected`);
      }
    });
  });
};
