const mongoose = require("mongoose");
const id = () => new mongoose.Types.ObjectId();

const getTime = date => {
  return `${date.getHours()}:${("0" + date.getMinutes()).slice(-2)}`;
};

const createUser = ({ name = "" } = {}) => ({ id: id(), name });

const createMessage = ({ message = "", sender = "" } = {}) => {
  return {
    id: id(),
    time: getTime(new Date(Date.now())),
    message,
    sender
  };
};

const createChat = ({ messages = [], name = "聊天室", users = [] } = {}) => {
  return {
    id: id(),
    name,
    messages,
    users,
    typingUsers: []
  };
};

module.exports = {
  createChat,
  createMessage,
  createUser
};
