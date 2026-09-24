import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { register, deactivate } from './index.js'
import * as client from './client.js'

describe('openfox-headroom plugin', () => {
  let calls: Record<string, any>
  let mockSettings: Record<string, any>
  let mockLogger: any
  let registry: any

  beforeEach(() => {
    calls = {}
    mockSettings = {}
    mockLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }
    registry = {
      context: {
        settings: vi.fn(() => mockSettings),
        publish: vi.fn((panelId, key, value) => {
          calls[`published_${panelId}_${key}`] = value
        }),
        notify: vi.fn(),
        logger: mockLogger,
      },
      registerSettings: vi.fn((s) => {
        calls.settings = s
      }),
      registerMessageTransform: vi.fn((t) => {
        calls.transform = t
      }),
      registerRpc: vi.fn((name, handler) => {
        calls[`rpc_${name}`] = handler
      }),
      registerUiPanel: vi.fn((p) => {
        calls.panel = p
      }),
      registerUiAction: vi.fn((a) => {
        calls.action = a
      }),
      registerUiComponent: vi.fn((c) => {
        calls[`component_${c.id}`] = c
      }),
      registerSettingsTab: vi.fn((tab) => {
        calls.settingsTab = tab
      }),
      registerAsset: vi.fn((asset) => {
        calls.asset = asset
      }),
    }
  })

  afterEach(async () => {
    await deactivate()
    vi.restoreAllMocks()
  })

  it('registers all contributions during register()', () => {
    register(registry)

    expect(registry.registerSettings).toHaveBeenCalled()
    expect(calls.settings.fields.some((f: any) => f.key === 'daemonStatus' && f.type === 'status')).toBe(true)
    expect(calls.settings.fields.some((f: any) => f.key === 'startProxy' && f.type === 'button')).toBe(true)
    expect(calls.settings.fields.some((f: any) => f.key === 'restartProxy' && f.type === 'button')).toBe(true)
    expect(calls.settings.fields.some((f: any) => f.key === 'stopProxy' && f.type === 'button')).toBe(true)

    expect(registry.registerMessageTransform).toHaveBeenCalled()
    expect(calls.transform.id).toBe('headroom')
    expect(calls.transform.priority).toBe(50)

    expect(registry.registerUiPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'headroom-dashboard',
        kind: 'iframe',
        url: 'http://127.0.0.1:8787/dashboard',
        size: '3xl',
      }),
    )

    expect(registry.registerUiComponent).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'headroom-header-btn',
        zone: 'header.actions',
      }),
    )

    expect(registry.registerUiComponent).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'headroom-stats-summary',
        zone: 'stats.modal.summary',
      }),
    )

    expect(registry.registerSettingsTab).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'headroom-tab',
        label: { en: 'Headroom', fr: 'Headroom' },
      }),
    )

    expect(registry.registerRpc).toHaveBeenCalledWith('startProxy', expect.any(Function))
    expect(registry.registerRpc).toHaveBeenCalledWith('stopProxy', expect.any(Function))
    expect(registry.registerRpc).toHaveBeenCalledWith('restartProxy', expect.any(Function))
    expect(registry.registerRpc).toHaveBeenCalledWith('installCli', expect.any(Function))
    expect(registry.registerRpc).toHaveBeenCalledWith('getStatus', expect.any(Function))
    expect(registry.registerRpc).toHaveBeenCalledWith('getSessionStats', expect.any(Function))
    expect(registry.registerRpc).toHaveBeenCalledWith('checkHealth', expect.any(Function))
    expect(registry.registerRpc).toHaveBeenCalledWith('refreshStatus', expect.any(Function))
  })

  it('publishes green status dot when proxy is running', async () => {
    vi.spyOn(client, 'checkHeadroomAvailability').mockResolvedValue({
      available: true,
      installed: true,
      running: true,
      version: '0.37.0',
      proxyUrl: 'http://127.0.0.1:8787',
    })

    register(registry)
    await calls.rpc_refreshStatus()

    expect(registry.context.publish).toHaveBeenCalledWith(
      'headroom-header-btn',
      'content',
      expect.objectContaining({
        type: 'button',
        icon: expect.stringContaining('#22c55e'),
      }),
    )
  })

  it('publishes red status dot when proxy is stopped', async () => {
    vi.spyOn(client, 'checkHeadroomAvailability').mockResolvedValue({
      available: false,
      installed: true,
      running: false,
      version: '0.37.0',
      proxyUrl: 'http://127.0.0.1:8787',
    })

    register(registry)
    await calls.rpc_refreshStatus()

    expect(registry.context.publish).toHaveBeenCalledWith(
      'headroom-header-btn',
      'content',
      expect.objectContaining({
        type: 'button',
        icon: expect.stringContaining('#ef4444'),
      }),
    )
  })

  it('getStatus returns status object with localized text and tone', async () => {
    vi.spyOn(client, 'checkHeadroomAvailability').mockResolvedValue({
      available: true,
      installed: true,
      running: true,
      version: '0.37.0',
      proxyUrl: 'http://127.0.0.1:8787',
    })

    register(registry)
    const status = await calls.rpc_getStatus()
    expect(status.running).toBe(true)
    expect(status.tone).toBe('success')
    expect(status.text.en).toContain('Running (http://127.0.0.1:8787)')
  })

  it('hides header button when showHeaderButton is false', async () => {
    mockSettings['showHeaderButton'] = false
    vi.spyOn(client, 'checkHeadroomAvailability').mockResolvedValue({
      available: true,
      installed: true,
      running: true,
      version: '0.37.0',
      proxyUrl: 'http://127.0.0.1:8787',
    })

    register(registry)
    await calls.rpc_refreshStatus()

    expect(registry.context.publish).toHaveBeenCalledWith(
      'headroom-header-btn',
      'content',
      expect.objectContaining({
        type: 'stack',
        children: [],
      }),
    )
  })

  it('launches proxy on startup when autoStart is true', async () => {
    mockSettings['autoStart'] = true
    const startSpy = vi.spyOn(client, 'startHeadroomProxy').mockResolvedValue({
      success: true,
      message: 'started',
    })

    register(registry)
    expect(startSpy).toHaveBeenCalled()
  })

  it('invokes startProxy, stopProxy, and restartProxy RPC handlers', async () => {
    register(registry)

    const startSpy = vi.spyOn(client, 'startHeadroomProxy').mockResolvedValue({ success: true, message: 'ok' })
    const stopSpy = vi.spyOn(client, 'stopHeadroomProxy').mockResolvedValue({ success: true, message: 'stopped' })
    const restartSpy = vi.spyOn(client, 'restartHeadroomProxy').mockResolvedValue({ success: true, message: 'restarted' })

    const startRes = await calls.rpc_startProxy()
    expect(startSpy).toHaveBeenCalled()
    expect(startRes.success).toBe(true)

    const stopRes = await calls.rpc_stopProxy()
    expect(stopSpy).toHaveBeenCalled()
    expect(stopRes.success).toBe(true)

    const restartRes = await calls.rpc_restartProxy()
    expect(restartSpy).toHaveBeenCalled()
    expect(restartRes.success).toBe(true)

    const installSpy = vi.spyOn(client, 'installHeadroomCli').mockResolvedValue({ success: true, message: 'installed' })
    const installRes = await calls.rpc_installCli()
    expect(installSpy).toHaveBeenCalled()
    expect(installRes.success).toBe(true)
    expect(registry.context.notify).toHaveBeenCalled()
  })

  it('compresses messages via transform and updates session token stats', async () => {
    register(registry)

    const compressSpy = vi.spyOn(client, 'compressMessagesWithHeadroom').mockResolvedValue({
      messages: [{ role: 'user', content: 'compressed prompt' }],
      tokensBefore: 100,
      tokensAfter: 40,
      tokensSaved: 60,
      compressionRatio: 0.4,
      transformsApplied: ['smart_crusher'],
      compressed: true,
    })

    const initialMessages = [{ role: 'user' as const, content: 'original prompt' }]
    const result = await calls.transform.transform(initialMessages, { model: 'gpt-4o', sessionId: 'sess-123' })

    expect(compressSpy).toHaveBeenCalledWith({
      messages: initialMessages,
      model: 'gpt-4o',
      headroomUrl: 'http://127.0.0.1:8787',
      frozenMessageCount: undefined,
      tokenBudget: undefined,
    })

    expect(result.messages[0].content).toBe('compressed prompt')
    expect(result.metadata.tokensSaved).toBe(60)

    expect(registry.context.publish).toHaveBeenCalledWith(
      'headroom-stats-summary',
      'sess-123:saved',
      expect.stringContaining('60 tokens'),
    )

    const stats = await calls.rpc_getSessionStats({}, { sessionId: 'sess-123' })
    expect(stats.tokensSaved).toBe(60)
    expect(stats.compressionsCount).toBe(1)
  })
})
