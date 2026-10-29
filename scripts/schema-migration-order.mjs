#!/usr/bin/env node

// Production is released through 263. New migration labels must advance in
// timestamp order. Keep the 260 prerequisite pinned so future clean replays
// reproduce the same schema even though 260–263 are already released.
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export function assertSchemaMigrationOrder(filenames, releasedVersion) {
  if (!/^\d{14}$/.test(releasedVersion)) {
    throw new Error('Released migration version must be a 14-digit timestamp')
  }
  const files = filenames.filter((name) => name.endsWith('.sql')).sort()
  const parsed = files.map((name) => {
    // Early history has labels such as 09b. Preserve that history, while
    // requiring plain numeric labels for every post-259 migration.
    const match = /^(\d{14})_(\d+)([a-z]?)_.*\.sql$/.exec(name)
    if (!match) throw new Error(`Migration filename has no logical number: ${name}`)
    return { name, version: match[1], number: Number(match[2]), suffix: match[3] }
  })
  const release = parsed.find((entry) => entry.version === releasedVersion)
  if (!release) throw new Error(`Released migration ${releasedVersion} is missing`)
  if (release.number !== 259 && releasedVersion === '20261025233000') {
    throw new Error('Released baseline timestamp no longer identifies migration 259')
  }
  if (new Set(parsed.map((entry) => entry.version)).size !== parsed.length) {
    throw new Error('Two migration files share a Supabase version timestamp')
  }

  const later = parsed.filter((entry) => entry.version > releasedVersion)
  for (const entry of later) {
    if (entry.suffix) {
      throw new Error(`Post-release migration must have a plain numeric label: ${entry.name}`)
    }
    if (entry.number <= release.number) {
      throw new Error(`Migration ${entry.name} is after the released timestamp but does not advance its logical number`)
    }
  }
  const subsequent = parsed.filter((entry) => entry.number > 259)
  let expected = 260
  for (const entry of subsequent) {
    if (entry.number !== expected) {
      throw new Error(`Expected migration ${expected} before ${entry.name}; released schema cannot skip a dependency`)
    }
    // Pin the reviewed prerequisite, including its version and filename. A
    // different migration merely labelled 260 must not satisfy this gate.
    if (entry.number === 260 && entry.name !== '20261025235000_260_building_the_google_campaign.sql') {
      throw new Error(`Migration 260 must be the Google Ads dependency: ${entry.name}`)
    }
    expected += 1
  }
  return {
    releasedVersion,
    releasedNumber: release.number,
    headVersion: parsed.at(-1)?.version ?? releasedVersion,
    nextNumber: expected,
    pendingCount: later.length,
  }
}

export function checkRepositorySchemaMigrationOrder(repository = resolve()) {
  const source = resolve(repository, 'supabase')
  const filenames = readdirSync(resolve(source, 'migrations'))
  const releasedVersion = readFileSync(
    resolve(source, 'verification', 'released-migration-version.txt'), 'utf8').trim()
  return assertSchemaMigrationOrder(filenames, releasedVersion)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    console.log(JSON.stringify(checkRepositorySchemaMigrationOrder()))
  } catch (error) {
    console.error(`Schema migration order blocked: ${error.message}`)
    process.exitCode = 1
  }
}
