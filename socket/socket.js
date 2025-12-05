const Chat = require("../models/Chat");
const {
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
} = require("./events");

let connectedUsers = {};

// 辅助函数：添加用户
function addUser(userList, user) {
  let newList = Object.assign({}, userList);
  newList[user.name] = user;
  return newList;
}

// 辅助函数：移除用户
function removeUser(userList, username) {
  let newList = Object.assign({}, userList);
  delete newList[username];
  return newList;
}

// 🔥 修复点 1：创建用户对象时，必须包含完整信息 (Email, Photo, DB ID)
function createUser({ name = "", socketId = "", userId = "", email = "", photoURL = "" } = {}) {
  return {
    id: userId,      // 对应 MongoDB 的 _id
    socketId,        // socket 连接 ID
    name,            // 对应 displayName
    email,
    photoURL
  };
}

module.exports = (io) => {
  console.log("⚡ Socket.io Service Started");

  io.on("connection", (socket) => {
    
    // ===================================
    // 1. 验证用户 (登录前的检查)
    // ===================================
    socket.on(CONFIRM_USER, (nickname, callback) => {
      if (Object.values(connectedUsers).some(u => u.name === nickname)) {
        callback({ isUser: true, user: null });
      } else {
        callback({ 
          isUser: false, 
          // 这里只是临时创建，真正的数据在 USER_CONNECTED 补全
          user: createUser({ name: nickname, socketId: socket.id }) 
        });
      }
    });

    // ===================================
    // 2. 用户正式上线 (连接成功)
    // ===================================
   // 在 socket.js 中找到这一段
   socket.on(USER_CONNECTED, (user) => {
      
    // 🕵️‍♀️🕵️‍♀️🕵️‍♀️ 加这几行调试日志！！！
    console.log("---------------------------------------");
    console.log("🔌 SOCKET 收到用户上线请求:", user.name);
    console.log("📦 前端传来的原始数据:", user);
    console.log("🔑 解析出的 ID:", user.id || user._id);
    // ---------------------------------------

    const newUser = createUser({
        name: user.name,
        socketId: socket.id,
        userId: user.id || user._id, // 这里是最关键的
        email: user.email,
        photoURL: user.photoURL
    });

      // 挂载到 socket 实例，方便后续直接取用
      socket.user = newUser;
      
      // 更新在线列表
      connectedUsers = addUser(connectedUsers, newUser);

      // 🔥 修复点 3：加入以 UserID 命名的房间 (多端同步的关键)
      if (newUser.id) {
        socket.join(newUser.id);
        console.log(`🔗 User ${newUser.name} (ID: ${newUser.id}) joined room.`);
      } else {
        console.warn(`⚠️ User ${newUser.name} connected without a valid Database ID!`);
      }
      // 🔥🔥🔥 [新增] 默认加入 "public" 大厅 (群聊用) 🔥🔥🔥
      socket.join("public");
      console.log(`🔗 User ${newUser.name} joined rooms: [${newUser.id || '?'}, "public"]`);

      // 广播更新在线列表
      io.emit(USER_CONNECTED, connectedUsers);

      // 欢迎自己
      socket.emit(ROOM_WELCOME, {
        user: "系统管家",
        message: `欢迎回来，${newUser.name}！`
      });
      
      console.log(`🟢 ${newUser.name} is Online`);
    });

  // ===================================
    // 3. 处理群发消息 (已修复：统一字段格式)
    // ===================================
    socket.on(MESSAGE_SENT, async (data) => {
      // 1. 安全校验：强制使用当前 Socket 的用户信息，防止前端伪造
      const sender = socket.user;
      if (!sender) return; 

      const targetRoom = data.room || "public";
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
        console.error("❌ Save public chat error:", err);
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
          return console.error("❌ 发送失败：发送者信息不完整");
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
               room: "private", // 必须标记为 private
               createdDate: new Date()
             });
             await newPrivateChat.save();
          }
      } catch (err) {
         console.error("❌ Save private chat error:", err);
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
            type: "private_message",
            content: `收到来自 ${senderUser.name} 的新消息`,
            fromUser: { 
                displayName: senderUser.name, 
                email: senderUser.email, 
                id: senderUser.id,    // <--- 确保这个 ID 存在！
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
            user: { displayName: "系统" },
            message: `用户 ${receiverName} 当前不在线，消息已保存。`,
            isSystem: true
        });
      }
    });

    // ===================================
    // 5. 正在输入 / 停止输入
    // ===================================
    socket.on(TYPING, ({ chatId, isTyping }) => {
       socket.broadcast.emit(TYPING, { user: socket.user.name, isTyping });
    });

    socket.on(STOP_TYPING, ({ chatId }) => {
      socket.broadcast.emit(STOP_TYPING, { user: socket.user.name, isTyping: false });
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

    socket.on("disconnect", () => {
      if (socket.user) {
        connectedUsers = removeUser(connectedUsers, socket.user.name);
        io.emit(USER_CONNECTED, connectedUsers);
        console.log(`🔴 ${socket.user.name} Disconnected`);
      }
    });

  });
};