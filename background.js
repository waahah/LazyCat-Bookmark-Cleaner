import { getCurrentTimeout } from './settings.js';

// 配置常量
const CONFIG = {
  TIMEOUT: {
    DEFAULT: 15000,    // 默认超时时间 15 秒
    MIN: 5000,         // 最小超时时间 5 秒
    MAX: 30000         // 最大超时时间 30 秒
  }
};

// 添加 onInstalled 事件监听器
chrome.runtime.onInstalled.addListener((details) => {
  // 仅在首次安装时打开页面
  if (details.reason === 'install') {
    chrome.tabs.create({
      url: 'index.html'
    });
  }
});

// 保留原有的 action 点击事件
chrome.action.onClicked.addListener((tab) => {
  chrome.tabs.create({
    url: 'index.html'
  });
});

// 处理 URL 检查请求
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'cancelScan') {
    // 取消所有活动请求
    activeRequests.forEach(controller => controller.abort());
    activeRequests.clear();
    return;
  }
  
  if (request.type === 'checkUrl') {
    const controller = new AbortController();
    activeRequests.add(controller);
    
    checkUrl(request.url, controller.signal)
      .then(result => {
        activeRequests.delete(controller);
        sendResponse(result);
      })
      .catch(error => {
        activeRequests.delete(controller);
        sendResponse({ 
          isValid: false, 
          reason: error.message 
        });
      });
    return true;
  }
});

async function checkUrl(url, signal) {
    try {
        // 添加信号到请求中
        const controller = new AbortController();
        const localSignal = controller.signal;
        
        // 如果外部信号被中止，也中止本地控制器
        signal.addEventListener('abort', () => {
            controller.abort();
        });
        
        activeRequests.add(controller);
        
        const result = await checkUrlOnce(url, localSignal);
        
        activeRequests.delete(controller);
        return result;
    } catch (error) {
        if (error.name === 'AbortError') {
            throw new Error('Request cancelled');
        }
        throw error;
    }
}

async function checkUrlOnce(url) {
  const startTime = Date.now();
  try {
    // 获取用户设置的超时时间
    const timeout = await getCurrentTimeout();
    
    console.group(`🔍 Checking URL: ${url}`);
    console.log(`⏱️ Start Time: ${new Date(startTime).toLocaleTimeString()}`);
    console.log(`⏱️ Timeout: ${timeout}ms`);
    
    const specialProtocols = [
      'chrome:', 'chrome-extension:', 'edge:', 'about:', 
      'file:', 'data:', 'javascript:', 'brave:'
    ];

    const urlObj = new URL(url);
    if (specialProtocols.some(protocol => url.startsWith(protocol))) {
      console.log(`🔒 Special protocol detected: ${urlObj.protocol}`);
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
          'net::ERR_BLOCKED_BY_CLIENT',
          'net::ERR_ABORTED',
          'net::ERR_FAILED'
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
        requestLog.statusCode = details.statusCode;
        console.log(`✅ Response received: Status ${details.statusCode}`);
        
        // 使用 handleStatusCode 的结果
        const result = handleStatusCode(details.statusCode, finalUrl || url);
        if (result) {
            if (finalUrl && finalUrl !== url) {
                result.redirectUrl = finalUrl;
                result.reason = result.reason || `Redirected to ${finalUrl}`;
            }
            resolveResult(result);
            return;
        }

        // 如果 handleStatusCode 没有返回结果，使用默认处理
        resolveResult({
            isValid: false,
            reason: `HTTP Error: ${details.statusCode}`
        });
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

      const timeoutId = setTimeout(() => {
        if (!isResolved) {
          const timeElapsed = Date.now() - startTime;
          console.group('⚠️ Timeout Detection:');
          console.log(`Time elapsed: ${timeElapsed}ms`);
          console.log(`Has any response: ${hasResponse}`);
          
          if (!hasResponse) {
            console.log('❌ Request timed out with no response');
            controller.abort();
            removeListeners();
            logRequestResult();
            resolve({
              isValid: false,
              reason: 'Request Timeout'
            });
          } else {
            console.log('⚠️ Request timed out but had partial response');
            logRequestResult();
            resolveResult({
              isValid: true,
              reason: 'Site is responding but slow'
            });
          }
          console.groupEnd();
        }
      }, timeout);  // 使用获取到的超时时间

      fetch(url, {
        method: 'GET',
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        },
        mode: 'no-cors',
        cache: 'no-cache'
      }).then(response => {
        console.log('📥 Fetch response received:', {
          status: response.status,
          type: response.type,
          url: response.url
        });
        hasResponse = true;
      }).catch((error) => {
        console.log('❌ Fetch error:', {
          name: error.name,
          message: error.message,
          type: error.type
        });
        
        // 对于 CORS 和一些常见的访问限制，认为网站是有效的
        if (error.name === 'TypeError' && error.message === 'Failed to fetch') {
          resolveResult({
            isValid: true,
            reason: 'Site blocks automated access but might be accessible in browser'
          });
        }
        // 其他错误继续等待 chrome.webRequest 的结果
      });
    });
  } catch (error) {
    console.error(`❌ URL parsing error:`, error);
    return {
      isValid: false,
      reason: 'Invalid URL format'
    };
  } finally {
    console.groupEnd();  // 确保日志组总是被关闭
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

// 添加 getMessage 函数定义
function getMessage(messageName, substitutions = null) {
    return chrome.i18n.getMessage(messageName, substitutions);
}

function handleStatusCode(statusCode, url) {
    // 2xx 和 3xx 都认为是有效的
    if (statusCode >= 200 && statusCode < 400) {
        return { isValid: true };
    }
    
    // 4xx 中的一些状态码表示资源存在但访问受限
    if ([401, 403, 429, 405, 406, 407, 408].includes(statusCode)) {
        return { 
            isValid: true,
            reason: getStatusCodeReason(statusCode)
        };
    }
    
    // 区分不同类型的 5xx 错误
    if (statusCode >= 500) {
        switch (statusCode) {
            case 503: // Service Unavailable
            case 504: // Gateway Timeout
                return {
                    isValid: true,
                    reason: getMessage('errorType_temporaryError', 'Service temporarily unavailable')
                };
                
            case 501: // Not Implemented
                return {
                    isValid: false,
                    reason: getMessage('errorType_notImplemented', 'Service not implemented')
                };
                
            case 502: // Bad Gateway
                return {
                    isValid: false,
                    reason: getMessage('errorType_badGateway', 'Bad Gateway')
                };
                
            default: // 500 和其他 5xx
                return {
                    isValid: false,
                    reason: getMessage('errorType_serverError', 'Server Error')
                };
        }
    }

    return null;
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

let activeRequests = new Set();