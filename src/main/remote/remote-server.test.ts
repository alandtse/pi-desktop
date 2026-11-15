import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import { once } from 'node:events'
import { WebSocket } from 'ws'
import {
  MAX_PAIR_BODY_BYTES,
  MAX_REMOTE_SOCKETS,
  createRemoteServer,
  type RemoteClient,
  type RemoteServerDeps,
} from './remote-server'
import type { PairingResult, PublicDevice } from './remote-pairing'
import type { RemoteServerMessage, RemoteSessionMessage } from '../../shared/remote-protocol'

const LOOPBACK = '127.0.0.1'
const AUTH_TIMEOUT_MS = 80
const GOOD_TOKEN = 'good-token'
const SECOND_TOKEN = 'second-token'
const DEVICE: PublicDevice = { deviceId: 'dev-1', label: 'My phone', pairedAt: 1, lastSeenAt: 2 }
const SECOND_DEVICE: PublicDevice = { deviceId: 'dev-2', label: 'Tablet', pairedAt: 1, lastSeenAt: 2 }

interface Harness {
  port: number
  origin: string
  server: ReturnType<typeof createRemoteServer>
  connected: RemoteClient[]
  disconnected: RemoteClient[]
  received: Array<{ deviceId: string; message: RemoteSessionMessage }>
  logs: string[]
  redeemCalls: Array<{ code: string; label: string; remoteAddress: string }>
  setRedeemResult(result: PairingResult): void
}

async function startServer(t: TestContext, overrides: Partial<RemoteServerDeps> = {}): Promise<Harness> {
  let redeemResult: PairingResult = { ok: true, token: 'new-token', device: DEVICE }
  const h: Omit<Harness, 'port' | 'origin' | 'server'> = {
    connected: [],
    disconnected: [],
    received: [],
    logs: [],
    redeemCalls: [],
    setRedeemResult: (result) => {
      redeemResult = result
    },
  }
  const server = createRemoteServer({
    pairing: {
      redeemPairingCode: async (code, label, remoteAddress) => {
        h.redeemCalls.push({ code, label, remoteAddress })
        return redeemResult
      },
      authenticate: async (token) => (token === GOOD_TOKEN ? DEVICE : token === SECOND_TOKEN ? SECOND_DEVICE : null),
    },
    handler: {
      onConnect: (client) => h.connected.push(client),
      onMessage: (client, message) => h.received.push({ deviceId: client.device.deviceId, message }),
      onDisconnect: (client) => h.disconnected.push(client),
    },
    isAllowedBindAddress: (address) => address === LOOPBACK,
    readStaticFile: async (relativePath) => {
      if (relativePath === 'remote.html') return { body: Buffer.from('<!doctype html><title>remote</title>'), contentType: 'text/html; charset=utf-8' }
      if (relativePath === 'assets/app.js') return { body: Buffer.from('console.log(1)'), contentType: 'text/javascript; charset=utf-8' }
      return null
    },
    readLocale: async (language) => (language === 'en' ? '{"hello":"Hello"}' : null),
    log: (_level, message) => h.logs.push(message),
    authTimeoutMs: AUTH_TIMEOUT_MS,
    ...overrides,
  })
  const { port } = await server.start(LOOPBACK, 0)
  t.after(() => server.stop())
  return { ...h, port, origin: `http://${LOOPBACK}:${port}`, server }
}

interface HttpReply {
  status: number
  headers: IncomingHttpHeaders
  body: string
}

function send(h: Harness, method: string, path: string, options: { headers?: Record<string, string>; body?: string } = {}): Promise<HttpReply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: LOOPBACK, port: h.port, method, path, headers: options.headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end(options.body)
  })
}

function openSocket(h: Harness, options: { origin?: string | null; path?: string; host?: string } = {}): WebSocket {
  const origin = options.origin === undefined ? h.origin : options.origin
  return new WebSocket(`ws://${LOOPBACK}:${h.port}${options.path ?? '/ws'}`, {
    ...(origin === null ? {} : { origin }),
    ...(options.host ? { headers: { host: options.host } } : {}),
  })
}

/** The HTTP status of a refused upgrade. */
async function refusedStatus(socket: WebSocket): Promise<number> {
  socket.on('error', () => {})
  const [, response] = (await once(socket, 'unexpected-response')) as [unknown, { statusCode: number }]
  return response.statusCode
}

async function nextMessage(socket: WebSocket): Promise<RemoteServerMessage> {
  const [data] = (await once(socket, 'message')) as [Buffer]
  return JSON.parse(data.toString('utf8')) as RemoteServerMessage
}

async function authedSocket(h: Harness, token = GOOD_TOKEN): Promise<WebSocket> {
  const socket = openSocket(h)
  await once(socket, 'open')
  socket.send(JSON.stringify({ type: 'auth', token }))
  assert.equal((await nextMessage(socket)).type, 'auth_ok')
  return socket
}

test('start refuses wildcard, empty and not-allowed addresses', async () => {
  const server = createRemoteServer({
    pairing: { redeemPairingCode: async () => ({ ok: false, reason: 'invalid_code' }), authenticate: async () => null },
    handler: { onConnect() {}, onMessage() {}, onDisconnect() {} },
    isAllowedBindAddress: () => true,
    readStaticFile: async () => null,
    readLocale: async () => null,
    log() {},
  })
  for (const address of ['0.0.0.0', '::', '', '[::]']) {
    await assert.rejects(server.start(address, 0), /may not listen/, JSON.stringify(address))
  }
  assert.equal(server.isRunning(), false)

  const strict = createRemoteServer({
    pairing: { redeemPairingCode: async () => ({ ok: false, reason: 'invalid_code' }), authenticate: async () => null },
    handler: { onConnect() {}, onMessage() {}, onDisconnect() {} },
    isAllowedBindAddress: () => false,
    readStaticFile: async () => null,
    readLocale: async () => null,
    log() {},
  })
  await assert.rejects(strict.start(LOOPBACK, 0))
})

test('the page is served with the security headers', async (t) => {
  const h = await startServer(t)
  const reply = await send(h, 'GET', '/')

  assert.equal(reply.status, 200)
  assert.match(reply.body, /<title>remote<\/title>/)
  assert.match(String(reply.headers['content-security-policy']), /default-src 'self'/)
  assert.match(String(reply.headers['content-security-policy']), /frame-ancestors 'none'/)
  assert.equal(reply.headers['x-content-type-options'], 'nosniff')
  assert.equal(reply.headers['referrer-policy'], 'no-referrer')
  assert.equal(reply.headers['cache-control'], 'no-store')
})

test('a request with a foreign Host header is refused', async (t) => {
  const h = await startServer(t)
  const reply = await send(h, 'GET', '/', { headers: { host: 'evil.example:80' } })

  assert.equal(reply.status, 421)
  assert.match(String(reply.headers['content-security-policy']), /default-src 'self'/)
})

test('assets and locales are served from the allowlist only', async (t) => {
  const h = await startServer(t)

  assert.equal((await send(h, 'GET', '/assets/app.js')).body, 'console.log(1)')
  assert.equal((await send(h, 'GET', '/locales/en')).body, '{"hello":"Hello"}')
  assert.equal((await send(h, 'GET', '/locales/zz')).status, 404)
  assert.equal((await send(h, 'GET', '/locales/..%2Fsecret')).status, 404)
  assert.equal((await send(h, 'GET', '/assets/missing.js')).status, 404)
  assert.equal((await send(h, 'GET', '/assets/..%2F..%2Fmain%2Findex.js')).status, 404)
  assert.equal((await send(h, 'GET', '/assets/../remote.html')).status, 404)
  assert.equal((await send(h, 'GET', '/index.html')).status, 404)
  assert.equal((await send(h, 'GET', '/settings.json')).status, 404)
})

test('a wrong method is refused', async (t) => {
  const h = await startServer(t)
  assert.equal((await send(h, 'POST', '/')).status, 405)
  assert.equal((await send(h, 'GET', '/pair')).status, 405)
  assert.equal((await send(h, 'DELETE', '/assets/app.js')).status, 405)
})

test('pairing returns the token and passes the caller address', async (t) => {
  const h = await startServer(t)
  const reply = await send(h, 'POST', '/pair', { body: JSON.stringify({ code: 'the-code', label: 'My phone' }) })

  assert.equal(reply.status, 200)
  assert.deepEqual(JSON.parse(reply.body), { token: 'new-token', device: DEVICE })
  assert.deepEqual(h.redeemCalls, [{ code: 'the-code', label: 'My phone', remoteAddress: LOOPBACK }])
})

test('pairing maps each refusal to its status', async (t) => {
  const h = await startServer(t)
  const body = JSON.stringify({ code: 'c', label: 'l' })

  h.setRedeemResult({ ok: false, reason: 'invalid_code' })
  const invalid = await send(h, 'POST', '/pair', { body })
  assert.equal(invalid.status, 403)
  assert.deepEqual(JSON.parse(invalid.body), { reason: 'invalid_code' })

  h.setRedeemResult({ ok: false, reason: 'denied' })
  assert.equal((await send(h, 'POST', '/pair', { body })).status, 403)

  h.setRedeemResult({ ok: false, reason: 'locked_out' })
  assert.equal((await send(h, 'POST', '/pair', { body })).status, 429)
})

test('pairing refuses a bad body without asking the pairing module', async (t) => {
  const h = await startServer(t)

  assert.equal((await send(h, 'POST', '/pair', { body: '{not json' })).status, 400)
  assert.equal((await send(h, 'POST', '/pair', { body: JSON.stringify({ code: 5, label: 'x' }) })).status, 400)
  assert.equal((await send(h, 'POST', '/pair', { body: JSON.stringify({ code: 'c' }) })).status, 400)
  assert.equal((await send(h, 'POST', '/pair', { body: JSON.stringify(['c', 'l']) })).status, 400)
  assert.equal((await send(h, 'POST', '/pair', { body: 'x'.repeat(MAX_PAIR_BODY_BYTES + 1) })).status, 413)
  assert.equal(h.redeemCalls.length, 0)
})

test('an upgrade with a wrong path, Origin or Host is refused', async (t) => {
  const h = await startServer(t)

  assert.equal(await refusedStatus(openSocket(h, { path: '/other' })), 403)
  assert.equal(await refusedStatus(openSocket(h, { origin: 'http://evil.example' })), 403)
  assert.equal(await refusedStatus(openSocket(h, { origin: null })), 403)
  assert.equal(await refusedStatus(openSocket(h, { host: 'evil.example:80' })), 403)
  assert.equal(h.connected.length, 0)
})

test('a valid token gets auth_ok and the handler sees the device', async (t) => {
  const h = await startServer(t)
  const socket = openSocket(h)
  await once(socket, 'open')
  socket.send(JSON.stringify({ type: 'auth', token: GOOD_TOKEN }))

  assert.deepEqual(await nextMessage(socket), { type: 'auth_ok', protocolVersion: 1, deviceLabel: 'My phone' })
  assert.equal(h.connected.length, 1)
  assert.deepEqual(h.connected[0].device, DEVICE)
})

test('a bad token gets auth_failed and a close, and never reaches the handler', async (t) => {
  const h = await startServer(t)
  const socket = openSocket(h)
  await once(socket, 'open')
  socket.send(JSON.stringify({ type: 'auth', token: 'wrong' }))

  assert.deepEqual(await nextMessage(socket), { type: 'auth_failed' })
  await once(socket, 'close')
  assert.equal(h.connected.length, 0)
  assert.equal(h.disconnected.length, 0)
})

test('a first message that is not auth closes the socket', async (t) => {
  const h = await startServer(t)
  const socket = openSocket(h)
  await once(socket, 'open')
  socket.send(JSON.stringify({ type: 'list_runtimes' }))

  await once(socket, 'close')
  assert.equal(h.received.length, 0)
  assert.equal(h.connected.length, 0)
})

test('a socket that does not authenticate in time is closed', async (t) => {
  const h = await startServer(t)
  const socket = openSocket(h)
  await once(socket, 'open')
  const startedAt = Date.now()

  await once(socket, 'close')
  assert.ok(Date.now() - startedAt >= AUTH_TIMEOUT_MS - 5)
  assert.equal(h.connected.length, 0)
})

test('a valid message after auth reaches the handler', async (t) => {
  const h = await startServer(t)
  const socket = await authedSocket(h)
  socket.send(JSON.stringify({ type: 'prompt', runtimeId: 'rt-1', text: 'hello', extra: true }))
  socket.send(JSON.stringify({ type: 'list_runtimes' }))

  // A reply to the second message proves that both were handled.
  h.connected[0].send({ type: 'dialog_resolved', dialogId: 'flush' })
  await nextMessage(socket)
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(h.received, [
    { deviceId: 'dev-1', message: { type: 'prompt', runtimeId: 'rt-1', text: 'hello' } },
    { deviceId: 'dev-1', message: { type: 'list_runtimes' } },
  ])
})

test('a bad frame gets a bad_message error and the socket stays open', async (t) => {
  const h = await startServer(t)
  const socket = await authedSocket(h)

  socket.send('not json')
  const first = await nextMessage(socket)
  assert.equal(first.type, 'error')
  assert.equal(first.type === 'error' && first.code, 'bad_message')

  socket.send(JSON.stringify({ type: 'auth', token: GOOD_TOKEN }))
  const second = await nextMessage(socket)
  assert.equal(second.type === 'error' && second.code, 'bad_message')

  socket.send(JSON.stringify({ type: 'abort', runtimeId: 'rt-1' }))
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(socket.readyState, WebSocket.OPEN)
  assert.deepEqual(h.received.map((entry) => entry.message.type), ['abort'])
})

test('the handler can send to a client, and close runs onDisconnect once', async (t) => {
  const h = await startServer(t)
  const socket = await authedSocket(h)
  h.connected[0].send({ type: 'dialog_resolved', dialogId: 'd-1' })
  assert.deepEqual(await nextMessage(socket), { type: 'dialog_resolved', dialogId: 'd-1' })

  socket.close()
  await once(socket, 'close')
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(h.disconnected.length, 1)
  assert.equal(h.disconnected[0], h.connected[0])
})

test('the socket limit refuses one more connection', async (t) => {
  const h = await startServer(t)
  for (let i = 0; i < MAX_REMOTE_SOCKETS; i++) await authedSocket(h)

  assert.equal(await refusedStatus(openSocket(h)), 503)
})

test('closeDevice closes only the sockets of that device', async (t) => {
  const h = await startServer(t)
  const first = await authedSocket(h, GOOD_TOKEN)
  const second = await authedSocket(h, SECOND_TOKEN)

  h.server.closeDevice('dev-1')
  await once(first, 'close')
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(second.readyState, WebSocket.OPEN)
})

test('stop closes every socket and the server', async (t) => {
  const h = await startServer(t)
  const socket = await authedSocket(h)

  await h.server.stop()
  if (socket.readyState !== WebSocket.CLOSED) await once(socket, 'close')
  assert.equal(h.server.isRunning(), false)
  await assert.rejects(send(h, 'GET', '/'))
})

test('the log never holds a token, a code or a message body', async (t) => {
  const h = await startServer(t)
  await send(h, 'POST', '/pair', { body: JSON.stringify({ code: 'secret-pairing-code', label: 'My phone' }) })
  const socket = await authedSocket(h)
  socket.send(JSON.stringify({ type: 'prompt', runtimeId: 'rt-1', text: 'private prompt text' }))
  await new Promise((resolve) => setTimeout(resolve, 20))

  const log = h.logs.join('\n')
  for (const secret of [GOOD_TOKEN, 'new-token', 'secret-pairing-code', 'private prompt text']) {
    assert.equal(log.includes(secret), false, secret)
  }
  assert.ok(h.logs.length > 0)
})
