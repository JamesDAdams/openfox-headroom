import { spawn, exec, execSync } from 'node:child_process'
import { access } from 'node:fs/promises'
import { promisify } from 'node:util'

const execP = promisify(exec)

let activeProxyProcess: ReturnType<typeof spawn> | null = null
let exitHandlersRegistered = false

function registerExitCleanup() {
  if (exitHandlersRegistered) return
  exitHandlersRegistered = true

  const cleanup = () => {
    if (activeProxyProcess) {
      try {
        activeProxyProcess.kill('SIGKILL')
      } catch {}
      activeProxyProcess = null
    }
    try {
      if (process.platform === 'win32') {
        execSync('taskkill /F /IM headroom.exe', { stdio: 'ignore' })
      } else {
        execSync('pkill -f "headroom proxy" || pkill -f headroom', { stdio: 'ignore' })
      }
    } catch {}
  }

  process.once('exit', cleanup)
  process.once('SIGINT', cleanup)
  process.once('SIGTERM', cleanup)
  process.once('beforeExit', cleanup)
}

export async function startHeadroomProxy(proxyUrl: string = DEFAULT_HEADROOM_URL): Promise<{ success: boolean; message: string }> {
  registerExitCleanup()

  const isRunning = await checkHeadroomProxy(proxyUrl)
  if (isRunning) {
    return { success: true, message: 'Headroom proxy is already running.' }
  }

  const cli = await checkHeadroomCli()
  if (!cli.installed) {
    return { success: false, message: 'Headroom CLI is not installed on this machine.' }
  }

  try {
    const child = spawn('headroom', ['proxy'], {
      stdio: 'ignore',
    })
    activeProxyProcess = child

    // Poll until proxy responds or timeout
    for (let i = 0; i < 15; i++) {
      await new Promise((resolve) => setTimeout(resolve, 200))
      if (await checkHeadroomProxy(proxyUrl)) {
        return { success: true, message: 'Headroom proxy started successfully.' }
      }
    }

    return { success: true, message: 'Headroom proxy launch initiated.' }
  } catch (error) {
    return { success: false, message: `Failed to start Headroom proxy: ${error instanceof Error ? error.message : String(error)}` }
  }
}

export async function stopHeadroomProxy(proxyUrl: string = DEFAULT_HEADROOM_URL): Promise<{ success: boolean; message: string }> {
  try {
    if (activeProxyProcess) {
      try {
        activeProxyProcess.kill('SIGTERM')
      } catch {
        // ignore
      }
      activeProxyProcess = null
    }

    if (process.platform === 'win32') {
      await execP('taskkill /F /IM headroom.exe').catch(() => {})
    } else {
      await execP('pkill -f "headroom proxy" || pkill -f headroom').catch(() => {})
    }

    // Wait until stopped
    for (let i = 0; i < 10; i++) {
      await new Promise((resolve) => setTimeout(resolve, 150))
      if (!(await checkHeadroomProxy(proxyUrl))) {
        break
      }
    }

    return { success: true, message: 'Headroom proxy stopped.' }
  } catch (error) {
    return { success: false, message: `Failed to stop Headroom proxy: ${error instanceof Error ? error.message : String(error)}` }
  }
}

export async function installHeadroomCli(): Promise<{ success: boolean; message: string }> {
  try {
    const cmd = 'pipx install "headroom-ai[all]" || pip3 install "headroom-ai[all]" || pip install "headroom-ai[all]" || npm install -g headroom-ai'
    await execP(cmd)
    const check = await checkHeadroomCli()
    if (check.installed) {
      return { success: true, message: `Headroom installed successfully (${check.version ?? 'ready'}).` }
    }
    return { success: false, message: 'Installation finished but headroom command was not found in PATH.' }
  } catch (error) {
    return { success: false, message: `Installation failed: ${error instanceof Error ? error.message : String(error)}` }
  }
}

export async function restartHeadroomProxy(proxyUrl: string = DEFAULT_HEADROOM_URL): Promise<{ success: boolean; message: string }> {
  await stopHeadroomProxy(proxyUrl)
  await new Promise((resolve) => setTimeout(resolve, 500))
  return startHeadroomProxy(proxyUrl)
}

export const DEFAULT_HEADROOM_URL = 'http://127.0.0.1:8787'

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  thinkingContent?: string
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>
  toolCallId?: string
  attachments?: Array<{
    id: string
    filename: string
    mimeType: string
    size: number
    data?: string
  }>
}

export interface HeadroomOpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: {
      name: string
      arguments: string
    }
  }>
  tool_call_id?: string
}

export interface HeadroomCompressResponse {
  messages: HeadroomOpenAIMessage[]
  tokens_before?: number
  tokens_after?: number
  tokens_saved?: number
  compression_ratio?: number
  transforms_applied?: string[]
  ccr_hashes?: string[]
}

export interface HeadroomCompressResult {
  messages: LLMMessage[]
  tokensBefore: number
  tokensAfter: number
  tokensSaved: number
  compressionRatio: number
  transformsApplied: string[]
  compressed: boolean
}

export interface HeadroomStatus {
  available: boolean
  installed: boolean
  running: boolean
  version: string | null
  proxyUrl: string
}

export function toHeadroomMessages(messages: LLMMessage[]): HeadroomOpenAIMessage[] {
  return messages.map((msg) => {
    const role = msg.role
    const content = msg.content ?? ''

    const out: HeadroomOpenAIMessage = {
      role,
      content,
    }

    if (msg.toolCalls && msg.toolCalls.length > 0) {
      out.tool_calls = msg.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: {
          name: tc.name,
          arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments ?? {}),
        },
      }))
    }

    if (msg.toolCallId) {
      out.tool_call_id = msg.toolCallId
    }

    return out
  })
}

export function fromHeadroomMessages(
  compressed: HeadroomOpenAIMessage[],
  original: LLMMessage[],
): LLMMessage[] {
  return compressed.map((cMsg, index) => {
    const orig = original[index]
    const role = cMsg.role as LLMMessage['role']
    const content = cMsg.content ?? ''

    const isSameRole = orig && orig.role === role

    const out: LLMMessage = {
      role,
      content,
      ...(isSameRole && orig.thinkingContent ? { thinkingContent: orig.thinkingContent } : {}),
      ...(isSameRole && orig.attachments ? { attachments: orig.attachments } : {}),
    }

    if (role === 'assistant') {
      if (cMsg.tool_calls && cMsg.tool_calls.length > 0) {
        out.toolCalls = cMsg.tool_calls.map((tc) => {
          let parsedArgs: Record<string, unknown>
          try {
            parsedArgs = JSON.parse(tc.function.arguments)
          } catch {
            parsedArgs = {}
          }
          return {
            id: tc.id,
            name: tc.function.name,
            arguments: parsedArgs,
          }
        })
      } else if (isSameRole && orig.toolCalls) {
        out.toolCalls = orig.toolCalls
      }
    }

    if (role === 'tool') {
      if (cMsg.tool_call_id) {
        out.toolCallId = cMsg.tool_call_id
      } else if (isSameRole && orig.toolCallId) {
        out.toolCallId = orig.toolCallId
      }
    }

    return out
  })
}

export async function checkHeadroomCli(): Promise<{ installed: boolean; version: string | null }> {
  try {
    const version = await new Promise<string>((resolve, reject) => {
      const proc = spawn('headroom', ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      proc.stdout?.on('data', (d: Buffer) => {
        out += d.toString()
      })
      proc.on('error', reject)
      proc.on('close', (code) => {
        if (code === 0) resolve(out.trim())
        else reject(new Error(`exit ${code}`))
      })
    })
    return { installed: true, version: version || null }
  } catch {
    try {
      await access('/usr/local/bin/headroom')
      return { installed: true, version: null }
    } catch {
      return { installed: false, version: null }
    }
  }
}

export async function checkHeadroomProxy(proxyUrl: string): Promise<boolean> {
  try {
    const resp = await fetch(`${proxyUrl}/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(1500),
    })
    if (!resp.ok) return false
    const data = (await resp.json()) as { status?: string }
    return data.status === 'healthy' || resp.status === 200
  } catch {
    return false
  }
}

export async function checkHeadroomAvailability(customProxyUrl?: string): Promise<HeadroomStatus> {
  const proxyUrl = customProxyUrl ?? DEFAULT_HEADROOM_URL
  const [cli, running] = await Promise.all([checkHeadroomCli(), checkHeadroomProxy(proxyUrl)])

  return {
    available: running || cli.installed,
    installed: cli.installed,
    running,
    version: cli.version,
    proxyUrl,
  }
}

export interface CompressMessagesOptions {
  messages: LLMMessage[]
  model?: string
  headroomUrl?: string
  tokenBudget?: number
  frozenMessageCount?: number
  timeoutMs?: number
}

export async function compressMessagesWithHeadroom(options: CompressMessagesOptions): Promise<HeadroomCompressResult> {
  const {
    messages,
    model = 'gpt-4o',
    headroomUrl = DEFAULT_HEADROOM_URL,
    tokenBudget,
    frozenMessageCount,
    timeoutMs = 5000,
  } = options

  const fallback: HeadroomCompressResult = {
    messages,
    tokensBefore: 0,
    tokensAfter: 0,
    tokensSaved: 0,
    compressionRatio: 1.0,
    transformsApplied: [],
    compressed: false,
  }

  if (messages.length === 0) {
    return fallback
  }

  try {
    const openaiMessages = toHeadroomMessages(messages)
    const body: Record<string, unknown> = {
      messages: openaiMessages,
      model,
    }

    if (tokenBudget !== undefined && tokenBudget > 0) {
      body['token_budget'] = tokenBudget
    }

    const config: Record<string, unknown> = {}
    if (frozenMessageCount !== undefined && frozenMessageCount > 0) {
      config['frozen_message_count'] = frozenMessageCount
    }

    if (Object.keys(config).length > 0) {
      body['config'] = config
    }

    const resp = await fetch(`${headroomUrl}/v1/compress`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })

    if (!resp.ok) {
      return fallback
    }

    const data = (await resp.json()) as HeadroomCompressResponse
    if (!data || !Array.isArray(data.messages)) {
      return fallback
    }

    const mappedMessages = fromHeadroomMessages(data.messages, messages)
    const tokensBefore = data.tokens_before ?? 0
    const tokensAfter = data.tokens_after ?? 0
    const tokensSaved = data.tokens_saved ?? Math.max(0, tokensBefore - tokensAfter)
    const compressionRatio = data.compression_ratio ?? (tokensBefore > 0 ? tokensAfter / tokensBefore : 1.0)

    return {
      messages: mappedMessages,
      tokensBefore,
      tokensAfter,
      tokensSaved,
      compressionRatio,
      transformsApplied: data.transforms_applied ?? [],
      compressed: true,
    }
  } catch {
    return fallback
  }
}
