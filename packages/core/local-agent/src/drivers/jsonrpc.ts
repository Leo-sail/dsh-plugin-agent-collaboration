/**
 * Newline-delimited JSON-RPC 2.0 over a child process's stdio.
 *
 * Just the slice an app-server driver needs: requests with a timeout, notifications, and
 * server→client requests answered by a handler. Cancellation is expressed by killing the
 * turn (A4 adds protocol-level interrupt), so no request re-wiring is needed here.
 *
 * @module
 */
import type { ChildProcess } from 'node:child_process'

interface Pending {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout> | undefined
}

export interface JsonRpcRequestOptions {
  /** 0 or omitted means "no timeout" (used for turn/start, which lasts the whole turn). */
  readonly timeoutMs?: number
  readonly signal?: AbortSignal | undefined
}

export class JsonRpcPeer {
  private readonly write: (message: unknown) => void
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private closed: Error | undefined
  /** Server → client requests. Returning a rejected promise answers with a JSON-RPC error. */
  requestHandler: ((method: string, params: unknown) => Promise<unknown>) | undefined
  /** Server → client notifications. */
  notificationHandler: ((method: string, params: unknown) => void) | undefined

  constructor(write: (message: unknown) => void) {
    this.write = write
  }

  request(method: string, params: unknown, options: JsonRpcRequestOptions = {}): Promise<unknown> {
    if (this.closed !== undefined) return Promise.reject(this.closed)
    if (options.signal?.aborted === true) return Promise.reject(new Error('request aborted'))
    const id = this.nextId++
    return new Promise<unknown>((resolve, reject) => {
      const timeoutMs = options.timeoutMs ?? 0
      const timer = timeoutMs > 0
        ? setTimeout(() => {
          this.pending.delete(id)
          reject(new Error(`JSON-RPC ${method} timed out after ${timeoutMs}ms`))
        }, timeoutMs)
        : undefined
      timer?.unref?.()
      if (options.signal !== undefined) {
        options.signal.addEventListener('abort', () => {
          if (!this.pending.has(id)) return
          this.pending.delete(id)
          if (timer !== undefined) clearTimeout(timer)
          reject(new Error(`JSON-RPC ${method} aborted`))
        }, { once: true })
      }
      this.pending.set(id, { resolve, reject, timer })
      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }

  notify(method: string, params: unknown): void {
    if (this.closed !== undefined) return
    this.write({ jsonrpc: '2.0', method, params })
  }

  /** Handle one decoded JSON-RPC message from the child. */
  async handle(message: unknown): Promise<void> {
    if (message === null || typeof message !== 'object') return
    const record = message as Record<string, unknown>
    const id = record['id']
    const method = record['method']
    const error = record['error']
    if (method === undefined) {
      // Response to one of our requests.
      if (typeof id !== 'number') return
      const pending = this.pending.get(id)
      if (pending === undefined) return
      this.pending.delete(id)
      if (pending.timer !== undefined) clearTimeout(pending.timer)
      if (error !== undefined) pending.reject(new Error(errorMessage(error)))
      else pending.resolve(record['result'])
      return
    }
    // Request or notification from the server.
    const params = record['params']
    if (id === undefined) {
      this.notificationHandler?.(String(method), params)
      return
    }
    const handler = this.requestHandler
    if (handler === undefined) {
      this.write({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${String(method)}` } })
      return
    }
    try {
      const result = await handler(String(method), params)
      this.write({ jsonrpc: '2.0', id, result: result ?? null })
    } catch (failure) {
      this.write({
        jsonrpc: '2.0',
        id,
        error: { code: -32603, message: failure instanceof Error ? failure.message : String(failure) },
      })
    }
  }

  /** Reject everything outstanding; the process is gone. */
  close(reason: Error): void {
    if (this.closed !== undefined) return
    this.closed = reason
    for (const [, pending] of this.pending) {
      if (pending.timer !== undefined) clearTimeout(pending.timer)
      pending.reject(reason)
    }
    this.pending.clear()
  }
}

function errorMessage(error: unknown): string {
  if (error !== null && typeof error === 'object') {
    const message = (error as Record<string, unknown>)['message']
    if (typeof message === 'string') return message
  }
  return String(error)
}

/** Line-framed reader for a child's stdout, feeding the peer. */
export function wireChild(child: ChildProcess, peer: JsonRpcPeer): void {
  let buffer = ''
  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    buffer += chunk
    let at: number
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at).trim()
      buffer = buffer.slice(at + 1)
      if (line === '') continue
      let decoded: unknown
      try { decoded = JSON.parse(line) } catch { continue }
      void peer.handle(decoded)
    }
  })
  child.on('exit', () => peer.close(new Error('the agent process exited')))
}
