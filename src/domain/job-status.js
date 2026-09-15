'use strict';

/**
 * Job status model.
 *
 * Valid transitions (see AGENTS.md §4):
 *
 *   queued ──► probing ──► queued ──► processing ──► completed
 *                                        │
 *                                        ├──► failed
 *                                        └──► cancel_requested ──► cancelled
 *   queued ──────────────────────────────────────────────────────► cancelled
 */

const JOB_STATUS = Object.freeze({
  QUEUED: 'queued',
  PROBING: 'probing',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCEL_REQUESTED: 'cancel_requested',
  CANCELLED: 'cancelled',
});

const ALL_STATUSES = Object.freeze(Object.values(JOB_STATUS));

const TERMINAL_STATUSES = Object.freeze([
  JOB_STATUS.COMPLETED,
  JOB_STATUS.FAILED,
  JOB_STATUS.CANCELLED,
]);

/** Statuses in which a worker may hold a render (process) reference. */
const ACTIVE_STATUSES = Object.freeze([
  JOB_STATUS.PROBING,
  JOB_STATUS.PROCESSING,
  JOB_STATUS.CANCEL_REQUESTED,
]);

const TRANSITIONS = Object.freeze({
  [JOB_STATUS.QUEUED]: Object.freeze([
    JOB_STATUS.PROBING,
    JOB_STATUS.PROCESSING,
    JOB_STATUS.CANCEL_REQUESTED,
    JOB_STATUS.CANCELLED,
    JOB_STATUS.FAILED,
  ]),
  [JOB_STATUS.PROBING]: Object.freeze([
    JOB_STATUS.QUEUED,
    JOB_STATUS.PROCESSING,
    JOB_STATUS.CANCEL_REQUESTED,
    JOB_STATUS.CANCELLED,
    JOB_STATUS.FAILED,
  ]),
  [JOB_STATUS.PROCESSING]: Object.freeze([
    JOB_STATUS.COMPLETED,
    JOB_STATUS.FAILED,
    JOB_STATUS.CANCEL_REQUESTED,
    JOB_STATUS.CANCELLED,
  ]),
  [JOB_STATUS.CANCEL_REQUESTED]: Object.freeze([
    JOB_STATUS.CANCELLED,
    JOB_STATUS.FAILED,
    // ffmpeg may have finished just before the kill was delivered.
    JOB_STATUS.COMPLETED,
  ]),
  [JOB_STATUS.COMPLETED]: Object.freeze([]),
  [JOB_STATUS.FAILED]: Object.freeze([]),
  [JOB_STATUS.CANCELLED]: Object.freeze([]),
});

function isKnownStatus(status) {
  return ALL_STATUSES.includes(status);
}

function isTerminalStatus(status) {
  return TERMINAL_STATUSES.includes(status);
}

function isActiveStatus(status) {
  return ACTIVE_STATUSES.includes(status);
}

function canTransition(from, to) {
  if (!isKnownStatus(from) || !isKnownStatus(to)) return false;
  if (from === to) return true;
  return (TRANSITIONS[from] || []).includes(to);
}

module.exports = {
  ACTIVE_STATUSES,
  ALL_STATUSES,
  JOB_STATUS,
  TERMINAL_STATUSES,
  TRANSITIONS,
  canTransition,
  isActiveStatus,
  isKnownStatus,
  isTerminalStatus,
};
