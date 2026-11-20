import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'
import { VideoTokenOverridesSchema } from '../dist/brand/tokens.js'

const path = resolve('src/brand/overrides.schema.json')
const expected = JSON.stringify(z.toJSONSchema(VideoTokenOverridesSchema), null, 2) + '\n'
if (process.argv.includes('--check')) {
  if (readFileSync(path, 'utf8') !== expected) {
    throw new Error('Video brand JSON Schema is stale; rebuild video-render')
  }
} else {
  writeFileSync(path, expected)
}
