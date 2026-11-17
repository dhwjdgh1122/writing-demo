// Offline report checks only. Never calls a model or grades free-text reasons.
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {z} from 'zod';

const verdict=z.enum(['equivalent','different','uncertain']);
const caseSchema=z.object({id:z.string().min(1),sourceText:z.string(),candidateText:z.string(),expected:z.enum(['equivalent','different'])});
const assessment=z.object({verdict,reason:z.string().min(1).max(250)});
const rowSchema=z.object({caseId:z.string(),input:z.object({sourceText:z.string(),candidateText:z.string()}),modelCalls:z.number().int().min(0).max(1),upstreamStatus:z.number().int().optional(),assessment:assessment.optional(),captureFailure:z.string().optional(),adapterError:z.string().optional()});
const reportSchema=z.object({diagnosticOnly:z.literal(true),cases:z.array(caseSchema),runs:z.array(rowSchema),modelCalls:z.number().int().nonnegative(),unexecuted:z.array(z.string())});

export function summarizeEquivalence(input, referenceCases) {
 const cases=z.array(caseSchema).min(1).parse(referenceCases),report=reportSchema.parse(input);
 assert.equal(new Set(cases.map(c=>c.id)).size,cases.length,'Duplicate reference IDs');
 assert.deepEqual(report.cases,cases,'Report fixture differs from reference cases');
 assert.equal(new Set(report.runs.map(r=>r.caseId)).size,report.runs.length,'Duplicate run IDs');
 assert.equal(report.modelCalls,report.runs.reduce((n,r)=>n+r.modelCalls,0),'Call count mismatch');
 const rows=new Map(report.runs.map(r=>[r.caseId,r]));
 for(const row of report.runs){
  const c=cases.find(c=>c.id===row.caseId);assert(c,'Unknown case ID');
  assert.deepEqual(row.input,{sourceText:c.sourceText,candidateText:c.candidateText},'Recorded input differs from fixture');
 }
 assert.deepEqual([...report.unexecuted].sort(),cases.filter(c=>!rows.has(c.id)).map(c=>c.id).sort(),'Unexecuted cases mismatch');
 const results=cases.map(c=>{
  const row=rows.get(c.id);
  const status=!row?'unexecuted':row.upstreamStatus!==200||!row.assessment||row.captureFailure||(row.adapterError&&row.adapterError!=='invalid')?'unavailable':row.assessment.verdict==='uncertain'?'uncertain':row.assessment.verdict===c.expected?'match':'mismatch';
  return {caseId:c.id,status,...(row?.assessment?{verdict:row.assessment.verdict}: {})};
 });
 const pairs=[];
 for(let i=0;i<cases.length;i++)for(let j=i+1;j<cases.length;j++){
  const a=cases[i],b=cases[j];
  if(a.sourceText===a.candidateText||a.sourceText!==b.candidateText||a.candidateText!==b.sourceText)continue;
  const x=results[i],y=results[j];
  const unavailable=[x,y].some(r=>['unavailable','unexecuted'].includes(r.status));
  pairs.push({caseIds:[a.id,b.id],status:unavailable?'unavailable':[x,y].some(r=>r.verdict==='uncertain')?'uncertain':x.verdict===y.verdict?'consistent':'inconsistent'});
 }
 return {totalCases:cases.length,modelCalls:report.modelCalls,counts:Object.fromEntries(['match','mismatch','uncertain','unavailable','unexecuted'].map(k=>[k,results.filter(r=>r.status===k).length])),results,reversePairs:pairs,reasonQualityAssessed:false,mergeGateResult:false};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const args=process.argv.slice(2);
 if(args.length!==1||args[0].startsWith('--'))throw Error('Use node scripts/summarize-explanation-equivalence.mjs report.json');
 const fixture=JSON.parse(readFileSync('tests/fixtures/explanation-equivalence-cases.json','utf8'));
 console.log(JSON.stringify(summarizeEquivalence(JSON.parse(readFileSync(args[0],'utf8')),fixture),null,2));
}
