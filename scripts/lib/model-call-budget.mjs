// Shared, manual-evaluation budget. Reserve immediately before each upstream call.
// A reserved attempt counts even when delivery, completion or billing is unknown.
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

export const MODEL_CALL_LIMITS = Object.freeze({ development: 24, final: 84, total: 108 });
const phases = ['development', 'final'];
const providers = ['gemini', 'elice'];
const statuses = ['reserved', 'received', 'failed'];
const identifier = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/;
const modelIdentifier = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasOnly = (value, allowed) => isObject(value) && Object.keys(value).every(key => allowed.includes(key));
const validTime = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const validHttpStatus = value => Number.isInteger(value) && value >= 100 && value <= 599;
const validName = (value, expression) => typeof value === 'string' && expression.test(value)
  && !/^(?:sk-|AIza)/.test(value);

function validateReservation(value) {
  if (!hasOnly(value, ['phase', 'label', 'provider', 'model']) || !phases.includes(value.phase)
    || !providers.includes(value.provider) || !validName(value.label, identifier)
    || !validName(value.model, modelIdentifier)) {
    throw new Error('Invalid model-call metadata. Use only phase, short identifier label, provider and model; never include text, keys or URLs.');
  }
}

function validateLedger(value) {
  if (!hasOnly(value, ['version', 'limits', 'calls']) || value.version !== 1
    || !hasOnly(value.limits, ['development', 'final', 'total'])
    || Object.entries(MODEL_CALL_LIMITS).some(([phase, maximum]) => value.limits[phase] !== maximum)
    || !Array.isArray(value.calls) || value.calls.length > MODEL_CALL_LIMITS.total) {
    throw new Error('Invalid model-call ledger; preserve it for inspection.');
  }
  const ids = new Set();
  const counts = { development: 0, final: 0 };
  for (const call of value.calls) {
    if (!hasOnly(call, ['id', 'phase', 'label', 'provider', 'model', 'reservedAt', 'status', 'finishedAt', 'httpStatus'])) {
      throw new Error('Invalid model-call ledger; preserve it for inspection.');
    }
    validateReservation({ phase: call.phase, label: call.label, provider: call.provider, model: call.model });
    if (typeof call.id !== 'string' || !uuid.test(call.id) || ids.has(call.id) || !validTime(call.reservedAt)
      || !statuses.includes(call.status)
      || (call.status === 'reserved' ? ('finishedAt' in call || 'httpStatus' in call)
        : !validTime(call.finishedAt))
      || ('httpStatus' in call && !validHttpStatus(call.httpStatus))) {
      throw new Error('Invalid model-call ledger; preserve it for inspection.');
    }
    ids.add(call.id);
    if (++counts[call.phase] > MODEL_CALL_LIMITS[call.phase]) throw new Error('Invalid model-call ledger; preserve it for inspection.');
  }
  return value;
}

function readLedger(path, allowCreate) {
  let info;
  try { info = lstatSync(path); }
  catch (error) {
    if (error?.code !== 'ENOENT') throw new Error('Cannot inspect model-call ledger; preserve it for inspection.');
    if (!allowCreate) throw new Error('Model-call ledger does not exist. Reserve a call before recording its result.');
    return { version: 1, limits: { ...MODEL_CALL_LIMITS }, calls: [] };
  }
  try {
    // Refuse directories and symbolic links rather than replacing unrelated data.
    if (!info.isFile()) throw new Error();
    return validateLedger(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    throw new Error('Invalid model-call ledger; preserve it for inspection.');
  }
}

function saveLedger(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let descriptor;
  let created = false;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    created = true;
    writeFileSync(descriptor, JSON.stringify(validateLedger(value), null, 2) + '\n', 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    // Same-directory rename replaces the complete ledger, never a partial JSON file.
    renameSync(temporary, path);
    created = false;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (created) unlinkSync(temporary);
  }
}

function withLedger(path, allowCreate, update) {
  if (typeof path !== 'string' || !path.trim()) throw new Error('A model-call ledger path is required.');
  const ledgerPath = resolve(path);
  const lockPath = `${ledgerPath}.lock`;
  let lock;
  try { lock = openSync(lockPath, 'wx', 0o600); }
  catch (error) {
    if (error?.code === 'EEXIST') throw new Error('Model-call ledger is locked. Inspect any active or interrupted run; the lock was not removed.');
    throw new Error('Cannot lock model-call ledger. Check that its directory exists and is writable.');
  }
  try {
    const ledger = readLedger(ledgerPath, allowCreate);
    const result = update(ledger);
    saveLedger(ledgerPath, ledger);
    return result;
  } finally {
    try { closeSync(lock); }
    finally { unlinkSync(lockPath); }
  }
}

export function reserveModelCall(ledgerPath, metadata) {
  validateReservation(metadata);
  return withLedger(ledgerPath, true, ledger => {
    const phaseCount = ledger.calls.filter(call => call.phase === metadata.phase).length;
    if (phaseCount >= MODEL_CALL_LIMITS[metadata.phase] || ledger.calls.length >= MODEL_CALL_LIMITS.total) {
      throw new Error(`Model-call budget exhausted for ${metadata.phase}. Reserved and failed attempts still count.`);
    }
    const id = randomUUID();
    ledger.calls.push({ id, ...metadata, reservedAt: new Date().toISOString(), status: 'reserved' });
    return id;
  });
}

export function finishModelCall(ledgerPath, id, outcome) {
  if (typeof id !== 'string' || !uuid.test(id) || !hasOnly(outcome, ['status', 'httpStatus'])
    || !['received', 'failed'].includes(outcome.status)
    || ('httpStatus' in outcome && !validHttpStatus(outcome.httpStatus))) {
    throw new Error('Invalid model-call outcome. Record only received/failed and an optional HTTP status.');
  }
  return withLedger(ledgerPath, false, ledger => {
    const call = ledger.calls.find(item => item.id === id);
    if (!call) throw new Error('Model-call reservation was not found.');
    if (call.status !== 'reserved') throw new Error('Model-call outcome is already recorded; previous results cannot be overwritten.');
    Object.assign(call, outcome, { finishedAt: new Date().toISOString() });
  });
}
