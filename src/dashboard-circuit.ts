/** The circuit is one persistent DOM. Values change in place, so a live update never moves the layout; one recorded Jev response is one round trip on the rail. */
export const CIRCUIT_CSS = `
.circuit{position:relative;padding:14px 16px 16px}.grp{height:18px;line-height:18px;font-size:12px;color:var(--faint);margin:2px 0 8px}.cells8{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}
.node{position:relative;z-index:1;border:1px solid var(--line);border-radius:8px;padding:11px 12px 0;background:var(--bg);display:flex;flex-direction:column;gap:4px;height:132px;min-width:0;overflow:hidden;text-align:left;font:inherit;color:inherit;cursor:pointer;appearance:none;transition:background .5s,border-color .2s}
.node:hover{border-color:color-mix(in srgb,var(--accent) 45%,var(--line))}.node.sel{border-color:var(--accent)}.node.zap{background:color-mix(in srgb,var(--accent) 16%,var(--bg));transition:none}
.node .t{height:18px;font-size:13px;font-weight:600;display:flex;align-items:center;gap:6px;white-space:nowrap}.node .t i{width:6px;height:6px;border-radius:50%;background:var(--faint);flex:none}.node.live .t i{background:var(--accent)}.node.err .t i{background:var(--err)}
.node .d{height:16px;line-height:16px;font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.node .d b{font-weight:500;color:var(--ink);font-variant-numeric:tabular-nums;transition:color .8s}.node.idle .d b{color:var(--faint)}.node .dec.flash b{color:var(--accent);transition:none}
.node .dec b span{display:inline-block;margin-right:.45em}.node .dec b span:last-child{margin-right:0}/* A value followed by its confidence or effort keeps a fixed width, so the second part never moves. */
.node .dec .s0:not(:last-child){width:4.7em;overflow:hidden;text-overflow:ellipsis;vertical-align:top}.node[data-feature=router] .dec .s0:not(:last-child){width:3.4em}.node[data-feature=router] .dec .s1{min-width:3.9em}
/* A narrow card drops the question label before the value rather than wrapping, so every card keeps its height. */
.node{container-type:inline-size}@container (max-width:180px){.node .dec .dl{display:none}}
/* One fixed line each for the recorded reason and the decision's probability, empty but present when unrecorded. */
.node .nt{height:15px;line-height:15px;font-size:11px;color:var(--faint);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.node .pb{display:block;flex:none;height:2px;background:var(--line);border-radius:1px}.node .pb i{display:block;height:100%;background:var(--accent);border-radius:1px;transition:width .12s ease-out}
.node .foot{margin-top:auto;height:14px;display:flex;align-items:center;gap:6px;font-size:11px;color:var(--faint)}.node .ago{margin-left:auto;width:64px;overflow:hidden;text-overflow:ellipsis;text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.strip{position:relative;display:block;height:14px;margin:2px -12px 0;border-top:1px solid var(--line);overflow:hidden}.strip .tr{position:absolute;inset:0}
.strip i{position:absolute;bottom:3px;width:1.5px;height:7px;background:var(--accent);border-radius:1px;animation:slide 60s linear forwards}.node.idle .strip i{background:var(--faint)}
@keyframes slide{from{left:100%}to{left:0}}@keyframes grid{to{background-position:-22px 100%}}@keyframes tw{0%,100%{opacity:1}50%{opacity:.25}}
.rail{position:relative;z-index:1;height:24px;margin:14px 0}.rail .ln{position:absolute;left:0;right:0;top:12px;height:1px;background:var(--spark)}
.jb{position:absolute;z-index:1;left:0;top:0;width:92px;height:24px;display:flex;align-items:center;gap:6px;padding:0 8px;border:1px solid var(--spark);border-radius:6px;background:var(--paper);font-size:12px;font-weight:600;white-space:nowrap;transition:border-color .15s}.jb i{width:6px;height:6px;border-radius:50%;background:var(--faint);flex:none;transition:background .15s}.jb .v{font-weight:400;color:var(--faint);font-variant-numeric:tabular-nums}.rail.wait .jb{border-color:var(--accent)}.rail.wait .jb i{background:var(--accent)}
.rail .ln b{position:absolute;top:-4px;width:8px;height:8px;margin-left:-4px;border-radius:50%;background:var(--accent);animation:ping .6s ease-out forwards}
@keyframes ping{from{box-shadow:0 0 0 0 color-mix(in srgb,var(--accent) 60%,transparent);opacity:1}to{box-shadow:0 0 0 10px transparent;opacity:0}}
svg.wires{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible}svg.wires line{stroke:var(--line);stroke-width:1}
/* Wires carry no record; only a Jev call moves, as a dot. */
svg.wires line{stroke:var(--spark);stroke-dasharray:2 6}
.trip{position:absolute;z-index:2;width:6px;height:6px;margin:-3px 0 0 -3px;border-radius:50%;background:var(--accent);pointer-events:none}.trip:after{content:attr(data-ms);position:absolute;left:3px;bottom:9px;transform:translateX(-50%);font-size:10px;line-height:12px;color:var(--accent);white-space:nowrap;font-variant-numeric:tabular-nums}.trip.end{background:none}
.insp .b{padding:14px 16px;display:flex;flex-direction:column;gap:12px}/* Every inspector line is one fixed line, recorded or not, so a new record never changes its height. */
.insp-tags{display:flex;gap:8px;align-items:center;height:20px}
.kv{display:grid;grid-template-columns:88px minmax(0,1fr);gap:8px 10px;font-size:13px;margin:0}.kv dt{color:var(--faint)}.kv dd{margin:0;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums}.kv dd.w2{height:3em;white-space:normal;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow-wrap:anywhere;word-break:keep-all}
.insp details summary{cursor:pointer;color:var(--muted);font-size:13px}.insp details p{color:var(--faint);font-size:13px;margin:8px 0 0}.link{appearance:none;border:0;background:none;padding:0;max-width:100%;text-align:left;font:inherit;font-size:13px;color:var(--accent);cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
@media(max-width:640px){svg.wires,.trip{display:none}.cells8{grid-template-columns:repeat(2,minmax(0,1fr))}}
`;

/** Embedded in the dashboard's single script, sharing its text-only renderer and recorded state. */
export const CIRCUIT_SCRIPT = `
// The feature filter uses the steps the circuit shows, so a node that is waiting on a response never filters to an empty list.
const circuitStep=s=>!s.lifecycle||s.title==='모델 · 응답 대기'||s.title==='모델 · 요청 실패';
const CIRCUIT=['admission','allocation','planning','workers','guard','router','compact'];
const NODE={admission:[['실행 형태','Execution path'],['형태','Path'],['실행 형태?','Execution path?']],allocation:[['등급 배정','Tier allocation'],['등급','Tier'],['등급?','Tier?']],planning:[['의존성 계획','Dependency plan'],['단계','Steps'],['단계 계획?','Plan steps?']],workers:[['수락 검사','Acceptance check'],['수락','Accept'],['수락?','Accept?']],guard:[['루트 도구 가드','Root tool guard'],['도구','Tool'],['도구 허용?','Allow tool?']],router:[['모델과 effort','Model and effort'],['모델','Model'],['이 턴 모델?','Model for this turn?']],compact:[['요약 대체','Summary replacement'],['유지','Kept'],['이 청크 유지?','Keep these chunks?']]};
// A Jev call is a measured response record; intents, policy follow-ups and host events are not calls.
const isCall=s=>s.lane==='jev'&&s.durationMs!==undefined&&!s.lifecycle;
// Jev traffic is every recorded Jev request and response; only a response is a call.
const isJev=s=>s.lane==='jev'&&!s.lifecycle;
// Jev calls arrive about once a minute in bursts: a 30-second window was empty 76% of the time, 2 minutes 44%.
const ACTIVITY_MS=60000,COMM_MS=120000,MAX_TRIPS=24;
// A held record waits for its arrival to play; it maps to its run so a row knows when it must redraw.
// Step ids repeat across runs in real traces, so a hold is keyed by run and step.
const isHeld=(runId,id)=>held.has(runId+' '+id);
let circuitMode='live',circuitFeature=null,held=new Map(),timers=new Set(),seenRuns=null,seenScope='',frameData=null,frameAt=0,frameGap=1000;
const motion=()=>!paused&&!$('connection').classList.contains('warn')&&!matchMedia('(prefers-reduced-motion: reduce)').matches;
// A node names the model family, as Claude ids reduce to sonnet or opus; the full id stays in the stage detail.
const modelName=v=>{const m=String(v||'').match(/(haiku|sonnet|opus|fable)|^gpt-[0-9.]+-([a-z]+)$/);return m?m[1]||m[2]:String(v||'').replace(/^claude-/,'')};
const fmt=t=>{const s=Math.floor(t/1000);return !Number.isFinite(t)?'–':s<2?label('방금','now'):s<60?label(s+'초 전',s+'s ago'):s<3600?label(Math.floor(s/60)+'분 전',Math.floor(s/60)+'m ago'):label(Math.floor(s/3600)+'시간 전',Math.floor(s/3600)+'h ago')};
const pct=v=>Math.round(v*100)+'%';

// #232: a worker result names its contract verdict; only an accept receipt reads as accepted, and a host end is not one.
const OUTCOME={accepted:['계약 수락','Contract accepted'],rejected:['계약 미충족','Contract not met'],unknown:['판정 미확인','Verdict unknown'],host_ended:['호스트 종료','Host ended']};
function decisionText(s){if(!s)return '–';if(s.outcome)return label(...OUTCOME[s.outcome]);const c=s.receipt?.choice;
  if(s.feature==='router'){const m=c||(s.model?[s.model.observed||s.model.selected,s.model.observedEffort||s.model.selectedEffort].filter(Boolean).join(' · '):'');return m?m.split(' · ').map((v,i)=>i?v:modelName(v)).join(' · '):tr(state[s.state])}
  const path=s.executionPath||(s.feature==='admission'?c:null);if(path==='direct')return label('직접','Direct');if(path==='orchestrated')return label('위임','Delegate');
  if(s.feature==='planning'&&s.graph?.length)return s.graph.length+label('단계',' steps');
  if(s.feature==='guard')return s.state==='error'?tr(state.error):String(s.summary).includes('거절')?label('거절','Denied'):label('허용','Allowed');
  if(c)return s.feature==='allocation'&&/(haiku|sonnet|opus|fable)/.test(c)?modelName(c):choiceName('',c);return tr(state[s.state])}
// The node and the run list show the decision with its recorded confidence; Router shows model and effort only.
const valueText=s=>{const v=decisionText(s),c=s?.receipt?.confidence;return s&&s.feature!=='router'&&c!=null?v+' '+c.toFixed(2):v};
function setSeg(box,value){const parts=String(value).replace(/ (\\d\\.\\d+)$/,' · $1').split(' · ');while(box.children.length>parts.length)box.lastChild.remove();while(box.children.length<parts.length)box.append(el('span','s'+box.children.length));parts.forEach((p,i)=>{if(box.children[i].textContent!==p)box.children[i].textContent=p})}
// One tick per recorded record inside the window. A tick slides by its own CSS animation from its true age; a frozen view rebuilds ticks at their ages on resume.
function ticks(box,records,windowMs,make){const ref=frozenAt??Date.now(),keep=new Set(),still=!motion();if(!box._ids){box._ids=new Set();box.addEventListener('animationend',e=>{if(e.animationName==='slide')e.target.remove()})}
  for(const s of records){const age=Math.max(0,ref-Date.parse(s.at));if(!(age<windowMs))continue;keep.add(s.id);const left=(100-100*age/windowMs).toFixed(2)+'%';if(box._ids.has(s.id)){if(still){const i=box.querySelector('[data-id="'+s.id+'"]');if(i)i.style.left=left}continue}const i=el('i');i.dataset.id=s.id;make?.(i,s);i.style.left=left;i.style.animationDelay=-(age/1000)+'s'+(make?',0s':'');box.append(i)}
  for(const i of [...box.children])if(!keep.has(i.dataset.id))i.remove();box._ids=keep}
function resetTicks(){for(const box of document.querySelectorAll('.strip .tr,#comm')){box.replaceChildren();if(box._ids)box._ids=new Set()}}
function cancelMotion(){for(const t of timers)clearTimeout(t);timers.clear();held.clear();for(const d of document.querySelectorAll('.trip,.rail .ln b'))d.remove();railWait=0;railMark()}
// The Jev badge marks a response being awaited: a recorded request without its response, or a dot waiting on the rail.
let railWait=0,railPend=0;const railMark=()=>$('pipeline').querySelector('.rail')?.classList.toggle('wait',railWait>0||railPend>0),onRail=d=>{railWait=Math.max(0,railWait+d);railMark()};
const later=(f,ms)=>{const t=setTimeout(()=>{timers.delete(t);f()},ms);timers.add(t)};
// Every record that is new since the last frame lands on its own, lifecycle, policy and host records included. A frame's records
// play back across the frame interval by their recorded times and at least a few frames apart, so a burst is a flow.
// A backlog larger than MAX_TRIPS (a resume after a long pause) shows its older records at once instead of queueing them.
function arrivals(ops){const scope=hostFilter+':'+circuitMode+':'+(circuitMode==='run'?selectedRun:''),now=performance.now(),ref=frozenAt??Date.now(),fresh=[];if(data!==frameData){frameGap=Math.min(2000,Math.max(300,now-frameAt));frameAt=now;frameData=data}
  // A patch keeps every unchanged run object, so only a changed run is searched, and only for step ids it did not have.
  if(seenRuns&&scope===seenScope&&motion())for(const r of ops.runs){const old=seenRuns.get(r.id);if(old===r)continue;const had=old&&new Set(old.steps.map(s=>s.id));for(const s of r.steps)if(CIRCUIT.includes(s.feature)&&(had?!had.has(s.id):ref-Date.parse(s.at)<ACTIVITY_MS))fresh.push({...s,runId:r.id,runTitle:r.title,host:r.host})}
  seenRuns=new Map(ops.runs.map(r=>[r.id,r]));if(scope!==seenScope)cancelMotion();seenScope=scope;
  fresh.sort((a,b)=>a.at.localeCompare(b.at)).splice(0,Math.max(0,fresh.length-MAX_TRIPS));const t0=Date.parse(fresh[0]?.at),span=Date.parse(fresh.at(-1)?.at)-t0,gap=Math.min(80,frameGap*.85/fresh.length);let at=-Infinity;
  fresh.forEach((s,i)=>{at=Math.max(span>0?(Date.parse(s.at)-t0)/span*frameGap*.85:i*frameGap/fresh.length,at+gap);held.set(s.runId+' '+s.id,s.runId);later(()=>launch(s),at)})}
function arrive(s){held.delete(s.runId+' '+s.id);if(data&&motion())land(s)}
function launch(s){const C=$('pipeline'),b=C.querySelector('[data-feature="'+s.feature+'"]'),ln=C.querySelector('.ln');if(!isCall(s)||!b||!ln||!motion()||(circuitMode==='run'&&s.runId!==selectedRun)){arrive(s);return}
  const c=C.getBoundingClientRect(),l=ln.getBoundingClientRect(),n=b.getBoundingClientRect(),x=n.left+n.width/2-c.left,y=l.top+1-c.top,ny=n.top<l.top?n.bottom-c.top:n.top-c.top;
  // The returning dot carries its response time and leaves it in view a moment after it lands.
  // A dot moves by transform only and stays where it landed, so it never takes part in layout.
  const dot=(y0,y1,done,lab)=>{const d=el('i','trip');if(lab)d.dataset.ms=lab;d.style.left=x+'px';d.style.top=y0+'px';C.append(d);const end=()=>{if(!lab)d.remove();else{d.classList.add('end');later(()=>d.remove(),700)}};if(!d.animate||matchMedia('(max-width:640px)').matches){later(()=>{end();done()},120);return}d.animate([{transform:'none'},{transform:'translateY('+(y1-y0)+'px)'}],{duration:120,easing:'ease-out',fill:'forwards'}).onfinish=()=>{end();if(motion())done();else arrive(s)}};
  dot(ny,y,()=>{const p=el('b');p.style.left=(x-(l.left-c.left))+'px';ln.append(p);p.addEventListener('animationend',()=>p.remove());onRail(1);later(()=>{onRail(-1);dot(y,ny,()=>arrive(s),ms(s.durationMs))},Math.max(30,s.durationMs/5))})}
function wires(){const C=$('pipeline'),svgEl=C.querySelector('svg.wires'),ln=C.querySelector('.ln');if(!svgEl||!ln)return;const c=C.getBoundingClientRect(),l=ln.getBoundingClientRect(),y=l.top+1-c.top;svgEl.replaceChildren();
  for(const n of C.querySelectorAll('.node')){const b=n.getBoundingClientRect(),x=b.left+b.width/2-c.left;svgEl.append(svg('line',{x1:x,x2:x,y1:b.top<l.top?b.bottom-c.top:b.top-c.top,y2:y}))}}
function buildCircuit(root){const wire=svg('svg',{class:'wires','aria-hidden':'true'}),node=id=>{const b=el('button','node idle');b.type='button';b.dataset.feature=id;b.setAttribute('aria-controls','circuit-inspector');const t=el('span','t');const dot=el('i');dot.setAttribute('aria-hidden','true');t.append(dot,el('span','nm',featureInfo[id][0]));const dec=el('span','d dec'),v=el('b');setSeg(v,'–');dec.append(el('span','dl',label(...NODE[id][1])),document.createTextNode(' '),v);const foot=el('span','foot');foot.append(el('span','ago'));const strip=el('span','strip');strip.setAttribute('aria-hidden','true');strip.append(el('span','tr'));const pb=el('span','pb');pb.setAttribute('aria-hidden','true');pb.append(el('i'));b.append(t,el('span','d ds',label(...NODE[id][0])),dec,el('span','nt'),pb,foot,strip);return b};
  const cells=ids=>{const g=el('div','cells8');for(const id of ids)g.append(node(id));return g};const rail=el('div','rail'),ln=el('div','ln'),jb=el('span','jb');ln.setAttribute('aria-hidden','true');jb.setAttribute('aria-hidden','true');jb.append(el('i'),'Jev',el('span','v'));rail.append(ln,jb);
  root.append(wire,el('div','grp gate-grp',label('Gate 단계','Gate stages')),cells(CIRCUIT.slice(0,4)),rail,el('div','grp mod-grp',label('독립 기능','Independent features')),cells(CIRCUIT.slice(4)));if(typeof ResizeObserver!=='undefined')new ResizeObserver(()=>requestAnimationFrame(wires)).observe(root)}
// Recorded steps of the last window that have landed; a lifecycle record moves a strip even though it is no decision.
const recent=(ops,win,ok)=>{const ref=frozenAt??Date.now(),out=[];for(const r of ops.runs)if(ref-Date.parse(r.lastAt)<win)for(const s of r.steps)if(ok(s,r)&&!isHeld(r.id,s.id)&&ref-Date.parse(s.at)<win)out.push(s);return out};
const strip=(ops,id)=>ticks($('pipeline').querySelector('[data-feature="'+id+'"] .strip .tr'),recent(ops,ACTIVITY_MS,(s,r)=>s.feature===id&&(circuitMode==='live'||r.id===selectedRun)),ACTIVITY_MS);
function paint(b,last,f,ref,run){const age=last?ref-Date.parse(last.at):Infinity,x=last&&run?loaded(run.id,last):last,c=x?.receipt?.confidence;b._last=last;setSeg(b.querySelector('.dec b'),last?valueText(last):'–');
  put(b.querySelector('.nt'),x?note(x,run):'');b.querySelector('.pb i').style.width=c==null?'0%':pct(c);
  const ago=b.querySelector('.ago');ago.dataset.at=last?.at||'';ago.dataset.none=last?'':f?.state==='unsupported'?label('미지원','Unsupported'):f?.state==='unavailable'?label('기록원 없음','No source'):'–';
  b.classList.toggle('live',age<ACTIVITY_MS);b.classList.toggle('idle',!(age<ACTIVITY_MS));b.classList.toggle('err',last?.state==='error'||last?.model?.status==='mismatch')}
function pipeline(ops,calls,pend){const root=$('pipeline');if(!root.querySelector('.node'))buildCircuit(root);
  root.querySelector('.gate-grp').textContent=label('Gate 단계','Gate stages');root.querySelector('.mod-grp').textContent=label('독립 기능','Independent features');
  for(const b of $('circuit-mode').querySelectorAll('button'))b.setAttribute('aria-pressed',String(b.dataset.circuitMode===circuitMode));
  const ref=frozenAt??Date.now(),last={},runOf={};for(const r of ops.runs)if(circuitMode==='live'||r.id===selectedRun)for(const s of r.steps)if(!s.lifecycle&&NODE[s.feature]&&!isHeld(r.id,s.id)&&!(last[s.feature]?.at>=s.at)){last[s.feature]=s;runOf[s.feature]=r}
  if(!circuitFeature)circuitFeature=CIRCUIT.reduce((a,id)=>last[id]&&!(last[a]?.at>=last[id].at)?id:a,null)||'admission';
  for(const id of CIRCUIT){const b=root.querySelector('[data-feature="'+id+'"]');
    b.querySelector('.nm').textContent=tr(featureInfo[id][0]);b.querySelector('.ds').textContent=label(...NODE[id][0]);b.querySelector('.dl').textContent=label(...NODE[id][1]);paint(b,last[id],ops.features.find(f=>f.id===id),ref,runOf[id]);
    b.classList.toggle('sel',circuitFeature===id);b.setAttribute('aria-pressed',String(circuitFeature===id));strip(ops,id)}
  // The badge names the Jev version the latest response recorded; with no recorded version it reads Jev alone.
  const mine=s=>circuitMode==='live'||s.runId===selectedRun,v=calls.find(s=>mine(s)&&s.receipt?.model)?.receipt.model.match(/^jev-([0-9]+\\.[0-9]+)/);put(root.querySelector('.jb .v'),v?v[1]:'');railPend=pend.filter(mine).length;railMark();
  circuitInspector(ops,last[circuitFeature])}
// A landed record flashes its node and strip; it becomes the node's value only when it is a decision newer than the shown one.
function landNode(ops,s){const b=$('pipeline').querySelector('[data-feature="'+s.feature+'"]');if(!b||circuitMode==='run'&&s.runId!==selectedRun)return;
  if(!s.lifecycle&&!(b._last?.at>s.at)){paint(b,s,ops.features.find(f=>f.id===s.feature),frozenAt??Date.now(),ops.runs.find(r=>r.id===s.runId));if(circuitFeature===s.feature)circuitInspector(ops,s)}strip(ops,s.feature);
  const d=b.querySelector('.dec');b.classList.add('zap');d.classList.add('flash');setTimeout(()=>b.classList.remove('zap'),160);requestAnimationFrame(()=>requestAnimationFrame(()=>d.classList.remove('flash')))}
// The inspector says in full what the card can only begin: why the decision was made, its effect, what followed in its run and,
// for a failure, its cause and current impact. A part the card already shows as the decision is left out.
const drop=(s,v)=>{const d=decisionText(s);return String(v||'').split(' · ').filter(p=>p&&p!==d).join(' · ')};
function reasonOf(s,r){const g=s.routing;if(g){const from=g.baseline&&modelName(g.baseline);return [from&&s.receipt?.choice&&!decisionText(s).startsWith(from)&&label(from+'에서 변경','Changed from '+from),why(g)].filter(Boolean).join(' · ')}return drop(s,tr((policyOf(s,r)||s).summary||''))}
function effectOf(s,reason){const m=s.model;if(m&&!reason.includes('일치')&&!/match/i.test(reason))return m.status==='confirmed'?label('선택과 실제 응답 일치','Selection matches the response'):m.status==='mismatch'?label('실제 응답 ','Responded with ')+m.observed:s.state==='active'?label('응답 대기','Awaiting response'):label('실제 응답 미관측','Response unobserved');
  if(s.graph?.length)return s.graph.length+label('개 작업 · 필수 검사 ',' tasks · required checks ')+s.graph.reduce((a,t)=>a+t.checks,0);return ''}
// The next record of the same run, its decision recorded with it aside.
const nextOf=(s,r)=>{if(!r)return null;const p=policyOf(s,r);return r.steps.slice(r.steps.indexOf(s)+1).find(x=>x!==p&&!x.lifecycle&&!isHeld(r.id,x.id))||null};
// The inspector is rebuilt only when its stage, its record, its fetched detail or the language changes, so an open help panel stays put.
function circuitInspector(ops,last){const root=$('circuit-inspector'),id=circuitFeature||'admission',run=last?ops.runs.find(r=>last.runId?r.id===last.runId:r.steps.includes(last)):null,step=run?.steps.find(s=>s.id===last.id)||last,x=run?detailed(run,step):step,key=[id,last,lang,x];if(root._key?.every((v,k)=>v===key[k]))return;root._key=key;
  const guide=GUIDE[id],i=lang==='en'?1:0,open=root.querySelector('details')?.open;root.replaceChildren();
  const head=el('div','ch');head.append(el('h2','',tr(featureInfo[id][0])),el('span','hint',label('단계 상세','Stage details')));const body=el('div','b');
  const tags=el('div','insp-tags');if(run?.host)tags.append(el('span','tag '+(run.host==='codex'?'cx':'cl'),run.host==='codex'?'Codex':'Claude'));body.append(tags);
  const kv=el('dl','kv');const row=(k,v,cls)=>{const d=el('dd',cls||'',v);kv.append(el('dt','',k),d);return d};
  // The selected card shows the decision, its reason line, its confidence and age, and the decision basis panel holds the probability and
  // threshold; the inspector adds what neither shows. #261: those facts come from the stage's newest Jev call, which a host
  // or local record may follow (a Router root_result, a Compact pass). Every line is drawn, recorded or not.
  let call=null;if(ops)for(const r of ops.runs)if(circuitMode==='live'||r.id===selectedRun)for(const s of r.steps)if(s.lane==='jev'&&s.feature===id&&!s.lifecycle&&!isHeld(r.id,s.id)&&!(call?.at>=s.at))call=s;
  const rc=call?.receipt,none='–',why=x?reasonOf(x,run):'',card=x?note(x,run).split(' · '):[],reason=why.split(' · ').filter(p=>p&&!card.includes(p)).join(' · ');
  row(label('실행','Run'),run?[tr(run.title),tr(state[run.state]),time(run.firstAt)].join(' · '):none);
  row(label('이유','Reason'),reason||none,'w2').title=reason;row(label('결과','Effect'),x&&effectOf(x,why)||none);
  const after=x&&nextOf(step,run);row(label('다음 단계','Next stage'),after?tr(after.title)+' · '+decisionText(after):none);
  row(label('원인','Cause'),x&&failedStep(x)?[x.cause||label(...ISSUES[issueKind(x)]),label(...IMPACT[x.impact?.now||'unknown'])].join(' · '):none);
  row(label('Jev 응답','Jev response'),call?.durationMs!==undefined?ms(call.durationMs):none);
  row(label('토큰','Tokens'),rc&&(rc.input!=null||rc.output!=null)?kTokens(rc.input)+' → '+kTokens(rc.output):none);
  row(label('추정 비용','Est. cost'),rc?.costUsd!=null?usd(rc.costUsd):none);row(label('Jev 모델','Jev model'),rc?.model||none);body.append(kv);
  const help=el('details');help.append(el('summary','',label('이 단계가 하는 일','How this stage works')),el('p','',guide.what[i]+' '+guide.jev[i]));help.open=!!open;body.append(help);
  const go=el('button','link',last?label('이 실행의 판단 근거와 시간축 보기 ↗','Inspect this execution and its evidence ↗'):label('이 기능의 실행 기록 보기 ↗','Show executions for this feature ↗'));go.type='button';go.dataset.inspectFeature=id;if(run)go.dataset.inspectRun=run.id;if(last)go.dataset.inspectStep=last.id;body.append(go);root.append(head,body)}
window.addEventListener('resize',()=>requestAnimationFrame(wires));
`;
