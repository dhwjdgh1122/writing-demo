// Offline saved-result audit. No provider imports, .env reads, network or auto retries.
import {readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {auditSpacingClaim} from './lib/explanation-spacing-audit.mjs';

const args=process.argv.slice(2);
if(args.length>1 || (args.length===1 && args[0]!=='--save')) throw new Error('Usage: node scripts/audit-explanation-spacing.mjs [--save]');
const hash=data=>createHash('sha256').update(data).digest('hex');
const paths=readdirSync('docs/evaluations').filter(name=>/^(partial-(?:gemini|elice)|quality-baseline-|contrast-examples-|thinking-(?:low|high)-|impact-fields-).+\.json$/.test(name)).sort();
const report={createdAt:new Date().toISOString(),codeCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  workingTreeStatus:execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim(),
  detectorSha256:hash(readFileSync('scripts/lib/explanation-spacing-audit.mjs')),
  runnerSha256:hash(readFileSync('scripts/audit-explanation-spacing.mjs')),
  scope:'Saved displayed explanations only; offline review suggestions, NOT product blocking or semantic quality verdicts.',
  sources:[],entries:[],excluded:{withheld:0,requestFailedCandidates:0,unexecutedCandidates:0}};
for(const name of paths){
  const path='docs/evaluations/'+name,content=readFileSync(path),saved=JSON.parse(content);
  report.sources.push({path,sha256:hash(content),provider:saved.provider,model:saved.model,experiment:saved.experiment});
  for(const c of saved.cases){
    const runs=saved.runs.filter(r=>r.caseId===c.id);
    if(runs.length>1)throw new Error('Ambiguous stored run association: '+path+'/'+c.id);
    const run=runs[0];
    if(!run){report.excluded.unexecutedCandidates+=c.candidates.length;continue;}
    if(run.status!==200){report.excluded.requestFailedCandidates+=c.candidates.length;continue;}
    const outputs=run.response?.explanations;
    if(!Array.isArray(outputs) || outputs.length!==c.candidates.length || new Set(outputs.map(e=>e.candidateId)).size!==outputs.length
      || outputs.some(e=>!c.candidates.some(candidate=>candidate.id===e.candidateId)))throw new Error('Ambiguous stored candidate association: '+path+'/'+c.id);
    for(const candidate of c.candidates){
      const output=outputs.find(e=>e.candidateId===candidate.id);
      if('error' in output){report.excluded.withheld++;continue;}
      report.entries.push({path,caseId:c.id,candidateId:candidate.id,sourceText:c.sourceText,candidateText:candidate.text,
        explanation:output.explanation,...auditSpacingClaim(c.sourceText,candidate.text,output.explanation)});
    }
  }
}
report.counts=Object.fromEntries(['review-needed','not-covered','abstained'].map(verdict=>[verdict,report.entries.filter(e=>e.verdict===verdict).length]));
const output=args.includes('--save')?'docs/evaluations/spacing-audit-'+report.createdAt.replace(/[:.]/g,'-')+'.json':null;
if(output)writeFileSync(output,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({output,sourceReports:paths.length,displayedExplanations:report.entries.length,counts:report.counts,excluded:report.excluded,
  findings:report.entries.filter(e=>e.verdict==='review-needed')}));
