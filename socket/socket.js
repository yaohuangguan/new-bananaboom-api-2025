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

// 辅助函数：创建用户对象
function createUser({ name = "", socketId = "", userId = "" } = {}) {
  return {
    id: userId, // 用户的数据库ID
    socketId,   // 当前连接的 socket ID
    name,       // 用户名
  };
}

module.exports = (io) => {
  console.log("⚡ Socket.io Service Started");

  io.on("connection", (socket) => {
    
    // ===================================
    // 1. 验证用户 (登录前的检查)
    // ===================================
    socket.on(CONFIRM_USER, (nickname, callback) => {
      // 检查用户名是否已存在于在线列表
      if (Object.values(connectedUsers).some(u => u.name === nickname)) {
        callback({ isUser: true, user: null });
      } else {
        // 这里暂时还没拿到 userId，等 USER_CONNECTED 时前端会传完整的过来
        callback({ 
          isUser: false, 
          user: createUser({ name: nickname, socketId: socket.id }) 
        });
      }
    });

    // ===================================
    // 2. 用户正式上线 (连接成功)
    // ===================================
    socket.on(USER_CONNECTED, (user) => {
      // 更新用户的 socketId (因为刷新页面 socketId 会变)
      user.socketId = socket.id;
      
      // 将用户加入在线列表
      connectedUsers = addUser(connectedUsers, user);
      
      // 将当前用户信息挂载到 socket 对象上，方便后续使用
      socket.user = user;

      // 🔥 关键步骤：让 Socket 加入以 UserID 命名的房间
      // 这样无论用户打开多少个标签页，只要 ID 一样，都能收到消息
      if (user.id) {
        socket.join(user.id);
        console.log(`🔗 User ${user.name} (ID: ${user.id}) joined their private room.`);
      }

      // 广播给所有人：更新侧边栏在线用户列表
      io.emit(USER_CONNECTED, connectedUsers);

      // 只发给当前用户：欢迎消息
      socket.emit(ROOM_WELCOME, {
        user: "系统管家",
        message: `欢迎回来，${user.name}！这里是你的私有聊天室。`
      });
      
      console.log(`🟢 ${user.name} is Online`);
    });

    // ===================================
    // 3. 处理群发消息 (Public / Room)
    // ===================================
    socket.on(MESSAGE_SENT, async (data) => {
      // data 结构: { message: "...", author: "...", userId: "...", room: "..." }
      console.log("📨 Group Message received:", data);

      // A. 存入 MongoDB
      try {
        if (data.userId && data.message) {
            const newChat = new Chat({
                user: { 
                    name: data.author, 
                    id: data.userId,
                },
                content: data.message,
                room: data.room || "public", // 默认为大厅
                createdDate: new Date()
            });

            await newChat.save();
        }
      } catch (err) {
        console.error("❌ Save public chat error:", err);
      }

      // B. 广播给房间内的所有人 (包括发送者自己)
      const targetRoom = data.room || "public";
      io.to(targetRoom).emit(MESSAGE_RECEIVED, data);
    });

    // ===================================
    // 4. 处理私聊消息 (Private)
    // ===================================
    socket.on(PRIVATE_MESSAGE, async ({ receiverName, message }) => {
      const senderUser = socket.user; // 从 socket 中获取发送者信息
      
      // 从在线列表中查找接收者信息
      const receiverUser = connectedUsers[receiverName];
      
      // A. 存入 MongoDB
      try {
          if (senderUser && receiverUser) {
             const newPrivateChat = new Chat({
               user: { 
                   name: senderUser.name, 
                   id: senderUser.id 
               },
               toUser: receiverUser.id, // 存入接收者的 Database ID
               content: message,
               room: "private",
               createdDate: new Date()
             });
             await newPrivateChat.save();
          }
      } catch (err) {
         console.error("❌ Save private chat error:", err);
      }

      // B. 消息推送逻辑
      if (receiverUser) {
        console.log(`🤫 Private Message: ${senderUser.name} -> ${receiverName}`);

        const newMsgPayload = {
          message,
          author: senderUser.name,
          fromUserId: senderUser.id,
          isPrivate: true,
          timestamp: new Date()
        };
        
        // 1. 发给接收者 (通过 User ID 房间投送，覆盖多端/多页面)
        // 这里的 receiverUser.id 必须和 USER_CONNECTED 里的 user.id 一致
        io.to(receiverUser.id).emit(PRIVATE_MESSAGE, newMsgPayload);

        // 2. 🔥 发送全局通知 (用于右上角铃铛、红点等，独立于聊天内容)
        io.to(receiverUser.id).emit(NEW_NOTIFICATION, {
            type: "private_message",
            content: `收到来自 ${senderUser.name} 的新消息`,
            fromUser: { displayName: senderUser.name, email: senderUser.email, id: senderUser.id },
            timestamp: new Date()
        });
        
        // 3. 发给自己 (让发送者的界面也能显示这条消息)
        socket.emit(PRIVATE_MESSAGE, newMsgPayload);

      } else {
        console.log(`⚠️ User ${receiverName} is offline.`);
        // 可选：在这里处理离线消息逻辑
        socket.emit(MESSAGE_RECEIVED, {
            author: "系统",
            message: `用户 ${receiverName} 当前不在线，消息已保存。`,
            isSystem: true
        });
      }
    });

    // ===================================
    // 5. 正在输入 (Typing)
    // ===================================
    socket.on(TYPING, ({ chatId, isTyping }) => {
       // 广播给除了自己以外的人
       socket.broadcast.emit(TYPING, { user: socket.user.name, isTyping });
    });

    // ===================================
    // 6. 停止输入 (Stop Typing)
    // ===================================
    socket.on(STOP_TYPING, ({ chatId }) => {
      socket.broadcast.emit(STOP_TYPING, { user: socket.user.name, isTyping: false });
   });

   // ===================================
   // 7. 主动登出 (Logout)
   // ===================================
   socket.on(LOGOUT, () => {
     if ("user" in socket) {
       console.log(`👋 ${socket.user.name} Logged out`);
       
       // 离开房间
       if (socket.user.id) {
           socket.leave(socket.user.id);
       }
       
       // 从列表移除
       connectedUsers = removeUser(connectedUsers, socket.user.name);
       
       // 广播列表更新
       io.emit(USER_CONNECTED, connectedUsers);
       
       // 清除引用
       delete socket.user;
     }
   });

    // ===================================
    // 8. 断开连接 (Disconnect)
    // ===================================
    socket.on("disconnect", () => {
      if ("user" in socket) {
        // 从列表移除
        connectedUsers = removeUser(connectedUsers, socket.user.name);
        
        // 广播列表更新
        io.emit(USER_CONNECTED, connectedUsers);
        
        console.log(`🔴 ${socket.user.name} Disconnected`);
      }
    });

  });
};