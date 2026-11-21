// Manual continuation ledger. Global authorization is open-ended; every experiment
// still has a fixed per-provider cap. Reserved/failed attempts are never refunded.
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

const identifier = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/;
const modelIdentifier = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const providers = ['gemini', 'elice'];
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasOnly = (value, allowed) => isObject(value) && Object.keys(value).every(key => allowed.includes(key));
const validName = (value, pattern = identifier) => typeof value === 'string' && pattern.test(value) && !/^(?:sk-|AIza)/.test(value);
const validTime = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const validStatus = value => Number.isInteger(value) && value >= 100 && value <= 599;
const invalidLedger = () => new Error('Invalid continuation ledger; preserve it and the previous ledger for inspection.');

function validateMetadata(value, maximum) {
  if (!hasOnly(value, ['experimentId', 'label', 'provider', 'model']) || !validName(value.experimentId)
    || !validName(value.label) || !providers.includes(value.provider) || !validName(value.model, modelIdentifier)
    || !Number.isSafeInteger(maximum) || maximum <= 0) {
    throw new Error('Invalid continuation metadata or experiment cap. Only identifiers, provider and model are allowed.');
  }
}

function validateLedger(value) {
  if (!hasOnly(value, ['version', 'previousLedger', 'authorization', 'calls']) || value.version !== 2
    || !hasOnly(value.previousLedger, ['path', 'sha256', 'calls'])
    || typeof value.previousLedger.path !== 'string' || !value.previousLedger.path.trim()
    || !/^[0-9a-f]{64}$/.test(value.previousLedger.sha256)
    || !Number.isSafeInteger(value.previousLedger.calls) || value.previousLedger.calls < 0
    || !hasOnly(value.authorization, ['mode', 'numericCallLimit'])
    || value.authorization.mode !== 'until-user-stop' || value.authorization.numericCallLimit !== null
    || !Array.isArray(value.calls)) throw invalidLedger();
  const ids = new Set(), experiments = new Map();
  for (const call of value.calls) {
    if (!hasOnly(call, ['id', 'experimentId', 'label', 'provider', 'model', 'perProviderMaxCalls', 'reservedAt', 'status', 'finishedAt', 'httpStatus'])) throw invalidLedger();
    validateMetadata({ experimentId: call.experimentId, label: call.label, provider: call.provider, model: call.model }, call.perProviderMaxCalls);
    if (typeof call.id !== 'string' || !uuid.test(call.id) || ids.has(call.id) || !validTime(call.reservedAt)
      || !['reserved', 'received', 'failed'].includes(call.status)
      || (call.status === 'reserved' ? ('finishedAt' in call || 'httpStatus' in call)
        : !validTime(call.finishedAt) || call.finishedAt < call.reservedAt)
      || ('httpStatus' in call && (call.status !== 'received' || !validStatus(call.httpStatus)))) throw invalidLedger();
    ids.add(call.id);
    const key = `${call.experimentId}/${call.provider}`;
    const existing = experiments.get(key) ?? { cap: call.perProviderMaxCalls, model: call.model, count: 0, labels: new Set() };
    if (existing.cap !== call.perProviderMaxCalls || existing.model !== call.model || existing.labels.has(call.label)
      || ++existing.count > existing.cap) throw invalidLedger();
    existing.labels.add(call.label);
    experiments.set(key, existing);
  }
  return value;
}

function readLedger(path) {
  try {
    if (!lstatSync(path).isFile()) throw invalidLedger();
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error('Continuation ledger does not exist; explicit authorization must be recorded first.');
    throw invalidLedger();
  }
  try {
    const ledger = validateLedger(JSON.parse(readFileSync(path, 'utf8')));
    const previousPath = resolve(ledger.previousLedger.path);
    if (previousPath === resolve(path) || !lstatSync(previousPath).isFile()) throw invalidLedger();
    const bytes = readFileSync(previousPath);
    const previous = JSON.parse(bytes.toString('utf8'));
    if (createHash('sha256').update(bytes).digest('hex') !== ledger.previousLedger.sha256
      || previous.version !== 1 || !Array.isArray(previous.calls) || previous.calls.length !== ledger.previousLedger.calls) throw invalidLedger();
    return ledger;
  } catch { throw invalidLedger(); }
}

export function inspectContinuationLedger(path) {
  if (typeof path !== 'string' || !path.trim()) throw new Error('A continuation ledger path is required.');
  return readLedger(resolve(path));
}

function saveLedger(path, ledger) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let descriptor, created = false;
  try {
    descriptor = openSync(temporary, 'wx', 0o600); created = true;
    writeFileSync(descriptor, JSON.stringify(validateLedger(ledger), null, 2) + '\n', 'utf8');
    fsyncSync(descriptor); closeSync(descriptor); descriptor = undefined;
    renameSync(temporary, path); created = false;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (created) unlinkSync(temporary);
  }
}

function withLedger(path, update) {
  if (typeof path !== 'string' || !path.trim()) throw new Error('A continuation ledger path is required.');
  const ledgerPath = resolve(path), lockPath = `${ledgerPath}.lock`;
  let lock;
  try { lock = openSync(lockPath, 'wx', 0o600); }
  catch (error) {
    if (error?.code === 'EEXIST') throw new Error('Continuation ledger is locked. Inspect the active/interrupted run; do not delete its lock automatically.');
    throw new Error('Cannot lock continuation ledger. Check its directory and permissions.');
  }
  try {
    const ledger = readLedger(ledgerPath);
    const result = update(ledger);
    saveLedger(ledgerPath, ledger);
    return result;
  } finally {
    try { closeSync(lock); } finally { unlinkSync(lockPath); }
  }
}

export function reserveContinuationCall(path, metadata, perProviderMaxCalls) {
  validateMetadata(metadata, perProviderMaxCalls);
  return withLedger(path, ledger => {
    const prior = ledger.calls.filter(call => call.experimentId === metadata.experimentId && call.provider === metadata.provider);
    if (prior.some(call => call.perProviderMaxCalls !== perProviderMaxCalls || call.model !== metadata.model)) {
      throw new Error('Experiment cap/model changed; create a reviewed new experiment instead of rewriting a previous plan.');
    }
    if (prior.some(call => call.label === metadata.label)) throw new Error('This experiment call is already reserved; interrupted attempts are not replayed.');
    if (prior.length >= perProviderMaxCalls) throw new Error('Experiment call budget exhausted; reserved and failed attempts count.');
    const id = randomUUID();
    ledger.calls.push({ id, ...metadata, perProviderMaxCalls, reservedAt: new Date().toISOString(), status: 'reserved' });
    return id;
  });
}

export function finishContinuationCall(path, id, outcome) {
  if (typeof id !== 'string' || !uuid.test(id) || !hasOnly(outcome, ['status', 'httpStatus'])
    || !['received', 'failed'].includes(outcome.status)
    || ('httpStatus' in outcome && (outcome.status !== 'received' || !validStatus(outcome.httpStatus)))) {
    throw new Error('Invalid continuation outcome. Record only received/failed and an optional received HTTP status.');
  }
  return withLedger(path, ledger => {
    const call = ledger.calls.find(value => value.id === id);
    if (!call) throw new Error('Continuation reservation was not found.');
    if (call.status !== 'reserved') throw new Error('Continuation outcome is already recorded and cannot be overwritten.');
    Object.assign(call, outcome, { finishedAt: new Date().toISOString() });
  });
}
