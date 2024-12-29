chrome.action.onClicked.addListener((tab) => {
  chrome.tabs.create({
    url: 'index.html'
  });
});

// 处理 URL 检查请求
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'checkUrl') {
    checkUrl(request.url)
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ 
        isValid: false, 
        reason: error.message 
      }));
    return true;
  }
});

async function checkUrl(url) {
    try {
        return await checkUrlOnce(url);
    } catch (error) {
        throw error;
    }
}

// 添加网络状况检测和超时管理
class NetworkTimeoutManager {
    constructor() {
        this.baseTimeout = 6000; // 基础超时时间 6 秒
        this.maxTimeout = 12000; // 最大超时时间 12 秒
        this.minTimeout = 4000;  // 最小超时时间 4 秒
        this.networkSamples = []; // 存储最近的网络响应时间样本
        this.maxSamples = 10;    // 保留最近 10 个样本
    }

    // 获取当前网络状况下的超时时间
    getTimeout() {
        if (this.networkSamples.length === 0) {
            return this.baseTimeout;
        }

        // 计算最近样本的平均响应时间
        const avgResponseTime = this.calculateAverageResponseTime();
        // 使用平均响应时间的 2.5 倍作为超时时间
        let timeout = avgResponseTime * 2.5;

        // 确保超时时间在合理范围内
        timeout = Math.max(this.minTimeout, Math.min(timeout, this.maxTimeout));
        
        console.log(`🕒 Dynamic timeout set to ${timeout}ms (avg response: ${avgResponseTime}ms)`);
        return timeout;
    }

    // 添加新的响应时间样本
    addSample(responseTime) {
        this.networkSamples.push(responseTime);
        if (this.networkSamples.length > this.maxSamples) {
            this.networkSamples.shift(); // 移除最老的样本
        }
        console.log(`📊 Network samples updated: ${this.networkSamples.join(', ')}ms`);
    }

    // 计算平均响应时间
    calculateAverageResponseTime() {
        if (this.networkSamples.length === 0) return this.baseTimeout;
        
        // 移除异常值（超过平均值两个标准差的样本）
        const samples = this.removeOutliers(this.networkSamples);
        const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
        
        console.log(`📈 Average response time: ${avg}ms (from ${samples.length} samples)`);
        return avg;
    }

    // 移除异常值
    removeOutliers(samples) {
        if (samples.length < 4) return samples; // 样本太少不处理

        const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
        const std = Math.sqrt(
            samples.reduce((sq, n) => sq + Math.pow(n - avg, 2), 0) / samples.length
        );
        
        return samples.filter(s => Math.abs(s - avg) <= 2 * std);
    }

    // 重置样本数据
    reset() {
        this.networkSamples = [];
    }
}

// 创建超时管理器实例
const timeoutManager = new NetworkTimeoutManager();

async function checkUrlOnce(url) {
  const startTime = Date.now();
  console.group(`🔍 Checking URL: ${url}`);
  console.log(`⏱️ Start Time: ${new Date(startTime).toLocaleTimeString()}`);
  
  const specialProtocols = [
    'chrome:', 'chrome-extension:', 'edge:', 'about:', 
    'file:', 'data:', 'javascript:', 'brave:'
  ];

  try {
    const urlObj = new URL(url);
    if (specialProtocols.some(protocol => url.startsWith(protocol))) {
      console.log(`🔒 Special protocol detected: ${urlObj.protocol}`);
      console.groupEnd();
      return {
        isValid: true,
        reason: 'Special protocol URL'
      };
    }

    return new Promise((resolve, reject) => {
      let finalUrl = url;
      let isResolved = false;
      let hasResponse = false;
      let requestLog = {
        startTime,
        endTime: null,
        duration: null,
        redirects: [],
        errors: [],
        statusCode: null,
        finalUrl: null,
        attempts: 0
      };

      const logRequestResult = () => {
        requestLog.endTime = Date.now();
        requestLog.duration = requestLog.endTime - requestLog.startTime;
        
        console.log('📊 Request Summary:');
        console.table({
          'Duration': `${requestLog.duration}ms`,
          'Has Response': hasResponse,
          'Status Code': requestLog.statusCode,
          'Redirects': requestLog.redirects.length,
          'Errors': requestLog.errors.length,
          'Final URL': requestLog.finalUrl || url
        });

        if (requestLog.redirects.length > 0) {
          console.log('↪️ Redirects:');
          console.table(requestLog.redirects);
        }

        if (requestLog.errors.length > 0) {
          console.log('❌ Errors:');
          console.table(requestLog.errors);
        }
      };

      const errorListener = (details) => {
        if (isResolved) return;
        hasResponse = true;
        requestLog.errors.push({
          error: details.error,
          timestamp: Date.now(),
          timeTaken: Date.now() - startTime
        });
        
        console.log(`❌ Error detected: ${details.error}`);
        
        const connectionErrors = [
          'net::ERR_SOCKET_NOT_CONNECTED',
          'net::ERR_CONNECTION_CLOSED',
          'net::ERR_CONNECTION_RESET',
          'net::ERR_CONNECTION_REFUSED',
          'net::ERR_CONNECTION_TIMED_OUT'
        ];

        const accessErrors = [
          'net::ERR_NETWORK_ACCESS_DENIED',
          'net::ERR_BLOCKED_BY_RESPONSE',
          'net::ERR_BLOCKED_BY_CLIENT'
        ];

        const certErrors = [
          'net::ERR_CERT_COMMON_NAME_INVALID',
          'net::ERR_CERT_AUTHORITY_INVALID',
          'net::ERR_CERT_DATE_INVALID'
        ];

        if (connectionErrors.includes(details.error)) {
          const alternateUrl = new URL(url);
          alternateUrl.protocol = urlObj.protocol === 'https:' ? 'http:' : 'https:';
          console.log(`💡 Suggestion: Try ${alternateUrl.protocol} protocol`);
          
          resolveResult({
            isValid: true,
            reason: `Connection failed, might be temporary or try ${alternateUrl.protocol.slice(0, -1)}`,
            alternateUrl: alternateUrl.toString()
          });
        }
        else if (accessErrors.includes(details.error)) {
          resolveResult({ 
            isValid: true,
            reason: 'Site blocks automated access but might be accessible in browser'
          });
        }
        else if (certErrors.includes(details.error)) {
          resolveResult({ 
            isValid: true,
            reason: 'Site has certificate issues but might be accessible'
          });
        }
        else {
          resolveResult({
            isValid: false,
            reason: details.error
          });
        }
      };

      const redirectListener = (details) => {
        hasResponse = true;
        requestLog.redirects.push({
          from: details.url,
          to: details.redirectUrl,
          timestamp: Date.now(),
          timeTaken: Date.now() - startTime
        });
        finalUrl = details.redirectUrl;
        requestLog.finalUrl = finalUrl;
        console.log(`↪️ Redirect: ${details.url} -> ${details.redirectUrl}`);
      };

      const listener = (details) => {
        if (isResolved) return;
        hasResponse = true;
        recordResponseTime(); // 记录响应时间
        requestLog.statusCode = details.statusCode;
        console.log(`✅ Response received: Status ${details.statusCode}`);
        
        if (details.statusCode >= 200 && details.statusCode < 300) {
            resolveResult({ isValid: true });
        }
        else if (details.statusCode >= 300 && details.statusCode < 400) {
            if (finalUrl && finalUrl !== url) {
                resolveResult({ 
                    isValid: true,
                    redirectUrl: finalUrl,
                    reason: `Redirected to ${finalUrl}`
                });
            } else {
                resolveResult({ isValid: false, reason: 'Redirect without target' });
            }
        }
        else if ([401, 403, 429].includes(details.statusCode)) {
            resolveResult({ 
                isValid: true,
                reason: getStatusCodeReason(details.statusCode)
            });
        }
        else {
            resolveResult({
                isValid: false,
                reason: `HTTP Error: ${details.statusCode}`
            });
        }
      };

      const resolveResult = (result) => {
        if (!isResolved) {
          isResolved = true;
          clearTimeout(timeout);
          removeListeners();
          
          logRequestResult();
          console.log(`🏁 Final result:`, result);
          console.groupEnd();
          
          resolve(result);
        }
      };

      const removeListeners = () => {
        if (!isResolved) {
          chrome.webRequest.onCompleted.removeListener(listener);
          chrome.webRequest.onErrorOccurred.removeListener(errorListener);
          chrome.webRequest.onBeforeRedirect.removeListener(redirectListener);
        }
      };

      const urlPatterns = [
        url,
        url.replace('http://', 'https://'),
        url.replace('https://', 'http://')
      ];

      chrome.webRequest.onResponseStarted.addListener(
        listener,
        { urls: urlPatterns, types: ['main_frame', 'xmlhttprequest'] }
      );

      chrome.webRequest.onBeforeRedirect.addListener(
        redirectListener,
        { urls: urlPatterns, types: ['main_frame', 'xmlhttprequest'] }
      );

      chrome.webRequest.onCompleted.addListener(
        listener,
        { urls: urlPatterns, types: ['main_frame', 'xmlhttprequest'] }
      );

      chrome.webRequest.onErrorOccurred.addListener(
        errorListener,
        { urls: urlPatterns, types: ['main_frame', 'xmlhttprequest'] }
      );

      const controller = new AbortController();
      const signal = controller.signal;

      const timeout = setTimeout(() => {
        if (!isResolved) {
          const timeElapsed = Date.now() - startTime;
          console.warn(`⚠️ Request timeout after ${timeElapsed}ms`);
          console.log(`Response received: ${hasResponse}`);
          
          if (!hasResponse) {
            controller.abort();
            removeListeners();
            resolve({
              isValid: false,
              reason: 'Request Timeout'
            });
          } else {
            resolveResult({
              isValid: true,
              reason: 'Site is responding but slow'
            });
          }
        }
      }, timeoutManager.getTimeout());

      // 在成功接收响应时记录响应时间
      const recordResponseTime = () => {
        if (!isResolved) {
          const responseTime = Date.now() - startTime;
          timeoutManager.addSample(responseTime);
        }
      };

      fetch(url, {
        method: 'GET',
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        },
        mode: 'no-cors',
        cache: 'no-cache'
      }).catch((error) => {
        console.log(`🔄 Fetch error:`, error);
        requestLog.errors.push({
          type: 'fetch',
          error: error.message,
          timestamp: Date.now(),
          timeTaken: Date.now() - startTime
        });
      });
    });
  } catch (error) {
    console.error(`❌ URL parsing error:`, error);
    console.groupEnd();
    return {
      isValid: false,
      reason: 'Invalid URL format'
    };
  }
}

function getStatusCodeReason(code) {
    const reasons = {
        401: 'Requires authentication',
        403: 'Access restricted',
        429: 'Too many requests'
    };
    return reasons[code] || `Status code: ${code}`;
}

function handleStatusCode(statusCode, url) {
  // 2xx: 成功
  if (statusCode >= 200 && statusCode < 300) {
    return { isValid: true };
  }
  
  // 3xx: 重定向
  if (statusCode >= 300 && statusCode < 400) {
    return { 
      isValid: true,
      reason: 'Redirect response'
    };
  }
  
  // 4xx: 客户端错误
  if (statusCode >= 400 && statusCode < 500) {
    // 特殊处理某些 4xx 状态码
    if ([401, 403, 429].includes(statusCode)) {
      return { 
        isValid: true,
        reason: getStatusCodeReason(statusCode)
      };
    }
    if (statusCode === 404) {
      return {
        isValid: false,
        reason: 'Page not found'
      };
    }
    return {
      isValid: false,
      reason: `Client error: ${statusCode}`
    };
  }
  
  // 5xx: 服务器错误
  if (statusCode >= 500) {
    return {
      isValid: true,
      reason: 'Server temporarily unavailable'
    };
  }
}

// 清理 URL 的辅助函数
function cleanupUrl(url) {
  try {
    const urlObj = new URL(url);
    
    // 1. 移除末尾的 # 或 /#
    if (urlObj.hash === '#' || urlObj.hash === '') {
      url = url.replace(/#$/, '');
      url = url.replace(/\/#$/, '/');
    }
    
    // 2. 处理重复的斜杠
    url = url.replace(/([^:]\/)\/+/g, '$1');
    
    // 3. 确保 http/https URL 末尾有斜杠
    if (!url.endsWith('/') && !urlObj.pathname.includes('.') && !urlObj.hash && !urlObj.search) {
      url += '/';
    }
    
    return url;
  } catch (e) {
    return url;
  }
}

// 检测是否为单页面应用 URL 模式
function isSPAUrl(url) {
  try {
    const urlObj = new URL(url);
    
    // 1. 检查是否为常见的 SPA 路由模式
    const spaPatterns = [
      /\/#\//, // Vue/React 常见路由格式
      /\/[#!]$/, // Angular 和其他框架常见格式
      /\/[#!]\//, // 带路径的 hash 路由
    ];
    
    if (spaPatterns.some(pattern => pattern.test(url))) {
      return true;
    }
    
    // 2. 检查是否为纯 hash 路由
    if (urlObj.hash && urlObj.hash !== '#') {
      return true;
    }
    
    return false;
  } catch (e) {
    return false;
  }
}

// 添加重试机制
async function checkUrlWithRetry(url, maxRetries = 2) {
  let lastError;
  
  for (let i = 0; i < maxRetries; i++) {
    try {
      if (i > 0) {
        console.log(`[Retry ${i}] Checking ${url}`);
        await new Promise(resolve => setTimeout(resolve, 2000 * i));
      }
      
      const result = await checkUrlOnce(url);
      if (result.isValid || !isRetryableError(result.reason)) {
        return result;
      }
      lastError = result;
    } catch (error) {
      lastError = { isValid: false, reason: error.message };
    }
  }
  
  return lastError;
}

function isRetryableError(error) {
  const retryableErrors = [
    'net::ERR_SOCKET_NOT_CONNECTED',
    'net::ERR_CONNECTION_RESET',
    'net::ERR_NETWORK_CHANGED',
    'net::ERR_CONNECTION_REFUSED',
    'net::ERR_CONNECTION_TIMED_OUT',
    'net::ERR_NETWORK_IO_SUSPENDED',
    'Request Timeout'
  ];
  return retryableErrors.some(e => error?.includes(e));
}