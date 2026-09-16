'use strict';

/**
 * Documentation drift guard.
 *
 * Verifies that `docs/openapi.json` matches the implementation: every registered
 * route is documented, every documented path exists, every error code the server
 * can return is in the enum, and the response schemas match the real serializers.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createJobRouter } = require('../../src/routes/job.routes');
const { createSystemRouter } = require('../../src/routes/system.routes');
const { ERROR_CODES } = require('../../src/utils/errors');
const { toJobDetail, toJobSummary, toProgressResponse } = require('../../src/domain/job-serializer');
const { ALL_STATUSES } = require('../../src/domain/job-status');
const { requiredProperties, schemaProperties, spec } = require('../helpers/openapi');

/** Express `:id` -> OpenAPI `{id}`, then prefix the mount point. */
function toOpenApiPath(mountPath, expressPath) {
  const converted = expressPath.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
  const joined = `${mountPath}${converted}`.replace(/\/$/, '');
  return joined === '' ? '/' : joined;
}

/** Collects `{ method, path }` pairs from a router instance. */
function collectRoutes(router, mountPath) {
  const routes = [];
  for (const layer of router.stack || []) {
    if (!layer.route) continue;
    const routePath = toOpenApiPath(mountPath, layer.route.path);
    for (const method of Object.keys(layer.route.methods)) {
      routes.push({ method: method.toUpperCase(), path: routePath });
    }
  }
  return routes;
}

const jobRow = Object.freeze({
  id: '9016409b-60a0-43e1-8a4c-855131aa2466',
  status: 'processing',
  original_filename: 'sosul eater rev.mp4',
  input_path: 'D:\\VideoTemp\\9016409b\\input.mp4',
  output_path: null,
  temp_output_path: null,
  width: 3840,
  height: 1620,
  duration_seconds: 1072.5,
  progress_percent: 47.85,
  frame: 12842,
  fps: 31.4,
  speed: '0.82x',
  elapsed_seconds: 513,
  total_size: null,
  pid: 4242,
  error_code: null,
  error_message: null,
  has_audio: true,
  audio_codec: 'aac',
  created_at: '2026-09-14T07:30:00.123Z',
  started_at: '2026-09-14T07:30:04.001Z',
  completed_at: null,
  updated_at: '2026-09-14T07:38:37.882Z',
});

test('openapi.json is a valid OpenAPI 3.1 document', () => {
  assert.match(spec.openapi, /^3\.1\./);
  assert.equal(typeof spec.info.title, 'string');
  assert.equal(typeof spec.info.version, 'string');
  assert.ok(spec.servers.length > 0);

  const operations = Object.values(spec.paths).flatMap((item) =>
    Object.keys(item).filter((key) => ['get', 'post', 'put', 'patch', 'delete'].includes(key)),
  );
  assert.equal(operations.length, 9, 'every operation must be documented');
  assert.equal(Object.keys(spec.paths).length, 7, 'every endpoint must be documented');
  assert.equal(Object.keys(spec.components.schemas).length >= 15, true);
});

test('every $ref in the spec resolves (no dangling references)', () => {
  const refs = new Set();
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string') refs.add(value);
      else walk(value);
    }
  };
  walk(spec);

  assert.ok(refs.size > 10, 'the spec should use shared components');
  for (const ref of refs) {
    assert.match(ref, /^#\//, `only local references are allowed: ${ref}`);
    const resolved = ref
      .slice(2)
      .split('/')
      .reduce((node, segment) => (node ? node[segment] : undefined), spec);
    assert.ok(resolved, `dangling reference: ${ref}`);
  }
});

test('every registered route is documented and vice versa', () => {
  const stubController = new Proxy(
    {},
    { get: () => (req, res) => res.status(204).end() },
  );

  const documented = new Set();
  for (const [specPath, operations] of Object.entries(spec.paths)) {
    for (const method of Object.keys(operations)) {
      if (['get', 'post', 'put', 'patch', 'delete'].includes(method)) {
        documented.add(`${method.toUpperCase()} ${specPath}`);
      }
    }
  }

  const implemented = new Set(
    [
      ...collectRoutes(createJobRouter({ controller: stubController }), '/api/v1'),
      ...collectRoutes(createSystemRouter({ controller: stubController }), '/api/v1/system'),
      { method: 'GET', path: '/health' },
    ].map((route) => `${route.method} ${route.path}`),
  );

  const missingInSpec = [...implemented].filter((route) => !documented.has(route));
  const missingInCode = [...documented].filter((route) => !implemented.has(route));

  assert.deepEqual(missingInSpec, [], 'routes that exist but are not documented');
  assert.deepEqual(missingInCode, [], 'documented routes that do not exist');
});

test('the error code enum covers exactly what the server can return', () => {
  const documented = new Set(spec.components.schemas.ApiErrorCode.enum);
  const implemented = new Set(Object.keys(ERROR_CODES).filter((code) => code !== 'REQUEST_ABORTED'));

  for (const code of implemented) {
    assert.ok(documented.has(code), `error code ${code} is missing from openapi.json`);
  }
  for (const code of documented) {
    assert.ok(implemented.has(code), `openapi.json documents unknown error code ${code}`);
  }
  // REQUEST_ABORTED is internal: the client is gone when it happens.
  assert.equal(documented.has('REQUEST_ABORTED'), false);
});

test('the job status enum matches the state machine', () => {
  assert.deepEqual(
    [...spec.components.schemas.JobStatus.enum].sort(),
    [...ALL_STATUSES].sort(),
  );
});

test('JobDetail / JobSummary / JobProgress schemas match the serializers', () => {
  const detail = toJobDetail(jobRow);
  const summary = toJobSummary(jobRow);
  const progress = toProgressResponse(jobRow);

  assert.deepEqual(
    Object.keys(detail).sort(),
    schemaProperties(spec.components.schemas.JobDetail).sort(),
  );
  assert.deepEqual(
    Object.keys(summary).sort(),
    schemaProperties(spec.components.schemas.JobSummary).sort(),
  );

  // The progress payload adds `error` (failed) and `completed` (terminal) only.
  const progressSchema = spec.components.schemas.JobProgress;
  const progressKeys = Object.keys(progress);
  for (const key of progressKeys) {
    assert.ok(
      schemaProperties(progressSchema).includes(key),
      `JobProgress does not document the key "${key}"`,
    );
  }
  for (const key of requiredProperties(progressSchema)) {
    assert.ok(progressKeys.includes(key), `JobProgress must always include "${key}"`);
  }
});

test('nested schemas match the nested serializer output', () => {
  const detail = toJobDetail(jobRow);
  const progressSchema = spec.components.schemas.JobDetail.properties;

  assert.deepEqual(Object.keys(detail.input).sort(), schemaProperties(progressSchema.input).sort());
  assert.deepEqual(
    Object.keys(detail.resolution).sort(),
    schemaProperties(progressSchema.resolution).sort(),
  );
  assert.deepEqual(
    Object.keys(detail.progress).sort(),
    schemaProperties(progressSchema.progress).sort(),
  );
  assert.deepEqual(
    Object.keys(detail.timestamps).sort(),
    schemaProperties(progressSchema.timestamps).sort(),
  );
  assert.deepEqual(
    schemaProperties(spec.components.schemas.JobOutput).sort(),
    ['filename', 'sizeBytes'],
  );
  assert.deepEqual(schemaProperties(spec.components.schemas.JobError).sort(), ['code', 'message']);
});

test('terminal and failed payload variants are documented', () => {
  const failedRow = { ...jobRow, status: 'failed', error_code: 'FFMPEG_ERROR', error_message: 'boom' };
  const completedRow = {
    ...jobRow,
    status: 'completed',
    progress_percent: 100,
    output_path: 'D:\\Hasil Render\\out_prob3_3840x1620.mp4',
    total_size: 1892344331,
  };

  const failed = toProgressResponse(failedRow);
  const completed = toProgressResponse(completedRow);

  assert.deepEqual(Object.keys(failed.error).sort(), schemaProperties(spec.components.schemas.JobError).sort());
  assert.equal(failed.completed, false);
  assert.equal(completed.completed, true);
  assert.deepEqual(
    Object.keys(completed.output).sort(),
    schemaProperties(spec.components.schemas.JobOutput).sort(),
  );

  // Both variants stay within the documented schema.
  for (const key of [...Object.keys(failed), ...Object.keys(completed)]) {
    assert.ok(
      schemaProperties(spec.components.schemas.JobProgress).includes(key),
      `JobProgress does not document the key "${key}"`,
    );
  }
});

test('the create / health / system status schemas cover the documented payloads', () => {
  assert.deepEqual(schemaProperties(spec.components.schemas.CreateJobResponse).sort(), [
    'height',
    'id',
    'position',
    'render',
    'status',
    'width',
  ]);
  assert.deepEqual(schemaProperties(spec.components.schemas.HealthResponse).sort(), [
    'service',
    'status',
    'uptimeSeconds',
  ]);
  assert.deepEqual(schemaProperties(spec.components.schemas.SystemStatusResponse).sort(), [
    'jobs',
    'queue',
    'renderOptions',
    'renderer',
    'service',
    'status',
    'thresholds',
    'uptimeSeconds',
  ]);
  assert.deepEqual(schemaProperties(spec.components.schemas.DeleteJobResponse).sort(), [
    'deleted',
    'id',
    'outputDeleted',
  ]);
  assert.deepEqual(schemaProperties(spec.components.schemas.ApiErrorResponse), ['error']);
  assert.deepEqual(schemaProperties(spec.components.schemas.JobListResponse).sort(), [
    'data',
    'pagination',
  ]);
  assert.deepEqual(schemaProperties(spec.components.schemas.Pagination).sort(), [
    'limit',
    'page',
    'total',
    'totalPages',
  ]);
  assert.deepEqual(schemaProperties(spec.components.schemas.JobSummary).includes('queuePosition'), true);
});
