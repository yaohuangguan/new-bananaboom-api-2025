const Todo = require("../models/Todo");
const auth = require("../middleware/auth");
const router = require("express").Router();
router.get("/", auth, async (req, res) => {
  const response = await Todo.find().sort({ timestamp: -1 });
  res.json(response);
});

router.post("/", auth, async (req, res) => {
  const { todo } = req.body;
  let timestamp = Date.now();
  const response = new Todo({ todo, done: false, timestamp });
  await response.save();
  const allTodo = await Todo.find().sort({ timestamp: -1 });
  res.json(allTodo);
});
router.get("/done/:id", async (req, res) => {
  const done = await Todo.findOne({ _id: req.params.id });
  res.json(done);
});
router.post("/done/:id", async (req, res) => {
  const done = await Todo.findOne({ _id: req.params.id }, { done: 1 });

  await Todo.updateOne({ _id: req.params.id }, { $set: { done: !done.done } });
  const allTodo = await Todo.find().sort({ timestamp: -1 });

  res.json(allTodo);
});

module.exports = router;
