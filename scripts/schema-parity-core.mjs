import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const VERSIONED_SQL = /^(\d{14})_(.+)\.sql$/;

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function md5(value) {
  return createHash("md5").update(value).digest("hex");
}

/** Sorting object keys makes catalog fingerprints independent of JSON key order. */
export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export async function readLocalMigrations(root) {
  const directory = join(root, "supabase", "migrations");
  const names = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
  const versions = new Set();
  const migrations = [];
  for (const filename of names) {
    const match = VERSIONED_SQL.exec(filename);
    if (!match) throw new Error(`Unversioned migration file: ${filename}`);
    const [, version, name] = match;
    if (versions.has(version)) throw new Error(`Duplicate migration version: ${version}`);
    versions.add(version);
    const content = await readFile(join(directory, filename), "utf8");
    migrations.push({
      version,
      name,
      filename,
      sha256: sha256(content),
      // Supabase may save a split statement array. A one-element, byte-equivalent
      // history entry can be proved equal; any other representation stays unknown.
      trimmedMd5: md5(content.trimEnd()),
    });
  }
  return migrations;
}

export function catalogObjects(rows) {
  const objects = new Map();
  for (const row of rows) {
    const kind = String(row.kind);
    const identity = String(row.identity);
    const key = `${kind}:${identity}`;
    if (objects.has(key)) throw new Error(`Duplicate catalog identity: ${key}`);
    objects.set(key, {
      kind,
      identity,
      fingerprint: sha256(stableJson(row.definition)),
    });
  }
  return objects;
}

export function compareHistory(local, left, right, leftName, rightName) {
  const findings = [];
  const localByVersion = new Map(local.map((migration) => [migration.version, migration]));
  const leftByVersion = new Map(left.map((migration) => [migration.version, migration]));
  const rightByVersion = new Map(right.map((migration) => [migration.version, migration]));

  for (const [environment, history] of [[leftName, left], [rightName, right]]) {
    const remoteByVersion = new Map(history.map((migration) => [migration.version, migration]));
    const remoteOnlyByName = new Map(history.filter((migration) => !localByVersion.has(migration.version)).map((migration) => [migration.name, migration]));
    for (const source of local) {
      const remote = remoteByVersion.get(source.version);
      if (!remote) {
        findings.push({ type: "locally_pending", environment, version: source.version, filename: source.filename, nextAction: "Review objects and release path; do not automatically apply." });
        const candidate = remoteOnlyByName.get(source.name);
        if (candidate) findings.push({ type: "possible_version_relabel", environment, localVersion: source.version, remoteVersion: candidate.version, name: source.name, nextAction: "Compare stored SQL and affected catalog objects before any history repair; this is a candidate, not proof of equivalence." });
        continue;
      }
      if (remote.name !== source.name) {
        findings.push({ type: "history_name_mismatch", environment, version: source.version, filename: source.filename, recordedName: remote.name, nextAction: "Inspect recorded SQL and catalog objects before any history repair." });
      }
    }
    for (const remote of history) {
      if (!localByVersion.has(remote.version)) {
        findings.push({ type: "remote_only", environment, version: remote.version, recordedName: remote.name, nextAction: "Identify the exact object change before considering a reviewed history repair." });
      }
    }
  }

  for (const version of new Set([...leftByVersion.keys(), ...rightByVersion.keys()])) {
    const a = leftByVersion.get(version);
    const b = rightByVersion.get(version);
    // A NULL statements array is common in Supabase migration history. Its
    // hash is unavailable, not evidence that the two SQL bodies differ.
    if (a && b && a.storedSqlMd5 !== null && b.storedSqlMd5 !== null && a.storedSqlMd5 !== b.storedSqlMd5) {
      findings.push({ type: "recorded_sql_mismatch", version, environments: [leftName, rightName], recordedHashes: [a.storedSqlMd5, b.storedSqlMd5], nextAction: "Compare object definitions and the reviewed migration sources; do not replay by version alone." });
    }
  }

  const singleStatementVerified = {};
  const contentUnverified = {};
  const storedSqlPayloadUnavailable = {};
  for (const [environment, history] of [[leftName, left], [rightName, right]]) {
    singleStatementVerified[environment] = 0;
    contentUnverified[environment] = 0;
    storedSqlPayloadUnavailable[environment] = history.filter((remote) => remote.storedSqlMd5 === null).length;
    if (storedSqlPayloadUnavailable[environment] > 0) {
      findings.push({ type: "history_sql_payload_unavailable", environment, count: storedSqlPayloadUnavailable[environment], nextAction: "Stored migration SQL is NULL; compare live catalog objects and source lineage. Do not treat an unavailable hash as an SQL mismatch or repair history solely to fill it." });
    }
    for (const remote of history) {
      const source = localByVersion.get(remote.version);
      if (!source) continue;
      if (remote.statementCount === 1 && remote.singleStatementTrimmedMd5 === source.trimmedMd5) singleStatementVerified[environment]++;
      else contentUnverified[environment]++;
    }
  }
  return { findings, singleStatementVerified, contentUnverified, storedSqlPayloadUnavailable };
}

export function compareCatalogs(left, right, leftName, rightName) {
  const findings = [];
  for (const key of new Set([...left.keys(), ...right.keys()])) {
    const a = left.get(key);
    const b = right.get(key);
    if (a?.fingerprint === b?.fingerprint) continue;
    const object = a ?? b;
    findings.push({
      type: !a ? "catalog_missing" : !b ? "catalog_extra" : "catalog_definition_mismatch",
      kind: object.kind,
      identity: object.identity,
      environments: [leftName, rightName],
      fingerprints: [a?.fingerprint ?? null, b?.fingerprint ?? null],
      nextAction: "Review the exact object definition and migration lineage before a corrective migration.",
    });
  }
  return findings.sort((a, b) => `${a.kind}:${a.identity}`.localeCompare(`${b.kind}:${b.identity}`));
}

export function boundedFindings(findings, limit = 400) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("Finding limit must be positive");
  const ordered = findings.toSorted((a, b) => stableJson(a).localeCompare(stableJson(b)));
  return { total: ordered.length, shown: ordered.slice(0, limit), omitted: Math.max(0, ordered.length - limit) };
}

export function historySummary(rows) {
  const ordered = rows.toSorted((a, b) => a.version.localeCompare(b.version));
  return {
    count: ordered.length,
    head: ordered.at(-1)?.version ?? null,
    digest: sha256(stableJson(ordered.map(({ version, name, storedSqlMd5 }) => [version, name, storedSqlMd5]))),
    storedSqlPayloadAvailable: ordered.filter((row) => row.storedSqlMd5 !== null).length,
    storedSqlPayloadUnavailable: ordered.filter((row) => row.storedSqlMd5 === null).length,
  };
}

export function localSummary(rows) {
  return {
    count: rows.length,
    head: rows.at(-1)?.version ?? null,
    digest: sha256(stableJson(rows.map(({ version, name, sha256: hash }) => [version, name, hash]))),
  };
}
