import User from '../models/User.js';
import Fitness from '../models/Fitness.js';
import Todo from '../models/Todo.js'; // 确保你的 Todo 模型路径正确

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
        name: 'update_fitness_goal',
        description:
          "修改用户的健身目标模式。如果用户提到'减肥'、'刷脂'、'瘦身'，请使用 goal='cut'。如果用户提到'增肌'、'变壮'、'增重'、'练块'，请使用 goal='bulk'。如果用户说'保持'、'维持'，请使用 goal='maintain'。",
        parameters: {
          type: 'OBJECT',
          properties: {
            goal: {
              type: 'STRING',
              enum: ['cut', 'bulk', 'maintain'],
              description: '目标模式'
            }
          },
          required: ['goal']
        }
      },

      // -----------------------------------------------------
      // ⚖️ 工具 B: 记录体重
      // -----------------------------------------------------
      {
        name: 'log_weight',
        description: "记录用户的体重。当用户提到现在的体重数值时调用（例如：'我今天85kg'）。",
        parameters: {
          type: 'OBJECT',
          properties: {
            weight: {
              type: 'NUMBER',
              description: '体重数值 (kg)'
            },
            dateStr: {
              type: 'STRING',
              description: '日期 (YYYY-MM-DD)。通常为今天，除非用户明确指定。'
            }
          },
          required: ['weight', 'dateStr']
        }
      },
      // -----------------------------------------------------
      // ✅ 工具 C: 添加待办事项 (升级版：支持提醒和日期)
      // -----------------------------------------------------
      {
        name: 'add_todo',
        description:
          "添加一条新的待办事项或愿望清单。当用户说'提醒我...'、'我要做...'、'把xx加入计划'时调用。如果用户提到了具体时间（如'5分钟后'），必须计算出 remindAt 时间戳。",
        parameters: {
          type: 'OBJECT',
          properties: {
            title: {
              type: 'STRING',
              description: '任务的标题/主要内容 (对应数据库的 todo 字段)'
            },
            detail: {
              type: 'STRING',
              description: '任务的详细描述、攻略或备注 (对应数据库的 description 字段)'
            },
            status: {
              type: 'STRING',
              enum: ['todo', 'in_progress', 'done'],
              description: '初始状态，默认为 todo (想做/未开始)'
            },
            // 🔥 新增：任务类型
            type: {
              type: 'STRING',
              enum: ['wish', 'routine'],
              description:
                "任务类型。'routine' 用于喝水、吃药等重复性或日常习惯；'task' 用于普通待办；'wish' 仅用于长期的愿望或想法。"
            },
            // 🔥 新增：循环规则 (Cron)
            recurrence: {
              type: 'STRING',
              description:
                "【仅针对 routine 类型】标准的 Cron 表达式。例如：每天='0 0 * * *'，每小时='0 * * * *'，每周一='0 0 * * 1'。如果是一次性任务，此字段留空。"
            },
            // 🔥 新增：提醒时间 (Bark 推送的关键)
            remindAt: {
              type: 'STRING',
              description:
                "精确的提醒时间 (ISO 8601 格式, 如 '2025-12-20T14:30:00.000Z')。务必根据当前时间和用户的相对时间描述（如'5分钟后'、'明晚8点'）进行计算并填入。"
            },
            // 🔥 新增：目标日期 (Bucket List 规划用)
            targetDate: {
              type: 'STRING',
              description: "计划的目标日期 (如 '2025-12-25')，用于愿望清单的宽泛时间规划，不同于精确提醒。"
            }
          },
          required: ['title']
        }
      },
      // -----------------------------------------------------
      // ✅ 工具 D: 删除任务 (用于取消提醒/删除心愿)
      // -----------------------------------------------------
      {
        name: 'delete_todo',
        description: "删除指定的待办事项或提醒。当用户说'取消提醒'、'删除这个任务'时调用。",
        parameters: {
          type: 'OBJECT',
          properties: {
            // 注意：这里让 AI 传 id 比较困难，通常是通过检索拿到 id
            // 或者让 AI 根据标题去模糊删除（需要后端支持），但最标准的是传 ID
            // 为了简化，我们让 AI 尝试传入任务的 ID (如果它在上下文中知道的话)
            // 或者我们可以做一个 search_and_delete 的逻辑，这里先给基础版
            id: {
              type: 'STRING',
              description: 'The ID of the todo/task to delete.'
            }
          },
          required: ['id']
        }
      },

      // -----------------------------------------------------
      // 🏃 工具 D: 记录运动打卡
      // -----------------------------------------------------
      {
        name: 'log_workout',
        description: "记录具体的运动内容。当用户说'我刚才跑了步'、'练了胸肌'时调用。",
        parameters: {
          type: 'OBJECT',
          properties: {
            type: {
              type: 'STRING',
              description: '运动类型，如：跑步、游泳、力量训练'
            },
            duration: {
              type: 'NUMBER',
              description: '时长(分钟)。如果未说明，默认为 30。'
            },
            dateStr: {
              type: 'STRING',
              description: '日期 (YYYY-MM-DD)。'
            }
          },
          required: ['type', 'dateStr']
        }
      },

      // -----------------------------------------------------
      // 📝 工具 E: 记录心情日记
      // -----------------------------------------------------
      {
        name: 'log_mood',
        description: '记录用户心情或日记。当用户表达情绪（开心、难过、焦虑）或总结一天时调用。',
        parameters: {
          type: 'OBJECT',
          properties: {
            mood: {
              type: 'STRING',
              enum: ['happy', 'neutral', 'bad'],
              description: '心情分类'
            },
            note: {
              type: 'STRING',
              description: '日记内容/备注。'
            },
            dateStr: {
              type: 'STRING',
              description: '日期 (YYYY-MM-DD)。'
            }
          },
          required: ['mood', 'dateStr']
        }
      },
      // -----------------------------------------------------
      // 💊 工具 F: 记录营养补剂 (蛋白粉/维生素)
      // -----------------------------------------------------
      {
        name: 'log_supplement',
        description: "记录用户摄入的营养补剂，如蛋白粉、维生素。当用户说'喝了蛋白粉'、'吃维生素了'时调用。",
        parameters: {
          type: 'OBJECT',
          properties: {
            protein: {
              type: 'BOOLEAN',
              description: '是否摄入蛋白粉'
            },
            vitamins: {
              type: 'BOOLEAN',
              description: '是否摄入维生素'
            },
            details: {
              type: 'STRING',
              description: '备注详情 (如口味、品牌等)'
            },
            dateStr: {
              type: 'STRING',
              description: '日期 (YYYY-MM-DD)。'
            }
          },
          required: ['dateStr']
        }
      },
      // -----------------------------------------------------
      // ✅ 工具 E: 更新用户设置 (换时区/改称呼等)
      // -----------------------------------------------------
      {
        name: 'update_user_settings',
        description:
          "更新用户的个人设置，比如所在时区、昵称等。当用户说'我到东京了'、'修改时区为纽约'、'以后叫我老大'时调用。",
        parameters: {
          type: 'OBJECT',
          properties: {
            timezone: {
              type: 'STRING',
              description:
                "IANA Timezone format (e.g., 'Asia/Tokyo', 'America/New_York', 'Europe/London'). Inference this from user's location name."
            },
            displayName: {
              type: 'STRING',
              description: 'New display name if user wants to change it.'
            }
          }
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
   * 优化：直接使用透传的 user 对象，省去一次查询
   */
  async update_fitness_goal({ goal }, { user }) {
    try {
      if (!user) throw new Error('用户信息缺失');

      // 直接操作透传进来的 user 对象（它是一个 Mongoose Document）
      user.fitnessGoal = goal;
      await user.save(); // 触发 Schema 验证

      const map = {
        cut: '减脂模式',
        bulk: '增肌模式',
        maintain: '保持模式'
      };

      return {
        success: true,
        message: `已将你的计划调整为：${map[goal] || goal}`
      };
    } catch (e) {
      return {
        success: false,
        message: '修改失败: ' + e.message
      };
    }
  },

  async log_weight({ weight, dateStr }, context) {
    // 第二个参数是 context
    try {
      // 从 context 中解构出 user
      const { user } = context;
      if (!user || !user._id) throw new Error('缺少用户信息');

      const userId = user._id; // 统一拿 ID

      const record = await Fitness.findOne({
        user: userId,
        dateStr
      });

      if (record) {
        if (!record.body) record.body = {};
        record.body.weight = weight;
        record.markModified('body');
        await record.save();
        return {
          success: true,
          message: `更新成功！${dateStr} 的体重已更新为 ${weight}kg`
        };
      } else {
        // 这里直接用传入的 user 对象即可，甚至不需要重新查库
        const newRecord = new Fitness({
          user: userId,
          date: new Date(dateStr),
          dateStr: dateStr,
          body: {
            weight: weight,
            height: user?.height || 175
          }
        });
        await newRecord.save();
        return {
          success: true,
          message: `记录成功！${dateStr} 体重 ${weight}kg`
        };
      }
    } catch (e) {
      return { success: false, message: '记录失败: ' + e.message };
    }
  },

  /**
   * ✅ 添加待办 (适配你的新 Schema)
   */
  add_todo: async ({ title, detail, status, remindAt, targetDate, type, recurrence }, { user }) => {
    try {
      // 1. 默认值处理
      // 如果 AI 没传 type，默认为 'wish'
      // 如果 AI 没传 recurrence，默认为 null
      const finalType = type || 'wish';
      const finalRecurrence = recurrence || null;

      const newTodo = new Todo({
        user: user._id, // 绑定当前用户
        todo: title,
        description: detail,
        status: status || 'todo',
        remindAt: remindAt ? new Date(remindAt) : undefined,
        targetDate: targetDate ? new Date(targetDate) : undefined,

        // 🔥 核心修改：存入这两个字段
        type: finalType,
        recurrence: finalRecurrence
      });

      await newTodo.save();

      return {
        success: true,
        msg: `已创建任务: "${title}"`,
        type: finalType,
        is_recurring: !!finalRecurrence
      };
    } catch (err) {
      return {
        error: `创建失败: ${err.message}`
      };
    }
  },

  delete_todo: async ({ id }) => {
    console.log(`🗑️ [Agent Action] Deleting Todo ID: ${id}`);

    if (!id) {
      return {
        error: '无法删除：缺少任务 ID。请先查询任务列表获取 ID。'
      };
    }

    try {
      // 执行删除
      const deletedTodo = await Todo.findByIdAndDelete(id);

      if (!deletedTodo) {
        return {
          error: '删除失败：找不到该 ID 的任务，可能已经被删除了。'
        };
      }

      return {
        success: true,
        message: `已成功删除任务："${deletedTodo.todo}"`,
        deleted_id: deletedTodo._id
      };
    } catch (err) {
      console.error('❌ Delete Todo Error:', err);
      return {
        error: `数据库错误: ${err.message}`
      };
    }
  },

  /**
   * 记录运动
   * 优化：参数对齐，使用 user._id 查询
   */
  async log_workout({ type, duration = 30, dateStr }, { user }) {
    try {
      if (!user?._id) throw new Error('缺少用户 ID');
      const userId = user._id;

      let record = await Fitness.findOne({ user: userId, dateStr });
      if (!record) {
        record = new Fitness({
          user: userId,
          date: new Date(dateStr),
          dateStr
        });
      }

      // 初始化 workout 对象
      if (!record.workout) record.workout = { types: [], duration: 0, isDone: true };

      record.workout.isDone = true;
      // 确保 duration 是数字相加
      record.workout.duration = (record.workout.duration || 0) + Number(duration);

      // 数组去重推入
      if (!record.workout.types) record.workout.types = [];
      if (!record.workout.types.includes(type)) {
        record.workout.types.push(type);
      }

      // 显式标记，确保嵌套更新成功
      record.markModified('workout');

      await record.save();
      return {
        success: true,
        message: `打卡成功！${type} ${duration}分钟。`
      };
    } catch (e) {
      return {
        success: false,
        message: '运动打卡失败: ' + e.message
      };
    }
  },

  /**
   * 记录心情
   * 优化：参数对齐，利用透传对象
   */
  async log_mood({ mood, note, dateStr }, { user }) {
    try {
      if (!user?._id) throw new Error('缺少用户 ID');
      const userId = user._id;

      let record = await Fitness.findOne({ user: userId, dateStr });
      if (!record) {
        record = new Fitness({
          user: userId,
          date: new Date(dateStr),
          dateStr
        });
      }

      // 1. 处理心情
      if (!record.status) record.status = {};
      record.status.mood = mood;
      record.markModified('status');

      // 2. 拼接笔记到 workout.note
      if (!record.workout) record.workout = {};
      const oldNote = record.workout.note || '';
      record.workout.note = oldNote ? `${oldNote} | ${note}` : note;

      // 必须标记 workout 修改
      record.markModified('workout');

      await record.save();
      return {
        success: true,
        message: `心情已记录 (${mood})。`
      };
    } catch (e) {
      return {
        success: false,
        message: '记录心情失败: ' + e.message
      };
    }
  },

  /**
   * 记录营养补剂
   */
  async log_supplement({ protein, vitamins, details, dateStr }, { user }) {
    try {
      if (!user?._id) throw new Error('缺少用户 ID');
      const userId = user._id;

      let record = await Fitness.findOne({ user: userId, dateStr });
      if (!record) {
        record = new Fitness({
          user: userId,
          date: new Date(dateStr),
          dateStr
        });
      }

      if (!record.supplements) record.supplements = {};

      // 仅当传入了 true/false 时才更新，undefined 不覆盖
      if (typeof protein === 'boolean') record.supplements.protein = protein;
      if (typeof vitamins === 'boolean') record.supplements.vitamins = vitamins;
      if (details) record.supplements.details = details;

      record.markModified('supplements');
      await record.save();

      return {
        success: true,
        message: `补剂记录成功！(蛋白粉: ${record.supplements.protein ? '✅' : '❌'}, 维生素: ${record.supplements.vitamins ? '✅' : '❌'
          })`
      };
    } catch (e) {
      return {
        success: false,
        message: '记录补剂失败: ' + e.message
      };
    }
  },
  // 在 functionsMap 中添加：
  update_user_settings: async ({ timezone, displayName }, { user }) => {
    // 注意：这里需要传入 user 对象（从 req.user 获取）
    // 如果你的 createAgentStream 里没有透传 user，需要改一下传参逻辑
    // 或者直接根据 user.id 查库

    try {
      const updateData = {};
      const msg = [];

      if (timezone) {
        updateData.timezone = timezone;
        msg.push(`时区已切换为 ${timezone}`);
      }
      if (displayName) {
        updateData.displayName = displayName;
        msg.push(`昵称已改为 ${displayName}`);
      }

      if (Object.keys(updateData).length === 0) {
        return {
          error: '没有检测到需要修改的设置'
        };
      }

      await User.findByIdAndUpdate(user._id, {
        $set: updateData
      });

      return {
        success: true,
        message: msg.join('，') + '。时间计算将立即生效。'
      };
    } catch (err) {
      return {
        error: `更新失败: ${err.message}`
      };
    }
  }
};

export {
  toolsSchema,
  functions
};
