/** The circuit is one persistent DOM. Values change in place, so a live update never moves the layout; one recorded Jev response is one round trip on the rail. */
export const CIRCUIT_CSS = `
.circuit{position:relative;padding:16px}.grp{line-height:18px;font-size:12px;color:var(--faint);margin:0 0 12px}.cells{display:flex;flex-wrap:wrap;gap:12px}
.node{position:relative;z-index:1;border:1px solid var(--spark);border-radius:8px;padding:12px 12px 0;background:var(--bg);display:flex;flex:1 1 200px;flex-direction:column;gap:4px;height:220px;min-width:0;overflow:hidden;text-align:left;font:inherit;color:inherit;cursor:pointer;appearance:none;transition:background .3s,border-color .15s}
.node[hidden]{display:none}.node:hover{border-color:color-mix(in srgb,var(--accent) 45%,var(--line))}.node.sel{border-color:var(--accent)}.node.zap{background:color-mix(in srgb,var(--accent) 8%,var(--bg));transition:none}
.node:focus-visible{outline:2px solid var(--accent);outline-offset:3px}.node .t{height:20px;font-size:14px;font-weight:600;display:flex;align-items:center;gap:8px;white-space:nowrap}.node .t i{position:relative;width:6px;height:6px;border-radius:50%;background:var(--faint);flex:none}.node.live .t i{background:var(--accent)}.node.zap .t i:after{content:"";position:absolute;inset:-4px;border:1px solid currentColor;border-radius:50%;color:var(--accent);animation:halo .6s ease-out forwards}.node.err .t i{background:var(--err)}.node.err .t i:after{color:var(--err)}
.node .d{height:16px;line-height:16px;font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.node .d b{font-weight:500;color:var(--ink);font-variant-numeric:tabular-nums;transition:color .15s}.node.idle .d b{color:var(--faint)}.node .dec.flash b{color:var(--accent);transition:none}
.node .dec b span{display:inline-block;margin-right:.45em}.node .dec b span:last-child{margin-right:0}/* A value followed by its confidence or effort keeps a fixed width, so the second part never moves. */
.node .dec .s0:not(:last-child){width:4.7em;overflow:hidden;text-overflow:ellipsis;vertical-align:top}.node[data-feature=router] .dec .s0:not(:last-child){width:3.4em}.node[data-feature=router] .dec .s1{min-width:3.9em}
/* Activity and reason retain their slots across live updates, with room to read the recorded facts. */
.node .ds{height:48px;line-height:16px;font-size:12px;font-variant-numeric:tabular-nums;white-space:normal;overflow-wrap:anywhere}.node .nt{height:48px;line-height:16px;font-size:12px;color:var(--faint);overflow:hidden;overflow-wrap:anywhere}.node .pb{display:block;flex:none;height:2px;background:var(--line);border-radius:1px}.node .pb i{display:block;height:100%;background:var(--accent);border-radius:1px;transition:width .12s ease-out}
.node .foot{margin-top:auto;height:14px;display:flex;align-items:center;gap:6px;font-size:11px;color:var(--faint)}.node .ago{margin-left:auto;width:64px;overflow:hidden;text-overflow:ellipsis;text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.strip{position:relative;display:block;height:14px;margin:2px -12px 0;border-top:1px solid var(--line);overflow:hidden}.strip .tr{position:absolute;inset:0}
.strip i{position:absolute;bottom:3px;width:1.5px;height:7px;background:var(--accent);border-radius:1px;animation:slide 60s linear forwards}.node.idle .strip i{background:var(--faint)}
@keyframes slide{from{left:100%}to{left:0}}@keyframes grid{to{background-position:-22px 100%}}@keyframes tw{0%,100%{opacity:1}50%{opacity:.25}}
.rail{position:relative;z-index:1;height:24px;margin:20px 0 0}.rail .ln{position:absolute;left:0;right:0;top:12px;height:1px;background:var(--spark)}
.jb{max-width:100%;position:absolute;z-index:1;left:0;top:0;width:auto;height:24px;display:flex;align-items:center;gap:6px;padding:0 8px;border:1px solid var(--spark);border-radius:6px;background:var(--paper);font-size:12px;font-weight:600;white-space:nowrap;transition:border-color .15s}.jb i{width:6px;height:6px;border-radius:50%;background:var(--faint);flex:none;transition:background .15s}.jb .v{min-width:0;overflow:hidden;text-overflow:ellipsis;font-weight:400;color:var(--faint);font-variant-numeric:tabular-nums}.rail.busy .jb{box-shadow:0 0 14px color-mix(in srgb,var(--accent) 45%,transparent)}.rail.wait .jb{border-color:var(--accent)}.rail.wait .jb i{background:var(--accent)}
.rail .ln b{position:absolute;top:-4px;width:8px;height:8px;margin-left:-4px;border-radius:50%;background:var(--accent);animation:ping .3s ease-out forwards}
@keyframes ping{from{box-shadow:0 0 0 0 color-mix(in srgb,var(--accent) 60%,transparent);opacity:1}to{box-shadow:0 0 0 10px transparent;opacity:0}}
svg.wires{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible}svg.wires line{stroke-width:1}
/* Wires carry no record; only a Jev call moves, as a dot. */
svg.wires line{stroke:var(--spark);stroke-dasharray:2 6}
.trip{position:absolute;z-index:2;width:6px;height:6px;margin:-3px 0 0 -3px;border-radius:50%;background:var(--accent);pointer-events:none}.trip{background:var(--signal,var(--accent));box-shadow:0 0 5px 2px var(--signal,var(--accent));filter:drop-shadow(0 0 4px var(--signal,var(--accent)))}.trip:before{content:"";position:absolute;left:1px;top:4px;width:4px;height:24px;border-radius:50%;background:linear-gradient(var(--signal,var(--accent)),transparent)}.trip.down:before{top:auto;bottom:4px;background:linear-gradient(transparent,var(--signal,var(--accent)))}.trip:after{content:attr(data-ms);position:absolute;left:3px;bottom:9px;transform:translateX(-50%);font-size:10px;line-height:12px;color:var(--accent);white-space:nowrap;font-variant-numeric:tabular-nums}.trip.end{background:none}
.insp .b{padding:14px 16px;display:flex;flex-direction:column;gap:12px;height:380px;overflow:auto;scrollbar-gutter:stable;overscroll-behavior:contain}.insp .b>*{flex-shrink:0}/* The inspector reserves space and keeps stable, scrollable fields across live updates. */
.insp-tags{display:flex;gap:8px;align-items:center;height:20px}
.kv{display:grid;grid-template-columns:88px minmax(0,1fr);gap:8px 10px;font-size:13px;margin:0}.kv dt{color:var(--faint)}.kv dd{margin:0;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums}.kv dd.w2{height:3em;white-space:normal;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow-wrap:anywhere;word-break:keep-all}
.insp .kv dd,.insp .kv dd.w2{height:48px;white-space:normal;display:block;overflow:auto;text-overflow:clip;overflow-wrap:anywhere;-webkit-line-clamp:unset;scrollbar-gutter:stable;overscroll-behavior:contain;user-select:text}.insp .kv dd:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.insp .kv{grid-template-columns:repeat(3,88px minmax(0,1fr));gap:12px 16px}
.insp .link{white-space:normal;overflow:visible;overflow-wrap:anywhere}.insp details summary{cursor:pointer;color:var(--muted);font-size:13px}.insp details p{color:var(--faint);font-size:13px;margin:8px 0 0}.link{appearance:none;border:0;background:none;padding:0;max-width:100%;text-align:left;font:inherit;font-size:13px;color:var(--accent);cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.still .node.zap .t i:after{animation-play-state:paused}
/* A shared wire is accurate for one row. Wrapped rows keep the live stage pulses and rail ticker without wires through cards. */
.circuit[data-wrapped=true] svg.wires,.circuit[data-wrapped=true] .trip{display:none}
@media(prefers-reduced-motion:reduce){.trip{display:none}.node,.node *,.node :after,.jb,.rail,.rail .ln b{animation:none!important;transition:none!important}}
@media(max-width:980px){.insp .kv{grid-template-columns:repeat(2,88px minmax(0,1fr))}}
@media(max-width:640px){svg.wires,.trip{display:none}.insp .kv{grid-template-columns:88px minmax(0,1fr)}}
`;

/** Embedded in the dashboard's single script, sharing its text-only renderer and recorded state. */
export const CIRCUIT_SCRIPT = `
// The feature filter uses the steps the circuit shows, so a node that is waiting on a response never filters to an empty list.
const circuitStep=s=>!s.lifecycle||s.title==='모델 · 응답 대기'||s.title==='모델 · 요청 실패';
const CIRCUIT=['admission','allocation','workers','router','compact'];
const NODE={admission:[['실행 형태','Execution path'],['형태','Path'],['실행 형태?','Execution path?']],allocation:[['등급 배정','Tier allocation'],['등급','Tier'],['등급?','Tier?']],workers:[['수락 검사','Acceptance check'],['수락','Accept'],['수락?','Accept?']],router:[['모델과 effort','Model and effort'],['모델','Model'],['이 턴 모델?','Model for this turn?']],compact:[['요약 대체','Summary replacement'],['유지','Kept'],['이 청크 유지?','Keep these chunks?']]};
// A Jev call is a measured response record; intents, policy follow-ups and host events are not calls.
const isCall=s=>s.lane==='jev'&&s.durationMs!==undefined&&!s.lifecycle;
// Jev traffic is every recorded Jev request and response; only a response is a call.
const isJev=s=>s.lane==='jev'&&!s.lifecycle;
// Jev calls arrive about once a minute in bursts: a 30-second window was empty 76% of the time, 2 minutes 44%.
const ACTIVITY_MS=60000,COMM_MS=120000,MAX_TRIPS=24;
// Values always reflect the newest frame; motion has its own bounded lifetime.
const isHeld=()=>false;
let circuitMode='live',circuitFeature=null,timers=new Set(),seenRuns=null,seenScope='',freshMotion=[],railCalls=[];
const motion=()=>!paused&&!$('connection').classList.contains('warn')&&!matchMedia('(prefers-reduced-motion: reduce)').matches;
// A node names the model family, as Claude ids reduce to sonnet or opus; the full id stays in the stage detail.
const modelName=v=>{const m=String(v||'').match(/(haiku|sonnet|opus|fable)|^gpt-[0-9.]+-([a-z]+)$/);return m?m[1]||m[2]:String(v||'').replace(/^claude-/,'')};
const fmt=t=>{const s=Math.floor(t/1000);return !Number.isFinite(t)?'–':s<2?label('방금','now'):s<60?label(s+'초 전',s+'s ago'):s<3600?label(Math.floor(s/60)+'분 전',Math.floor(s/60)+'m ago'):label(Math.floor(s/3600)+'시간 전',Math.floor(s/3600)+'h ago')};
const pct=v=>Math.round(v*100)+'%';

// #232: a worker result names its contract verdict; only an accept receipt reads as accepted, and a host end is not one.
const OUTCOME={accepted:['계약 수락','Contract accepted'],rejected:['계약 미충족','Contract not met'],unknown:['판정 미확인','Verdict unknown'],host_ended:['호스트 종료','Host ended']};
function decisionText(s){if(!s)return '–';if(s.feature==='workers'&&!s.outcome)return label('판정 없음','No verdict');if(s.outcome)return label(...OUTCOME[s.outcome]);const c=s.receipt?.choice;
  if(s.feature==='router'){const m=c||(s.model?[s.model.observed||s.model.selected,s.model.observedEffort||s.model.selectedEffort].filter(Boolean).join(' · '):'');return m?m.split(' · ').map((v,i)=>i?v:modelName(v)).join(' · '):tr(state[s.state])}
  const path=s.executionPath||(s.feature==='admission'?c:null);if(path==='direct')return label('직접','Direct');if(path==='orchestrated')return label('위임','Delegate');
  if(c)return s.feature==='allocation'&&/(haiku|sonnet|opus|fable)/.test(c)?modelName(c):choiceName('',c);return tr(state[s.state])}
// The node and the run list show the decision with its recorded confidence; Router shows model and effort only.
const valueText=s=>{const v=decisionText(s),c=s?.receipt?.confidence;return s&&s.feature!=='router'&&c!=null?v+' '+c.toFixed(2):v};
function setSeg(box,value){const parts=String(value).replace(/ (\\d\\.\\d+)$/,' · $1').split(' · ');while(box.children.length>parts.length)box.lastChild.remove();while(box.children.length<parts.length)box.append(el('span','s'+box.children.length));parts.forEach((p,i)=>{if(box.children[i].textContent!==p)box.children[i].textContent=p})}
// One tick per recorded record inside the window. A tick slides by its own CSS animation from its true age; a frozen view rebuilds ticks at their ages on resume.
function ticks(box,records,windowMs,make){const ref=frozenAt??Date.now(),keep=new Set(),still=!motion();if(!box._ids){box._ids=new Set();box.addEventListener('animationend',e=>{if(e.animationName==='slide')e.target.remove()})}
  for(const s of records){const age=Math.max(0,ref-Date.parse(s.at));if(!(age<windowMs))continue;keep.add(s.id);const left=(100-100*age/windowMs).toFixed(2)+'%';if(box._ids.has(s.id)){if(still){const i=box.querySelector('[data-id="'+s.id+'"]');if(i)i.style.left=left}continue}const i=el('i');i.dataset.id=s.id;make?.(i,s);i.style.left=left;i.style.animationDelay=-(age/1000)+'s'+(make?',0s':'');box.append(i)}
  for(const i of [...box.children])if(!keep.has(i.dataset.id))i.remove();box._ids=keep}
function resetTicks(){for(const box of document.querySelectorAll('.strip .tr,#comm')){box.replaceChildren();if(box._ids)box._ids=new Set()}}
function cancelMotion(){for(const t of timers)clearTimeout(t);timers.clear();freshMotion=[];for(const d of document.querySelectorAll('.trip,.rail .ln b'))d.remove();for(const a of flights.values())a.cancel?.();flights.clear();railWait=0;railMark()}
let railWait=0,railPend=0;const railMark=()=>$('pipeline').querySelector('.rail')?.classList.toggle('wait',railWait>0||railPend>0);
const later=(f,ms)=>{const t=setTimeout(()=>{timers.delete(t);f()},ms);timers.add(t)};
const flights=new Map();
function arrivals(ops){const scope=hostFilter+':'+circuitMode+':'+(circuitMode==='run'?selectedRun:''),ref=frozenAt??Date.now(),fresh=[];
  if(scope!==seenScope)cancelMotion();
  if(seenRuns&&scope===seenScope)for(const r of ops.runs){const old=seenRuns.get(r.id);if(old===r)continue;const had=new Set(old?.steps.map(s=>s.id));for(const s of r.steps)if(CIRCUIT.includes(s.feature)&&!had.has(s.id)&&(old||ref-Date.parse(s.at)<ACTIVITY_MS))fresh.push({...s,runId:r.id,host:r.host})}
  seenRuns=new Map(ops.runs.map(r=>[r.id,r]));seenScope=scope;freshMotion.push(...fresh);
  // Run after pipeline() has painted the values. No record, node or call-log row waits for playback.
  if(fresh.length)requestAnimationFrame(()=>{const records=freshMotion;freshMotion=[];if(!motion())return;const busy=records.length>12,updated=new Map();for(const s of records){flashNode(s);if(isJev(s))launch(s,busy);updated.set(s.runId,s)}for(const [id,s]of updated){const li=rowEls.get(id),r=ops.runs.find(r=>r.id===id);if(li&&r)fill(li,r,s)}})}
function burst(el,error=false,strong=false){if(!el||!motion())return;const color=error?'var(--err)':'var(--accent)';el.animate?.([{boxShadow:'0 0 '+(strong?24:12)+'px '+color,backgroundColor:'color-mix(in srgb,'+color+' '+(strong?10:6)+'%,var(--bg))',borderColor:color},{boxShadow:'0 0 0 transparent',backgroundColor:'var(--bg)',borderColor:'var(--line)'}],{duration:300,easing:'ease-out'});el.classList.add('zap');later(()=>el.classList.remove('zap'),300)}
function flashNode(s){const b=$('pipeline').querySelector('[data-feature="'+s.feature+'"]');if(!b||b.hidden||circuitMode==='run'&&s.runId!==selectedRun)return;const value=valueText(s),changed=b._flashValue!==undefined&&b._flashValue!==value;b._flashValue=value;burst(b,s.state==='error',changed)}
function launch(s,busy=false){const C=$('pipeline'),b=C.querySelector('[data-feature="'+s.feature+'"]'),ln=C.querySelector('.ln');if(!b||b.hidden||!ln||!motion()||circuitMode==='run'&&s.runId!==selectedRun)return;
  const response=isCall(s),key=s.runId+':'+(s.callId||(response?s.id:s.feature)),existing=flights.get(key),duration=busy?150:180;
  const ping=x=>{const p=el('b');p.style.left=x+'px';ln.append(p);later(()=>p.remove(),300);burst(C.querySelector('.jb'),s.state==='error',busy)};
  if(existing&&response){existing.respond(s);return}
  // The budget caps particles, never values. Saturation still lights the rail and flashes each result's node.
  if(C.querySelectorAll('.trip').length>=MAX_TRIPS){ping(ln.clientWidth/2);return}
  const c=C.getBoundingClientRect(),l=ln.getBoundingClientRect(),n=b.getBoundingClientRect(),x=n.left+n.width/2-c.left,y=l.top+1-c.top,ny=n.top<l.top?n.bottom-c.top:n.top-c.top;
  const wire=C.querySelector('svg.wires line[data-wire="'+s.feature+'"]');
  const leg=(y0,y1,result,done)=>{const d=el('i','trip'+(y1>y0?' down':''));if(result)d.dataset.ms=ms(result.durationMs);d.style.left=x+'px';d.style.top=y0+'px';d.style.setProperty('--signal',s.state==='error'?'var(--err)':'var(--accent)');C.append(d);
    wire?.animate?.([{opacity:1,stroke:'var(--accent)',filter:'drop-shadow(0 0 4px var(--accent))'},{opacity:.5,stroke:'var(--spark)',filter:'none'}],{duration:duration+80});
    const finish=()=>{d.remove();done()};if(!d.animate){finish();return}const a=d.animate([{transform:'translateY(0)',opacity:1},{transform:'translateY('+(y1-y0)+'px)',opacity:1}],{duration,easing:'linear'});a.onfinish=finish;a.oncancel=()=>d.remove();return a};
  let atRail=false,answer=response?s:null,returning=false,inbound;
  const back=()=>{if(!atRail||!answer||returning)return;returning=true;inbound=leg(y,ny,answer,()=>{flights.delete(key);flashNode(answer)})};
  const outbound=leg(ny,y,null,()=>{atRail=true;ping(x-(l.left-c.left));back()});
  flights.set(key,{respond:result=>{answer=result;back()},cancel:()=>{outbound?.cancel();inbound?.cancel()}});
  // A missing response leaves no moving or glowing particle behind.
  later(()=>{if(!answer)flights.delete(key)},ACTIVITY_MS);
}
function wires(){const C=$('pipeline'),svgEl=C.querySelector('svg.wires'),ln=C.querySelector('.ln'),cells=C.querySelector('.cells');if(!svgEl||!ln||!cells)return;
  // Balance the visible stages, not a historic slot count. Every row fills its width; a narrow odd count becomes a single column.
  const nodes=[...cells.querySelectorAll('.node:not([hidden])')];if(!nodes.length){svgEl.replaceChildren();return}const capacity=Math.max(1,Math.floor((cells.clientWidth+12)/212));let rows=Math.ceil(nodes.length/capacity);if(rows>nodes.length/2)rows=nodes.length;
  const size=Math.floor(nodes.length/rows),extra=nodes.length%rows;let at=0;for(let row=0;row<rows;row++){const count=size+(row<extra?1:0),basis='calc((100% - '+((count-1)*12)+'px) / '+count+')';for(let i=0;i<count;i++)nodes[at++].style.flexBasis=basis}C.dataset.wrapped=String(rows>1);
  const c=C.getBoundingClientRect(),l=ln.getBoundingClientRect(),y=l.top+1-c.top;svgEl.replaceChildren();
  for(const n of C.querySelectorAll('.node:not([hidden])')){const b=n.getBoundingClientRect(),x=b.left+b.width/2-c.left;svgEl.append(svg('line',{'data-wire':n.dataset.feature,x1:x,x2:x,y1:b.top<l.top?b.bottom-c.top:b.top-c.top,y2:y}))}}
function buildCircuit(root){const wire=svg('svg',{class:'wires','aria-hidden':'true'}),node=id=>{const b=el('button','node idle');b.type='button';b.dataset.feature=id;b.setAttribute('aria-controls','circuit-inspector');const t=el('span','t');const dot=el('i');dot.setAttribute('aria-hidden','true');t.append(dot,el('span','nm',featureInfo[id][0]));const dec=el('span','d dec'),v=el('b');setSeg(v,'–');dec.append(el('span','dl',label(...NODE[id][1])),document.createTextNode(' '),v);const foot=el('span','foot');foot.append(el('span','ago'));const strip=el('span','strip');strip.setAttribute('aria-hidden','true');strip.append(el('span','tr'));const pb=el('span','pb');pb.setAttribute('aria-hidden','true');pb.append(el('i'));b.append(t,el('span','d ds',label(...NODE[id][0])),dec,el('span','nt'),pb,foot,strip);return b};
  const cells=el('div','cells');for(const id of CIRCUIT)cells.append(node(id));const rail=el('div','rail'),ln=el('div','ln'),jb=el('span','jb');ln.setAttribute('aria-hidden','true');jb.setAttribute('aria-hidden','true');jb.append(el('i'),'Jev',el('span','v'));rail.append(ln,jb);
  root.append(wire,el('div','grp',label('Gate 단계 · 독립 기능','Gate stages · Independent features')),cells,rail);wires();if(typeof ResizeObserver!=='undefined')new ResizeObserver(()=>requestAnimationFrame(wires)).observe(root)}
// Recorded steps of the last window that have landed; a lifecycle record moves a strip even though it is no decision.
const recent=(ops,win,ok)=>{const ref=frozenAt??Date.now(),out=[];for(const r of ops.runs)if(ref-Date.parse(r.lastAt)<win)for(const s of r.steps)if(ok(s,r)&&!isHeld(r.id,s.id)&&ref-Date.parse(s.at)<win)out.push(s);return out};
const strip=(ops,id)=>ticks($('pipeline').querySelector('[data-feature="'+id+'"] .strip .tr'),recent(ops,ACTIVITY_MS,(s,r)=>s.feature===id&&(circuitMode==='live'||r.id===selectedRun)),ACTIVITY_MS);
function paint(b,last,f,ref,run){const age=last?ref-Date.parse(last.at):Infinity,x=last&&run?loaded(run.id,last):last,c=x?.receipt?.confidence;b._last=last;if(b._flashValue===undefined&&last)b._flashValue=valueText(last);setSeg(b.querySelector('.dec b'),last?.feature==='workers'&&last.outcome==='host_ended'?label('판정 없음','No verdict'):last?valueText(last):'–');
  put(b.querySelector('.nt'),x?note(x,run):'');b.querySelector('.pb i').style.width=c==null?'0%':pct(c);
  const ago=b.querySelector('.ago');ago.dataset.at=last?.at||'';ago.dataset.none=last?'':f?.state==='unsupported'?label('미지원','Unsupported'):f?.state==='unavailable'?label('기록원 없음','No source'):'–';
  b.classList.toggle('live',age<ACTIVITY_MS);b.classList.toggle('idle',!(age<ACTIVITY_MS));b.classList.toggle('err',last?.state==='error'||last?.model?.status==='mismatch')}
function pipeline(ops,calls,pend){const root=$('pipeline'),built=!root.querySelector('.node');if(built)buildCircuit(root);
  root.querySelector('.grp').textContent=label('Gate 단계 · 독립 기능','Gate stages · Independent features');
  for(const b of $('circuit-mode').querySelectorAll('button'))b.setAttribute('aria-pressed',String(b.dataset.circuitMode===circuitMode));
  const ref=frozenAt??Date.now(),last={},runOf={};for(const r of ops.runs)if(circuitMode==='live'||r.id===selectedRun)for(const s of r.steps)if(!s.lifecycle&&NODE[s.feature]&&!isHeld(r.id,s.id)&&!(last[s.feature]?.at>=s.at)){last[s.feature]=s;runOf[s.feature]=r}
  // A feature the scoped host does not run (Jev Compact on Codex) has no card, and no inspector, in that view.
  const off=id=>ops.features.find(f=>f.id===id)?.state==='unsupported',changed=CIRCUIT.some(id=>root.querySelector('[data-feature="'+id+'"]').hidden!==off(id));for(const id of CIRCUIT)root.querySelector('[data-feature="'+id+'"]').hidden=off(id);if(built||changed)wires();if(off(circuitFeature))circuitFeature=null;
  if(!circuitFeature)circuitFeature=CIRCUIT.reduce((a,id)=>last[id]&&!off(id)&&!(last[a]?.at>=last[id].at)?id:a,null)||'admission';
  for(const id of CIRCUIT){const b=root.querySelector('[data-feature="'+id+'"]');
    b.querySelector('.nm').textContent=tr(featureInfo[id][0]);const activity=activityOf(id);put(b.querySelector('.ds'),activity?activityLine(activity):label('24h 추적 불가','24h untrackable'));b.querySelector('.ds').title=activity?activityLine(activity):'';b.querySelector('.dl').textContent=label(...NODE[id][1]);paint(b,last[id],ops.features.find(f=>f.id===id),ref,runOf[id]);
    const detail=[id==='router'?currentRouter(activity):'',activity?activityDetail(id,activity):'',b.querySelector('.nt').textContent].filter(Boolean).join(' · ');put(b.querySelector('.nt'),detail);b.querySelector('.nt').title=detail;b.classList.toggle('sel',circuitFeature===id);b.setAttribute('aria-pressed',String(circuitFeature===id));strip(ops,id)}
  // The existing badge is the live ticker; the inspector retains each response's Jev model.
  const mine=s=>circuitMode==='live'||s.runId===selectedRun;railCalls=calls.filter(mine);railStats(railCalls);railPend=pend.filter(mine).length;railMark();
  circuitInspector(ops,last[circuitFeature])}
// Existing node lines and inspector rows share doctor's structured activity check.
const activityOf=id=>data?.activity24h?.[hostFilter]?.find(c=>c.feature===id);
const activityLine=a=>{const m=a.metrics;return '24h '+({ok:label('정상','OK'),warn:label('주의','Warn'),fail:label('오류','Fail'),info:label('관측','Info')}[a.level]||a.level)+' · '+label('발화 ','fired ')+num(m.fired)+' · '+label('적용 ','applied ')+(m.applied==null?label('미확인','unknown'):num(m.applied))+' · '+label('회귀 ','regressions ')+num(m.regression)};
const netText=a=>{const effect=a.metrics.effect,usd=n=>(n<0?'−':'+')+'$'+Math.abs(n).toFixed(2);return effect==null?label('미확인','unknown'):Array.isArray(effect)?effect.map(usd).join(' / '):usd(effect)};
const currentRouter=a=>{const s=a?.current;return s?[label('최근 루트 (전체 실행)','Latest root (all runs)'),s.host==='codex'?'Codex':s.host==='claude'?'Claude':'',s.at?date(s.at):'',s.runId||'',s.model?.observed?label('관측','observed'):label('선택','selected'),decisionText({...s,feature:'router'})].filter(Boolean).join(' · '):''};
function activityDetail(id,a){const m=a.metrics;if(id==='workers')return label('수락 ','accepted ')+num(m.accepted)+' · '+label('거절 ','rejected ')+num(m.rejected)+' · '+label('실행 실패 ','execution failures ')+num(m.failed)+' · '+label('대기 ','pending ')+num(m.pending)+' · '+label('취소 ','cancelled ')+num(m.cancelled);if(id==='compact')return label('복원 ','restored ')+num(m.restored)+' · '+label('예산 ','budget ')+(m.budgetUsed==null?label('미확인','unknown'):num(m.budgetUsed))+' / '+(m.budget==null?label('미확인','unknown'):num(m.budget));return (id==='admission'?label('경로 변경 ','path changes ')+num(m.applied)+' · ':id==='allocation'?label('등급 변경 ','tier changes ')+num(m.applied)+' · ':'')+label('효과 ','effect ')+(id==='router'?label('(루트 비용 추정) ','(root cost estimate) '):'')+netText(a)}
function railStats(calls){const rail=$('pipeline').querySelector('.rail'),box=rail?.querySelector('.v');if(!box)return;const ref=frozenAt??Date.now(),recent=calls.filter(s=>ref-Date.parse(s.at)<60000),values=calls.slice(0,16).map(s=>s.durationMs).sort((a,b)=>a-b),latest=calls[0],text=[latest?tr(featureInfo[latest.feature][0])+' '+decisionText(latest)+' '+ms(latest.durationMs):label('응답 대기','Awaiting calls'),num(recent.length)+'/min','p50 '+(values.length?ms(values[Math.ceil(values.length*.5)-1]):'–')].join(' · ');put(box,text);box.title=text;rail.classList.toggle('busy',recent.length>=6)}
// The inspector says in full what the card can only begin: why the decision was made, its effect, what followed in its run and,
// for a failure, its cause and current impact. Full values remain readable beyond the compact cards.
const drop=(s,v)=>{const d=decisionText(s);return String(v||'').split(' · ').filter(p=>p&&p!==d).join(' · ')};
function reasonOf(s,r){const g=s.routing;if(g){const from=g.baseline&&modelName(g.baseline);return [from&&s.receipt?.choice&&!decisionText(s).startsWith(from)&&label(from+'에서 변경','Changed from '+from),why(g)].filter(Boolean).join(' · ')}return drop(s,tr((policyOf(s,r)||s).summary||''))}
function effectOf(s,reason){const m=s.model;if(m&&!reason.includes('일치')&&!/match/i.test(reason))return m.status==='confirmed'?label('선택과 실제 응답 일치','Selection matches the response'):m.status==='mismatch'?label('실제 응답 ','Responded with ')+m.observed:s.state==='active'?label('응답 대기','Awaiting response'):label('실제 응답 미관측','Response unobserved');
  return ''}
// The next record of the same run, its decision recorded with it aside.
const nextOf=(s,r)=>{if(!r)return null;const p=policyOf(s,r);return r.steps.slice(r.steps.indexOf(s)+1).find(x=>x!==p&&!x.lifecycle&&!isHeld(r.id,x.id))||null};
// Live values update persistent fields; scrolling, selection, keyboard focus and expanded help stay put.
function circuitInspector(ops,last){const root=$('circuit-inspector'),id=circuitFeature||'admission',run=last?ops.runs.find(r=>last.runId?r.id===last.runId:r.steps.includes(last)):null,step=run?.steps.find(s=>s.id===last.id)||last,x=run?detailed(run,step):step,key=[id,last,lang,x,activityOf(id)];if(root._key?.every((v,k)=>v===key[k]))return;root._key=key;
  const guide=GUIDE[id],i=lang==='en'?1:0;
  let view=root._view;
  if(!view||view.id!==id||view.lang!==lang){
    const head=el('div','ch');head.append(el('h2','',tr(featureInfo[id][0])),el('span','hint',label('단계 상세 · 스크롤하여 전문 읽기','Stage details · Scroll to read full values')));
    const body=el('div','b'),tags=el('div','insp-tags'),kv=el('dl','kv'),help=el('details'),go=el('button','link');
    help.append(el('summary','',label('이 단계가 하는 일','How this stage works')),el('p','',guide.what[i]+' '+guide.jev[i]));go.type='button';
    body.append(tags,kv,help,go);root.replaceChildren(head,body);view=root._view={id,lang,body,tags,kv,go,rows:[]};
  }
  const {body,tags,kv,go}=view;let rowIndex=0;
  if(tags.dataset.inspectorHost!==(run?.host||'')){tags.dataset.inspectorHost=run?.host||'';tags.replaceChildren();if(run?.host)tags.append(el('span','tag '+(run.host==='codex'?'cx':'cl'),run.host==='codex'?'Codex':'Claude'))}
  const row=(k,v,cls)=>{let d=view.rows[rowIndex++];if(!d){d=el('dd',cls||'');d.tabIndex=0;d.setAttribute('aria-label',k);kv.append(el('dt','',k),d);view.rows.push(d)}put(d,v);return d};
  // #261 host followups may share a receipt, but only inside this run and its recorded request identity.
  // Legacy records without either identity are usable only when there is exactly one preceding call.
  const candidates=run?.steps.filter(s=>s.lane==='jev'&&s.feature===id&&!s.lifecycle&&!isHeld(run.id,s.id)&&s.at<=step.at)||[];
  const matches=candidates.filter(s=>s===step||s.callId&&s.callId===step?.callId);
  const call=matches.at(-1)||(candidates.length===1&&!step?.callId&&!candidates[0].callId?candidates[0]:null);
  const activity=activityOf(id),rc=call?.receipt,none='–',why=x?reasonOf(x,run):'',card=x?note(x,run).split(' · '):[],reason=why.split(' · ').filter(p=>p&&!card.includes(p)).join(' · ');
  row(label('실행','Run'),run?[tr(run.title),tr(state[run.state]),time(run.firstAt)].join(' · '):none);
  row(label('판정','Decision'),x?(x.receipt?.choice||(x.model||x.outcome?decisionText(x):call?.receipt?.choice||decisionText(x))):none);
  row(label('모델 · effort','Model · effort'),x?.model?[label('선택','Selected')+': '+[x.model.selected,x.model.selectedEffort].filter(Boolean).join(' · '),label('관측','Observed')+': '+[x.model.observed||label('미확인','Unknown'),x.model.observedEffort].filter(Boolean).join(' · ')].join(' / '):none);
  row(label('상태와 사유','Status and notes'),[last?.title,last?.summary,last?note(last,run):'',activity?activityDetail(id,activity):''].filter(Boolean).map(tr).join(' · ')||none,'w2');
  row(label('이유','Reason'),reason||none,'w2').title=reason;row(label('결과','Effect'),x&&effectOf(x,why)||none);
  const after=x&&nextOf(step,run);row(label('다음 단계','Next stage'),after?tr(after.title)+' · '+decisionText(after):none);
  row(label('원인','Cause'),x&&failedStep(x)?[x.cause||label(...ISSUES[issueKind(x)]),label(...IMPACT[x.impact?.now||'unknown'])].join(' · '):none);
  row(label('Jev 응답','Jev response'),call?.durationMs!==undefined?ms(call.durationMs):none);
  row(label('토큰','Tokens'),rc&&(rc.input!=null||rc.output!=null)?num(rc.input)+' → '+num(rc.output):none);
  row(label('추정 비용','Est. cost'),rc?.costUsd!=null?usd(rc.costUsd):none);row(label('Jev 모델','Jev model'),rc?.model||none);
  row(label('24h 활동','24h activity'),activity?activityLine(activity):label('추적 불가','Untrackable'),'w2');row(label('24h 효과','24h effect'),[id==='router'?currentRouter(activity):'',activity?activityDetail(id,activity):label('미확인','Unknown')].filter(Boolean).join(' · '),'w2');
  put(go,last?label('이 실행의 판단 근거와 시간축 보기 ↗','Inspect this execution and its decisions ↗'):label('이 기능의 실행 기록 보기 ↗','Show executions for this feature ↗'));go.dataset.inspectFeature=id;if(run)go.dataset.inspectRun=run.id;else delete go.dataset.inspectRun;if(last)go.dataset.inspectStep=last.id;else delete go.dataset.inspectStep}
window.addEventListener('resize',()=>requestAnimationFrame(wires));
`;
