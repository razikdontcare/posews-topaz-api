'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createRenderQueue } = require('../../src/queue/render.queue');

function createHarness(options = {}) {
  const events = [];
  const logs = [];
  const logger = {
    error: (message) => logs.push(['error', String(message)]),
    warn: (message) => logs.push(['warn', String(message)]),
    info: (message) => logs.push(['info', String(message)]),
    debug: (message) => logs.push(['debug', String(message)]),
  };
  const queue = createRenderQueue({
    concurrency: options.concurrency ?? 1,
    logger,
    runner: options.runner,
    loadQueuedJobIds: options.loadQueuedJobIds,
    isRunnerAvailable: options.isRunnerAvailable,
    ensureRunnerAvailable: options.ensureRunnerAvailable,
    onRunnerError: options.onRunnerError,
    reconcileIntervalMs: 0,
  });
  return { queue, events, logs, logger };
}

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

/** Runner that records start/end and can be held open per job. */
function recordingRunner(state = { running: 0, maxRunning: 0, order: [] }) {
  return async (jobId) => {
    state.running += 1;
    state.maxRunning = Math.max(state.maxRunning, state.running);
    state.order.push({ type: 'start', jobId });
    await tick(30);
    state.order.push({ type: 'end', jobId });
    state.running -= 1;
    return { status: 'completed' };
  };
}

test('runs jobs in FIFO order, one at a time', async () => {
  const state = { running: 0, maxRunning: 0, order: [] };
  const { queue } = createHarness({ runner: recordingRunner(state) });

  queue.enqueue('A');
  queue.enqueue('B');
  queue.enqueue('C');
  assert.equal(queue.queuedCount, 2); // A already started

  await tick(300);
  assert.deepEqual(
    state.order.map((entry) => `${entry.type}:${entry.jobId}`),
    ['start:A', 'end:A', 'start:B', 'end:B', 'start:C', 'end:C'],
  );
  assert.equal(state.maxRunning, 1, 'never two renders at the same time');
  assert.equal(queue.activeCount, 0);
  assert.equal(queue.queuedCount, 0);
});

test('the same job can never be queued or executed twice', async () => {
  const state = { running: 0, maxRunning: 0, order: [] };
  const { queue } = createHarness({ runner: recordingRunner(state) });

  assert.equal(queue.enqueue('A'), true);
  assert.equal(queue.enqueue('A'), false, 'duplicate enqueue must be ignored');
  assert.equal(queue.isPending('A'), false, 'A is already active');

  queue.enqueue('B');
  assert.equal(queue.enqueue('B'), false);

  await tick(300);
  assert.equal(state.order.filter((entry) => entry.jobId === 'A').length, 2); // start + end
});

test('remove() drops a job that has not started yet', async () => {
  const state = { running: 0, maxRunning: 0, order: [] };
  const { queue } = createHarness({ runner: recordingRunner(state) });

  queue.enqueue('A');
  queue.enqueue('B');
  assert.equal(queue.remove('B'), true);
  assert.equal(queue.remove('B'), false);
  assert.equal(queue.queuedCount, 0);

  await tick(200);
  assert.deepEqual(
    state.order.map((entry) => `${entry.type}:${entry.jobId}`),
    ['start:A', 'end:A'],
  );
});

test('pause() stops new work until resume()', async () => {
  const state = { running: 0, maxRunning: 0, order: [] };
  const { queue } = createHarness({ runner: recordingRunner(state) });

  queue.pause('test');
  queue.enqueue('A');
  await tick(60);
  assert.equal(state.order.length, 0, 'nothing runs while paused');

  queue.resume();
  await tick(120);
  assert.deepEqual(
    state.order.map((entry) => `${entry.type}:${entry.jobId}`),
    ['start:A', 'end:A'],
  );
});

test('a deferred render (renderer unavailable) stays queued and pauses the queue', async () => {
  let available = false;
  const runs = [];
  const { queue, logs } = createHarness({
    runner: async (jobId) => {
      runs.push(jobId);
      return available ? { status: 'completed' } : { status: 'deferred', deferred: true };
    },
    isRunnerAvailable: () => available,
    ensureRunnerAvailable: async () => available,
  });

  queue.enqueue('A');
  await tick(60);
  assert.deepEqual(runs, ['A']);
  assert.equal(queue.isPaused, true);
  assert.equal(queue.queuedCount, 1, 'the job goes back into the queue');
  assert.match(logs.map((entry) => entry[1]).join('\n'), /renderer unavailable/i);

  available = true;
  const result = await queue.reconcile();
  assert.equal(result.paused, false);
  assert.equal(queue.isPaused, false);
  await tick(80);
  assert.deepEqual(runs, ['A', 'A']);
  assert.equal(queue.queuedCount, 0);
});

test('reconcile() hydrates from the database and does not duplicate work', async () => {
  const state = { running: 0, maxRunning: 0, order: [] };
  const dbIds = ['job-1', 'job-2'];
  const { queue } = createHarness({
    runner: recordingRunner(state),
    loadQueuedJobIds: () => dbIds,
  });

  const first = await queue.reconcile();
  assert.equal(first.enqueued, 2);
  const second = await queue.reconcile();
  assert.equal(second.enqueued, 0, 'already known jobs are not re-enqueued');

  await tick(300);
  assert.equal(state.maxRunning, 1);
  assert.deepEqual(queue.snapshot().active, []);
});

test('reconcile() keeps the queue paused while the renderer is unavailable', async () => {
  const runs = [];
  const { queue } = createHarness({
    runner: async (jobId) => {
      runs.push(jobId);
      return { status: 'completed' };
    },
    loadQueuedJobIds: () => ['A'],
    isRunnerAvailable: () => false,
    ensureRunnerAvailable: async () => false,
  });

  const result = await queue.reconcile();
  assert.equal(result.paused, true);
  assert.equal(queue.isPaused, true);
  assert.deepEqual(runs, []);
  assert.equal(queue.queuedCount, 0, 'nothing is queued while the renderer is unusable');
});

test('a runner that throws notifies the error handler and keeps the queue alive', async () => {
  const errors = [];
  const state = { running: 0, maxRunning: 0, order: [] };
  const { queue } = createHarness({
    runner: async (jobId) => {
      if (jobId === 'bad') throw new Error('runner exploded');
      return recordingRunner(state)(jobId);
    },
    onRunnerError: (jobId, error) => errors.push([jobId, error.message]),
  });

  queue.enqueue('bad');
  queue.enqueue('good');
  await tick(200);

  assert.deepEqual(errors, [['bad', 'runner exploded']]);
  assert.deepEqual(
    state.order.map((entry) => `${entry.type}:${entry.jobId}`),
    ['start:good', 'end:good'],
  );
});

test('stop() prevents new work and drains the active one', async () => {
  const state = { running: 0, maxRunning: 0, order: [] };
  const { queue } = createHarness({ runner: recordingRunner(state) });

  queue.enqueue('A');
  queue.enqueue('B');
  const drained = await queue.stop({ timeoutMs: 1000 });

  assert.equal(drained, true);
  await tick(100);
  assert.deepEqual(
    state.order.map((entry) => `${entry.type}:${entry.jobId}`),
    ['start:A', 'end:A'],
  );
  assert.equal(queue.enqueue('C'), false);
});
