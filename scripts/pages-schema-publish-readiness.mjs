#!/usr/bin/env node

// A code merge can carry a reviewed migration before its production receipt.
// Hold that expected intermediate state without starting the browser build.
// Invalid migration order still throws, and the deploy job rechecks the marker.
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { checkRepositorySchemaMigrationOrder } from './schema-migration-order.mjs'

export function pagesSchemaPublishReadiness(state) {
  if (state.pendingCount > 0 && state.releasedVersion < state.headVersion) {
    return { publish: false, reason: `Awaiting release receipt for ${state.headVersion}` }
  }
  if (state.pendingCount === 0 && state.releasedVersion === state.headVersion) {
    return { publish: true, reason: `Released schema head ${state.headVersion}` }
  }
  throw new Error('Schema marker and migration head are inconsistent')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = pagesSchemaPublishReadiness(checkRepositorySchemaMigrationOrder())
    console.error(result.reason)
    console.log(`publish=${result.publish}`)
  } catch (error) {
    console.error(`Pages schema readiness blocked: ${error.message}`)
    process.exitCode = 1
  }
}
