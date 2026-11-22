#!/usr/bin/env node
const { createHash } = require('node:crypto')
const { createReadStream } = require('node:fs')
const { readdir, writeFile } = require('node:fs/promises')
const path = require('node:path')

const INSTALLER_PATTERN = /\.(AppImage|exe|dmg|zip)$/

async function writeChecksums(directory) {
  const files = (await readdir(directory)).filter((name) => INSTALLER_PATTERN.test(name)).sort()
  if (files.length === 0) throw new Error(`No release installers found in ${directory}`)

  for (const name of files) {
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(path.join(directory, name))) hash.update(chunk)
    await writeFile(path.join(directory, `${name}.sha256`), `${hash.digest('hex')}  ${name}\n`)
  }
}

if (require.main === module) {
  writeChecksums(process.argv[2] || 'release').catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}

module.exports = { writeChecksums }
