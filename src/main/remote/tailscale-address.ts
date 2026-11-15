import type { NetworkInterfaceInfo } from 'node:os'

/** The carrier-grade NAT block Tailscale assigns device addresses from. */
export const TAILSCALE_CIDR = '100.64.0.0/10'

const IPV4_OCTETS = 4
const IPV4_BITS = 32
const OCTET_MAX = 255
// Plain decimal only: no sign, no hex, no leading zero, no spaces.
const OCTET_PATTERN = /^(0|[1-9]\d{0,2})$/

/** The address as an unsigned 32-bit number, or null when it is not dotted IPv4. */
function ipv4ToNumber(address: string): number | null {
  const parts = address.split('.')
  if (parts.length !== IPV4_OCTETS) return null
  let value = 0
  for (const part of parts) {
    if (!OCTET_PATTERN.test(part)) return null
    const octet = Number(part)
    if (octet > OCTET_MAX) return null
    value = value * (OCTET_MAX + 1) + octet
  }
  return value
}

function parseCidr(cidr: string): { base: number; size: number } {
  const [baseText, prefixText] = cidr.split('/')
  const base = ipv4ToNumber(baseText)
  if (base === null) throw new Error(`Invalid CIDR base: ${cidr}`)
  return { base, size: 2 ** (IPV4_BITS - Number(prefixText)) }
}

const TAILSCALE_RANGE = parseCidr(TAILSCALE_CIDR)

/** True only for a valid dotted IPv4 address inside the Tailscale range. */
export function isTailscaleAddress(address: string): boolean {
  const value = ipv4ToNumber(address)
  if (value === null) return false
  return value >= TAILSCALE_RANGE.base && value < TAILSCALE_RANGE.base + TAILSCALE_RANGE.size
}

/**
 * This machine's Tailscale addresses, from `os.networkInterfaces()`. The
 * remote server may bind to one of these and to nothing else, so a home
 * network or public address can never be chosen by mistake.
 */
export function findTailscaleAddresses(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>): string[] {
  const found = new Set<string>()
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal && isTailscaleAddress(entry.address)) {
        found.add(entry.address)
      }
    }
  }
  return [...found].sort((a, b) => (ipv4ToNumber(a) ?? 0) - (ipv4ToNumber(b) ?? 0))
}
