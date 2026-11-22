// Offline record processing only. No provider, product API, prompt or automatic
// semantic judge. A valid record/group never establishes explanation quality.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { propositionInput } from './explanation-propositions.mjs';

export const REVIEW_CONTRACT_VERSION = 'proposition-review-v1';
const textIds = ['t1', 't2'];
const propositionIds = Array.from({ length: 8 }, (_, index) => `h${index + 1}`);
const boundedText = maximum => z.string().refine(value => value.trim().length > 0 && [...value].length <= maximum);
const localId = boundedText(128);
const propositionId = z.enum(propositionIds);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const revisionId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const metadataSchema = z.object({ runId: localId, requestId: localId }).strict();
const bindingSchema = z.object({
  runId: localId, requestId: localId, contractVersion: z.literal(REVIEW_CONTRACT_VERSION),
  inputSha256: digest, outputSha256: digest,
}).strict();
const propositionShape = {
  id: propositionId, statement: boundedText(300), originId: z.enum(textIds),
};
const outputSchema = z.object({
  propositions: z.array(z.object(propositionShape).strict()).min(1).max(8),
}).strict();
const snapshotSchema = z.object({
  binding: bindingSchema, rawResponseSha256: digest, input: z.unknown(),
  propositions: z.array(z.object({ ...propositionShape, sourceContext: boundedText(2000) }).strict()).min(1).max(8),
  semanticAssessment: z.literal('not-performed'),
}).strict();
const supportSchema = z.object({
  propositionId, status: z.enum(['unreviewed', 'supported', 'unsupported', 'uncertain']), reason: boundedText(2000),
}).strict();
const relationSchema = z.object({
  leftId: propositionId, rightId: propositionId,
  status: z.enum(['unreviewed', 'same', 'different', 'uncertain']), reason: boundedText(2000),
}).strict();
const coverageSchema = z.object({
  id: localId, originId: z.enum(textIds), information: boundedText(2000),
  propositionIds: z.array(propositionId).max(8),
  status: z.enum(['preserved', 'missing', 'overstated', 'needs-review']), reason: boundedText(2000),
}).strict();
const reviewSchema = z.object({
  reviewRevision: revisionId, binding: bindingSchema,
  reviewer: z.object({ kind: z.enum(['human', 'ai-assisted']), id: localId }).strict(),
  withdrawn: z.boolean(), supports: z.array(supportSchema).max(8),
  relations: z.array(relationSchema).max(28), coverage: z.array(coverageSchema),
}).strict();
const historySchema = z.object({
  activeRevisions: z.array(revisionId).max(1), revisions: z.array(reviewSchema),
}).strict();
const groupsSchema = z.array(z.object({
  reviewRevision: revisionId, representativeId: propositionId,
  memberIds: z.array(propositionId).min(2).max(8),
}).strict()).max(4);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const inputHash = input => hash(JSON.stringify(input.texts.map(({ id, text }) => ({ id, text }))));
const outputHash = propositions => hash(JSON.stringify(propositions.map(({ id, statement, originId }) => ({ id, statement, originId }))));
const pairKey = (left, right) => JSON.stringify([left, right].sort());
const unique = values => new Set(values).size === values.length;
const sameBinding = (a, b) => Object.keys(bindingSchema.shape).every(key => a[key] === b[key]);

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
const failure = (validationError, extra = {}) => freeze({ ok: false, validationError, ...extra, semanticAssessment: 'not-performed' });

function outputError(decoded) {
  const parsed = outputSchema.safeParse(decoded);
  if (!parsed.success) return 'proposition-schema';
  const items = parsed.data.propositions;
  if (!unique(items.map(item => item.id))) return 'duplicate-proposition-id';
  if (!unique(items.map(item => JSON.stringify([item.originId, item.statement])))) return 'duplicate-origin-statement';
  return null;
}

/** Take a detached immutable snapshot from raw JSON. Strings mean UTF-8;
 * Uint8Array preserves received bytes (including BOM/line endings) for hashing.
 * Invalid output has a raw hash, but never a validated output hash/snapshot.
 * Invalid caller input/metadata throws before examining the proposed output. */
export function createPropositionReviewSnapshot(inputValue, rawResponse, metadata) {
  const input = propositionInput(inputValue);
  const parsedMeta = metadataSchema.safeParse(metadata);
  if (!parsedMeta.success) throw new Error('Only bounded local runId/requestId metadata may bind a snapshot.');
  if (typeof rawResponse !== 'string' && !(rawResponse instanceof Uint8Array)) {
    throw new Error('Raw response must be a UTF-8 string or Uint8Array.');
  }
  const bytes = Buffer.from(rawResponse);
  const rawResponseSha256 = hash(bytes);
  const fail = error => failure(error, { rawResponseSha256 });
  let decoded;
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    if (typeof rawResponse === 'string' && text !== rawResponse) return fail('raw-response-encoding');
    decoded = JSON.parse(text);
  } catch {
    return fail('raw-response-json');
  }
  const error = outputError(decoded);
  if (error) return fail(error);
  const binding = {
    ...parsedMeta.data, contractVersion: REVIEW_CONTRACT_VERSION,
    inputSha256: inputHash(input), outputSha256: outputHash(decoded.propositions),
  };
  const propositions = decoded.propositions.map(item => ({
    ...item, sourceContext: input.texts.find(text => text.id === item.originId).text,
  }));
  return freeze({ ok: true, snapshot: {
    binding, rawResponseSha256, input, propositions, semanticAssessment: 'not-performed',
  } });
}

// Revalidate serialized snapshots against their canonical content and context.
// Hashes bind records; they do not authenticate a reviewer or an external file.
function checkSnapshot(value) {
  const parsed = snapshotSchema.safeParse(value);
  if (!parsed.success) return null;
  const snapshot = parsed.data;
  let input;
  try { input = propositionInput(snapshot.input); } catch { return null; }
  const proposed = snapshot.propositions.map(({ id, statement, originId }) => ({ id, statement, originId }));
  if (outputError({ propositions: proposed })) return null;
  if (snapshot.binding.inputSha256 !== inputHash(input) || snapshot.binding.outputSha256 !== outputHash(proposed)) return null;
  if (snapshot.propositions.some(item => item.sourceContext !== input.texts.find(text => text.id === item.originId).text)) return null;
  return { ...snapshot, input };
}

function reviewError(snapshot, revisions) {
  const ids = new Set(snapshot.propositions.map(item => item.id));
  if (!unique(revisions.map(review => review.reviewRevision))) return 'duplicate-review-revision';
  for (const review of revisions) {
    if (!sameBinding(snapshot.binding, review.binding)) return 'review-binding-mismatch';
    if (!unique(review.supports.map(item => item.propositionId))) return 'duplicate-support-review';
    if (review.supports.some(item => !ids.has(item.propositionId))) return 'unknown-support-proposition';
    const pairs = review.relations.map(item => pairKey(item.leftId, item.rightId));
    if (!unique(pairs)) return 'duplicate-relation-review';
    if (review.relations.some(item => item.leftId === item.rightId || !ids.has(item.leftId) || !ids.has(item.rightId))) return 'invalid-relation-proposition';
    if (!unique(review.coverage.map(item => item.id))) return 'duplicate-coverage-id';
    for (const item of review.coverage) {
      if (!unique(item.propositionIds) || item.propositionIds.some(id => !ids.has(id))) return 'invalid-coverage-proposition';
      if (item.propositionIds.some(id => snapshot.propositions.find(p => p.id === id).originId !== item.originId)) return 'coverage-origin-mismatch';
      if (item.status === 'preserved' && item.propositionIds.length === 0) return 'coverage-without-proposition';
    }
  }
  return null;
}

/** Consume explicit review records; never infer support, coverage or equivalence.
 * Empty/withdrawn/uncertain reviews do not fall back to an older positive result.
 * ok means record integrity only, even if a human/AI-supplied judgment is wrong.
 * Groups are proposals validated against the CURRENT full revision each time;
 * callers must not treat a previously returned group as current after a change. */
export function applyPropositionReview(snapshotValue, historyValue, proposedGroups = []) {
  const snapshot = checkSnapshot(snapshotValue);
  if (!snapshot) return failure('snapshot-integrity');
  const parsedHistory = historySchema.safeParse(historyValue);
  const parsedGroups = groupsSchema.safeParse(proposedGroups);
  if (!parsedHistory.success) return failure('review-history-schema');
  if (!parsedGroups.success) return failure('review-groups-schema');
  const history = parsedHistory.data;
  const error = reviewError(snapshot, history.revisions);
  if (error) return failure(error);
  const activeId = history.activeRevisions[0];
  const active = history.revisions.find(review => review.reviewRevision === activeId);
  if (activeId !== undefined && !active) return failure('active-review-not-found');
  if (active && history.revisions.some(review => review.reviewRevision > active.reviewRevision)) return failure('stale-active-review');
  if (active?.withdrawn) return failure('active-review-withdrawn');
  if (!active && parsedGroups.data.length) return failure('group-without-active-review');

  const supports = snapshot.propositions.map(item => active?.supports.find(s => s.propositionId === item.id)
    ?? { propositionId: item.id, status: 'unreviewed', reason: null });
  const relations = [];
  for (let left = 0; left < snapshot.propositions.length; left++) {
    for (let right = left + 1; right < snapshot.propositions.length; right++) {
      const leftId = snapshot.propositions[left].id, rightId = snapshot.propositions[right].id;
      relations.push(active?.relations.find(r => pairKey(r.leftId, r.rightId) === pairKey(leftId, rightId))
        ?? { leftId, rightId, status: 'unreviewed', reason: null });
    }
  }
  const used = new Set(), groups = [];
  for (const group of parsedGroups.data) {
    if (group.reviewRevision !== active.reviewRevision) return failure('stale-group-review');
    if (!unique(group.memberIds) || !group.memberIds.includes(group.representativeId)) return failure('invalid-group-members');
    if (group.memberIds.some(id => used.has(id))) return failure('overlapping-groups');
    if (group.memberIds.some(id => !snapshot.propositions.some(item => item.id === id))) return failure('unknown-group-proposition');
    if (group.memberIds.some(id => supports.find(item => item.propositionId === id).status !== 'supported')) return failure('group-support-not-confirmed');
    for (let left = 0; left < group.memberIds.length; left++) {
      for (let right = left + 1; right < group.memberIds.length; right++) {
        const relation = relations.find(r => pairKey(r.leftId, r.rightId) === pairKey(group.memberIds[left], group.memberIds[right]));
        if (relation.status !== 'same') return failure('group-relation-not-confirmed');
      }
    }
    group.memberIds.forEach(id => used.add(id));
    groups.push({
      binding: snapshot.binding, ...group,
      members: group.memberIds.map(id => snapshot.propositions.find(item => item.id === id)),
    });
  }
  return freeze(structuredClone({
    ok: true, binding: snapshot.binding, rawResponseSha256: snapshot.rawResponseSha256,
    reviewRevision: active?.reviewRevision ?? null, reviewer: active?.reviewer ?? null,
    propositions: snapshot.propositions, supports, relations, coverage: active?.coverage ?? [],
    reviewHistory: history, groups, semanticAssessment: 'not-performed',
  }));
}
