const mongoose = require('mongoose');
const Schema = mongoose.Schema;

/**
 * ExternalResource Schema - 外部数据缓冲池 (万能收纳箱)
 * * * 设计理念：
 * 1. 这是一个通用的“中间仓库”，用来囤积从 TianAPI 等外部接口抓来的数据。
 * 2. 不强制要求数据格式，利用 MongoDB 的 `Mixed` 类型存储任意结构。
 * 3. 既省钱 (API 缓存)，又防丢 (数据私有化)。
 */
const ExternalResourceSchema = new Schema({
  // --- 核心分类 ---
  // 目前主要用 'recipe'，未来可扩展 'news', 'hotsearch', 'poetry'
  type: {
    type: String,
    required: true,
    enum: ['recipe', 'news', 'hotsearch', 'other'], 
    index: true
  },

  // --- 唯一标识 (防重核心) ---
  // 生成规则示例：
  // 1. 菜谱: "recipe:红烧肉:家常做法" (如果 API 没 ID，就用 关键词+标题 组合)
  // 2. 新闻: "news:API返回的ID"
  // 作用：确保同一个内容不会重复插入，而是更新。
  uniqueKey: { 
    type: String, 
    required: true, 
    unique: true 
  },

  // --- 搜索关键词 ---
  // 记录当时是搜什么词把这条数据抓回来的。
  // 例如：搜 "红烧肉"，抓回来了 "土豆红烧肉", "毛氏红烧肉"。
  // 以后搜 "红烧肉" 时，这几条都能被查出来。
  queryKeyword: { type: String, index: true },

  // --- 通用展示字段 ---
  title: { type: String, required: true }, // 标题
  description: { type: String },          // 简介/摘要
  coverImage: { type: String },           // 封面图 URL

  // --- 🔥 原始数据 (核心) ---
  // 这里存放 TianAPI 返回的完整 JSON 对象。
  // 因为不同类型的外部数据结构完全不同，Mixed 类型允许我们存任何东西。
  // 对于菜谱，这里面会存: ingredients(原料), steps(做法HTML), tips(提示) 等
  rawData: { type: Schema.Types.Mixed },

  // --- 状态标记 ---
  // 比如你特别喜欢这个做法，可以手动标星 (预留字段)
  isFavorite: { type: Boolean, default: false },

}, { timestamps: true });

// 复合索引：加速查询
// 场景：查找 type 为 recipe 且关键词为 "红烧肉" 的所有记录
ExternalResourceSchema.index({ type: 1, queryKeyword: 1 });

module.exports = mongoose.model('external_resource', ExternalResourceSchema);