const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { mkdtemp, readFile, rm, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { test } = require('node:test')
const { writeChecksums } = require('./release-checksums')

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-desktop-checksums-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

test('writes SHA-256 sidecars for release installer formats only', async (t) => {
  const directory = await temporaryDirectory(t)
  const installers = [
    'Pi-Desktop-1.0-linux-x86_64.AppImage',
    'Pi-Desktop-1.0-win-x64-setup.exe',
    'Pi-Desktop-1.0-mac-arm64.dmg',
    'Pi-Desktop-1.0-mac-arm64.zip',
  ]

  for (const name of installers) await writeFile(path.join(directory, name), `payload:${name}`)
  await writeFile(path.join(directory, 'latest-mac.yml'), 'not an installer')
  await writeChecksums(directory)

  for (const name of installers) {
    const payload = `payload:${name}`
    const expected = `${createHash('sha256').update(payload).digest('hex')}  ${name}\n`
    assert.equal(await readFile(path.join(directory, `${name}.sha256`), 'utf8'), expected)
  }
  await assert.rejects(readFile(path.join(directory, 'latest-mac.yml.sha256')))
})

test('fails when there are no installer artifacts', async (t) => {
  const directory = await temporaryDirectory(t)
  await writeFile(path.join(directory, 'latest-linux.yml'), 'not an installer')
  await assert.rejects(writeChecksums(directory), /No release installers found/)
})
