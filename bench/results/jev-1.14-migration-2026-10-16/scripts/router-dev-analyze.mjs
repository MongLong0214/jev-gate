import {readFileSync,existsSync} from 'node:fs';
const E=['low','medium','high','xhigh','max'], O=['mechanical','routine','complex','open_problem'];
const [tag,split,reps,arm='capable_first',rule='ordered']=process.argv.slice(2);
const tot={n:0,exact:0,under:0,over:0,effExact:0,effOk:0,effUnder:0,effOver:0,complexExact:0,complexEffUnder:0,fail:0}; const miss={};
for(let r=1;r<=+reps;r++){ const f=`${tag}-${split}-r${r}.jsonl`; if(!existsSync(f)) continue;
  const recs=readFileSync(f,'utf8').split('\n').filter(Boolean).map(JSON.parse).filter(x=>!x.pair_of);
  for(const x of recs){const a=x.arms[arm]; if(!a?.ok){tot.fail++;continue}; const o=a[rule]; const lr=O.indexOf(x.label); tot.n++;
    if(o.rank===lr){tot.exact++; tot.effExact++; const e=E.indexOf(o.effort),lo=E.indexOf(x.effort_range[0]),hi=E.indexOf(x.effort_range[1]);
      if(e>=lo&&e<=hi)tot.effOk++; else if(e<lo){tot.effUnder++; if(x.label==='complex')tot.complexEffUnder++; (miss[x.id]??=[]).push(o.effort);} else {tot.effOver++;(miss[x.id]??=[]).push(o.effort);} if(x.label==='complex')tot.complexExact++;}
    else if(o.rank<lr)tot.under++; else tot.over++;}}
const p=(k)=>(100*k/tot.n).toFixed(1);
console.log(tag,split,arm,rule,`reps=${reps} n=${tot.n} fail=${tot.fail} exact=${p(tot.exact)}% under=${p(tot.under)}% over=${p(tot.over)}% | effort in range ${(100*tot.effOk/tot.effExact).toFixed(1)}% of exact; effort UNDER ${tot.effUnder} (complex ${tot.complexEffUnder}/${tot.complexExact} exact complex = ${(100*tot.complexEffUnder/Math.max(1,tot.complexExact)).toFixed(1)}%), OVER ${tot.effOver}`);
console.log('  misses',JSON.stringify(miss));
