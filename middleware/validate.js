import { validationResult } from 'express-validator';

// 这个中间件用于统一处理校验结果
// 如果有错，直接返回 400 和错误详情；如果没错，继续执行 next()
const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    // 返回 400 Bad Request 以及具体的错误字段
    return res.status(400).json({
      msg: '参数校验失败',
      errors: errors.array()
    });
  }
  next();
};

export default validate;
