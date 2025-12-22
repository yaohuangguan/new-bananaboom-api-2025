/**
 * @description Native Fetch Wrapper (Axios Style)
 * @author Sam Yao
 * @version 1.0.0
 */

class AxiosError extends Error {
  constructor(message, code, config, request, response) {
    super(message);
    this.name = 'AxiosError';
    this.code = code;
    this.config = config;
    this.request = request;
    this.response = response;
    this.isAxiosError = true;
  }
}

class InterceptorManager {
  constructor() {
    this.handlers = [];
  }
  use(fulfilled, rejected) {
    this.handlers.push({ fulfilled, rejected });
    return this.handlers.length - 1;
  }
  eject(id) {
    if (this.handlers[id]) {
      this.handlers[id] = null;
    }
  }
}

class MiniAxios {
  constructor(defaults = {}) {
    this.defaults = {
      timeout: 0,
      headers: {
        'Content-Type': 'application/json',
        ...defaults.headers
      },
      ...defaults
    };
    this.interceptors = {
      request: new InterceptorManager(),
      response: new InterceptorManager()
    };
  }

  /**
   * 核心请求方法
   */
  async request(urlOrConfig, config = {}) {
    // 1. 参数归一化
    let mergedConfig;
    if (typeof urlOrConfig === 'string') {
      mergedConfig = { ...this.defaults, ...config, url: urlOrConfig };
    } else {
      mergedConfig = { ...this.defaults, ...urlOrConfig };
    }

    // 2. 构造 Promise 链，处理请求拦截器
    const chain = [this._dispatchRequest.bind(this), undefined];

    // 将请求拦截器插入到链的前面 (后进先出，或者按顺序，Axios 是反向遍历，这里简化为顺序)
    this.interceptors.request.handlers.forEach((interceptor) => {
      if (interceptor) {
        chain.unshift(interceptor.fulfilled, interceptor.rejected);
      }
    });

    // 将响应拦截器插入到链的后面
    this.interceptors.response.handlers.forEach((interceptor) => {
      if (interceptor) {
        chain.push(interceptor.fulfilled, interceptor.rejected);
      }
    });

    let promise = Promise.resolve(mergedConfig);

    while (chain.length) {
      promise = promise.then(chain.shift(), chain.shift());
    }

    return promise;
  }

  /**
   * 实际派发 Fetch 请求
   */
  async _dispatchRequest(config) {
    const { url, baseURL, params, data, headers, timeout, method } = config;

    // A. URL 处理
    let fullUrl = url;
    if (baseURL && !/^https?:\/\//i.test(url)) {
      // 简单拼接，处理斜杠
      const cleanBase = baseURL.replace(/\/+$/, '');
      const cleanUrl = url.replace(/^\/+/, '');
      fullUrl = `${cleanBase}/${cleanUrl}`;
    }

    // B. Query Params 处理
    if (params) {
      const queryStr = new URLSearchParams(params).toString();
      fullUrl += (fullUrl.includes('?') ? '&' : '?') + queryStr;
    }

    // C. 超时处理
    let signal;
    let timeoutId;
    if (timeout > 0) {
      const controller = new AbortController();
      signal = controller.signal;
      timeoutId = setTimeout(() => controller.abort(), timeout);
    }

    // D. Body 处理
    let body = undefined;
    if (data !== undefined) {
      if (headers['Content-Type'] && headers['Content-Type'].includes('json')) {
        body = JSON.stringify(data);
      } else {
        body = data; // FormData, Blob, string 等原生支持的格式
      }
    }

    // E. 执行 Fetch
    try {
      const response = await fetch(fullUrl, {
        method: (method || 'GET').toUpperCase(),
        headers: headers,
        body: body,
        signal: signal
      });

      if (timeoutId) clearTimeout(timeoutId);

      // F. 解析响应
      const resData = await this._parseResponse(response);

      // 构造 Axios 风格的响应对象
      const axiosResponse = {
        data: resData,
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers),
        config: config,
        request: null // Node fetch 没有 XMLHttpRequest 对象，留空
      };

      // G. 校验状态码 (默认 2xx 成功，否则抛错)
      if (!response.ok) {
        throw new AxiosError(
          `Request failed with status code ${response.status}`,
          response.status,
          config,
          null,
          axiosResponse
        );
      }

      return axiosResponse;
    } catch (error) {
      if (timeoutId) clearTimeout(timeoutId);

      // 处理超时错误
      if (error.name === 'AbortError') {
        throw new AxiosError(`timeout of ${timeout}ms exceeded`, 'ECONNABORTED', config, null, null);
      }

      // 如果已经是 AxiosError (比如上面的 status check 抛出的)，直接透传
      if (error.isAxiosError) throw error;

      // 处理网络错误
      throw new AxiosError(error.message, 'ERR_NETWORK', config, null, null);
    }
  }

  async _parseResponse(response) {
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      try {
        return await response.json();
      } catch {
        return await response.text(); // JSON 解析失败降级为文本
      }
    }
    return await response.text(); // 默认当文本处理
  }

  // === 快捷方法别名 ===

  get(url, config) {
    return this.request({ ...config, method: 'GET', url });
  }
  delete(url, config) {
    return this.request({ ...config, method: 'DELETE', url });
  }
  head(url, config) {
    return this.request({ ...config, method: 'HEAD', url });
  }
  options(url, config) {
    return this.request({ ...config, method: 'OPTIONS', url });
  }
  post(url, data, config) {
    return this.request({ ...config, method: 'POST', url, data });
  }
  put(url, data, config) {
    return this.request({ ...config, method: 'PUT', url, data });
  }
  patch(url, data, config) {
    return this.request({ ...config, method: 'PATCH', url, data });
  }
}

// 导出工厂函数
function createInstance(defaultConfig) {
  const context = new MiniAxios(defaultConfig);
  // 绑定 request 方法的 this 上下文
  const instance = MiniAxios.prototype.request.bind(context);

  // 将实例属性拷贝到 request 函数上 (为了能用 instance.get, instance.interceptors)
  Object.assign(instance, context);
  // 将原型链上的方法也拷贝过去
  const proto = Object.getPrototypeOf(context);
  Object.getOwnPropertyNames(proto).forEach((prop) => {
    if (prop !== 'constructor' && typeof context[prop] === 'function') {
      instance[prop] = context[prop].bind(context);
    }
  });

  instance.create = function (config) {
    return createInstance(config);
  };

  return instance;
}

// 默认导出实例
const http = createInstance({
  timeout: 10000,
  headers: {
    Accept: 'application/json, text/plain, */*'
  }
});

export default http;
// ✅ 这里的 Named Export 是为了让你能直接 import { get, post }
// 注意：delete 是 JS 关键字，不能声明为变量名，所以通常习惯导出为 del
export const get = http.get;
export const post = http.post;
export const put = http.put;
export const patch = http.patch;
export const del = http.delete;
export const head = http.head;
export const options = http.options;
export const request = http.request;
