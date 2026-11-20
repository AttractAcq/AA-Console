import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { buildTheme } from '../dist/brand/theme.js'

const { tokens, captionText, captionBackground } = buildTheme(null)
const c = tokens.colours
const expected = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720" role="img" aria-label="Attract Acquisition motion brand title-card fixture">
  <rect width="1280" height="720" fill="${c.background}"/>
  <rect x="96" y="54" width="1088" height="612" rx="${tokens.radii.card}" fill="${c.surface}" stroke="${c.secondary}" stroke-width="${tokens.strokes.regular}"/>
  <rect x="144" y="108" width="304" height="56" rx="28" fill="${c.accent}"/>
  <text x="172" y="144" fill="${c.primary}" font-family="system-ui,sans-serif" font-size="25" font-weight="700">ATTRACT ACQUISITION</text>
  <text x="144" y="290" fill="${c.primary}" font-family="system-ui,sans-serif" font-size="${tokens.type.scale.h1}" font-weight="700">One idea per scene.</text>
  <text x="148" y="355" fill="${c.text}" font-family="system-ui,sans-serif" font-size="${tokens.type.scale.body}">A calm, legible explanation system.</text>
  <circle cx="1010" cy="316" r="112" fill="${c.accent}"/>
  <path d="M947 318 L990 361 L1074 271" fill="none" stroke="${c.primary}" stroke-linecap="round" stroke-linejoin="round" stroke-width="${tokens.strokes.bold * 2}"/>
  <rect x="144" y="550" width="992" height="80" rx="${tokens.radii.card}" fill="${captionBackground}"/>
  <text x="180" y="600" fill="${captionText}" font-family="system-ui,sans-serif" font-size="${tokens.type.scale.caption}">Captions own the lower safe area.</text>
</svg>
`
const path = resolve('fixtures/aa-brand-preview.svg')
if (process.argv.includes('--check')) {
  if (readFileSync(path, 'utf8') !== expected) throw new Error('AA brand fixture is stale')
} else {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, expected)
}
