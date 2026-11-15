import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { NetworkInterfaceInfo } from 'node:os'
import { findTailscaleAddresses, isTailscaleAddress } from './tailscale-address'

function ipv4(address: string, internal = false): NetworkInterfaceInfo {
  return { address, netmask: '255.255.255.255', family: 'IPv4', mac: '00:00:00:00:00:00', internal, cidr: `${address}/32` }
}

function ipv6(address: string): NetworkInterfaceInfo {
  return { address, netmask: 'ffff::', family: 'IPv6', mac: '00:00:00:00:00:00', internal: false, cidr: `${address}/64`, scopeid: 0 }
}

test('the first and last address of 100.64.0.0/10 are inside the range', () => {
  assert.equal(isTailscaleAddress('100.64.0.0'), true)
  assert.equal(isTailscaleAddress('100.127.255.255'), true)
  assert.equal(isTailscaleAddress('100.101.102.103'), true)
})

test('the addresses next to the range are outside', () => {
  assert.equal(isTailscaleAddress('100.63.255.255'), false)
  assert.equal(isTailscaleAddress('100.128.0.0'), false)
})

test('home network, loopback and wildcard addresses are outside', () => {
  assert.equal(isTailscaleAddress('192.168.1.5'), false)
  assert.equal(isTailscaleAddress('10.0.0.2'), false)
  assert.equal(isTailscaleAddress('127.0.0.1'), false)
  assert.equal(isTailscaleAddress('0.0.0.0'), false)
})

test('IPv6 and malformed text are rejected', () => {
  for (const text of ['fd7a:115c:a1e0::1', '::', '100.64.0', '100.64.0.256', '100.64.0.1.2', '100.64.-1.1', '100.64.0x1.1', ' 100.64.0.1', '100.64.0.1 ', 'abc', '']) {
    assert.equal(isTailscaleAddress(text), false, JSON.stringify(text))
  }
})

test('the interface scan returns only external IPv4 addresses in the range', () => {
  const found = findTailscaleAddresses({
    lo: [ipv4('127.0.0.1', true)],
    wlan0: [ipv4('192.168.1.20'), ipv6('fe80::1')],
    tailscale0: [ipv4('100.101.102.103'), ipv6('fd7a:115c:a1e0::1')],
  })
  assert.deepEqual(found, ['100.101.102.103'])
})

test('the scan sorts its result and drops duplicates and internal entries', () => {
  const found = findTailscaleAddresses({
    b: [ipv4('100.99.0.2'), ipv4('100.70.0.1', true)],
    a: [ipv4('100.80.0.1'), ipv4('100.99.0.2')],
  })
  assert.deepEqual(found, ['100.80.0.1', '100.99.0.2'])
})

test('the scan handles no interfaces and an undefined list', () => {
  assert.deepEqual(findTailscaleAddresses({}), [])
  assert.deepEqual(findTailscaleAddresses({ ghost: undefined }), [])
})
