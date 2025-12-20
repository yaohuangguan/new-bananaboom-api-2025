const User = require("../models/User");
const Fitness = require("../models/Fitness");
const Todo = require("../models/Todo"); // 确保你的 Todo 模型路径正确

// ==========================================
// 1. 定义给 AI 看的“说明书” (Schema)
// ==========================================
const toolsSchema = [
  {
    functionDeclarations: [
      // -----------------------------------------------------
      // 💪 工具 A: 修改健身模式 (Cut/Bulk/Maintain)
      // -----------------------------------------------------
      {
        name: "update_fitness_goal",
        description: "修改用户的健身目标模式。如果用户提到'减肥'、'刷脂'、'瘦身'，请使用 goal='cut'。如果用户提到'增肌'、'变壮'、'增重'、'练块'，请使用 goal='bulk'。如果用户说'保持'、'维持'，请使用 goal='maintain'。",
        parameters: {
          type: "OBJECT",
          properties: {
            goal: {
              type: "STRING",
              enum: ["cut", "bulk", "maintain"],
              description: "目标模式"
            }
          },
          required: ["goal"]
        }
      },

      // -----------------------------------------------------
      // ⚖️ 工具 B: 记录体重
      // -----------------------------------------------------
      {
        name: "log_weight",
        description: "记录用户的体重。当用户提到现在的体重数值时调用（例如：'我今天85kg'）。",
        parameters: {
          type: "OBJECT",
          properties: {
            weight: {
              type: "NUMBER",
              description: "体重数值 (kg)"
            },
            dateStr: {
              type: "STRING",
              description: "日期 (YYYY-MM-DD)。通常为今天，除非用户明确指定。"
            }
          },
          required: ["weight", "dateStr"]
        }
      },
// -----------------------------------------------------
      // ✅ 工具 C: 添加待办事项 (升级版：支持提醒和日期)
      // -----------------------------------------------------
      {
        name: "add_todo",
        description: "添加一条新的待办事项或愿望清单。当用户说'提醒我...'、'我要做...'、'把xx加入计划'时调用。如果用户提到了具体时间（如'5分钟后'），必须计算出 remindAt 时间戳。",
        parameters: {
          type: "OBJECT",
          properties: {
            title: {
              type: "STRING",
              description: "任务的标题/主要内容 (对应数据库的 todo 字段)"
            },
            detail: {
              type: "STRING",
              description: "任务的详细描述、攻略或备注 (对应数据库的 description 字段)"
            },
            status: {
              type: "STRING",
              enum: ["todo", "in_progress", "done"],
              description: "初始状态，默认为 todo (想做/未开始)"
            },
            // 🔥 新增：提醒时间 (Bark 推送的关键)
            remindAt: {
              type: "STRING",
              description: "精确的提醒时间 (ISO 8601 格式, 如 '2025-12-20T14:30:00.000Z')。务必根据当前时间和用户的相对时间描述（如'5分钟后'、'明晚8点'）进行计算并填入。"
            },
            // 🔥 新增：目标日期 (Bucket List 规划用)
            targetDate: {
              type: "STRING",
              description: "计划的目标日期 (如 '2025-12-25')，用于愿望清单的宽泛时间规划，不同于精确提醒。"
            }
          },
          required: ["title"]
        }
      },

      // -----------------------------------------------------
      // 🏃 工具 D: 记录运动打卡
      // -----------------------------------------------------
      {
        name: "log_workout",
        description: "记录具体的运动内容。当用户说'我刚才跑了步'、'练了胸肌'时调用。",
        parameters: {
          type: "OBJECT",
          properties: {
            type: {
              type: "STRING",
              description: "运动类型，如：跑步、游泳、力量训练"
            },
            duration: {
              type: "NUMBER",
              description: "时长(分钟)。如果未说明，默认为 30。"
            },
            dateStr: {
              type: "STRING",
              description: "日期 (YYYY-MM-DD)。"
            }
          },
          required: ["type", "dateStr"]
        }
      },

      // -----------------------------------------------------
      // 📝 工具 E: 记录心情日记
      // -----------------------------------------------------
      {
        name: "log_mood",
        description: "记录用户心情或日记。当用户表达情绪（开心、难过、焦虑）或总结一天时调用。",
        parameters: {
          type: "OBJECT",
          properties: {
            mood: {
              type: "STRING",
              enum: ["happy", "neutral", "bad"],
              description: "心情分类"
            },
            note: {
              type: "STRING",
              description: "日记内容/备注。"
            },
            dateStr: {
              type: "STRING",
              description: "日期 (YYYY-MM-DD)。"
            }
          },
          required: ["mood", "dateStr"]
        }
      }
    ]
  }
];

// ==========================================
// 2. 后端执行逻辑 (Executor)
// ==========================================
const functions = {
  /**
   * 修改健身目标
   */
  async update_fitness_goal({ goal }, userId) {
    try {
    // ✅ 新代码: Find -> Modify -> Save
    const user = await User.findById(userId);
    if (user) {
      user.fitnessGoal = goal;
      await user.save(); // 触发 Schema 验证和 Hooks
    }
      const map = { cut: "减脂模式", bulk: "增肌模式", maintain: "保持模式" };
      return { success: true, message: `已将你的计划调整为：${map[goal] || goal}` };
    } catch (e) {
      return { success: false, message: "修改失败: " + e.message };
    }
  },

  /**
   * 记录体重
   */
  async log_weight({ weight, dateStr }, userId) {
    try {
      let record = await Fitness.findOne({ user: userId, dateStr });
      if (record) {
        record.body.weight = weight;
        await record.save();
        return { success: true, message: `更新成功！${dateStr} 的体重已更新为 ${weight}kg` };
      } else {
        const user = await User.findById(userId);
        const newRecord = new Fitness({
          user: userId,
          date: new Date(dateStr),
          dateStr: dateStr,
          body: {
            weight: weight,
            height: user.height || 175
          }
        });
        await newRecord.save();
        return { success: true, message: `记录成功！${dateStr} 体重 ${weight}kg` };
      }
    } catch (e) {
      return { success: false, message: "记录失败: " + e.message };
    }
  },

  /**
   * ✅ 添加待办 (适配你的新 Schema)
   */
  async add_todo({ title, detail = "", status = "todo" }, userId) {
    try {
      const now = new Date();
      
      const newTodo = new Todo({
        // 核心字段
        user: userId, // ⚠️ 确保你的 Todo Schema 里有 user 字段关联，如果没有，请确认如何关联用户
        todo: title,  // 对应 Schema 的 todo
        description: detail, // 对应 Schema 的 description
        status: status,

        // 兼容旧字段 (Legacy Support)
        done: false,
        create_date: now.toLocaleDateString(), // e.g. "12/20/2025"
        timestamp: Date.now().toString(),
        
        // 其他字段
        order: 0,
        images: []
      });

      await newTodo.save();
      return { success: true, message: `已添加任务: "${title}"` };
    } catch (e) {
      console.error(e);
      return { success: false, message: "添加任务失败: " + e.message };
    }
  },

  /**
   * 记录运动
   */
  async log_workout({ type, duration = 30, dateStr }, userId) {
    try {
      let record = await Fitness.findOne({ user: userId, dateStr });
      if (!record) {
        // 如果当天没记录，新建一条
        record = new Fitness({ user: userId, date: new Date(dateStr), dateStr });
      }

      // 确保 workout 对象存在
      if (!record.workout) record.workout = {};
      
      record.workout.isDone = true;
      record.workout.duration = (record.workout.duration || 0) + duration;
      
      // 记录类型
      if (!record.workout.types) record.workout.types = [];
      if (!record.workout.types.includes(type)) {
        record.workout.types.push(type);
      }

      await record.save();
      return { success: true, message: `打卡成功！${type} ${duration}分钟。` };
    } catch (e) {
      return { success: false, message: "运动打卡失败: " + e.message };
    }
  },

  /**
   * 记录心情
   */
  async log_mood({ mood, note, dateStr }, userId) {
    try {
      let record = await Fitness.findOne({ user: userId, dateStr });
      if (!record) {
        record = new Fitness({ user: userId, date: new Date(dateStr), dateStr });
      }
      
      // 确保 status 对象存在 (假设 mood 在 status.mood)
      if (!record.status) record.status = {};
      record.status.mood = mood;

      // 记录笔记到 workout.note 或专门的 note 字段
      if (!record.workout) record.workout = {};
      const oldNote = record.workout.note || "";
      record.workout.note = oldNote ? `${oldNote} | ${note}` : note;

      await record.save();
      return { success: true, message: `心情已记录 (${mood})。` };
    } catch (e) {
      return { success: false, message: "记录心情失败: " + e.message };
    }
  }
};

module.exports = { toolsSchema, functions };