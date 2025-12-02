const dotenv = require('dotenv');
dotenv.config(); // 这行代码会把 .env 里的内容加载到 process.env 里

const express = require("express");
const connectDB = require("./config/db");
const http = require("http");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const compression = require("compression");
const app = express();
const corsConfig = require("./corsConfig");
const server = http.createServer(app);
const socketManager = require("./socket/socket");
const io = require("socket.io")(server);



app.use(compression());
app.use(morgan("tiny"));
app.use(helmet());
app.use(helmet.hidePoweredBy());
app.options("*", cors());
app.use(cors(corsConfig));
// 🔥 请改成这样：
app.use(express.json({ limit: '50mb' })); 
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use((_req, res, next) => {
  res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
  res.setHeader("X-XSS-Protection", 1);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("X-Frame-Options", "Deny");
  next();
});


connectDB();

//socket
io.on("connection", socketManager);

app.get("/", (_req, res) => {
  res.json("api server");
});

app.use("/api/auth", require("./routes/auth"));
app.use("/api/posts", require("./routes/posts"));
app.use("/api/resume", require("./routes/resume"));
app.use("/api/homepage", require("./routes/homepage"));
app.use("/api/comments", require("./routes/comments"));
app.use("/api/users", require("./routes/users"));
app.use("/api/todo", require("./routes/todo"));

//port
const PORT = process.env.PORT || 5000;

//create server
server.listen(PORT, () => console.log(` Server listening on ${PORT}`));

module.exports = io;
