#!/usr/bin/env node

// Source-side release stop: a browser bundle may use new DB types only after
// the migration marker advances to the last tracked migration. The marker is
// a release receipt, not an independent query of production; B009 still needs
// a live production parity probe before full acceptance.
import { checkRepositorySchemaMigrationOrder } from './schema-migration-order.mjs'

const state = checkRepositorySchemaMigrationOrder()
if (state.pendingCount !== 0 || state.releasedVersion !== state.headVersion) {
  console.error(
    `Pages schema release blocked: ${state.pendingCount} tracked migration(s) are newer than ` +
    `released marker ${state.releasedVersion}; tracked head is ${state.headVersion}.`,
  )
  process.exitCode = 1
} else {
  console.log(`Pages schema marker matches tracked head ${state.headVersion}.`)
}
