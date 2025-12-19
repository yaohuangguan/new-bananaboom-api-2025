const express = require("express");
const router = express.Router();
const axios = require("axios");
const ExternalResource = require("../models/ExternalResource");
const auth = require("../middleware/auth");
const checkPrivate = require("../middleware/checkPrivate");

// 从环境变量获取天行 API Key
const TIAN_KEY = process.env.TIAN_API_KEY; 

// 全局中间件：只有 VIP (家人) 才能调用
router.use(auth, checkPrivate);

/**
 * =================================================================
 * 🔥 核心接口：获取菜谱做法列表 (自动缓存模式)
 * =================================================================
 * @route   GET /api/external/recipe/detail
 * @desc    根据菜名获取多种做法。优先查本地库，没有则去 API 抓取并存库。
 * @access  Private
 * * @param   {string} name  - (Query) 菜名，如 "红烧肉"
 * @param   {string} force - (Query, 可选) "true" 强制刷新，忽略本地缓存直接调 API
 * * @returns {Array} 返回做法列表数组:
 * [
 * {
 * "id": "数据库ID",
 * "title": "家常红烧肉",
 * "image": "http://...",
 * "description": "...",
 * "ingredients": "五花肉500g...",
 * "steps": "<p>1. 切块...</p>", 
 * "source": "local" | "tianapi"
 * },
 * ...
 * ]
 */
router.get("/recipe/detail", async (req, res) => {
  const { name, force } = req.query;

  if (!name) return res.status(400).json({ msg: "请提供菜名" });

  try {
    // -------------------------------------------------------
    // Step 1: 先查本地“私有知识库” (省钱逻辑)
    // -------------------------------------------------------
    // 逻辑：查找 type='recipe' 且 queryKeyword 匹配的所有记录
    let localRecipes = [];
    
    // 如果没有强制刷新，才查库
    if (force !== 'true') {
      localRecipes = await ExternalResource.find({ 
        type: 'recipe', 
        queryKeyword: name 
      });
    }

    // ✅ Cache Hit: 本地有库存 (且数量大于0)
    // 直接返回本地数据，速度极快，且不消耗 API 次数
    if (localRecipes.length > 0) {
      console.log(`[Cache Hit] 本地找到 ${localRecipes.length} 种关于 "${name}" 的做法`);
      
      const formattedList = localRecipes.map(item => ({
        id: item._id, // 唯一ID，前端用于 v-for 的 key
        title: item.title,
        image: item.coverImage,
        description: item.description,
        // 兼容处理：不同 API 可能返回 yuanliao 或 ingredients
        ingredients: item.rawData.ingredients || item.rawData.yuanliao,
        steps: item.rawData.steps || item.rawData.zuofa,
        tips: item.rawData.tips || item.rawData.tishi,
        source: "local" // 标记数据来源
      }));

      return res.json(formattedList);
    }

    // -------------------------------------------------------
    // Step 2: 本地没有，去 TianAPI 进货 (进货逻辑)
    // -------------------------------------------------------
    console.log(`[API Call] 本地无数据，正在请求天行获取 10 种 "${name}" 的做法...`);
    
    // num=10 : 一次抓 10 种不同做法
    const tianUrl = `https://apis.tianapi.com/caipu/index?key=${TIAN_KEY}&word=${encodeURIComponent(name)}&num=10`;
    
    const response = await axios.get(tianUrl);
    const apiRes = response.data;

    // 容错：如果 API 也没数据
    if (apiRes.code !== 200 || !apiRes.result.list) {
       console.log("TianAPI 返回空或错误:", apiRes.msg);
       return res.status(404).json({ msg: "未找到相关菜谱，请尝试更换关键词", list: [] });
    }

    const apiList = apiRes.result.list;
    const savedList = [];

    // -------------------------------------------------------
    // Step 3: 将抓回来的 10 种做法全部存入仓库
    // -------------------------------------------------------
    for (const item of apiList) {
      // 构造唯一键：
      // 为了区分“土豆红烧肉”和“板栗红烧肉”，我们尝试用 cp_name 做区分
      // uniqueKey 格式: "recipe:土豆红烧肉"
      const uniqueKey = `recipe:${item.cp_name}`;

      // 使用 findOneAndUpdate (Upsert)
      // 如果库里有了就更新，没有就插入
      const newResource = await ExternalResource.findOneAndUpdate(
        { uniqueKey }, 
        {
          type: 'recipe',
          uniqueKey: uniqueKey,
          queryKeyword: name, // 核心：记录这是搜 "红烧肉" 搜出来的
          
          title: item.cp_name,
          description: item.des || item.texing || "暂无简介",
          coverImage: item.picUrl,
          
          // 🔥 把 API 给的所有字段全存进去，防止以后漏掉信息
          rawData: {
            ingredients: item.yuanliao, // 原料
            steps: item.zuofa,          // 做法 (HTML)
            tips: item.tishi,           // 小贴士
            texing: item.texing,        // 特性
            kouwei: item.kouwei,        // 口味
            tiaoliao: item.tiaoliao     // 调料
          }
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      
      // 格式化返回给前端的数据
      savedList.push({
        id: newResource._id,
        title: item.cp_name,
        image: item.picUrl,
        description: item.des || item.texing,
        ingredients: item.yuanliao,
        steps: item.zuofa,
        tips: item.tishi,
        source: "tianapi"
      });
    }

    // -------------------------------------------------------
    // Step 4: 返回新鲜抓取的数据列表
    // -------------------------------------------------------
    res.json(savedList);

  } catch (err) {
    console.error("External Recipe Error:", err);
    res.status(500).json({ msg: "服务器内部错误" });
  }
});



/**
 * =================================================================
 * 🔥 获取全网热搜榜 (Network Hot Search)
 * =================================================================
 * @route   GET /api/external/hotsearch/list
 * @desc    获取当天的全网热搜。
 * 默认缓存策略：如果今天已经抓取过，直接返回库里的数据（省钱）。
 * 强制刷新：传 ?force=true，则重新调天行接口并更新数据库。
 * @access  Private
 * * @param   {string} force - (Query) "true" 强制刷新
 */
router.get("/hotsearch/list", async (req, res) => {
    const { force } = req.query;
    const todayStr = new Date().toISOString().split('T')[0]; // 例如 "2025-12-19"
    const uniqueKey = `hotsearch:${todayStr}`;
  
    try {
      // -------------------------------------------------------
      // Step 1: 先查本地缓存 (除非强制刷新)
      // -------------------------------------------------------
      if (force !== 'true') {
        const cachedHot = await ExternalResource.findOne({ uniqueKey });
        
        if (cachedHot) {
          console.log(`[Cache Hit] 返回本地存储的热搜 (${todayStr})`);
          return res.json({
            date: todayStr,
            list: cachedHot.rawData.list, // 直接返回存好的列表
            updateTime: cachedHot.updatedAt,
            source: "local"
          });
        }
      }
  
      // -------------------------------------------------------
      // Step 2: 调用天行 API (全网热搜)
      // -------------------------------------------------------
      console.log(`[API Call] 正在抓取全网热搜...`);
      const tianUrl = `https://apis.tianapi.com/networkhot/index?key=${TIAN_KEY}`;
      
      const response = await axios.get(tianUrl);
      const apiRes = response.data;
  
      if (apiRes.code !== 200) {
        return res.status(400).json({ msg: apiRes.msg || "天行接口调用失败" });
      }
  
      const hotList = apiRes.result.list; // 天行返回的数组
  
      // -------------------------------------------------------
      // Step 3: 存入/更新数据库
      // -------------------------------------------------------
      // 逻辑：每天只保留一条记录。如果今天有了，就更新 list；没有就插入。
      const savedDoc = await ExternalResource.findOneAndUpdate(
        { uniqueKey },
        {
          type: 'hotsearch',
          uniqueKey: uniqueKey,
          title: `${todayStr} 全网热搜榜`,
          description: `包含 ${hotList.length} 条热点 (Top 1: ${hotList[0].title})`,
          
          // 热搜一般没有封面，可以给个默认图，或者留空
          coverImage: "", 
          
          // 🔥 将整个列表存入 rawData
          rawData: {
            list: hotList
          }
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
  
      // -------------------------------------------------------
      // Step 4: 返回数据
      // -------------------------------------------------------
      res.json({
        date: todayStr,
        list: hotList,
        updateTime: savedDoc.updatedAt,
        source: "tianapi"
      });
  
    } catch (err) {
      console.error("Hotsearch Error:", err);
      res.status(500).json({ msg: "服务器内部错误" });
    }
  });
  

module.exports = router;