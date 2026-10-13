/** The circuit is one persistent DOM. Values change in place, so a live update never moves the layout; one recorded Jev response is one round trip on the rail. */
export const CIRCUIT_CSS = `
.circuit{position:relative;padding:14px 16px 16px}.grp{font-size:12px;color:var(--faint);margin:2px 0 8px}.cells8{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}
.node{position:relative;z-index:1;border:1px solid var(--line);border-radius:8px;padding:11px 12px 0;background:var(--bg);display:flex;flex-direction:column;gap:4px;min-height:132px;min-width:0;overflow:hidden;text-align:left;font:inherit;color:inherit;cursor:pointer;appearance:none;transition:background .5s,border-color .2s}
.node:hover{border-color:color-mix(in srgb,var(--accent) 45%,var(--line))}.node.sel{border-color:var(--accent)}.node.zap{background:color-mix(in srgb,var(--accent) 16%,var(--bg));transition:none}
.node .t{font-size:13px;font-weight:600;display:flex;align-items:center;gap:6px;white-space:nowrap}.node .t i{width:6px;height:6px;border-radius:50%;background:var(--faint);flex:none}.node.live .t i{background:var(--accent)}.node.err .t i{background:var(--err)}
.node .d{font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.node .d b{font-weight:500;color:var(--ink);font-variant-numeric:tabular-nums;transition:color .8s}.node.idle .d b{color:var(--faint)}.node .dec.flash b{color:var(--accent);transition:none}
.node .dec b span{display:inline-block;margin-right:.45em}.node .dec b span:last-child{margin-right:0}.node[data-feature=router] .dec .s0{min-width:3.3em}.node[data-feature=router] .dec .s1{min-width:3.9em}
.node{container-type:inline-size}@container (max-width:150px){.node .dec b{display:block}}
.node .foot{margin-top:auto;display:flex;align-items:center;gap:6px;font-size:11px;color:var(--faint)}.node .ago{margin-left:auto;min-width:44px;text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.strip{position:relative;display:block;height:14px;margin:6px -12px 0;border-top:1px solid var(--line);overflow:hidden}.strip .tr{position:absolute;inset:0}
.strip i{position:absolute;bottom:3px;width:1.5px;height:7px;background:var(--accent);border-radius:1px;animation:slide 60s linear forwards}.node.idle .strip i{background:var(--faint)}
@keyframes slide{from{left:100%}to{left:0}}@keyframes tw{0%,100%{opacity:1}50%{opacity:.25}}
.rail{position:relative;z-index:1;display:flex;align-items:center;gap:10px;margin:14px 0}.rail .nm{font-size:12px;font-weight:600;color:var(--accent)}.rail .ln{flex:1;height:2px;background:linear-gradient(90deg,var(--rail2),var(--rail) 50%,var(--rail2));border-radius:2px;position:relative}
.rail .lat{font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums;min-width:52px;text-align:right}.rail .ln b{position:absolute;top:-3px;width:8px;height:8px;margin-left:-4px;border-radius:50%;background:var(--accent);animation:ping .6s ease-out forwards}
@keyframes ping{from{box-shadow:0 0 0 0 color-mix(in srgb,var(--accent) 60%,transparent);opacity:1}to{box-shadow:0 0 0 10px transparent;opacity:0}}
svg.wires{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible}svg.wires line{stroke:var(--line);stroke-width:1}
.trip{position:absolute;z-index:2;width:6px;height:6px;margin:-3px 0 0 -3px;border-radius:50%;background:var(--accent);pointer-events:none}
.insp .b{padding:14px 16px;display:flex;flex-direction:column;gap:12px}.insp-tags{display:flex;gap:8px;align-items:center}.insp-tags time{margin-left:auto;color:var(--faint)}.insp-desc{font-weight:500}
.kv{display:grid;grid-template-columns:78px minmax(0,1fr);gap:8px 10px;font-size:13px;margin:0}.kv dt{color:var(--faint)}.kv dd{margin:0;min-width:0;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}
.insp details summary{cursor:pointer;color:var(--muted);font-size:13px}.insp details p{color:var(--faint);font-size:13px;margin:8px 0 0}.link{appearance:none;border:0;background:none;padding:0;text-align:left;font:inherit;font-size:13px;color:var(--accent);cursor:pointer}
@media(max-width:640px){svg.wires,.trip{display:none}.cells8{grid-template-columns:repeat(2,minmax(0,1fr))}}
`;

/** Embedded in the dashboard's single script, sharing its text-only renderer and recorded state. */
export const CIRCUIT_SCRIPT = `
// The feature filter uses the steps the circuit shows, so a node that is waiting on a response never filters to an empty list.
const circuitStep=s=>!s.lifecycle||s.title==='모델 · 응답 대기'||s.title==='모델 · 요청 실패';
const CIRCUIT=['admission','allocation','planning','workers','guard','router','compact','evidence'];
const NODE={admission:[['실행 형태','Execution path'],['형태','Path'],['실행 형태?','Execution path?']],allocation:[['등급 배정','Tier allocation'],['등급','Tier'],['등급?','Tier?']],planning:[['의존성 계획','Dependency plan'],['단계','Steps'],['단계 계획?','Plan steps?']],workers:[['수락 검사','Acceptance check'],['수락','Accept'],['수락?','Accept?']],guard:[['루트 도구 가드','Root tool guard'],['도구','Tool'],['도구 허용?','Allow tool?']],router:[['모델과 effort','Model and effort'],['모델','Model'],['이 턴 모델?','Model for this turn?']],compact:[['요약 대체','Summary replacement'],['유지','Kept'],['이 청크 유지?','Keep these chunks?']],evidence:[['근거 판정','Evidence judgment'],['근거','Evidence'],['근거 충분?','Evidence relevant?']]};
// A Jev call is a measured response record; intents, policy follow-ups and host events are not calls.
const isCall=s=>s.lane==='jev'&&s.durationMs!==undefined&&!s.lifecycle;
// Jev traffic is every recorded Jev request and response; only a response is a call.
const isJev=s=>s.lane==='jev'&&!s.lifecycle;
const ACTIVITY_MS=60000,COMM_MS=30000,MAX_TRIPS=24;
// A held record waits for its arrival to play; it maps to its run so a row knows when it must redraw.
let circuitMode='live',circuitFeature=null,held=new Map(),timers=new Set(),seenRuns=null,seenScope='',frameData=null,frameAt=0,frameGap=1000;
const motion=()=>!paused&&!$('connection').classList.contains('warn')&&!matchMedia('(prefers-reduced-motion: reduce)').matches;
// A node names the model family, as Claude ids reduce to sonnet or opus; the full id stays in the stage detail.
const modelName=v=>{const m=String(v||'').match(/(haiku|sonnet|opus|fable)|^gpt-[0-9.]+-([a-z]+)$/);return m?m[1]||m[2]:String(v||'').replace(/^claude-/,'')};
const fmt=t=>{const s=Math.floor(t/1000);return !Number.isFinite(t)?'–':s<2?label('방금','now'):s<60?label(s+'초 전',s+'s ago'):s<3600?label(Math.floor(s/60)+'분 전',Math.floor(s/60)+'m ago'):label(Math.floor(s/3600)+'시간 전',Math.floor(s/3600)+'h ago')};
const pct=v=>Math.round(v*100)+'%';
const confRest=rc=>pct(rc.confidence)+(rc.threshold==null?'':' · '+label('변경 기준 ','change threshold ')+pct(rc.threshold)),confText=rc=>rc?.confidence==null?'–':label('확신 ','Confidence ')+confRest(rc);
function decisionText(s){if(!s)return '–';const c=s.receipt?.choice;
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
function resetTicks(){for(const box of document.querySelectorAll('.strip .tr,#comm,#ct')){box.replaceChildren();if(box._ids)box._ids=new Set()}}
function cancelMotion(){for(const t of timers)clearTimeout(t);timers.clear();held.clear();for(const d of document.querySelectorAll('.trip,.rail .ln b'))d.remove()}
const later=(f,ms)=>{const t=setTimeout(()=>{timers.delete(t);f()},ms);timers.add(t)};
// Every record that is new since the last frame lands on its own, lifecycle, policy and host records included. A frame's records
// play back across the frame interval by their recorded times and at least a few frames apart, so a burst is a flow.
// A backlog larger than MAX_TRIPS (a resume after a long pause) shows its older records at once instead of queueing them.
function arrivals(ops){const scope=hostFilter+':'+circuitMode+':'+(circuitMode==='run'?selectedRun:''),now=performance.now(),ref=frozenAt??Date.now(),fresh=[];if(data!==frameData){frameGap=Math.min(2000,Math.max(300,now-frameAt));frameAt=now;frameData=data}
  // A patch keeps every unchanged run object, so only a changed run is searched, and only for step ids it did not have.
  if(seenRuns&&scope===seenScope&&motion())for(const r of ops.runs){const old=seenRuns.get(r.id);if(old===r)continue;const had=old&&new Set(old.steps.map(s=>s.id));for(const s of r.steps)if(CIRCUIT.includes(s.feature)&&(had?!had.has(s.id):ref-Date.parse(s.at)<ACTIVITY_MS))fresh.push({...s,runId:r.id,runTitle:r.title,host:r.host})}
  seenRuns=new Map(ops.runs.map(r=>[r.id,r]));if(scope!==seenScope)cancelMotion();seenScope=scope;
  fresh.sort((a,b)=>a.at.localeCompare(b.at)).splice(0,Math.max(0,fresh.length-MAX_TRIPS));const t0=Date.parse(fresh[0]?.at),span=Date.parse(fresh.at(-1)?.at)-t0,gap=Math.min(80,frameGap*.85/fresh.length);let at=-Infinity;
  fresh.forEach((s,i)=>{at=Math.max(span>0?(Date.parse(s.at)-t0)/span*frameGap*.85:i*frameGap/fresh.length,at+gap);held.set(s.id,s.runId);later(()=>launch(s),at)})}
function arrive(s){held.delete(s.id);if(data&&motion())land(s)}
function launch(s){const C=$('pipeline'),b=C.querySelector('[data-feature="'+s.feature+'"]'),ln=C.querySelector('.ln');if(!isCall(s)||!b||!ln||!motion()||(circuitMode==='run'&&s.runId!==selectedRun)){arrive(s);return}
  const c=C.getBoundingClientRect(),l=ln.getBoundingClientRect(),n=b.getBoundingClientRect(),x=n.left+n.width/2-c.left,y=l.top+1-c.top,ny=n.top<l.top?n.bottom-c.top:n.top-c.top;
  const dot=(y0,y1,done)=>{const d=el('i','trip');d.style.left=x+'px';d.style.top=y0+'px';C.append(d);if(!d.animate||matchMedia('(max-width:640px)').matches){later(()=>{d.remove();done()},120);return}d.animate([{top:y0+'px'},{top:y1+'px'}],{duration:120,easing:'ease-out'}).onfinish=()=>{d.remove();if(motion())done();else arrive(s)}};
  dot(ny,y,()=>{const p=el('b');p.style.left=(x-(l.left-c.left))+'px';ln.append(p);p.addEventListener('animationend',()=>p.remove());C.querySelector('.lat').textContent=ms(s.durationMs);later(()=>dot(y,ny,()=>arrive(s)),Math.max(30,s.durationMs/5))})}
function wires(){const C=$('pipeline'),svgEl=C.querySelector('svg.wires'),ln=C.querySelector('.ln');if(!svgEl||!ln)return;const c=C.getBoundingClientRect(),l=ln.getBoundingClientRect(),y=l.top+1-c.top;svgEl.replaceChildren();
  for(const n of C.querySelectorAll('.node')){const b=n.getBoundingClientRect(),x=b.left+b.width/2-c.left;svgEl.append(svg('line',{x1:x,x2:x,y1:b.top<l.top?b.bottom-c.top:b.top-c.top,y2:y}))}}
function buildCircuit(root){const wire=svg('svg',{class:'wires','aria-hidden':'true'}),node=id=>{const b=el('button','node idle');b.type='button';b.dataset.feature=id;b.setAttribute('aria-controls','circuit-inspector');const t=el('span','t');const dot=el('i');dot.setAttribute('aria-hidden','true');t.append(dot,el('span','nm'));const dec=el('span','d dec');dec.append(el('span','dl'),document.createTextNode(' '),el('b'));const foot=el('span','foot');foot.append(el('span','ago'));const strip=el('span','strip');strip.setAttribute('aria-hidden','true');strip.append(el('span','tr'));b.append(t,el('span','d ds'),dec,foot,strip);return b};
  const cells=ids=>{const g=el('div','cells8');for(const id of ids)g.append(node(id));return g};const rail=el('div','rail');const ln=el('div','ln');ln.setAttribute('aria-hidden','true');rail.append(el('span','nm','Jev'),ln,el('span','lat','–'));
  root.append(wire,el('div','grp gate-grp'),cells(CIRCUIT.slice(0,4)),rail,el('div','grp mod-grp'),cells(CIRCUIT.slice(4)));if(typeof ResizeObserver!=='undefined')new ResizeObserver(()=>requestAnimationFrame(wires)).observe(root)}
// Recorded steps of the last window that have landed; a lifecycle record moves a strip even though it is no decision.
const recent=(ops,win,ok)=>{const ref=frozenAt??Date.now(),out=[];for(const r of ops.runs)if(ref-Date.parse(r.lastAt)<win)for(const s of r.steps)if(ok(s,r)&&!held.has(s.id)&&ref-Date.parse(s.at)<win)out.push(s);return out};
const strip=(ops,id)=>ticks($('pipeline').querySelector('[data-feature="'+id+'"] .strip .tr'),recent(ops,ACTIVITY_MS,(s,r)=>s.feature===id&&(circuitMode==='live'||r.id===selectedRun)),ACTIVITY_MS);
function paint(b,last,f,ref){const age=last?ref-Date.parse(last.at):Infinity;b._last=last;setSeg(b.querySelector('.dec b'),last?valueText(last):'–');
  const ago=b.querySelector('.ago');ago.dataset.at=last?.at||'';ago.dataset.none=last?'':f?.state==='unsupported'?label('미지원','Unsupported'):f?.state==='unavailable'?label('기록원 없음','No source'):'–';
  b.classList.toggle('live',age<ACTIVITY_MS);b.classList.toggle('idle',!(age<ACTIVITY_MS));b.classList.toggle('err',last?.state==='error'||last?.model?.status==='mismatch')}
function pipeline(ops,calls){const root=$('pipeline');if(!root.querySelector('.node'))buildCircuit(root);
  root.querySelector('.gate-grp').textContent=label('Gate 단계','Gate stages');root.querySelector('.mod-grp').textContent=label('독립 기능','Independent features');
  for(const b of $('circuit-mode').querySelectorAll('button'))b.setAttribute('aria-pressed',String(b.dataset.circuitMode===circuitMode));
  const ref=frozenAt??Date.now(),last={};for(const r of ops.runs)if(circuitMode==='live'||r.id===selectedRun)for(const s of r.steps)if(!s.lifecycle&&NODE[s.feature]&&!held.has(s.id)&&!(last[s.feature]?.at>=s.at))last[s.feature]=s;
  if(!circuitFeature)circuitFeature=CIRCUIT.reduce((a,id)=>last[id]&&!(last[a]?.at>=last[id].at)?id:a,null)||'admission';
  for(const id of CIRCUIT){const b=root.querySelector('[data-feature="'+id+'"]');
    b.querySelector('.nm').textContent=tr(featureInfo[id][0]);b.querySelector('.ds').textContent=label(...NODE[id][0]);b.querySelector('.dl').textContent=label(...NODE[id][1]);paint(b,last[id],ops.features.find(f=>f.id===id),ref);
    b.classList.toggle('sel',circuitFeature===id);b.setAttribute('aria-pressed',String(circuitFeature===id));strip(ops,id)}
  // While a trip is in flight its ping owns the latency label, so a redraw never steps it back to an older call.
  const latest=calls.find(s=>circuitMode==='live'||s.runId===selectedRun);if(!held.size)root.querySelector('.lat').textContent=latest?ms(latest.durationMs):'–';
  circuitInspector(ops,last[circuitFeature])}
// A landed record flashes its node and strip; it becomes the node's value only when it is a decision newer than the shown one.
function landNode(ops,s){const b=$('pipeline').querySelector('[data-feature="'+s.feature+'"]');if(!b||circuitMode==='run'&&s.runId!==selectedRun)return;
  if(!s.lifecycle&&!(b._last?.at>s.at)){paint(b,s,ops.features.find(f=>f.id===s.feature),frozenAt??Date.now());if(circuitFeature===s.feature)circuitInspector(ops,s)}strip(ops,s.feature);
  const d=b.querySelector('.dec');b.classList.add('zap');d.classList.add('flash');setTimeout(()=>b.classList.remove('zap'),160);requestAnimationFrame(()=>requestAnimationFrame(()=>d.classList.remove('flash')))}
// The inspector is rebuilt only when its stage, its record or the language changes, so an open help panel stays put.
function circuitInspector(ops,last){const root=$('circuit-inspector'),id=circuitFeature||'admission',key=[id,last,lang];if(root._key?.every((v,k)=>v===key[k]))return;root._key=key;
  const guide=GUIDE[id],i=lang==='en'?1:0,open=root.querySelector('details')?.open,run=last?ops.runs.find(r=>r.steps.some(s=>s.id===last.id)):null;root.replaceChildren();
  const head=el('div','ch');head.append(el('h2','',tr(featureInfo[id][0])),el('span','hint',label('단계 상세','Stage details')));const body=el('div','b');
  if(last){const tags=el('div','insp-tags');if(run?.host)tags.append(el('span','tag '+(run.host==='codex'?'cx':'cl'),run.host==='codex'?'Codex':'Claude'));tags.append(el('span','tag '+({done:'ok',active:'run',error:'er'}[last.state]||'wa'),tr(state[last.state])),el('time','mono',time(last.at)));body.append(tags)}
  body.append(el('div','insp-desc',label(...NODE[id][0])));const kv=el('dl','kv');const row=(k,v,cls)=>{const d=el('dd',cls||'',v);kv.append(el('dt','',k),d);return d};
  row(label('판정','Decision'),last?decisionText(last):'–');row(label('신뢰도','Confidence'),confText(last?.receipt));const age=row(label('갱신','Updated'),last?'':'–','ago');age.dataset.at=last?.at||'';age.dataset.none='–';row(label('Jev 응답','Jev response'),last?.durationMs!==undefined&&last.lane==='jev'?ms(last.durationMs):'–');body.append(kv);
  const help=el('details');help.append(el('summary','',label('이 단계가 하는 일','How this stage works')),el('p','',guide.what[i]+' '+guide.jev[i]));help.open=!!open;body.append(help);
  const go=el('button','link',last?label('이 실행의 판단 근거와 시간축 보기 ↗','Inspect this execution and its evidence ↗'):label('이 기능의 실행 기록 보기 ↗','Show executions for this feature ↗'));go.type='button';go.dataset.inspectFeature=id;if(run)go.dataset.inspectRun=run.id;if(last)go.dataset.inspectStep=last.id;body.append(go);root.append(head,body)}
window.addEventListener('resize',()=>requestAnimationFrame(wires));
`;
