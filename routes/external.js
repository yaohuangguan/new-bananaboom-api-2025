const express = require("express");
const router = express.Router();
const axios = require("axios");
const ExternalResource = require("../models/ExternalResource");


// 从环境变量获取天行 API Key
const TIAN_KEY = process.env.TIAN_API_KEY; 



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



// ==========================================
// ⚡️ 策略配置中心 (核心解耦)
// ==========================================
// 以后想加新栏目，就在这里加一行，下面逻辑都不用动
const CATEGORY_CONFIG = {
    // 1. 全网热搜
    hotsearch: {
      tianUrl: `https://apis.tianapi.com/networkhot/index?key=${TIAN_KEY}`,
      titleSuffix: "全网热搜榜",
      apiListKey: "list", // 天行热搜接口返回数据在 result.list 里
      hasPic: false       // 热搜通常没图
    },
    // 2. 财经新闻
    finance: {
      tianUrl: `https://apis.tianapi.com/caijing/index?key=${TIAN_KEY}&num=20`,
      titleSuffix: "财经快报",
      apiListKey: "newslist", // 天行新闻类接口通常在 newslist 里
      hasPic: true
    },
    // 3. 电竞/游戏资讯
    game: {
      tianUrl: `https://apis.tianapi.com/game/index?key=${TIAN_KEY}&num=20`,
      titleSuffix: "电竞/游戏资讯",
      apiListKey: "newslist",
      hasPic: true
    },
    // 🔥 4. 国内新闻 (新增)
    guonei: {
      tianUrl: `https://apis.tianapi.com/guonei/index?key=${TIAN_KEY}&num=20`,
      titleSuffix: "国内新闻",
      apiListKey: "newslist", // 这里的结构通常也是 newslist
      hasPic: true
    },
    // 🔥 5. 国际新闻 (新增)
    world: {
      tianUrl: `https://apis.tianapi.com/world/index?key=${TIAN_KEY}&num=20`,
      titleSuffix: "国际新闻",
      apiListKey: "newslist",
      hasPic: true
    }
  };
  
  /**
   * =================================================================
   * 🔥 通用日报列表接口 (Unified Daily List)
   * =================================================================
   * @route   GET /api/external/daily-list?type=hotsearch
   * @desc    统一获取 热搜/财经/游戏 等日报型数据。
   * @logic   按天存储 + 6小时自动过期刷新 + Google链接注入。
   * @param   {string} type  - (Required) hotsearch | finance | game
   * @param   {string} force - (Optional) "true" 强制刷新
   */
  router.get("/daily-list", async (req, res) => {
    const { type, force } = req.query;
    
    // 1. 校验 type 是否合法
    const config = CATEGORY_CONFIG[type];
    if (!config) {
      return res.status(400).json({ msg: `不支持的类型: ${type}。请检查参数。` });
    }
  
    const todayStr = new Date().toISOString().split('T')[0]; // "2025-12-19"
    const uniqueKey = `${type}:${todayStr}`; // e.g., "game:2025-12-19"
  
    try {
      // -------------------------------------------------------
      // Step 1: 检查本地缓存 (复用之前的 6小时过期逻辑)
      // -------------------------------------------------------
      let useCache = false;
      const cachedData = await ExternalResource.findOne({ uniqueKey });
  
      if (cachedData) {
        const now = new Date();
        const lastUpdate = new Date(cachedData.updatedAt);
        const diffMs = now - lastUpdate;
        const sixHoursMs = 6 * 60 * 60 * 1000; 
  
        if (force === 'true') {
          useCache = false;
        } else if (diffMs > sixHoursMs) {
          console.log(`[${type}] 缓存过期 (>6h)，准备刷新...`);
          useCache = false;
        } else {
          useCache = true;
        }
      }
  
      // -------------------------------------------------------
      // Step 2: 缓存命中，直接返回 (带空值保护)
      // -------------------------------------------------------
      if (useCache && cachedData) {
        const safeList = (cachedData.rawData && cachedData.rawData.list) ? cachedData.rawData.list : [];
        
        // 补全 Google URL (防止旧数据缺失)
        const listWithUrl = safeList.map(item => ({
          ...item,
          googleUrl: item.googleUrl || `https://www.google.com/search?q=${encodeURIComponent(item.title)}`
        }));
  
        return res.json({
          type,
          date: todayStr,
          list: listWithUrl,
          updateTime: cachedData.updatedAt,
          source: "local"
        });
      }
  
      // -------------------------------------------------------
      // Step 3: 调用天行 API (通用进货)
      // -------------------------------------------------------
      console.log(`[API Call] 正在抓取 ${type} ...`);
      
      const response = await axios.get(config.tianUrl);
      const apiRes = response.data;
  
      if (apiRes.code !== 200) {
        // 降级：如果 API 挂了，有旧缓存就先顶上
        if (cachedData) {
          const fallbackList = cachedData.rawData?.list || [];
          return res.json({
             type,
             date: todayStr,
             list: fallbackList,
             source: "local-fallback"
          });
        }
        return res.status(400).json({ msg: apiRes.msg || "天行接口调用失败" });
      }
  
      // 🛡️ 安全解析列表 (防弹衣)
      let rawList = [];
      if (apiRes.result && Array.isArray(apiRes.result[config.apiListKey])) {
        rawList = apiRes.result[config.apiListKey];
      } else {
        console.warn(`[Warning] ${type} API returned no list.`);
      }
  
      // 🔥 数据清洗 & 注入链接
      const processedList = rawList.map(item => ({
        ...item,
        // 优先用 API 自带 url，没有就用 google
        url: item.url || `https://www.google.com/search?q=${encodeURIComponent(item.title)}`,
        googleUrl: `https://www.google.com/search?q=${encodeURIComponent(item.title)}`
      }));
  
      // -------------------------------------------------------
      // Step 4: 存入数据库
      // -------------------------------------------------------
      let savedDoc = null;
      if (processedList.length > 0) {
        savedDoc = await ExternalResource.findOneAndUpdate(
          { uniqueKey },
          {
            type: type, // 确保 Model 的 enum 里包含 'game'
            uniqueKey: uniqueKey,
            title: `${todayStr} ${config.titleSuffix}`,
            description: `包含 ${processedList.length} 条资讯`,
            // 如果该类型支持图片且列表有图，取第一张做封面
            coverImage: (config.hasPic && processedList[0]?.picUrl) ? processedList[0].picUrl : "",
            rawData: { list: processedList }
          },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        );
      } else {
        // 没抓到数据，复用旧的或新建个空的防止报错
        savedDoc = cachedData || { updatedAt: new Date() };
      }
  
      // -------------------------------------------------------
      // Step 5: 返回
      // -------------------------------------------------------
      res.json({
        type,
        date: todayStr,
        list: processedList,
        updateTime: savedDoc.updatedAt,
        source: "tianapi"
      });
  
    } catch (err) {
      console.error(`Daily List Error (${type}):`, err);
      res.status(500).json({ msg: "服务器内部错误" });
    }
  });

module.exports = router;