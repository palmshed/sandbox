#!/usr/bin/env node
/**
 * scripts/verify-schemas.mjs
 *
 * Validates every JSON schema under spec/:
 *
 *   1. each file is well-formed JSON with the expected identity fields
 *      ($schema draft-2020-12, $id, title, type),
 *   2. each schema validates against the JSON Schema 2020-12 meta-schema
 *      (structural correctness: property types, required format, etc.),
 *   3. every $ref resolves: local '#/$defs/...' pointers must exist, and
 *      cross-file refs ('exec.schema.json#...') must resolve to a sibling file.
 *
 * Requires the repo-root dev dependencies (ajv): `npm ci` at the repo root.
 * CI (docs.yml/release.yml) and `npm run preflight` invoke this same script.
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { REPO_ROOT, Reporter } from './lib/preflight-lib.mjs';

const SPEC_DIR = path.join(REPO_ROOT, 'spec');
const schemaFiles = fs.readdirSync(SPEC_DIR).filter((f) => f.endsWith('.schema.json'));

const report = new Reporter();

async function main() {
  let ajv;
  try {
    const { Ajv2020 } = await import('ajv/dist/2020.js');
    ajv = new Ajv2020({ strict: true, strictTypes: false, allErrors: true });
  } catch (err) {
    console.error('ajv is not installed at the repo root. Run: npm ci');
    process.exit(2);
  }

  const schemas = new Map();
  for (const file of schemaFiles) {
    const abs = path.join(SPEC_DIR, file);
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(abs, 'utf-8'));
    } catch (err) {
      report.check(`${file} parses as JSON`, false, err.message);
      continue;
    }
    schemas.set(file, doc);

    const identityOk =
      doc.$schema === 'https://json-schema.org/draft/2020-12/schema' &&
      typeof doc.$id === 'string' &&
      typeof doc.title === 'string' &&
      (doc.type === 'object' || doc.definitions || doc.$defs);
    report.check(
      `${file} identity ($schema/$id/title/type)`,
      identityOk,
      identityOk ? '' : `got ${JSON.stringify({ $schema: doc.$schema, title: doc.title, type: doc.type })}`
    );
  }

  // Validate each schema against the meta-schema. strict mode catches
  // undefined keywords and dangling keywords.
  for (const [file, doc] of schemas) {
    try {
      const validate = ajv.compile(doc);
      validate({});
      report.check(`${file} meta-schema`, true);
    } catch (err) {
      report.check(`${file} meta-schema`, false, err.message);
    }
  }

  // $ref resolution: collect every ref in every schema and resolve it.
  const refs = new Map();
  const walk = (node, file) => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item, file);
    } else if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (k === '$ref' && typeof v === 'string') {
          if (!refs.has(file)) refs.set(file, []);
          refs.get(file).push(v);
        } else {
          walk(v, file);
        }
      }
    }
  };
  for (const [file, doc] of schemas) walk(doc, file);

  const resolvePointer = (doc, pointer) => {
    const parts = pointer.split('/').filter(Boolean).map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
    let cur = doc;
    for (const part of parts) {
      if (cur == null || typeof cur !== 'object' || !(part in cur)) return null;
      cur = cur[part];
    }
    return cur;
  };

  let refCheck = true;
  const refDetails = [];
  for (const [file, refsList] of refs) {
    for (const ref of refsList) {
      const [targetFile, pointer] = ref.split('#');
      if (!pointer) {
        refCheck = false;
        refDetails.push(`${file}: ${ref} has no pointer`);
        continue;
      }
      if (pointer === '/') continue; // root ref
      if (!targetFile) {
        // local ref into the same document
        if (resolvePointer(schemas.get(file), pointer) === null) {
          refCheck = false;
          refDetails.push(`${file}: ${ref} does not resolve`);
        }
      } else {
        const target = schemas.get(targetFile);
        if (!target) {
          refCheck = false;
          refDetails.push(`${file}: ${ref} references missing file ${targetFile}`);
        } else if (resolvePointer(target, pointer) === null) {
          refCheck = false;
          refDetails.push(`${file}: ${ref} does not resolve in ${targetFile}`);
        }
      }
    }
  }
  report.check(`$ref resolution (${[...refs.values()].flat().length} refs)`, refCheck, refCheck ? '' : refDetails.join('; '));

  const exit = report.finish();
  process.exit(exit);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
