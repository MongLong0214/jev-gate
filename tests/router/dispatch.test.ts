import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dispatchPolicy } from '../../src/dispatch-policy.js';
import { newGeneration, readJob, reserve, updateJob } from '../../src/job.js';
import { OWNED_AGENTS, type Reservation } from '../../src/types.js';
describe('shared automatic child eligibility and ownership', () => {
  it.each(Object.keys(OWNED_AGENTS))('does not inherit a restricted model in %s',agent=>{
    const dir=mkdtempSync(join(tmpdir(),'jev-dispatch-')); const env={JEV_GATE_STATE_DIR:dir};
    try {
      const profile=OWNED_AGENTS[agent]!;
      updateJob(env,'root',()=>{const state=newGeneration(null,'root','prompt','orchestrated').state;return {...state,current:reserve(state.current,'tool',{role:profile.role,taskId:null,contractHash:null,rev:null,tier:profile.tier,attempt:1,deliverables:[]})};});
      expect(dispatchPolicy('root','tool','fable',false,env,agent)).toMatchObject({deny:expect.stringContaining('main session')});
      const job=readJob(env,'root'); expect(job.ok&&job.value?.current).toMatchObject({active:{},root_fallback:true});
      expect(dispatchPolicy('root','tool','fable',true,env,agent)).toMatchObject({model:'claude-fable-5-1'});
    } finally {rmSync(dir,{recursive:true,force:true});}
  });
  it.each(['codex','background','launch-pending'] as const)('preserves %s reservations without a confirmed unstarted boundary',kind=>{
    const dir=mkdtempSync(join(tmpdir(),'jev-dispatch-protected-')); const env={JEV_GATE_STATE_DIR:dir};
    try {
      updateJob(env,'root',()=>{const state=newGeneration(null,'root','prompt','orchestrated').state;
        const extra: Partial<Reservation> = kind==='codex'?{codex_execution:{thread_id:'worker',turn_id:null,cwd:dir,root_cwd:dir}}:{background_execution:{token:'owner',agent_id:kind==='background'?'native':null,subagent_type:'jev-gate:worker',resolved_model:null}};
        const current=reserve(state.current,'tool',{role:'worker',taskId:null,contractHash:null,rev:null,tier:'standard',attempt:1,deliverables:['src/x.ts']});
        return {...state,current:{...current,active:{tool:{...current.active.tool!,...extra}}}};
      });
      expect(dispatchPolicy('root','tool','fable',false,env,'jev-gate:worker')).toMatchObject({deny:expect.stringContaining('protected')});
      const job=readJob(env,'root'); expect(job.ok&&job.value?.current.active.tool).toBeTruthy();
    } finally {rmSync(dir,{recursive:true,force:true});}
  });
});
