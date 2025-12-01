const io = require("../index").io;
const {
  CONFIRM_USER,
  USER_CONNECTED,
  LOGOUT,
  ROOM_WELCOME
} = require("./events");
const { createChat, createMessage, createUser } = require("./helper");
let connectedUsers = {};
module.exports = async socket => {
  const Chat = require("../models/Chats");
  console.log("New client connected" + socket.id);
  socket.on(CONFIRM_USER, (nickname, callback) => {
    callback({ user: createUser({ name: nickname }) });
  });
  socket.on(USER_CONNECTED, user => {
    connectedUsers = addUser(connectedUsers, user);
    socket.user = user;
    console.log("connectedUsers", connectedUsers);
  });
  socket.emit(USER_CONNECTED, connectedUsers);
  socket.broadcast.emit(ROOM_WELCOME,{ user: "管家", message: `宝贝，欢迎来到密室` });

  await socket.on("disconnect", function() {
    console.log("a user disconnected");
  });
};

function addUser(userList, user) {
  let newList = Object.assign({}, userList);
  newList[user.name] = user;
  return newList;
}
function removeUser(userList, user) {
  let newList = Object.assign({}, userList);
  delete newList[user];
  return newList;
}
