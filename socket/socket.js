const Chat = require("../models/Chat");
const {
  CONFIRM_USER,
  USER_CONNECTED,
  LOGOUT,
  ROOM_WELCOME,
  MESSAGE_SENT,
  MESSAGE_RECEIVED,
  PRIVATE_MESSAGE, // 新增
  TYPING,          // 新增
  STOP_TYPING      // 新增
} = require("./events");

let connectedUsers = {};

// 辅助函数
function addUser(userList, user) {
  let newList = Object.assign({}, userList);
  newList[user.name] = user;
  return newList;
}

function removeUser(userList, username) {
  let newList = Object.assign({}, userList);
  delete newList[username];
  return newList;
}

function createUser({ name = "", socketId = "" } = {}) {
  return {
    id: socketId,
    name,
  };
}

module.exports = (io) => {
  console.log("⚡ Socket.io Service Started");

  io.on("connection", (socket) => {
    
    // 1. 验证用户（和之前一样）
    socket.on(CONFIRM_USER, (nickname, callback) => {
      if (Object.values(connectedUsers).some(u => u.name === nickname)) {
        callback({ isUser: true, user: null });
      } else {
        callback({ isUser: false, user: createUser({ name: nickname, socketId: socket.id }) });
      }
    });

    // 2. 用户上线（和之前一样，但加了广播）
    socket.on(USER_CONNECTED, (user) => {
      user.socketId = socket.id;
      connectedUsers = addUser(connectedUsers, user);
      socket.user = user;

      // 广播给所有人：更新在线用户列表 (Sidebar 用的)
      io.emit(USER_CONNECTED, connectedUsers);
      // 🔥🔥🔥 B. [新增] 欢迎事件：只发给当前连接的这个用户
      socket.emit(ROOM_WELCOME, {
        user: "系统管家",
        message: `欢迎回来，${user.name}！这里是你的私有聊天室。`
      });
      
      console.log(`🟢 ${user.name} is Online`);
    });

    

    // 3. 处理群发消息 (完整版)
    socket.on(MESSAGE_SENT, async (data) => {
      // data 结构预期: { message: "内容", author: "用户名", userId: "用户ID", room: "房间名(可选)" }
      console.log("📨 Message received:", data);

      // A. 存入 MongoDB (持久化)
      try {
        // 只有当消息有内容且发送者有 ID 时才存库，防止空消息或未授权消息
        if (data.userId && data.message) {
            const newChat = new Chat({
                user: { 
                    name: data.author, 
                    id: data.userId,
                    // avatar: data.avatar // 如果前端传了头像url也可以存
                },
                content: data.message,
                // 如果前端没传 room，默认存入 "public"
                room: data.room || "public",
                createdDate: new Date()
            });

            await newChat.save();
            // console.log("✅ Message saved to DB");
        }
      } catch (err) {
        console.error("❌ Save chat error:", err);
      }

      // B. 广播给房间内的所有人 (包括发送者自己)
      // 使用 io.to(room) 可以支持多房间。如果没传 room 就发给 "public"
      const targetRoom = data.room || "public";
      
      // 注意：这里使用的是 io.to().emit()，这样只有在同一个房间的人才能收到
      // 事件名 MESSAGE_RECEIVED 必须和前端监听的事件名一致
      io.to(targetRoom).emit(MESSAGE_RECEIVED, data);
    });

   // 4. 处理私聊消息 (完整版：含存库)
   socket.on(PRIVATE_MESSAGE, async ({ receiverName, message }) => {
    // 1. 获取发送者信息 (建议直接从 socket.user 获取，比前端传更安全)
    const senderUser = socket.user; 

    // 2. 获取接收者信息 (从在线列表中查找)
    // 前提：你的 addUser 逻辑里存了用户的完整信息(包括数据库_id)
    const receiverUser = connectedUsers[receiverName];
    
    if (receiverUser) {
      console.log(`🤫 Private message from ${senderUser.name} to ${receiverName}`);

      // --- A. 存入 MongoDB (私聊存库核心) ---
      try {
          const newPrivateChat = new Chat({
              // 发送者
              user: { 
                  name: senderUser.name, 
                  id: senderUser.id // 存发送者的数据库ID
              },
              // 接收者 (这是你刚才在 Model 里加的关键字段)
              toUser: receiverUser.id, // 存接收者的数据库ID
              content: message,
              room: "private", // 标记为私聊，或者你可以不做区分，只看 toUser
              createdDate: new Date()
          });

          await newPrivateChat.save();
      } catch (err) {
          console.error("❌ Save private chat error:", err);
      }

      // --- B. 发送消息 (实时推送) ---
      const newMsgPayload = {
          message,
          author: senderUser.name,
          isPrivate: true,
          timestamp: new Date()
      };
      
      // 1. 发送给接收方 (通过 socketId 定点投送)
      io.to(receiverUser.socketId).emit(PRIVATE_MESSAGE, newMsgPayload);
      
      // 2. 也要发给自己 (不然你自己屏幕上看不到这条刚发的消息)
      socket.emit(PRIVATE_MESSAGE, newMsgPayload);

    } else {
      // 可选：如果用户不在线
      // 你依然可以选择存库 (离线消息)，只是不执行 io.to().emit()
      console.log(`⚠️ User ${receiverName} is offline.`);
      
      // 建议：可以给发送者回一个提示
      // socket.emit("ERROR_MESSAGE", { content: "对方不在线，稍后回复" });
    }
  });

    // 🔥🔥🔥 5. 处理“正在输入...”状态
    socket.on(TYPING, ({ chatId, isTyping }) => {
       // 广播给在这个聊天室的其他人
       // socket.broadcast 表示“除了我自己，发给其他人”
       socket.broadcast.emit(TYPING, { user: socket.user.name, isTyping });
    });

    // 🔥🔥🔥 6. [新增] 停止输入
    // 当前端检测到输入框失焦或停止打字超过几秒时触发
    socket.on(STOP_TYPING, ({ chatId }) => {
      socket.broadcast.emit(STOP_TYPING, { user: socket.user.name, isTyping: false });
   });

   // 🔥🔥🔥 7. [新增] 主动登出
    // 用户点击 Logout 按钮时触发，比 disconnect 更及时
    socket.on(LOGOUT, () => {
      if ("user" in socket) {
        console.log(`👋 ${socket.user.name} Logged out`);
        connectedUsers = removeUser(connectedUsers, socket.user.name);
        io.emit(USER_CONNECTED, connectedUsers);
        
        // 清除 socket 上的用户信息，防止 disconnect 时重复触发逻辑
        delete socket.user; 
      }
    });

    // 6. 断开连接
    socket.on("disconnect", () => {
      if ("user" in socket) {
        connectedUsers = removeUser(connectedUsers, socket.user.name);
        io.emit(USER_CONNECTED, connectedUsers); // 告诉大家某人下线了
        console.log(`🔴 ${socket.user.name} Disconnected`);
      }
    });
  });
};