import { Schema, model } from 'mongoose';

const FootprintSchema = Schema(
  {
    // --- 1. 归属信息 ---
    user: {
      type: Schema.Types.ObjectId,
      ref: 'users',
      required: true
    },
    // 如果是情侣/家庭应用，可以加个字段标记是“谁”主张去的，或者关联一组人
    companions: [{ type: String }], // 同行者，如 ["老婆", "爸妈"]

    // --- 2. 地理信息 (核心：用于地图点亮) ---
    location: {
      // 结构化地址，方便统计“你去过多少个国家/省份”
      country: { type: String, default: '中国' },
      province: { type: String }, // e.g. "四川省"
      city: { type: String }, // e.g. "成都市"
      district: { type: String }, // e.g. "锦江区"

      // 具体地名 (POI)
      name: { type: String, required: true }, // e.g. "成都大熊猫繁育研究基地"
      address: { type: String },

      // 经纬度 (地图打点必须)
      // 建议格式：[经度(lng), 纬度(lat)]，这是 MongoDB GeoJSON 的标准顺序
      coordinates: {
        type: [Number],
        index: '2dsphere' // 🔥 加上地理位置索引，以后可以查“我附近的足迹”
      },

      // 行政区划代码 (Adcode)，前端地图库(如ECharts)常用这个来高亮区域
      adcode: { type: String }
    },

    // --- 3. 回忆详情 (富文本) ---
    content: {
      type: String,
      maxlength: 2000,
      default: '' // 游记/感想
    },
    images: [{ type: String }], // 照片墙

    // --- 4. 评价与心情 ---
    rating: {
      type: Number,
      min: 1,
      max: 5,
      default: 5 // 评分：1-5星
    },
    mood: {
      type: String,
      // 预设一些心情 Emoji 或 关键词
      enum: ['happy', 'excited', 'peaceful', 'tired', 'sad', 'romantic', 'adventurous'],
      default: 'happy'
    },
    cost: { type: Number }, // 可选：记录这趟花了多少钱

    // --- 5. 时间与状态 ---
    visitDate: { type: Date, required: true }, // 真正去的时间
    status: {
      type: String,
      enum: ['visited', 'planned'], // 既是足迹，也可以是种草清单
      default: 'visited'
    },

    // 是否置顶/精选（比如这是蜜月旅行，想在地图上显示得大一点）
    isHighlight: { type: Boolean, default: false }
  },
  { timestamps: true }
);

export default model('footprint', FootprintSchema);
