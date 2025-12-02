const Todo = require("../models/Todo");
const auth = require("../middleware/auth");
const router = require("express").Router();
const logOperation = require("../utils/audit"); // 🔥 引入日志工具

router.get("/", auth, async (req, res) => {
  const response = await Todo.find().sort({ timestamp: -1 });
  res.json(response);
});

router.post("/", auth, async (req, res) => {
  const { todo } = req.body;
  let timestamp = Date.now();
  const response = new Todo({ todo, done: false, timestamp });
  await response.save();
  // 🔥🔥🔥 记录日志
  logOperation({
    operatorId: req.user.id,
    action: "CREATE_TODO",
    target: todo,
    ip: req.ip,
    io: req.app.get('socketio')
});

  const allTodo = await Todo.find().sort({ timestamp: -1 });
  res.json(allTodo);
});
router.get("/done/:id", async (req, res) => {
  const done = await Todo.findOne({ _id: req.params.id });
  res.json(done);
});
// 4. 修改状态 (完成/未完成) 或 修改内容
// 建议把这个路由改成 PUT /:id 更符合规范，但为了兼容旧前端，保持原样
router.post("/done/:id", auth, async (req, res) => {
  // 你的旧逻辑支持修改 done 状态，或者修改 todo 内容
  const { done, todo } = req.body;
  
  try {
    const updateFields = {};
    if (done !== undefined) updateFields.done = done;
    if (todo !== undefined) updateFields.todo = todo;

    const updatedTodo = await Todo.findByIdAndUpdate(
      req.params.id, 
      { $set: updateFields },
      { new: true } // 这一步只是为了拿到更新后的对象做记录，不需要返回给前端（因为下面重新查了列表）
    );

    // 🔥🔥🔥 记录日志
    let action = "UPDATE_TODO";
    if (done === 1 || done === true) action = "COMPLETE_TODO";
    if (done === 0 || done === false) action = "UNCOMPLETE_TODO";

    logOperation({
        operatorId: req.user.id,
        action: action,
        target: updatedTodo ? updatedTodo.todo : req.params.id,
        details: updateFields,
        ip: req.ip,
        io: req.app.get('socketio')
    });

    const allTodos = await Todo.find().sort({ timestamp: -1 });
    res.json(allTodos);
  } catch (err) {
    console.error(err);
    res.status(500).send("Server Error");
  }
});

module.exports = router;
