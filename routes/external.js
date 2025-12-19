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
    const todayStr = new Date().toISOString().split('T')[0];
    const uniqueKey = `hotsearch:${todayStr}`;
  
    try {
      // -------------------------------------------------------
      // Step 1: 检查本地缓存及其新鲜度
      // -------------------------------------------------------
      let useCache = false;
      const cachedHot = await ExternalResource.findOne({ uniqueKey });
  
      if (cachedHot) {
        const now = new Date();
        const lastUpdate = new Date(cachedHot.updatedAt);
        const diffMs = now - lastUpdate;
        const sixHoursMs = 6 * 60 * 60 * 1000; // 6小时的毫秒数
  
        if (force === 'true') {
          console.log(`[Force Refresh] 前端强制刷新，忽略缓存`);
          useCache = false;
        } else if (diffMs > sixHoursMs) {
          // 🔥 核心逻辑：超过6小时，视为过期
          console.log(`[Cache Expired] 本地热搜已过期 ${Math.floor(diffMs / 1000 / 60)} 分钟，准备重新抓取...`);
          useCache = false;
        } else {
          // 缓存有效
          console.log(`[Cache Hit] 本地热搜有效 (更新于 ${Math.floor(diffMs / 1000 / 60)} 分钟前)`);
          useCache = true;
        }
      }
  
      // -------------------------------------------------------
      // Step 2: 如果缓存有效，直接返回
      // -------------------------------------------------------
      if (useCache && cachedHot) {
        // 补全 URL (兼容旧数据)
        const listWithUrl = cachedHot.rawData.list.map(item => ({
          ...item,
          url: item.url || `https://www.google.com/search?q=${encodeURIComponent(item.title)}`
        }));
  
        return res.json({
          date: todayStr,
          list: listWithUrl,
          updateTime: cachedHot.updatedAt,
          source: "local",
          nextUpdateIn: "Less than 6 hours" // 调试信息
        });
      }
  
      // -------------------------------------------------------
      // Step 3: 调用天行 API (进货)
      // -------------------------------------------------------
      console.log(`[API Call] 正在抓取全网热搜...`);
      const tianUrl = `https://apis.tianapi.com/networkhot/index?key=${TIAN_KEY}`;
      
      const response = await axios.get(tianUrl);
      const apiRes = response.data;
  
      if (apiRes.code !== 200) {
        // 如果 API 挂了，但我们手里有旧缓存（哪怕过期的），为了体验也先返回旧的
        if (cachedHot) {
          console.error("API 失败，降级返回过期缓存");
          return res.json({
             date: todayStr,
             list: cachedHot.rawData.list, // 注意这里可能没有 url 字段，前端最好做个容错
             source: "local-fallback"
          });
        }
        return res.status(400).json({ msg: apiRes.msg || "天行接口调用失败" });
      }
  
      const rawList = apiRes.result.list;
  
      // 🔥 处理数据：注入 Google 链接
      const processedList = rawList.map(item => ({
        ...item,
        url: `https://www.google.com/search?q=${encodeURIComponent(item.title)}`
      }));
  
      // -------------------------------------------------------
      // Step 4: 更新数据库 (更新 updatedAt 时间)
      // -------------------------------------------------------
      const savedDoc = await ExternalResource.findOneAndUpdate(
        { uniqueKey },
        {
          type: 'hotsearch',
          uniqueKey: uniqueKey,
          title: `${todayStr} 全网热搜榜`,
          description: `包含 ${processedList.length} 条热点`,
          rawData: { list: processedList } // 存入最新数据
        },
        { 
          upsert: true, 
          new: true, 
          setDefaultsOnInsert: true 
          // Mongoose 会自动更新 updatedAt 为当前时间
        }
      );
  
      // -------------------------------------------------------
      // Step 5: 返回最新数据
      // -------------------------------------------------------
      res.json({
        date: todayStr,
        list: processedList,
        updateTime: savedDoc.updatedAt,
        source: "tianapi"
      });
  
    } catch (err) {
      console.error("Hotsearch Error:", err);
      res.status(500).json({ msg: "服务器内部错误" });
    }
  });


  /**
 * =================================================================
 * 🔥 获取财经新闻 (Finance News) - 独立接口
 * =================================================================
 * @route   GET /api/external/finance/list
 * @desc    获取今日财经资讯。
 * 逻辑复刻热搜榜：
 * 1. 按天存储 (finance:2025-xx-xx)。
 * 2. 6小时自动过期刷新。
 * 3. 自动注入 Google 搜索链接。
 * @access  Private
 * * @param   {string} force - (Query) "true" 强制刷新
 */
  这个错误是非常经典的空指针错误 (TypeError: Cannot read properties of undefined)。

  原因很简单：TianAPI 返回的数据结构里，result 或者 result.list 是空的 (undefined)，导致代码执行到 .map() 时崩溃了。这可能是因为那一刻 API 没有返回数据，或者返回格式稍微有点不一样（比如 result 为 null）。
  
  我们需要给代码加一层**“防弹衣”**（空值检查），确保即便 API 返回空数据，服务器也不会崩。
  
  请修改 routes/external.js 中的 /finance/list 接口，主要修改两个地方：
  
  修复后的 routes/external.js (财经接口部分)
  请直接替换原来的 router.get("/finance/list", ...) 部分：
  
  JavaScript
  
  /**
   * =================================================================
   * 🔥 获取财经新闻 (修复版 - 增加空值安全检查)
   * =================================================================
   */
  router.get("/finance/list", async (req, res) => {
    const { force } = req.query;
    const todayStr = new Date().toISOString().split('T')[0];
    const uniqueKey = `finance:${todayStr}`; 
  
    try {
      // -------------------------------------------------------
      // Step 1: 检查本地缓存
      // -------------------------------------------------------
      let useCache = false;
      const cachedFinance = await ExternalResource.findOne({ uniqueKey });
  
      if (cachedFinance) {
        const now = new Date();
        const lastUpdate = new Date(cachedFinance.updatedAt);
        const diffMs = now - lastUpdate;
        const sixHoursMs = 6 * 60 * 60 * 1000; 
  
        if (force === 'true') {
          useCache = false;
        } else if (diffMs > sixHoursMs) {
          useCache = false;
        } else {
          useCache = true;
        }
      }
  
      // -------------------------------------------------------
      // Step 2: 缓存有效则直接返回 (修复点1：防止缓存坏数据导致崩盘)
      // -------------------------------------------------------
      if (useCache && cachedFinance) {
        // 安全获取列表，如果 list 丢了就给个空数组
        const safeList = (cachedFinance.rawData && cachedFinance.rawData.list) ? cachedFinance.rawData.list : [];
        
        const listWithUrl = safeList.map(item => ({
          ...item,
          googleUrl: item.googleUrl || `https://www.google.com/search?q=${encodeURIComponent(item.title)}`
        }));
  
        return res.json({
          date: todayStr,
          list: listWithUrl,
          updateTime: cachedFinance.updatedAt,
          source: "local"
        });
      }
  
      // -------------------------------------------------------
      // Step 3: 调用天行财经 API
      // -------------------------------------------------------
      console.log(`[API Call] 正在抓取财经新闻...`);
      const tianUrl = `https://apis.tianapi.com/caijing/index?key=${TIAN_KEY}&num=20`;
      
      const response = await axios.get(tianUrl);
      const apiRes = response.data;
  
      // 如果 API 报错
      if (apiRes.code !== 200) {
        if (cachedFinance) {
          // 降级：如果有旧缓存，哪怕过期了也先返回，别报错
          const fallbackList = (cachedFinance.rawData && cachedFinance.rawData.list) ? cachedFinance.rawData.list : [];
          return res.json({
             date: todayStr,
             list: fallbackList,
             source: "local-fallback"
          });
        }
        return res.status(400).json({ msg: apiRes.msg || "天行接口调用失败" });
      }
  
      // 🔥🔥🔥 修复点2：核心修复 (Fix .map error)
      // 确保 rawList 绝对是个数组，而不是 undefined
      let rawList = [];
      if (apiRes.result && Array.isArray(apiRes.result.list)) {
        rawList = apiRes.result.list;
      } else {
        console.warn("TianAPI warning: result.list is missing or empty", apiRes);
        // 如果 API 返回成功代码但没有 list，我们就不处理了，直接返回空或报错
      }
  
      const processedList = rawList.map(item => ({
        ...item,
        url: item.url || `https://www.google.com/search?q=${encodeURIComponent(item.title)}`,
        googleUrl: `https://www.google.com/search?q=${encodeURIComponent(item.title)}`
      }));
  
      // -------------------------------------------------------
      // Step 4: 存入数据库
      // -------------------------------------------------------
      // 只有当真的抓到了数据才存，防止把空列表存进去覆盖了可能有用的旧数据
      let savedDoc = null;
      if (processedList.length > 0) {
        savedDoc = await ExternalResource.findOneAndUpdate(
          { uniqueKey },
          {
            type: 'finance',
            uniqueKey: uniqueKey,
            title: `${todayStr} 财经快报`,
            description: `包含 ${processedList.length} 条资讯`,
            coverImage: processedList[0]?.picUrl || "",
            rawData: { list: processedList }
          },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        );
      } else {
          // 如果没抓到数据，尝试复用缓存对象以便返回 updateTime
          savedDoc = cachedFinance || { updatedAt: new Date() };
      }
  
      res.json({
        date: todayStr,
        list: processedList,
        updateTime: savedDoc ? savedDoc.updatedAt : new Date(),
        source: "tianapi"
      });
  
    } catch (err) {
      console.error("Finance Error:", err);
      res.status(500).json({ msg: "服务器内部错误" });
    }
  });

module.exports = router;