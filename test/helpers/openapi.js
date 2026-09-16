'use strict';

/**
 * OpenAPI helpers for tests: load `docs/openapi.json` and compare real HTTP
 * responses against the documented schemas, so the documentation cannot drift
 * from the implementation.
 */

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const SPEC_PATH = path.resolve(__dirname, '..', '..', 'docs', 'openapi.json');
const spec = JSON.parse(fs.readFileSync(SPEC_PATH, 'utf8'));

function resolve(node) {
  if (!node) return null;
  if (node.$ref) {
    const name = node.$ref.split('/').pop();
    return resolve(spec.components.schemas[name]);
  }
  return node;
}

/** Property names of a schema (following `$ref` and `oneOf`). */
function schemaProperties(node) {
  const resolved = resolve(node);
  if (!resolved) return [];
  if (resolved.oneOf) {
    const names = new Set();
    for (const variant of resolved.oneOf) {
      for (const name of schemaProperties(variant)) names.add(name);
    }
    return [...names];
  }
  return Object.keys(resolved.properties || {});
}

function requiredProperties(node) {
  return resolve(node)?.required || [];
}

/** Asserts that an object's keys are a documented subset (or an exact match). */
function assertResponseShape(payload, schemaName, { mode = 'subset', label = schemaName } = {}) {
  const schema = spec.components.schemas[schemaName];
  assert.ok(schema, `openapi.json has no schema ${schemaName}`);

  const actual = Object.keys(payload).sort();
  const documented = schemaProperties(schema).sort();

  for (const key of actual) {
    assert.ok(documented.includes(key), `${label}: undocumented response key "${key}"`);
  }
  for (const key of requiredProperties(schema)) {
    assert.ok(actual.includes(key), `${label}: missing documented key "${key}"`);
  }
  if (mode === 'exact') {
    assert.deepEqual(actual, documented, `${label}: key set differs from the documented schema`);
  }
  return actual;
}

module.exports = { SPEC_PATH, assertResponseShape, requiredProperties, schemaProperties, spec };
