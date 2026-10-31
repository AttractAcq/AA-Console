#!/usr/bin/env node

// Read-only; GitHub branch protection must eventually require this result.
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { verifyApprovedProductionRelease } from './production-release-attestation.mjs'

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw new Error('usage: node scripts/verify-approved-production-release.mjs REQUEST_UUID')
    const result = await verifyApprovedProductionRelease({
      requestId: process.argv[2],
      supabaseUrl: process.env.SUPABASE_URL,
      serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      token: process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? null,
    })
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } catch (error) {
    console.error(`Production release blocked: ${error.message}`)
    process.exitCode = 1
  }
}
