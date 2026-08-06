import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AxiosError, AxiosRequestConfig } from 'axios'

const mocks = vi.hoisted(() => {
  return {
    pushMock: vi.fn(),
    logoutMock: vi.fn(),
    clearTokenMock: vi.fn(),
    markServerOnlineMock: vi.fn(),
    reportNetworkErrorMock: vi.fn(),
    authToken: { value: 'old-bearer' },
  }
})

vi.mock('@/router', () => ({
  default: { push: (...args: unknown[]) => mocks.pushMock(...args) },
}))

vi.mock('@/stores', () => ({
  useAuthStore: () => ({
    get token() {
      return mocks.authToken.value
    },
    logout: mocks.logoutMock,
    clearToken: mocks.clearTokenMock,
  }),
}))

vi.mock('@/composables/useOfflineStatus', () => ({
  useGlobalOfflineStatus: () => ({
    markServerOnline: mocks.markServerOnlineMock,
    reportNetworkError: mocks.reportNetworkErrorMock,
  }),
}))

vi.mock('@/plugins/i18n', () => ({
  getCurrentLocale: () => 'zh-CN',
}))

vi.mock('@/utils/requestOptimizer', () => ({
  initializeRequestOptimizer: vi.fn(),
}))

import api from '@/api/index'

interface FakeError {
  config?: AxiosRequestConfig
  response?: { status: number; data: unknown }
  code?: string
  name?: string
  message?: string
}

function makeError(partial: FakeError): AxiosError {
  return partial as unknown as AxiosError
}

afterEach(() => {
  vi.clearAllMocks()
  mocks.authToken.value = 'old-bearer'
  api.defaults.adapter = undefined
})

describe('api response interceptor - auth retry on 401/403', () => {
  it('clears expired bearer and retries once on 401, cookie-backed success', async () => {
    const handlers = (api.interceptors.response as unknown as { handlers: Array<{ rejected?: (e: AxiosError) => Promise<unknown> }> }).handlers
    const rejected = handlers[handlers.length - 1].rejected
    expect(typeof rejected).toBe('function')

    api.defaults.adapter = (_config: AxiosRequestConfig) =>
      Promise.resolve({ data: { detail: 'ok-from-cookie' }, status: 200, statusText: 'OK', headers: {}, config: _config } as never)

    const err = makeError({
      config: { headers: {} },
      response: { status: 401, data: { detail: 'bearer expired' } },
    })

    const result = await rejected!(err)
    expect(mocks.clearTokenMock).toHaveBeenCalled()
    expect(result).toBeTruthy()
  })

  it('forces logout when 401 retry still fails (no valid cookie)', async () => {
    const handlers = (api.interceptors.response as unknown as { handlers: Array<{ rejected?: (e: AxiosError) => Promise<unknown> }> }).handlers
    const rejected = handlers[handlers.length - 1].rejected!

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    api.defaults.adapter = (_config: AxiosRequestConfig) =>
      Promise.reject(makeError({ config: { headers: {} }, response: { status: 401, data: { detail: 'no cookie' } } }))

    const err = makeError({
      config: { headers: {}, __authRetried: true } as AxiosRequestConfig,
      response: { status: 401, data: { detail: 'no cookie' } },
    })

    await expect(rejected(err)).rejects.toBeTruthy()
    expect(mocks.logoutMock).toHaveBeenCalled()
    expect(mocks.pushMock).toHaveBeenCalledWith('/login')
  })

  it('forces logout directly on 403 when retry already happened', async () => {
    const handlers = (api.interceptors.response as unknown as { handlers: Array<{ rejected?: (e: AxiosError) => Promise<unknown> }> }).handlers
    const rejected = handlers[handlers.length - 1].rejected!

    const err = makeError({
      config: { headers: {}, __authRetried: true } as AxiosRequestConfig,
      response: { status: 403, data: { detail: 'forbidden' } },
    })

    await expect(rejected(err)).rejects.toBeTruthy()
    expect(mocks.logoutMock).toHaveBeenCalled()
    expect(mocks.pushMock).toHaveBeenCalledWith('/login')
  })

  it('does not retry again when already retried', async () => {
    const handlers = (api.interceptors.response as unknown as { handlers: Array<{ rejected?: (e: AxiosError) => Promise<unknown> }> }).handlers
    const rejected = handlers[handlers.length - 1].rejected!

    const err = makeError({
      config: { headers: {}, __authRetried: true } as AxiosRequestConfig,
      response: { status: 401, data: { detail: 'x' } },
    })

    await expect(rejected(err)).rejects.toBeTruthy()
    expect(mocks.clearTokenMock).not.toHaveBeenCalled()
    expect(mocks.logoutMock).toHaveBeenCalled()
  })
})
