import type { AxiosInstance, AxiosRequestConfig } from 'axios'
import { useToast } from 'vue-toastification'
import router from '@/router'
import { useAuthStore } from '@/stores'
import { initializeRequestOptimizer } from '@/utils/requestOptimizer'
import { useGlobalOfflineStatus } from '@/composables/useOfflineStatus'
import i18n, { getCurrentLocale } from '@/plugins/i18n'
import {
  ApiRequestError,
  createApiClients,
  getApiBusinessErrorMessage,
  isApiBusinessFailure,
  isApiResponse,
  type ApiFeedbackMode,
  type ApiFallbackMessageKey,
  type DataApiClient,
  type PluginApiClient,
} from './client'

/** 带连接探测和反馈策略的 MoviePilot 请求配置。 */
export interface ConnectionAwareRequestConfig extends AxiosRequestConfig {
  feedback?: ApiFeedbackMode
  skipConnectionTracking?: boolean
}

const globalOfflineStatus = useGlobalOfflineStatus()
const toast = useToast()
// 会话失效后短暂窗口内的 401 都是同一次 token 作废的连带失败，统一静默避免刷屏。
const SESSION_EXPIRED_SUPPRESSION_MS = 5000
let sessionExpiredAt = 0
const fallbackMessageKeys: Record<ApiFallbackMessageKey, string> = {
  'invalid-envelope': 'common.invalidApiResponse',
  'network-error': 'common.networkConnectionFailed',
  'request-failed': 'common.apiRequestFailed',
  timeout: 'common.requestTimeout',
}
const { api, pluginApi } = createApiClients({
  baseURL: import.meta.env.VITE_API_BASE_URL,
  setupInstance: initializeClient,
  hooks: {
    markServerOnline: globalOfflineStatus.markServerOnline,
    reportConnectionFailure: globalOfflineStatus.reportNetworkError,
    // fork：403 仅来自边缘 WAF（如 Cloudflare）或安全拒绝，非登录态失效；
    // 后端已将全部认证失败统一为 401，故 403 绝不触发登出，仅拒绝请求即可。
    onForbidden: () => {},
    onClearCredentials: () => useAuthStore().clearToken(),
    onUnauthorized: (error: ApiRequestError) => {
      const authStore = useAuthStore()
      const retried = (error.config as (AxiosRequestConfig & { __authRetried?: boolean }) | undefined)?.__authRetried
      // 未重试的 401（如登录页校验失败、无 token）交给调用方展示，不登出。
      if (!retried) {
        return Date.now() - sessionExpiredAt < SESSION_EXPIRED_SUPPRESSION_MS
      }
      // 已重试仍 401：Bearer 与资源 Cookie 均失效，属会话失效。
      // 同一会话失效的连带请求在窗口内静默，避免并发刷屏。
      if (Date.now() - sessionExpiredAt < SESSION_EXPIRED_SUPPRESSION_MS) {
        return true
      }
      sessionExpiredAt = Date.now()
      authStore.logout()
      toast.error(i18n.global.t('common.sessionExpired'))
      void router.push('/login')
      return true
    },
  },
  notifier: {
    error: message => toast.error(message),
    success: message => toast.success(message),
  },
  resolveFallbackMessage: key => i18n.global.t(fallbackMessageKeys[key]),
})

declare global {
  interface Window {
    MoviePilotAPI: PluginApiClient
  }
}

/** 为两个客户端安装同一套取消、认证和语言请求头。 */
function initializeClient(instance: AxiosInstance | DataApiClient) {
  initializeRequestOptimizer(instance)
  instance.interceptors.request.use(config => {
    const authStore = useAuthStore()
    if (authStore.token) config.headers.Authorization = `Bearer ${authStore.token}`

    const locale = getCurrentLocale()
    config.headers['X-MoviePilot-Locale'] = locale
    config.headers['Accept-Language'] = locale
    return config
  })
}

// 插件远程组件接收 endpoint 的最终 payload，内部页面默认使用严格 envelope 解包客户端。
if (typeof window !== 'undefined') window.MoviePilotAPI = pluginApi

export { ApiRequestError, getApiBusinessErrorMessage, isApiBusinessFailure, isApiResponse, pluginApi }
export type { ApiFeedbackMode, DataApiClient, PluginApiClient }

export default api
