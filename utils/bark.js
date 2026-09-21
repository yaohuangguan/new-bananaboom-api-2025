import fetch from './http.js'
import { getR2DeliveryUrl, getR2KeyFromReference } from './r2Reference.js'

// =====================================================================
// 📨 辅助函数：Bark 推送 (增强版 - 支持 Sound/Level/Icon)
// =====================================================================
export async function sendBarkNotification (barkUrl, title, body, options = {}) {
    try {
      if (!barkUrl) return;
  
      // 1. 处理基础 URL
      const baseUrl = barkUrl.endsWith('/') ? barkUrl.slice(0, -1) : barkUrl;
  
      const resolveMediaUrl = (value) => {
        const key = getR2KeyFromReference(value);
        return key ? getR2DeliveryUrl(key) : value;
      };

      // 2. 准备 URL 参数
      const params = new URLSearchParams({
        // 图标: 如果 task 没配，用默认闹钟图标
        icon: resolveMediaUrl(options.icon) || 'https://cdn-icons-png.flaticon.com/512/3602/3602145.png',
        // 铃声: 默认 minuet
        sound: options.sound || 'minuet',
        // 中断级别: 默认 active
        level: options.level || 'active',
        // 分组
        group: 'Todo'
      });
  
      // 如果有点击跳转
      if (options.url) {
        params.append('url', options.url);
      }
  
      // 如果有图片
      if (options.image) {
        params.append('image', resolveMediaUrl(options.image));
      }
  
      // 如果有持续响铃
      if (options.call === '1') {
        params.append('call', options.call);
      }
  
      // 3. 拼接 & 发送
      // 格式: base/title/body?params
      const finalUrl = `${baseUrl}/${encodeURIComponent(title)}/${encodeURIComponent(body)}?${params.toString()}`;
  
      await fetch.get(finalUrl);
      console.log(`📱 Bark Params: ${params.toString()}`);
    } catch (e) {
      console.error(`❌ Bark Failed: ${e.message}`);
    }
  }