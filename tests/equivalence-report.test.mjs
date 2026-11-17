import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {summarizeEquivalence} from '../scripts/summarize-explanation-equivalence.mjs';
const cases=JSON.parse(readFileSync(new URL('./fixtures/explanation-equivalence-cases.json',import.meta.url),'utf8'));
function report(){return {diagnosticOnly:true,cases:structuredClone(cases),modelCalls:6,unexecuted:[],runs:cases.map(c=>({caseId:c.id,input:{sourceText:c.sourceText,candidateText:c.candidateText},modelCalls:1,upstreamStatus:200,assessment:{verdict:c.expected,reason:'단위 테스트용 판정'},adapterError:'invalid'}))};}

test('equivalence report counts expected diagnostic adapter errors separately from provider failures',()=>{
 const summary=summarizeEquivalence(report(),cases);
 assert.deepEqual(summary.counts,{match:6,mismatch:0,uncertain:0,unavailable:0,unexecuted:0});
 assert.equal(summary.reversePairs.length,2);
 assert(summary.reversePairs.every(p=>p.status==='consistent'));
 assert.equal(summary.reasonQualityAssessed,false);assert.equal(summary.mergeGateResult,false);
});
test('reverse disagreement is exposed and consistency does not erase two wrong verdicts',()=>{
 const r=report();r.runs[3].assessment.verdict='equivalent';
 let summary=summarizeEquivalence(r,cases);
 assert.equal(summary.counts.mismatch,1);assert.equal(summary.reversePairs[1].status,'inconsistent');
 r.runs[2].assessment.verdict='equivalent';summary=summarizeEquivalence(r,cases);
 assert.equal(summary.counts.mismatch,2);assert.equal(summary.reversePairs[1].status,'consistent');
});
test('unexecuted, unavailable, uncertain and capture failures stay in the denominator',()=>{
 const r=report();r.runs.pop();r.modelCalls=5;r.unexecuted=['EQ-06'];
 r.runs[0].adapterError='unavailable';r.runs[0].upstreamStatus=503;
 r.runs[1].assessment.verdict='uncertain';r.runs[2].captureFailure='diagnostic-schema';
 const summary=summarizeEquivalence(r,cases);
 assert.deepEqual(summary.counts,{match:2,mismatch:0,uncertain:1,unavailable:2,unexecuted:1});
 assert.equal(summary.totalCases,6);assert(summary.reversePairs.every(p=>p.status==='unavailable'));
});
test('modified expectations, duplicate rows and mismatched inputs cannot produce a valid summary',()=>{
 let r=report();r.cases[0].expected='different';assert.throws(()=>summarizeEquivalence(r,cases),/fixture differs/);
 r=report();r.runs.push(r.runs[0]);r.modelCalls++;assert.throws(()=>summarizeEquivalence(r,cases),/Duplicate run/);
 r=report();r.runs[0].input.candidateText='다른 문장';assert.throws(()=>summarizeEquivalence(r,cases),/input differs/);
 r=report();r.unexecuted=['EQ-01'];assert.throws(()=>summarizeEquivalence(r,cases),/Unexecuted cases/);
});
