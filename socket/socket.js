const Chat = require("./models/Chat");
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
} = require("./utils/events");

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
      console.log(`🟢 ${user.name} is Online`);
    });

    // 3. 处理群发消息 (原有逻辑)
    socket.on(MESSAGE_SENT, async (data) => {
      // data: { message, author, userId, room }
      // 存库... (省略，同上)
      
      // 广播给房间所有人
      io.emit(MESSAGE_RECEIVED, data);
    });

    // 🔥🔥🔥 4. 处理私聊消息 (像微信一样点对点)
    socket.on(PRIVATE_MESSAGE, async ({ receiverName, message, sender }) => {
      // receiverName: 接收者的名字 (必须在 connectedUsers 里)
      // 找到接收者的 Socket ID
      const receiver = connectedUsers[receiverName];
      
      if (receiver) {
        // 定点发送给接收者
        const newMsg = {
            message,
            author: sender,
            isPrivate: true,
            timestamp: new Date()
        };
        
        // 发送给接收方
        io.to(receiver.socketId).emit(PRIVATE_MESSAGE, newMsg);
        
        // 也要发给自己（不然自己屏幕上看不到自己发了啥）
        socket.emit(PRIVATE_MESSAGE, newMsg);

        // TODO: 这里可以加私聊存库逻辑 (Chat Model 需要支持存 receiver)
      }
    });

    // 🔥🔥🔥 5. 处理“正在输入...”状态
    socket.on(TYPING, ({ chatId, isTyping }) => {
       // 广播给在这个聊天室的其他人
       // socket.broadcast 表示“除了我自己，发给其他人”
       socket.broadcast.emit(TYPING, { user: socket.user.name, isTyping });
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