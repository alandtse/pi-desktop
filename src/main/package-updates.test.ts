import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  explainOmpFailure,
  fetchRegistryVersion,
  OmpPluginListError,
  ompNpmTargets,
  findPackageUpdates,
  ompRegistryQuery,
  ompUpdateInstallSpec,
  piRegistryQuery,
  PI_UPDATE_ALL_ARGS,
  registryVersionUrl,
  runtimesBlockingUpdate,
  type OmpRegistryQuery,
  type RegistryQuery,
} from './package-updates'
import type { OmpNpmPlugin } from './omp-plugin-list'
import { t } from '../shared/i18n'

const HTTP_NOT_FOUND = 404

test('Pi Update all updates both the CLI and its installed extensions without approving project files', () => {
  assert.deepEqual(PI_UPDATE_ALL_ARGS, ['update', '--all', '--no-approve'])
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function plugin(overrides: Partial<OmpNpmPlugin> = {}): OmpNpmPlugin {
  return { name: 'pi-ask-user', version: '0.14.0', enabled: true, enabledFeatures: null, ...overrides }
}

test('piRegistryQuery follows latest for an unversioned npm source', () => {
  assert.deepEqual(piRegistryQuery('npm:pi-subagents'), { name: 'pi-subagents', tag: 'latest' })
  assert.deepEqual(piRegistryQuery('npm:@juicesharp/rpiv-todo'), { name: '@juicesharp/rpiv-todo', tag: 'latest' })
})

test('piRegistryQuery follows an explicit dist-tag', () => {
  assert.deepEqual(piRegistryQuery('npm:pi-ollama-cloud@latest'), { name: 'pi-ollama-cloud', tag: 'latest' })
  assert.deepEqual(piRegistryQuery('npm:@scope/name@next'), { name: '@scope/name', tag: 'next' })
})

test('piRegistryQuery skips pins, ranges, git and local sources', () => {
  assert.equal(piRegistryQuery('npm:pi-subagents@1.2.3'), null)
  assert.equal(piRegistryQuery('npm:@scope/name@1.2.3'), null)
  assert.equal(piRegistryQuery('npm:pi-subagents@^1.2.0'), null)
  assert.equal(piRegistryQuery('git:github.com/user/repo'), null)
  assert.equal(piRegistryQuery('./local/extension'), null)
})

test('ompRegistryQuery follows latest for the ranges bun writes, keeping the entry prefix', () => {
  assert.deepEqual(
    ompRegistryQuery('pi-ask-user', 'npm:pi-ask-user@^0.14.0'),
    { name: 'pi-ask-user', tag: 'latest', specPrefix: 'npm:' }
  )
  assert.deepEqual(ompRegistryQuery('pi-ask-user', '^0.15.0'), { name: 'pi-ask-user', tag: 'latest', specPrefix: '' })
  assert.deepEqual(ompRegistryQuery('pi-ask-user', '~0.15.0'), { name: 'pi-ask-user', tag: 'latest', specPrefix: '' })
  assert.deepEqual(ompRegistryQuery('pi-ask-user', '*'), { name: 'pi-ask-user', tag: 'latest', specPrefix: '' })
})

test('ompRegistryQuery keeps a dist-tag and resolves an npm alias', () => {
  assert.deepEqual(ompRegistryQuery('x', 'npm:@scope/real@next'), { name: '@scope/real', tag: 'next', specPrefix: 'npm:' })
  assert.deepEqual(ompRegistryQuery('pi-ask-user', 'latest'), { name: 'pi-ask-user', tag: 'latest', specPrefix: '' })
})

test('ompRegistryQuery skips pins and non-registry installs', () => {
  assert.equal(ompRegistryQuery('pi-ask-user', 'npm:pi-ask-user@0.14.0'), null)
  assert.equal(ompRegistryQuery('pi-ask-user', '0.14.0'), null)
  assert.equal(ompRegistryQuery('local', 'file:../local'), null)
  assert.equal(ompRegistryQuery('linked', 'link:../linked'), null)
  assert.equal(ompRegistryQuery('repo', 'github:user/repo'), null)
  assert.equal(ompRegistryQuery('repo', 'git+https://github.com/user/repo.git'), null)
  assert.equal(ompRegistryQuery('repo', 'user/repo'), null)
})

test('registryVersionUrl encodes the scope slash and the tag', () => {
  assert.equal(registryVersionUrl({ name: 'pi-subagents', tag: 'latest' }), 'https://registry.npmjs.org/pi-subagents/latest')
  assert.equal(
    registryVersionUrl({ name: '@juicesharp/rpiv-todo', tag: 'latest' }),
    'https://registry.npmjs.org/@juicesharp%2frpiv-todo/latest'
  )
})

test('fetchRegistryVersion reads the manifest version', async () => {
  let requested = ''
  const version = await fetchRegistryVersion({ name: 'pi-ask-user', tag: 'latest' }, async (url) => {
    requested = String(url)
    return jsonResponse({ name: 'pi-ask-user', version: '0.15.0' })
  })
  assert.equal(version, '0.15.0')
  assert.equal(requested, 'https://registry.npmjs.org/pi-ask-user/latest')
})

test('fetchRegistryVersion returns null on HTTP errors, bad bodies, and network failures', async () => {
  const query: RegistryQuery = { name: 'missing', tag: 'latest' }
  assert.equal(await fetchRegistryVersion(query, async () => jsonResponse('not found', HTTP_NOT_FOUND)), null)
  assert.equal(await fetchRegistryVersion(query, async () => jsonResponse({ version: 7 })), null)
  assert.equal(await fetchRegistryVersion(query, async () => new Response('<html>')), null)
  assert.equal(await fetchRegistryVersion(query, async () => { throw new Error('offline') }), null)
})

test('findPackageUpdates reports only candidates behind the registry', async () => {
  const latest: Record<string, string | null> = { a: '1.1.0', b: '2.0.0', c: null }
  const updates = await findPackageUpdates(
    [
      { source: 'npm:a', query: { name: 'a', tag: 'latest' }, installedVersion: '1.0.0' },
      { source: 'npm:b', query: { name: 'b', tag: 'latest' }, installedVersion: '2.0.0' },
      { source: 'npm:c', query: { name: 'c', tag: 'latest' }, installedVersion: '1.0.0' },
    ],
    async (query) => latest[query.name]
  )
  assert.deepEqual(updates, [{ source: 'npm:a', installedVersion: '1.0.0', latestVersion: '1.1.0' }])
})

test('ompUpdateInstallSpec carries the feature selection in bracket syntax', () => {
  const query: OmpRegistryQuery = { name: 'pi-ask-user', tag: 'latest', specPrefix: 'npm:' }
  assert.equal(ompUpdateInstallSpec(query, plugin()), 'npm:pi-ask-user@latest')
  assert.equal(ompUpdateInstallSpec(query, plugin({ enabledFeatures: [] })), 'npm:pi-ask-user@latest[]')
  assert.equal(ompUpdateInstallSpec(query, plugin({ enabledFeatures: ['a', 'b'] })), 'npm:pi-ask-user@latest[a,b]')
})

test('ompUpdateInstallSpec keeps the store entry prefix', () => {
  assert.equal(
    ompUpdateInstallSpec({ name: 'pi-ask-user', tag: 'latest', specPrefix: '' }, plugin()),
    'pi-ask-user@latest'
  )
  assert.equal(
    ompUpdateInstallSpec({ name: '@scope/x', tag: 'next', specPrefix: 'npm:' }, plugin({ name: '@scope/x' })),
    'npm:@scope/x@next'
  )
})

test('explainOmpFailure replaces the missing-bun error and keeps others', () => {
  const missingBun = '✘ Failed to install npm:pi-ask-user@latest: Error: Executable not found in $PATH: "bun"'
  assert.equal(explainOmpFailure(missingBun), t('errors.packages.missingBun'))
  assert.equal(explainOmpFailure('Plugin "x" is not installed'), 'Plugin "x" is not installed')
})

const OMP_LIST_JSON = JSON.stringify({ npm: [{ name: 'pi-ask-user', version: '0.14.0', enabled: true }] })

test('ompNpmTargets pairs each npm plugin with its store lookup', () => {
  const targets = ompNpmTargets({ success: true, output: OMP_LIST_JSON }, { 'pi-ask-user': 'npm:pi-ask-user@^0.14.0' })
  assert.equal(targets.length, 1)
  assert.equal(targets[0].plugin.name, 'pi-ask-user')
  assert.deepEqual(targets[0].query, { name: 'pi-ask-user', tag: 'latest', specPrefix: 'npm:' })
})

test('ompNpmTargets reports a failed plugin list instead of an empty one', () => {
  assert.throws(
    () => ompNpmTargets({ success: false, output: 'omp: timed out' }, {}),
    (error: unknown) => error instanceof OmpPluginListError && error.detail === 'omp: timed out'
  )
})

test('an idle open session tab does not block an update, a working turn does', () => {
  // The bug this guards: `status` stays 'running' for as long as the session tab
  // is open, so waiting on it never ended. An idle session holds no turn.
  assert.equal(runtimesBlockingUpdate([
    { status: 'running', activity: null },
    { status: 'running', activity: 'completed' },
    { status: 'stopped', activity: null },
  ]), 0)

  // A turn in flight is the real reason not to swap the CLI underneath it.
  assert.equal(runtimesBlockingUpdate([
    { status: 'running', activity: 'working' },
    { status: 'running', activity: null },
  ]), 1)

  // A process still coming up counts too: it may start a turn at any moment.
  assert.equal(runtimesBlockingUpdate([
    { status: 'starting', activity: null },
    { status: 'running', activity: 'needs-approval' },
  ]), 1)
})
