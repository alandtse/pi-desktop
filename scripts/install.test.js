const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { mkdtemp, mkdir, readFile, readdir, rm, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { test } = require('node:test')

const root = path.resolve(__dirname, '..')
const assetName = 'Pi-Desktop-1.2.3-alpha-linux-x86_64.AppImage'
const assetUrl = `https://github.com/FaqFirebase/pi-desktop/releases/download/v1.2.3-alpha/${assetName}`
const payload = Buffer.from('test installer payload')
const shellTest = (name, fn) => test(name, { skip: process.platform === 'win32' }, fn)

async function fixture(t, checksumOverride) {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-desktop-install-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const bin = path.join(directory, 'bin')
  const home = path.join(directory, 'home')
  await mkdir(bin)
  await mkdir(home)
  const releaseMetadata = {
    assets: [{ browser_download_url: assetUrl }],
  }
  await writeFile(path.join(directory, 'releases.json'), JSON.stringify(releaseMetadata))
  await writeFile(path.join(directory, 'payload'), payload)
  const digest = checksumOverride ?? createHash('sha256').update(payload).digest('hex')
  await writeFile(path.join(directory, 'checksum'), `${digest}  ${assetName}\n`)
  await writeFile(path.join(bin, 'pi'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  await writeFile(path.join(bin, 'uname'), `#!/usr/bin/env node\nconsole.log(process.argv[2] === '-s' ? 'Linux' : 'x86_64')\n`, { mode: 0o755 })
  await writeFile(path.join(bin, 'sha256sum'), `#!/usr/bin/env node\nconst fs = require('node:fs')\nconst crypto = require('node:crypto')\nconst file = process.argv[process.argv.length - 1]\nconst digest = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')\nconsole.log(digest + '  ' + file)\n`, { mode: 0o755 })
  await writeFile(path.join(bin, 'curl'), `#!/bin/bash
set -e
for arg in "$@"; do
  case "$arg" in https://*) url="$arg" ;; esac
done
while [ "$#" -gt 0 ]; do
  if [ "$1" = '-o' ]; then shift; output="$1"; break; fi
  shift
done
case "$url" in
  *api.github.com*) source='releases.json' ;;
  *.sha256) source='checksum' ;;
  *) source='payload' ;;
esac
printf '%s\\n' "$url" >> "$TEST_DIR/requests"
[ "$TEST_FAIL" != "$source" ] || exit 22
if [ -n "$output" ]; then
  cp "$TEST_DIR/$source" "$output"
else
  cat "$TEST_DIR/$source"
fi
`, { mode: 0o755 })

  return {
    directory,
    home,
    output: path.join(home, '.local', 'bin', 'pi-desktop'),
    run: (extraEnv = {}) => spawnSync('/bin/bash', [path.join(root, 'install.sh')], {
      cwd: root,
      encoding: 'utf8',
      timeout: 15_000,
      env: {
        ...process.env,
        HOME: home,
        PATH: `${bin}:${process.env.PATH}`,
        TEST_DIR: directory,
        ...extraEnv,
      },
    }),
  }
}

shellTest('Linux installer verifies the release checksum before installing', async (t) => {
  const f = await fixture(t)
  const result = f.run()
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.deepEqual(await readFile(f.output), payload)
  const requests = await readFile(path.join(f.directory, 'requests'), 'utf8')
  assert.ok(requests.includes(`${assetUrl}.sha256`))
  assert.ok(requests.includes(assetUrl))
  assert.deepEqual(await readdir(path.dirname(f.output)), ['pi-desktop'])
})

shellTest('Linux installer refuses a mismatched checksum and preserves the installed binary', async (t) => {
  const f = await fixture(t, '0'.repeat(64))
  await mkdir(path.dirname(f.output), { recursive: true })
  await writeFile(f.output, 'existing installation')
  const result = f.run()
  assert.notEqual(result.status, 0, result.error?.message)
  assert.match(result.stdout + result.stderr, /SHA-256 mismatch/, JSON.stringify({ stdout: result.stdout, stderr: result.stderr, error: result.error?.message, status: result.status }))
  assert.equal(await readFile(f.output, 'utf8'), 'existing installation')
  assert.deepEqual((await readdir(path.dirname(f.output))).sort(), ['pi-desktop'])
})

shellTest('Linux installer fails closed if the checksum sidecar cannot be downloaded', async (t) => {
  const f = await fixture(t)
  const result = f.run({ TEST_FAIL: 'checksum' })
  assert.notEqual(result.status, 0, result.error?.message)
  assert.match(result.stdout + result.stderr, /Could not download the SHA-256 checksum/, JSON.stringify({ stdout: result.stdout, stderr: result.stderr, error: result.error?.message, status: result.status }))
  await assert.rejects(readFile(f.output))
})
