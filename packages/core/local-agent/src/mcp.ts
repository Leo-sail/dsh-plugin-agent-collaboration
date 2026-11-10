/**
 * Loopback MCP server (Streamable HTTP) for ONE agent conversation.
 *
 * It exposes exactly the DSH tools the adapter allow-listed, on 127.0.0.1 with a random port
 * and a per-conversation bearer token. A `tools/call` does NOT execute anything here: it
 * parks until the host resolves it, which is what lets the adapter turn one CLI tool call
 * into an ordinary DSH tool call (approvals and ledger included) and feed the result back.
 *
 * Only the slice MCP clients use in practice is implemented: initialize, initialized,
 * tools/list, tools/call, plus 401/405 handling. Everything else is -32601.
 *
 * @module
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'

const PROTOCOL_VERSION = '2025-03-26'

/** One tool as the agent sees it. */
export interface McpToolSpec {
  readonly name: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
}

export interface McpToolResult {
  readonly text: string
  readonly isError: boolean
}

/** A parked tool call the adapter will resolve on the next host turn. */
export interface McpCall {
  readonly callId: string
  readonly name: string
  readonly arguments: Record<string, unknown>
}

export class LoopbackMcp {
  readonly token = randomBytes(32).toString('hex')
  /** Resolved after `listen()`; undefined before. */
  url: string | undefined
  private readonly server: Server
  private readonly tools: McpToolSpec[] = []
  private readonly pending = new Map<string, (result: McpToolResult) => void>()
  private onCall: ((call: McpCall) => void) | undefined
  private listening: Promise<string> | undefined
  private port: number | undefined

  constructor() {
    this.server = createServer((request, response) => {
      void this.serve(request, response).catch(() => {
        if (!response.headersSent) response.writeHead(500)
        response.end()
      })
    })
  }

  setTools(tools: readonly McpToolSpec[]): void {
    this.tools.length = 0
    this.tools.push(...tools.map(tool => ({ ...tool })))
  }

  /** Register the sink for one conversation's calls (one server belongs to one session). */
  setCallHandler(handler: (call: McpCall) => void): void {
    this.onCall = handler
  }

  async listen(): Promise<string> {
    this.listening ??= new Promise<string>((resolve, reject) => {
      this.server.listen(0, '127.0.0.1', () => {
        const address = this.server.address()
        if (address === null || typeof address === 'string') { reject(new Error('no port')); return }
        this.port = address.port
        this.url = `http://127.0.0.1:${address.port}/mcp`
        // A finished host run must be able to exit even while the conversation is idle.
        this.server.unref()
        resolve(this.url)
      }).once('error', reject)
    })
    return this.listening
  }

  /** Answer the parked call from the host. Unknown/already-settled ids are ignored. */
  resolve(callId: string, result: McpToolResult): void {
    const settle = this.pending.get(callId)
    if (settle === undefined) return
    this.pending.delete(callId)
    settle(result)
  }

  /** Fail every parked call (turn aborted / conversation closed). */
  failAll(error: Error): void {
    for (const [, settle] of this.pending) settle({ text: error.message, isError: true })
    this.pending.clear()
  }

  close(): void {
    this.failAll(new Error('the conversation closed'))
    this.server.close()
  }

  private async serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== '/mcp') { response.writeHead(404); response.end(); return }
    // Bearer header (documented) or a query token (some clients cannot send headers on the
    // first GET); both are per-conversation random secrets.
    const authorized = request.headers.authorization === `Bearer ${this.token}`
      || url.searchParams.get('token') === this.token
    if (!authorized) {
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'unauthorized' } }))
      return
    }
    if (request.method === 'DELETE') { response.writeHead(204); response.end(); return }
    if (request.method !== 'POST') { response.writeHead(405); response.end(); return }
    const body = await readBody(request)
    let message: unknown
    try { message = JSON.parse(body) } catch { response.writeHead(400); response.end(); return }
    const messages = Array.isArray(message) ? (message as unknown[]) : [message]
    const replies: unknown[] = []
    for (const item of messages) {
      const reply = await this.handleMessage(item)
      if (reply !== undefined) replies.push(reply)
    }
    if (replies.length === 0) { response.writeHead(202); response.end(); return }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(replies.length === 1 ? replies[0] : replies))
  }

  private async handleMessage(message: unknown): Promise<unknown | undefined> {
    if (message === null || typeof message !== 'object') return undefined
    const record = message as Record<string, unknown>
    const method = record['method']
    if (method === undefined) return undefined // client response; nothing to answer
    const id = record['id']
    const params = (record['params'] ?? {}) as Record<string, unknown>
    switch (method) {
      case 'initialize':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: typeof params['protocolVersion'] === 'string' ? params['protocolVersion'] : PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: 'dsh-local-agent', version: '1' },
          },
        }
      case 'notifications/initialized':
        return undefined
      case 'tools/list':
        return {
          jsonrpc: '2.0',
          id,
          result: { tools: this.tools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })) },
        }
      case 'tools/call': {
        const name = String(params['name'] ?? '')
        const args = params['arguments'] !== null && typeof params['arguments'] === 'object'
          ? params['arguments'] as Record<string, unknown>
          : {}
        if (!this.tools.some(tool => tool.name === name)) {
          return { jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool: ${name}` } }
        }
        const callId = `mcp-${randomUUID()}`
        const result = await new Promise<McpToolResult>(resolve => {
          this.pending.set(callId, resolve)
          this.onCall?.({ callId, name, arguments: args })
        })
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: result.text }],
            ...(result.isError ? { isError: true } : {}),
          },
        }
      }
      case 'ping':
        return { jsonrpc: '2.0', id, result: {} }
      default:
        if (id === undefined) return undefined
        return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${String(method)}` } }
    }
  }
}

async function readBody(request: IncomingMessage): Promise<string> {
  let body = ''
  for await (const chunk of request) body += chunk
  return body
}
