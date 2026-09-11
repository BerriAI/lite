import { readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { correctAnswer, expectedAnswers } from './scoring.js';

const files=process.argv.slice(2);
if(!files.length)throw new Error('Supply native-eval JSON result files to summarize.');
const experiments=[];
for(const file of files){
  const raw=JSON.parse(await readFile(file,'utf8'));
  experiments.push({name:basename(file,'.json'),models:raw.models,results:raw.results.map((record:any)=>{
    const name=record.label.split('/')[1];
    const {breakdown,...total}=record.usage??{breakdown:[]};
    return {...record,passed:expectedAnswers[name]?correctAnswer(name,record.final??''):record.passed,validation:expectedAnswers[name]?'exact JSON key/value comparison':'node check.mjs: assert.deepEqual on generated file',usage:{...total,requestsByRole:breakdown.reduce((roles:Record<string,number>,row:any)=>({...roles,[row.role]:(roles[row.role]??0)+1}),{}),cachedTokens:breakdown.reduce((sum:number,row:any)=>sum+(row.usage?.cachedTokens??0),0)}};
  })});
}
await writeFile(join(import.meta.dirname,'results','native-results.json'),JSON.stringify({experiments},null,2)+'\n');
for(const experiment of experiments){
  for(const state of ['off','on']){
    const rows=experiment.results.filter((r:any)=>r.label.endsWith('/'+state));
    const sum=(field:string)=>rows.reduce((sum:number,r:any)=>sum+(r[field]??r.usage?.[field]??0),0);
    console.log(JSON.stringify({experiment:experiment.name,state,runs:rows.length,passed:rows.filter((r:any)=>r.passed).length,callerInput:sum('callerInputTokens'),totalInput:sum('inputTokens'),output:sum('outputTokens'),requests:sum('requests'),seconds:Math.round(sum('durationMs')/1000)}));
  }
}
