import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  MAX_ID_CHARS,
  REMOTE_PROTOCOL_VERSION,
  parseClientMessage,
  type RemoteServerMessage,
  type RemoteSessionMessage,
} from '../../shared/remote-protocol'
import type { PublicDevice, RemotePairing } from './remote-pairing'

export const REMOTE_DEFAULT_PORT = 47800
export const AUTH_TIMEOUT_MS = 5_000
export const MAX_REMOTE_SOCKETS = 4
export const MAX_REMOTE_MESSAGE_BYTES = 64 * 1024
export const HEARTBEAT_INTERVAL_MS = 30_000
export const MAX_PAIR_BODY_BYTES = 4 * 1024

const PAGE_FILE = 'remote.html'
const SOCKET_PATH = '/ws'
const PAIR_PATH = '/pair'
const ASSET_ROUTE = /^\/assets\/([A-Za-z0-9._-]+)$/
const LOCALE_ROUTE = /^\/locales\/([A-Za-z-]{2,12})$/
const WILDCARD_ADDRESSES: ReadonlySet<string> = new Set(['', '0.0.0.0', '::', '[::]'])
const JSON_CONTENT_TYPE = 'application/json; charset=utf-8'
const TEXT_CONTENT_TYPE = 'text/plain; charset=utf-8'
// WebSocket close code "policy violation".
const CLOSE_POLICY_VIOLATION = 1008

const STATUS_OK = 200
const STATUS_BAD_REQUEST = 400
const STATUS_FORBIDDEN = 403
const STATUS_NOT_FOUND = 404
const STATUS_METHOD_NOT_ALLOWED = 405
const STATUS_PAYLOAD_TOO_LARGE = 413
const STATUS_MISDIRECTED = 421
const STATUS_TOO_MANY_REQUESTS = 429
const STATUS_UNAVAILABLE = 503

const STATUS_TEXT: Record<number, string> = {
  [STATUS_FORBIDDEN]: 'Forbidden',
  [STATUS_UNAVAILABLE]: 'Service Unavailable',
}

/** Sent with every response. The page may load and connect only to this server. */
const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
}

/** One authenticated phone connection, as the session handler sees it. */
export interface RemoteClient {
  readonly device: PublicDevice
  send(message: RemoteServerMessage): void
  close(): void
}

/** Supplied by the session bridge. The server itself knows nothing about Pi. */
export interface RemoteSessionHandler {
  onConnect(client: RemoteClient): void
  onMessage(client: RemoteClient, message: RemoteSessionMessage): void
  onDisconnect(client: RemoteClient): void
}

export interface RemoteServerDeps {
  pairing: Pick<RemotePairing, 'redeemPairingCode' | 'authenticate'>
  handler: RemoteSessionHandler
  /** In the app: true only for a Tailscale address of this machine. */
  isAllowedBindAddress(address: string): boolean
  /** Reads `remote.html` or `assets/<name>` from the built phone page, or null. */
  readStaticFile(relativePath: string): Promise<{ body: Buffer; contentType: string } | null>
  readLocale(language: string): Promise<string | null>
  /** Must never be given a token, a code or a message body. */
  log(level: 'info' | 'warn', message: string): void
  authTimeoutMs?: number
  heartbeatIntervalMs?: number
}

export interface RemoteServer {
  start(address: string, port: number): Promise<{ address: string; port: number }>
  stop(): Promise<void>
  closeDevice(deviceId: string): void
  isRunning(): boolean
}

interface SocketState {
  socket: WebSocket
  remoteAddress: string
  phase: 'waiting' | 'checking' | 'authed'
  client: RemoteClient | null
  answeredLastPing: boolean
  authTimer: ReturnType<typeof setTimeout> | null
}

/**
 * The HTTP and WebSocket server a paired phone talks to. It binds one allowed
 * address, serves the phone page, redeems pairing codes, and passes validated
 * messages from authenticated sockets to the session handler.
 *
 * Electron-free: every dependency is injected, so this runs under node:test.
 */
export function createRemoteServer(deps: RemoteServerDeps): RemoteServer {
  const authTimeoutMs = deps.authTimeoutMs ?? AUTH_TIMEOUT_MS
  const heartbeatIntervalMs = deps.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS

  let httpServer: Server | null = null
  let socketServer: WebSocketServer | null = null
  let heartbeat: ReturnType<typeof setInterval> | null = null
  let expectedHost = ''
  const sockets = new Set<SocketState>()

  // ─── HTTP ─────────────────────────────────────────────────────────────────

  function reply(res: ServerResponse, status: number, contentType: string, body: string | Buffer): void {
    res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': contentType })
    res.end(body)
  }

  function replyStatus(res: ServerResponse, status: number): void {
    reply(res, status, TEXT_CONTENT_TYPE, String(status))
  }

  function replyJson(res: ServerResponse, status: number, value: unknown): void {
    reply(res, status, JSON_CONTENT_TYPE, JSON.stringify(value))
  }

  /** The decoded path without its query, or null when it cannot be decoded. */
  function requestPath(req: IncomingMessage): string | null {
    const raw = (req.url ?? '').split('?')[0]
    try {
      return decodeURIComponent(raw)
    } catch {
      return null
    }
  }

  function readPairBody(req: IncomingMessage): Promise<string | 'too_large'> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = []
      let size = 0
      let tooLarge = false
      req.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > MAX_PAIR_BODY_BYTES) {
          tooLarge = true
          chunks.length = 0
          return
        }
        if (!tooLarge) chunks.push(chunk)
      })
      req.on('end', () => resolve(tooLarge ? 'too_large' : Buffer.concat(chunks).toString('utf8')))
      req.on('error', () => resolve('too_large'))
    })
  }

  function readPairRequest(body: string): { code: string; label: string } | null {
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      return null
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    const { code, label } = parsed as Record<string, unknown>
    if (typeof code !== 'string' || typeof label !== 'string') return null
    if (code.length === 0 || code.length > MAX_ID_CHARS || label.length > MAX_ID_CHARS) return null
    return { code, label }
  }

  async function handlePair(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readPairBody(req)
    if (body === 'too_large') {
      res.setHeader('Connection', 'close')
      replyStatus(res, STATUS_PAYLOAD_TOO_LARGE)
      return
    }
    const request = readPairRequest(body)
    if (!request) {
      replyStatus(res, STATUS_BAD_REQUEST)
      return
    }
    const remoteAddress = req.socket.remoteAddress ?? ''
    const result = await deps.pairing.redeemPairingCode(request.code, request.label, remoteAddress)
    if (result.ok) {
      deps.log('info', `Paired device ${result.device.deviceId} from ${remoteAddress}`)
      replyJson(res, STATUS_OK, { token: result.token, device: result.device })
      return
    }
    deps.log('warn', `Pairing refused for ${remoteAddress}: ${result.reason}`)
    replyJson(res, result.reason === 'locked_out' ? STATUS_TOO_MANY_REQUESTS : STATUS_FORBIDDEN, { reason: result.reason })
  }

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.headers.host !== expectedHost) {
      replyStatus(res, STATUS_MISDIRECTED)
      return
    }
    const path = requestPath(req)
    if (path === null) {
      replyStatus(res, STATUS_NOT_FOUND)
      return
    }

    if (path === PAIR_PATH) {
      if (req.method !== 'POST') replyStatus(res, STATUS_METHOD_NOT_ALLOWED)
      else await handlePair(req, res)
      return
    }

    const asset = ASSET_ROUTE.exec(path)
    const locale = LOCALE_ROUTE.exec(path)
    const isPage = path === '/'
    if (!isPage && !asset && !locale) {
      replyStatus(res, STATUS_NOT_FOUND)
      return
    }
    if (req.method !== 'GET') {
      replyStatus(res, STATUS_METHOD_NOT_ALLOWED)
      return
    }

    if (locale) {
      const text = await deps.readLocale(locale[1])
      if (text === null) replyStatus(res, STATUS_NOT_FOUND)
      else reply(res, STATUS_OK, JSON_CONTENT_TYPE, text)
      return
    }
    // The route pattern has no slash, but a name of only dots still escapes.
    if (asset && asset[1].includes('..')) {
      replyStatus(res, STATUS_NOT_FOUND)
      return
    }
    const file = await deps.readStaticFile(asset ? `assets/${asset[1]}` : PAGE_FILE)
    if (!file) replyStatus(res, STATUS_NOT_FOUND)
    else reply(res, STATUS_OK, file.contentType, file.body)
  }

  // ─── WebSocket ────────────────────────────────────────────────────────────

  function refuseUpgrade(socket: Duplex, status: number): void {
    socket.write(`HTTP/1.1 ${status} ${STATUS_TEXT[status]}\r\nConnection: close\r\n\r\n`)
    socket.destroy()
  }

  function sendTo(socket: WebSocket, message: RemoteServerMessage): void {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message))
  }

  async function handleAuth(state: SocketState, raw: string): Promise<void> {
    const message = parseClientMessage(raw)
    if (message?.type !== 'auth') {
      state.socket.close(CLOSE_POLICY_VIOLATION)
      return
    }
    state.phase = 'checking'
    const device = await deps.pairing.authenticate(message.token, state.remoteAddress)
    if (state.authTimer) clearTimeout(state.authTimer)
    state.authTimer = null
    if (!device) {
      deps.log('warn', `Authentication failed for ${state.remoteAddress}`)
      sendTo(state.socket, { type: 'auth_failed' })
      state.socket.close(CLOSE_POLICY_VIOLATION)
      return
    }
    if (state.socket.readyState !== state.socket.OPEN) return

    const client: RemoteClient = {
      device,
      send: (outgoing) => sendTo(state.socket, outgoing),
      close: () => state.socket.close(),
    }
    state.client = client
    state.phase = 'authed'
    deps.log('info', `Device ${device.deviceId} connected from ${state.remoteAddress}`)
    sendTo(state.socket, { type: 'auth_ok', protocolVersion: REMOTE_PROTOCOL_VERSION, deviceLabel: device.label })
    deps.handler.onConnect(client)
  }

  function handleFrame(state: SocketState, raw: string, isBinary: boolean): void {
    if (state.phase === 'waiting') {
      if (isBinary) state.socket.close(CLOSE_POLICY_VIOLATION)
      else void handleAuth(state, raw)
      return
    }
    // Nothing is accepted while the token check is still running.
    if (state.phase === 'checking' || !state.client) {
      state.socket.close(CLOSE_POLICY_VIOLATION)
      return
    }
    const message = isBinary ? null : parseClientMessage(raw)
    if (!message || message.type === 'auth') {
      state.client.send({ type: 'error', code: 'bad_message', message: 'The message is not valid.' })
      return
    }
    deps.handler.onMessage(state.client, message)
  }

  function acceptSocket(socket: WebSocket, req: IncomingMessage): void {
    const state: SocketState = {
      socket,
      remoteAddress: req.socket.remoteAddress ?? '',
      phase: 'waiting',
      client: null,
      answeredLastPing: true,
      authTimer: null,
    }
    sockets.add(state)
    state.authTimer = setTimeout(() => {
      deps.log('warn', `No authentication in time from ${state.remoteAddress}`)
      socket.close(CLOSE_POLICY_VIOLATION)
    }, authTimeoutMs)

    socket.on('pong', () => {
      state.answeredLastPing = true
    })
    socket.on('message', (data, isBinary) => handleFrame(state, data.toString(), isBinary))
    socket.on('error', () => socket.terminate())
    socket.on('close', () => {
      if (state.authTimer) clearTimeout(state.authTimer)
      sockets.delete(state)
      if (state.client) {
        deps.log('info', `Device ${state.client.device.deviceId} disconnected`)
        deps.handler.onDisconnect(state.client)
      }
    })
  }

  function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    socket.on('error', () => socket.destroy())
    const expectedOrigin = `http://${expectedHost}`
    if (requestPath(req) !== SOCKET_PATH || req.headers.host !== expectedHost || req.headers.origin !== expectedOrigin) {
      deps.log('warn', `Upgrade refused for ${req.socket.remoteAddress ?? ''}`)
      refuseUpgrade(socket, STATUS_FORBIDDEN)
      return
    }
    if (sockets.size >= MAX_REMOTE_SOCKETS || !socketServer) {
      refuseUpgrade(socket, STATUS_UNAVAILABLE)
      return
    }
    socketServer.handleUpgrade(req, socket, head, (accepted) => acceptSocket(accepted, req))
  }

  function checkHeartbeats(): void {
    for (const state of sockets) {
      if (!state.answeredLastPing) {
        state.socket.terminate()
        continue
      }
      state.answeredLastPing = false
      state.socket.ping()
    }
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  return {
    isRunning: () => httpServer !== null,

    async start(address, port) {
      if (httpServer) throw new Error('The remote server is already running')
      if (WILDCARD_ADDRESSES.has(address) || !deps.isAllowedBindAddress(address)) {
        throw new Error(`The remote server may not listen on "${address}"`)
      }

      const server = createServer((req, res) => {
        handleRequest(req, res).catch(() => {
          if (!res.headersSent) replyStatus(res, STATUS_BAD_REQUEST)
          else res.destroy()
        })
      })
      server.on('upgrade', handleUpgrade)

      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, address, () => {
          server.removeListener('error', reject)
          resolve()
        })
      })

      const actualPort = (server.address() as AddressInfo).port
      expectedHost = `${address}:${actualPort}`
      httpServer = server
      socketServer = new WebSocketServer({ noServer: true, clientTracking: false, maxPayload: MAX_REMOTE_MESSAGE_BYTES })
      heartbeat = setInterval(checkHeartbeats, heartbeatIntervalMs)
      deps.log('info', `Remote server listening on ${expectedHost}`)
      return { address, port: actualPort }
    },

    async stop() {
      const server = httpServer
      if (!server) return
      httpServer = null
      socketServer = null
      if (heartbeat) clearInterval(heartbeat)
      heartbeat = null
      for (const state of sockets) state.socket.terminate()
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
      deps.log('info', 'Remote server stopped')
    },

    closeDevice(deviceId) {
      for (const state of sockets) {
        if (state.client?.device.deviceId === deviceId) state.socket.close()
      }
    },
  }
}
