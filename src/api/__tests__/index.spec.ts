import { AxiosError, AxiosHeaders, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  i18nT: vi.fn((key: string) => `translated:${key}`),
  authState: { token: null as string | null },
  logout: vi.fn(),
  clearToken: vi.fn(),
  routerPush: vi.fn(),
  toastError: vi.fn(),
}))

vi.mock('@/router', () => ({
  default: { push: mocks.routerPush },
}))
vi.mock('@/stores', () => ({
  useAuthStore: () => ({
    get token() {
      return mocks.authState.token
    },
    // 与真实 store 一致：登出时清空 token，后续在途请求按无 token 处理。
    logout: mocks.logout.mockImplementation(() => {
      mocks.authState.token = null
    }),
    // fork：401 时清除本地 Bearer，由请求层用资源 Cookie 兜底重试。
    clearToken: mocks.clearToken.mockImplementation(() => {
      mocks.authState.token = null
    }),
  }),
}))
vi.mock('@/utils/requestOptimizer', () => ({
  initializeRequestOptimizer: vi.fn(),
}))
vi.mock('@/composables/useOfflineStatus', () => ({
  useGlobalOfflineStatus: () => ({
    markServerOnline: vi.fn(),
    reportNetworkError: vi.fn(),
  }),
}))
vi.mock('@/plugins/i18n', () => ({
  default: { global: { t: mocks.i18nT } },
  getCurrentLocale: () => 'zh-CN',
}))
vi.mock('vue-toastification', () => ({
  useToast: () => ({ error: mocks.toastError, success: vi.fn() }),
}))

/** 安装始终返回指定 HTTP 失败的适配器。 */
async function installFailingAdapter(status: number, data: unknown) {
  const module = await import('@/api')
  module.default.defaults.adapter = async config => {
    const response: AxiosResponse = {
      config: config as InternalAxiosRequestConfig,
      data,
      headers: new AxiosHeaders(),
      status,
      statusText: 'Error',
    }
    throw new AxiosError(
      'Request failed',
      AxiosError.ERR_BAD_RESPONSE,
      config as InternalAxiosRequestConfig,
      undefined,
      response,
    )
  }
  return module
}

describe('API application wiring', () => {
  beforeEach(() => {
    // 重新加载 @/api 模块，重置模块级会话失效时间戳，避免用例间抑制窗口泄漏。
    vi.resetModules()
    mocks.authState.token = null
    mocks.logout.mockClear()
    mocks.clearToken.mockClear()
    mocks.routerPush.mockClear()
    mocks.toastError.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('向 window 暴露插件最终 payload 客户端，而内部默认导出数据客户端', async () => {
    const module = await import('@/api')

    expect(window.MoviePilotAPI).toBe(module.pluginApi)
    expect(module.default).not.toBe(module.pluginApi)
  })

  it('通过 i18n 实例解析请求层 fallback 文案', async () => {
    const module = await import('@/api')
    module.default.defaults.adapter = async config => ({
      config: config as InternalAxiosRequestConfig,
      data: { legacy: true },
      headers: new AxiosHeaders(),
      status: 200,
      statusText: 'OK',
    })

    const error = await module.default.get('/legacy').catch(reason => reason)

    expect(error).toBeInstanceOf(module.ApiRequestError)
    expect((error as Error).message).toBe('translated:common.invalidApiResponse')
    expect(mocks.i18nT).toHaveBeenCalledWith('common.invalidApiResponse')
  })

  it('已登录时并发 401 只统一登出并提示一次本地化文案', async () => {
    vi.useFakeTimers()
    mocks.authState.token = 'expired-token'
    const module = await installFailingAdapter(401, { detail: 'Not authenticated' })

    await Promise.allSettled([module.default.get('/dashboard'), module.default.get('/subscribe')])

    expect(mocks.logout).toHaveBeenCalledOnce()
    expect(mocks.routerPush).toHaveBeenCalledWith('/login')
    expect(mocks.toastError).toHaveBeenCalledOnce()
    expect(mocks.toastError).toHaveBeenCalledWith('translated:common.sessionExpired')
  })

  it('登出后短暂窗口内的在途 401 保持静默，窗口过后恢复逐条提示', async () => {
    vi.useFakeTimers()
    mocks.authState.token = 'expired-token'
    const module = await installFailingAdapter(401, { detail: 'Not authenticated' })

    await module.default.get('/dashboard').catch(() => {})
    expect(mocks.toastError).toHaveBeenCalledOnce()

    // 窗口内的连带 401 不再弹出英文提示。
    await module.default.get('/subscribe').catch(() => {})
    expect(mocks.toastError).toHaveBeenCalledOnce()

    vi.setSystemTime(Date.now() + 6000)
    await module.default.get('/resource').catch(() => {})
    expect(mocks.toastError).toHaveBeenCalledTimes(2)
    // fork：重试后仍 401（Cookie 也失效）属于会话失效，提示本地化文案（非后端原始英文）。
    expect(mocks.toastError).toHaveBeenLastCalledWith('translated:common.sessionExpired')
  })

  it('401 时清除 Bearer 并用资源 Cookie 兜底重试成功，不登出', async () => {
    mocks.authState.token = 'expired-token'
    const module = await import('@/api')
    let call = 0
    module.default.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      call += 1
      if (call === 1) {
        throw new AxiosError(
          'Request failed',
          AxiosError.ERR_BAD_RESPONSE,
          config,
          undefined,
          {
            config,
            data: { detail: 'bearer expired' },
            headers: new AxiosHeaders(),
            status: 401,
            statusText: 'Error',
          },
        )
      }
      return {
        config,
        data: { success: true, message: 'ok', data: 'cookie-ok' },
        headers: new AxiosHeaders(),
        status: 200,
        statusText: 'OK',
      }
    }

    const result = await module.default.get('/dashboard')

    expect(mocks.clearToken).toHaveBeenCalledTimes(1)
    expect(mocks.logout).not.toHaveBeenCalled()
    expect(result).toBe('cookie-ok')
  })

  it('403 不触发登出（边缘 WAF 拒绝非登录态失效）', async () => {
    mocks.authState.token = 'valid-token'
    const module = await installFailingAdapter(403, { detail: 'forbidden' })

    await module.default.get('/resource').catch(() => {})

    expect(mocks.logout).not.toHaveBeenCalled()
    expect(mocks.routerPush).not.toHaveBeenCalled()
    expect(mocks.clearToken).not.toHaveBeenCalled()
  })
})
