import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'

const sql = readFileSync(resolve('supabase/verification/schema-replay-fingerprint.sql'), 'utf8')

test('catalog fingerprint includes bot, storage, auth and credential schemas', () => {
  const schemas = sql.match(/with target_schemas\(schema_name\) as \((.*?)\)\s*select/s)?.[1]
  assert.ok(schemas, 'target schema list is missing')
  for (const schema of ['public', 'mcp_internal', 'storage', 'auth', 'vault',
    'graphql_public', 'cron']) {
    assert.match(schemas, new RegExp(`\\('${schema}'::name\\)`), `${schema} omitted`)
  }
})

test('all security-relevant catalog sections use the target schema list', () => {
  for (const section of ['relations', 'columns', 'constraints', 'indexes', 'functions',
    'views', 'enums', 'triggers']) {
    const body = sql.match(new RegExp(`'${section}', \\(\\s*(.*?)\\n  \\),`, 's'))?.[1]
    assert.ok(body, `${section} section is missing`)
    assert.match(body, /join target_schemas s on s\.schema_name = n\.nspname/,
      `${section} no longer scopes all target schemas`)
  }
  assert.match(sql, /from pg_policies where schemaname in \(select schema_name from target_schemas\)/)
  assert.match(sql, /from pg_default_acl/)
  assert.match(sql, /from pg_trigger/)
  for (const privilege of ['nspacl', 'relacl', 'attacl', 'proacl', 'defaclacl',
    'relforcerowsecurity']) {
    assert.match(sql, new RegExp(`\\b${privilege}\\b`), `${privilege} omitted`)
  }
})

test('catalog contract checks internal schema access and storage RLS', () => {
  const contract = readFileSync(resolve('supabase/verification/schema-replay-contract.sql'), 'utf8')
  assert.match(contract, /'mcp_internal\.mcp_bots'/)
  assert.match(contract, /'storage\.objects'/)
  assert.match(contract, /has_schema_privilege\('anon', 'mcp_internal', 'USAGE'\)/)
  assert.match(contract, /has_schema_privilege\('service_role', 'mcp_internal', 'USAGE'\)/)
})
