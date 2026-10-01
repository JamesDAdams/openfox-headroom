import {
  checkHeadroomAvailability,
  compressMessagesWithHeadroom,
  startHeadroomProxy,
  stopHeadroomProxy,
  restartHeadroomProxy,
  installHeadroomCli,
  DEFAULT_HEADROOM_URL,
} from './client.js'

export interface PluginContext {
  settings(scope?: 'global' | 'project', projectId?: string): Record<string, unknown>
  publish(panelId: string | undefined, key: string, value: unknown): void
  notify(request: {
    title: { en: string; fr: string }
    body?: { en: string; fr: string }
    level?: 'info' | 'success' | 'warning' | 'error'
  }): void
  logger: {
    debug(msg: string, ctx?: Record<string, unknown>): void
    info(msg: string, ctx?: Record<string, unknown>): void
    warn(msg: string, ctx?: Record<string, unknown>): void
    error(msg: string, ctx?: Record<string, unknown>): void
  }
}

export interface PluginRegistry {
  readonly context: PluginContext
  registerSettings(schema: any): void
  registerMessageTransform(transform: any): void
  registerRpc(method: string, handler: any): void
  registerUiPanel(panel: any): void
  registerUiAction(action: any): void
  registerUiComponent(component: any): void
  registerSettingsTab(tab: any): void
  registerAsset(assetPath: string): void
}

export interface SessionTokenStats {
  tokensBefore: number
  tokensAfter: number
  tokensSaved: number
  compressionsCount: number
}

const sessionStatsMap = new Map<string, SessionTokenStats>()
let pollInterval: NodeJS.Timeout | null = null
let activeRegistry: PluginRegistry | null = null

function readShowHeaderButton(context: PluginContext): boolean {
  const settings = context.settings() ?? {}
  return settings['showHeaderButton'] !== false
}

function getHeaderComponent(running: boolean, show: boolean) {
  if (!show) {
    return {
      type: 'stack' as const,
      direction: 'row' as const,
      children: [],
    }
  }

  const dotColor = running ? '#22c55e' : '#ef4444'
  const tooltipText = running
    ? { en: 'Headroom: Running (Click to open dashboard)', fr: 'Headroom : Actif (Cliquer pour ouvrir le tableau de bord)' }
    : { en: 'Headroom: Stopped (Click to open dashboard)', fr: 'Headroom : Arrêté (Cliquer pour ouvrir le tableau de bord)' }

  return {
    type: 'button' as const,
    variant: 'ghost' as const,
    label: { en: 'Headroom', fr: 'Headroom' },
    tooltip: tooltipText,
    icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18"><image href="https://avatars.githubusercontent.com/u/294291659?s=60&amp;v=4" x="1" y="2" width="18" height="18" preserveAspectRatio="xMidYMid slice"/><circle cx="19" cy="5" r="3.5" fill="${dotColor}" stroke="#0f172a" stroke-width="1.5"/></svg>`,
    onActivate: {
      kind: 'openPanel' as const,
      panelId: 'headroom-dashboard',
    },
  }
}

async function updateLiveStatus(context: PluginContext, customUrl?: string): Promise<{ running: boolean; installed: boolean }> {
  try {
    const settings = context.settings() ?? {}
    const proxyUrl =
      customUrl ??
      (typeof settings['proxyUrl'] === 'string' && settings['proxyUrl'].trim()
        ? settings['proxyUrl'].trim().replace(/\/+$/, '')
        : DEFAULT_HEADROOM_URL)

    const showHeader = readShowHeaderButton(context)
    const status = await checkHeadroomAvailability(proxyUrl)

    // Update header button with green/red dot
    const headerNode = getHeaderComponent(status.running, showHeader)
    // Keep the registered node in sync: a client that loads later renders it as-is,
    // so a stale node shows a header button the user disabled.
    activeRegistry?.registerUiComponent({
      id: 'headroom-header-btn',
      zone: 'header.actions',
      component: headerNode,
    })
    context.publish('headroom-header-btn', 'content', headerNode)

    // Update settings tab status card
    const statusLabel = status.running
      ? `● Running on ${proxyUrl}`
      : status.installed
        ? `○ CLI installed (proxy stopped)`
        : `○ Headroom CLI not found`
    const statusTone = status.running ? 'success' : status.installed ? 'warning' : 'danger'

    context.publish('headroom-settings-status', 'statusText', statusLabel)
    context.publish('headroom-settings-status', 'statusTone', statusTone)

    return status
  } catch {
    return { running: false, installed: false }
  }
}

export function register(registry: PluginRegistry): void {
  const context = registry.context

  // 1. Settings Schema
  registry.registerSettings({
    fields: [
      {
        key: 'daemonStatus',
        type: 'status',
        section: { en: 'Headroom Server Status & Controls', fr: 'Statut et Contrôles du Serveur Headroom' },
        label: { en: 'Server Status', fr: 'Statut du serveur' },
        rpcMethod: 'getStatus',
      },
      {
        key: 'startProxy',
        type: 'button',
        label: { en: 'Launch Server', fr: 'Lancer le serveur' },
        buttonLabel: { en: 'Launch', fr: 'Lancer' },
        buttonVariant: 'primary',
        rpcMethod: 'startProxy',
        width: 'half',
      },
      {
        key: 'restartProxy',
        type: 'button',
        label: { en: 'Restart Server', fr: 'Relancer le serveur' },
        buttonLabel: { en: 'Restart', fr: 'Relancer' },
        buttonVariant: 'secondary',
        rpcMethod: 'restartProxy',
        width: 'half',
      },
      {
        key: 'stopProxy',
        type: 'button',
        label: { en: 'Close Server', fr: 'Fermer le serveur' },
        buttonLabel: { en: 'Close / Stop', fr: 'Fermer' },
        buttonVariant: 'danger',
        rpcMethod: 'stopProxy',
        width: 'half',
      },
      {
        key: 'enabled',
        type: 'boolean',
        section: { en: 'Compression Settings', fr: 'Paramètres de compression' },
        label: { en: 'Enable Context Compression', fr: 'Activer la compression de contexte' },
        description: {
          en: 'Compress tool outputs, logs, and prompt context using Headroom before sending to LLM.',
          fr: 'Compresse les sorties d’outils, journaux et contexte avec Headroom avant l’envoi au LLM.',
        },
        default: true,
      },
      {
        key: 'showHeaderButton',
        type: 'boolean',
        label: { en: 'Show Header Button', fr: 'Afficher le bouton dans l’en-tête' },
        description: {
          en: 'Show a quick-access button with live status dot in the OpenFox header bar.',
          fr: 'Affiche un bouton d’accès rapide avec pastille d’état dans l’en-tête OpenFox.',
        },
        default: false,
      },
      {
        key: 'autoStart',
        type: 'boolean',
        label: { en: 'Launch Headroom on Startup', fr: 'Lancer Headroom au démarrage' },
        description: {
          en: 'Automatically launch the `headroom proxy` daemon when OpenFox starts if stopped.',
          fr: 'Lance automatiquement le démon « headroom proxy » au démarrage d’OpenFox s’il est arrêté.',
        },
        default: true,
      },
      {
        key: 'proxyUrl',
        type: 'text',
        label: { en: 'Headroom Proxy URL', fr: 'URL du proxy Headroom' },
        description: {
          en: 'Address of the Headroom proxy daemon (default: http://127.0.0.1:8787).',
          fr: 'Adresse du démon proxy Headroom (par défaut : http://127.0.0.1:8787).',
        },
        default: DEFAULT_HEADROOM_URL,
      },
      {
        key: 'frozenMessageCount',
        type: 'number',
        label: { en: 'Frozen Message Count (Prompt Caching)', fr: 'Messages gelés (Prompt Caching)' },
        description: {
          en: 'Number of initial conversation messages to keep unmodified to preserve prompt cache hits.',
          fr: 'Nombre de messages initiaux à conserver intacts pour préserver le cache de prompt.',
        },
        default: 0,
      },
      {
        key: 'tokenBudget',
        type: 'number',
        label: { en: 'Token Budget', fr: 'Budget de tokens' },
        description: {
          en: 'Target token limit for compression (leave blank for automatic compression).',
          fr: 'Limite cible de tokens pour la compression (laisser vide pour compression automatique).',
        },
      },
    ],
  })

  // 2. Message Transform Pipeline Hook
  registry.registerMessageTransform({
    id: 'headroom',
    priority: 50,
    transform: async (messages: any[], transformCtx: any) => {
      const settings = context.settings() ?? {}
      const enabled = settings['enabled'] !== false
      if (!enabled) {
        return messages
      }

      const proxyUrl =
        typeof settings['proxyUrl'] === 'string' && settings['proxyUrl'].trim()
          ? settings['proxyUrl'].trim().replace(/\/+$/, '')
          : DEFAULT_HEADROOM_URL

      const frozenMessageCount =
        typeof settings['frozenMessageCount'] === 'number' && settings['frozenMessageCount'] > 0
          ? settings['frozenMessageCount']
          : undefined

      const tokenBudget =
        typeof settings['tokenBudget'] === 'number' && settings['tokenBudget'] > 0
          ? settings['tokenBudget']
          : undefined

      const result = await compressMessagesWithHeadroom({
        messages,
        model: transformCtx?.model,
        headroomUrl: proxyUrl,
        frozenMessageCount,
        tokenBudget,
      })

      const sessionId = typeof transformCtx?.sessionId === 'string' ? transformCtx.sessionId : undefined

      if (result.compressed) {
        if (sessionId) {
          const current = sessionStatsMap.get(sessionId) ?? {
            tokensBefore: 0,
            tokensAfter: 0,
            tokensSaved: 0,
            compressionsCount: 0,
          }
          current.tokensBefore += result.tokensBefore
          current.tokensAfter += result.tokensAfter
          current.tokensSaved += result.tokensSaved
          current.compressionsCount += 1
          sessionStatsMap.set(sessionId, current)

          const totalSavedFormatted = `${current.tokensSaved.toLocaleString()}`
          const ratioPercent =
            current.tokensBefore > 0
              ? `${(((current.tokensBefore - current.tokensAfter) / current.tokensBefore) * 100).toFixed(1)}%`
              : '0%'

          context.publish('headroom-stats-summary', `${sessionId}:saved`, `${totalSavedFormatted} tokens`)
          context.publish('headroom-stats-summary', `${sessionId}:ratio`, ratioPercent)
          context.publish('headroom-stats-summary', `${sessionId}:count`, `${current.compressionsCount}`)
          context.publish('headroom-stats-summary', 'saved', `${totalSavedFormatted} tokens`)
          context.publish('headroom-stats-summary', 'ratio', ratioPercent)
          context.publish('headroom-stats-summary', 'count', `${current.compressionsCount}`)
        }

        context.logger.debug('Headroom compressed messages', {
          tokensBefore: result.tokensBefore,
          tokensAfter: result.tokensAfter,
          tokensSaved: result.tokensSaved,
          compressionRatio: result.compressionRatio,
          transforms: result.transformsApplied,
        })
      }

      return {
        messages: result.messages,
        metadata: {
          tokensBefore: result.tokensBefore,
          tokensAfter: result.tokensAfter,
          tokensSaved: result.tokensSaved,
          compressionRatio: result.compressionRatio,
          transformsApplied: result.transformsApplied,
          compressed: result.compressed,
        },
      }
    },
  })

  // 3. UI Dashboard Modal Panel
  registry.registerUiPanel({
    id: 'headroom-dashboard',
    title: { en: 'Headroom Dashboard', fr: 'Tableau de bord Headroom' },
    kind: 'iframe',
    url: 'http://127.0.0.1:8787/dashboard',
    size: '3xl',
  })

  // Plugins menu row: clicking the plugin name opens the same dashboard as the header button.
  registry.registerUiAction({
    id: 'headroom-menu',
    slot: 'plugin.menu',
    label: { en: 'Headroom Compression', fr: 'Headroom Compression' },
    onActivate: { kind: 'openPanel', panelId: 'headroom-dashboard' },
  })

  // 4. Header UI Component (with live green/red dot)
  activeRegistry = registry
  registry.registerUiComponent({
    id: 'headroom-header-btn',
    zone: 'header.actions',
    component: getHeaderComponent(false, readShowHeaderButton(context)),
  })

  // 5. Session Stats Summary UI Component
  registry.registerUiComponent({
    id: 'headroom-stats-summary',
    zone: 'stats.modal.summary',
    component: {
      type: 'card',
      title: { en: 'Headroom Token Optimization', fr: 'Optimisation des tokens Headroom' },
      subtitle: {
        en: 'Tokens saved through context compression in this conversation.',
        fr: 'Tokens économisés grâce à la compression de contexte dans cette conversation.',
      },
      children: [
        {
          type: 'keyValue',
          items: [
            { key: { en: 'Tokens Saved', fr: 'Tokens économisés' }, value: '{{saved}}' },
            { key: { en: 'Compression Rate', fr: 'Taux de compression' }, value: '{{ratio}}' },
            { key: { en: 'Optimized Turns', fr: 'Tours optimisés' }, value: '{{count}}' },
          ],
        },
      ],
    },
  })

  // 6. Process Management & Health RPCs
  registry.registerRpc('startProxy', async () => {
    const settings = context.settings() ?? {}
    const proxyUrl =
      typeof settings['proxyUrl'] === 'string' && settings['proxyUrl'].trim()
        ? settings['proxyUrl'].trim().replace(/\/+$/, '')
        : DEFAULT_HEADROOM_URL

    const res = await startHeadroomProxy(proxyUrl)
    await updateLiveStatus(context, proxyUrl)
    return res
  })

  registry.registerRpc('stopProxy', async () => {
    const settings = context.settings() ?? {}
    const proxyUrl =
      typeof settings['proxyUrl'] === 'string' && settings['proxyUrl'].trim()
        ? settings['proxyUrl'].trim().replace(/\/+$/, '')
        : DEFAULT_HEADROOM_URL

    const res = await stopHeadroomProxy(proxyUrl)
    await updateLiveStatus(context, proxyUrl)
    return res
  })

  registry.registerRpc('restartProxy', async () => {
    const settings = context.settings() ?? {}
    const proxyUrl =
      typeof settings['proxyUrl'] === 'string' && settings['proxyUrl'].trim()
        ? settings['proxyUrl'].trim().replace(/\/+$/, '')
        : DEFAULT_HEADROOM_URL

    const res = await restartHeadroomProxy(proxyUrl)
    await updateLiveStatus(context, proxyUrl)
    return res
  })

  registry.registerRpc('installCli', async () => {
    context.notify({
      title: { en: 'Installing Headroom CLI...', fr: 'Installation de la CLI Headroom…' },
      body: {
        en: 'Running background installation (pipx / pip / npm)...',
        fr: 'Installation en arrière-plan (pipx / pip / npm)…',
      },
      level: 'info',
    })

    const res = await installHeadroomCli()
    if (res.success) {
      context.notify({
        title: { en: 'Headroom Installed', fr: 'Headroom installé' },
        body: { en: res.message, fr: res.message },
        level: 'success',
      })
    } else {
      context.notify({
        title: { en: 'Installation Failed', fr: 'Échec de l’installation' },
        body: { en: res.message, fr: res.message },
        level: 'error',
      })
    }
    await updateLiveStatus(context)
    return res
  })

  registry.registerRpc('getStatus', async () => {
    const settings = context.settings() ?? {}
    const proxyUrl =
      typeof settings['proxyUrl'] === 'string' && settings['proxyUrl'].trim()
        ? settings['proxyUrl'].trim().replace(/\/+$/, '')
        : DEFAULT_HEADROOM_URL

    const status = await checkHeadroomAvailability(proxyUrl)
    const text = status.running
      ? { en: `Running (${proxyUrl})`, fr: `En cours d’exécution (${proxyUrl})` }
      : status.installed
        ? { en: 'Stopped (CLI installed)', fr: 'Arrêté (CLI installée)' }
        : { en: 'CLI not installed', fr: 'CLI non installée' }

    return {
      running: status.running,
      installed: status.installed,
      available: status.available,
      version: status.version,
      proxyUrl: status.proxyUrl,
      text,
      tone: status.running ? 'success' : status.installed ? 'warning' : 'danger',
    }
  })

  registry.registerRpc('getSessionStats', async (_params: any, rpcCtx: any) => {
    const sessionId = typeof rpcCtx?.sessionId === 'string' ? rpcCtx.sessionId : undefined
    if (!sessionId) {
      return { tokensBefore: 0, tokensAfter: 0, tokensSaved: 0, compressionsCount: 0 }
    }
    return (
      sessionStatsMap.get(sessionId) ?? {
        tokensBefore: 0,
        tokensAfter: 0,
        tokensSaved: 0,
        compressionsCount: 0,
      }
    )
  })

  registry.registerRpc('checkHealth', async () => {
    const settings = context.settings() ?? {}
    const proxyUrl =
      typeof settings['proxyUrl'] === 'string' && settings['proxyUrl'].trim()
        ? settings['proxyUrl'].trim().replace(/\/+$/, '')
        : DEFAULT_HEADROOM_URL

    return checkHeadroomAvailability(proxyUrl)
  })

  registry.registerRpc('refreshStatus', async () => {
    const status = await updateLiveStatus(context)
    return status
  })

  // 8. Initial Startup & Auto-Start Handling
  const initialSettings = context.settings() ?? {}
  const proxyUrl =
    typeof initialSettings['proxyUrl'] === 'string' && initialSettings['proxyUrl'].trim()
      ? initialSettings['proxyUrl'].trim().replace(/\/+$/, '')
      : DEFAULT_HEADROOM_URL

  if (initialSettings['autoStart'] === true) {
    void startHeadroomProxy(proxyUrl).then(() => {
      void updateLiveStatus(context, proxyUrl)
    })
  } else {
    void updateLiveStatus(context, proxyUrl)
  }

  // Periodic polling for status dot updates (every 5 seconds)
  if (!pollInterval) {
    pollInterval = setInterval(() => {
      void updateLiveStatus(context)
    }, 5000)
    pollInterval.unref?.()
  }
}

export async function deactivate(): Promise<void> {
  if (pollInterval) {
    clearInterval(pollInterval)
    pollInterval = null
  }
  sessionStatsMap.clear()
  await stopHeadroomProxy()
}

export * from './client.js'
