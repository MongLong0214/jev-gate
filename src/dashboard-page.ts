import { PATCH_SCRIPT } from './dashboard-patch.js';
import { JEV_PRICING } from './bench/usage.js';

/** Loopback UI. Recorded metadata enters through textContent only. */
export const DASHBOARD_PAGE = `<!doctype html><html lang="ko" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark light"><meta name="theme-color" content="#08090a"><link rel="icon" href="/favicon.svg" type="image/svg+xml"><title>Jev Gate · 개요</title><style>
:root{color-scheme:dark;--bg:#08090a;--paper:#0d0e10;--raised:#18191a;--hover:#141516;--chip:#1b1c1f;--spark:#34343a;--ink:#f7f8f8;--muted:#8a8f98;--faint:#80858d;--line:#23252a;--accent:#4b8df8;--on-accent:#fff;--ok:#6fcfa9;--warn:#e9bd7e;--err:#f87171;--done:#3e3e44}
:root[data-theme=light]{color-scheme:light;--bg:#f7f8f8;--paper:#fff;--raised:#eef0f3;--hover:#f3f4f6;--chip:#eceef1;--spark:#cfd3d9;--ink:#18191b;--muted:#5d6169;--faint:#61656c;--line:#e2e4e8;--accent:#2563eb;--on-accent:#fff;--ok:#11795c;--warn:#895910;--err:#c42a3a;--done:#b9bdc4}
*{box-sizing:border-box;scrollbar-width:thin;scrollbar-color:var(--spark) transparent}[hidden]{display:none!important}.ver[hidden]{display:inline-block!important;visibility:hidden}
body{margin:0;background:var(--bg);color:var(--ink);font:13px/1.45 Geist,Inter,-apple-system,BlinkMacSystemFont,"Segoe UI","Apple SD Gothic Neo","Noto Sans KR",sans-serif;-webkit-font-smoothing:antialiased}
button{font:inherit;color:inherit;cursor:pointer;background:none;border:0;padding:0}button:disabled{cursor:wait}a{color:inherit}
button:focus-visible,summary:focus-visible,a:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:4px}
h1,h2,p{margin:0}.m{font-family:"Geist Mono",ui-monospace,SFMono-Regular,Menlo,monospace;font-variant-numeric:tabular-nums;letter-spacing:-.01em}.cap{font-size:11px;line-height:16px;color:var(--faint)}
.skip-link{position:absolute;left:-9999px}.skip-link:focus{left:16px;top:8px;z-index:9;background:var(--paper);padding:6px 10px;border-radius:6px}
@keyframes blink{50%{opacity:.35}}@keyframes rip{from{transform:scale(1);opacity:.9}to{transform:scale(3.4);opacity:0}}@keyframes grow{from{transform:scaleX(0)}to{transform:scaleX(1)}}
@keyframes fly{0%{transform:translateX(0);opacity:1}50%{transform:translateX(calc(100% - 8px))}96%{transform:translateX(0);opacity:1}100%{transform:translateX(0);opacity:0}}@keyframes turn{0%,49.9%{transform:scaleX(1)}50%,100%{transform:scaleX(-1)}}
.top{border-bottom:1px solid var(--line);background:var(--bg)}
header{max-width:1440px;margin:0 auto;padding:0 24px;min-height:52px;display:flex;flex-wrap:wrap;align-items:center;gap:8px 20px}
.brand{display:flex;align-items:center;gap:10px}.brand svg{color:var(--ink)}.home{font-weight:600;font-size:14px;text-decoration:none;white-space:nowrap}
.ver{display:inline-block;width:17ch;font-size:12px;color:var(--faint);text-decoration:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.ver:hover{color:var(--ink)}header:has(#crumb:not([hidden])) .ver{display:none}.ver[data-state=update],.ver[data-state=mismatch]{color:var(--warn)}
.crumb{flex:1 1 0;display:flex;align-items:center;gap:10px;min-width:0;color:var(--muted)}.crumb a{flex:none;white-space:nowrap;text-decoration:none;min-height:32px;display:inline-flex;align-items:center}.crumb a:hover{color:var(--ink)}.crumb .sep,#crumb-id{flex:none}.crumb .sep{color:var(--done)}#crumb-run{min-width:0;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tabs{display:flex;gap:16px;margin-left:12px;align-self:stretch}.tabs button{min-height:50px;border-bottom:2px solid transparent;padding-top:2px;color:var(--faint);font-weight:500;white-space:nowrap}.tabs button:hover{color:var(--ink)}.tabs button[aria-pressed=true]{color:var(--ink);border-bottom-color:var(--ink)}
.ctl{display:flex;align-items:center;gap:8px 16px;margin-left:auto;flex-wrap:wrap;color:var(--muted)}
.chk{display:flex;align-items:center;gap:6px;min-height:32px;color:var(--muted);white-space:nowrap}.chk:hover{color:var(--ink)}
.chk:before{content:"";flex:none;width:13px;height:13px;border:1px solid var(--spark);border-radius:3px;background:var(--bg);color:var(--on-accent);font-size:10px;line-height:11px;text-align:center}.chk[aria-checked=true]:before{content:"✓";background:var(--accent);border-color:var(--accent)}
.live-btn{display:flex;align-items:center;gap:8px;min-height:32px;padding:0 10px;border:1px solid var(--spark);border-radius:6px}.live-btn i{flex:none;width:6px;height:6px;border-radius:50%;background:var(--accent);animation:blink 2s steps(5) infinite}
.live-btn[aria-pressed=true] i{background:var(--done);animation:none}.live-btn.warn i{background:var(--warn);animation:none}#connection{display:block;width:14ch;font-size:12px;color:var(--ink);text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tb{min-height:32px;padding:0 10px;border:1px solid var(--line);border-radius:6px;font-size:12px;color:var(--muted);white-space:nowrap}.tb:hover{color:var(--ink)}
#notice{max-width:1440px;margin:12px auto 0;padding:0 24px;color:var(--warn);font-size:12px}#notice:empty{display:none}
main{max-width:1440px;margin:0 auto;padding:16px 24px}
.grid{display:grid;grid-template-columns:minmax(0,1fr) 368px;grid-template-rows:auto 1fr auto;gap:16px;min-height:calc(100vh - 85px)}
.panel{background:var(--paper);border:1px solid var(--line);border-radius:8px;min-width:0;overflow:hidden}
.ph{display:flex;align-items:center;gap:4px 12px;flex:none;min-height:44px;padding:0 16px;border-bottom:1px solid var(--chip)}.ph h2{font-size:13px;font-weight:500;white-space:nowrap}
.ph .desc{min-width:0;font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.kp{display:grid;grid-template-columns:repeat(3,minmax(0,1fr)) 303px}
.kpi{display:flex;flex-direction:column;justify-content:center;gap:8px;height:72px;padding:0 16px;min-width:0;text-align:left}.kp .kpi+.kpi{border-left:1px solid var(--chip)}
.kl{font-size:12px;line-height:16px;color:var(--muted)}.kv{display:flex;align-items:baseline;gap:8px;white-space:nowrap;min-width:0}
.kn{font-size:24px;font-weight:500;letter-spacing:-.04em;line-height:1}.kn small{font-size:13px;color:var(--faint);letter-spacing:0}
.ks{font-size:12px;color:var(--faint);min-width:0;overflow:hidden;text-overflow:ellipsis}.ks.acc{color:var(--accent)}.ks.er,.kn.er{color:var(--err)}
.roller{display:flex;height:1em;overflow:hidden}.roller .dg{display:block;height:1em;overflow:hidden}.roller .roll{display:flex;flex-direction:column;transition:transform .55s cubic-bezier(.2,.9,.2,1)}.roller .roll span{height:1em}.roller .sep{color:var(--done)}
.att{height:auto;color:inherit}.att:hover{background:var(--hover)}
.tp{display:flex;flex-direction:column;min-height:0}.seg{margin-left:auto;display:flex;padding:2px;gap:2px;border:1px solid var(--line);border-radius:6px}.seg button{height:24px;padding:0 10px;border-radius:4px;font-size:12px;color:var(--faint)}.seg button:hover{color:var(--ink)}.seg button[aria-pressed=true]{background:var(--line);color:var(--ink)}
.jb{flex:1;display:flex;min-height:0}.plot{flex:1;min-width:0;display:flex;flex-direction:column;padding:16px}
.sc{position:relative;flex:1;min-height:180px;margin:8px 0 0 40px}
.yt{position:absolute;left:0;right:0;border-top:1px solid var(--hover)}.yt.z{border-top-color:var(--line)}.yt span{position:absolute;left:-40px;top:-8px;width:34px;text-align:right}
.p50l{position:absolute;inset:0;pointer-events:none;transition:transform .35s cubic-bezier(.2,.9,.2,1)}.p50l:before{content:"";position:absolute;left:0;right:0;bottom:0;border-top:1px dashed var(--accent);opacity:.7}
.p50l span{position:absolute;left:8px;bottom:-9px;z-index:2;padding:0 6px;font-size:11px;line-height:16px;color:var(--accent);background:var(--paper);border:1px solid var(--accent);border-radius:4px}
.edge{position:absolute;top:0;bottom:0;right:0;width:120px;background:linear-gradient(90deg,transparent,color-mix(in srgb,var(--accent) 7%,transparent));pointer-events:none}
.edge-l{position:absolute;top:0;bottom:0;right:0;width:2px;background:var(--accent);box-shadow:0 0 14px 2px color-mix(in srgb,var(--accent) 80%,transparent);animation:blink 2s steps(5) infinite;pointer-events:none}
#dots{position:absolute;inset:0}.dw,.dy{position:absolute;inset:0;pointer-events:none}
.dot{position:absolute;left:100%;bottom:0;border-radius:50%;background:var(--ink);pointer-events:auto;cursor:pointer}
.dot.fresh,.dot.on{background:var(--accent);opacity:1!important}.dot.fresh{box-shadow:0 0 12px 3px color-mix(in srgb,var(--accent) 80%,transparent)}.dot.on{box-shadow:0 0 0 2px var(--paper),0 0 0 3.5px var(--accent)}
.dot.fresh:before,.dot.fresh:after{content:"";position:absolute;inset:-2px;border-radius:50%;border:1.5px solid var(--accent);animation:rip .9s cubic-bezier(.2,.8,.2,1) both}.dot.fresh:after{border-width:1px;animation-delay:.18s}
.stem{position:absolute;left:100%;bottom:0;width:1px;height:100%;transform-origin:bottom;margin-left:-.5px;background:linear-gradient(to top,transparent,var(--accent))}
.tip{position:absolute;z-index:4;pointer-events:none;background:var(--raised);border:1px solid var(--spark);border-radius:6px;padding:8px 12px;white-space:nowrap;box-shadow:0 8px 24px rgba(0,0,0,.35)}.tip .v{font-size:12px;margin-top:2px}.tip .c{color:var(--muted);margin-top:2px}
.ax{display:flex;justify-content:space-between;height:16px;margin:8px 0 0 40px}
.mini{position:relative;flex:none;height:32px;margin:12px 0 0 40px}.mini svg{position:absolute;inset:0;width:100%;height:100%}#mini-a{fill:var(--ink);fill-opacity:.07}#mini-l{fill:none;stroke:var(--done);stroke-width:1.25}
.band{position:absolute;top:0;bottom:0;right:0;min-width:3px;background:color-mix(in srgb,var(--accent) 14%,transparent)}.band:before{content:"";position:absolute;left:0;top:0;bottom:0;width:1px;background:var(--accent)}.mini>span{position:absolute;left:-40px;top:8px;width:34px;text-align:right}
.rail{flex:0 0 303px;min-width:0;border-left:1px solid var(--chip);padding:16px;display:flex;flex-direction:column;justify-content:space-between;gap:12px}
.rl{display:flex;justify-content:space-between;align-items:baseline;gap:8px;min-height:16px;font-size:12px;color:var(--muted);white-space:nowrap}.rl b{font-weight:400;color:var(--ink)}.rl>.cap{flex:1;min-width:0;text-align:right;overflow:hidden;text-overflow:ellipsis}
.big{display:flex;align-items:baseline;gap:6px;margin-top:8px}#j-last{font-size:44px;font-weight:500;letter-spacing:-.05em;line-height:1}#j-last.hot{color:var(--accent)}.big small{font-size:14px;color:var(--faint)}
.trk{display:flex;align-items:center;gap:8px}.nd{font-size:11px;line-height:20px;color:var(--muted);border:1px solid var(--spark);border-radius:4px;padding:0 6px}
.wire{position:relative;flex:1;height:14px;clip-path:inset(-12px 0)}.wire:before{content:"";position:absolute;left:0;right:0;top:6px;height:2px;background:repeating-linear-gradient(90deg,var(--line) 0 4px,transparent 4px 8px)}
.lane{position:absolute;inset:0;animation:fly var(--d) cubic-bezier(.45,0,.55,1) both}.pk{position:absolute;left:0;top:3px;width:8px;height:8px;border-radius:50%;background:var(--accent);box-shadow:0 0 10px 2px color-mix(in srgb,var(--accent) 85%,transparent);animation:turn var(--d) linear both}
.pk:after{content:"";position:absolute;right:100%;top:3px;width:26px;height:2px;border-radius:1px;background:linear-gradient(90deg,transparent,var(--accent))}.tc{margin-top:8px}
.wb{position:relative;height:16px;margin-top:8px}.wb .bg,.wb .fl{position:absolute;left:0;right:0;top:5px;height:6px;border-radius:3px}.wb .bg{background:var(--chip)}.wb .fl{background:linear-gradient(90deg,var(--done),var(--accent));transform-origin:left;transform:scaleX(0);transition:transform .35s cubic-bezier(.2,.9,.2,1)}
.wb .tkl{position:absolute;inset:0;transition:transform .35s cubic-bezier(.2,.9,.2,1)}.wb .tkl i{position:absolute;left:-1px;top:1px;width:2px;height:14px;border-radius:1px;background:var(--ink)}.wl{display:flex;justify-content:space-between;gap:8px;margin-top:4px;white-space:nowrap}
.ft{display:grid;grid-template-columns:minmax(0,1fr) 40px 56px 48px;gap:8px;align-items:center;height:24px;font-size:12px;border-bottom:1px solid var(--hover)}.ft.h{height:20px;font-size:11px;border-bottom-color:var(--chip)}.ft>:not(:first-child){text-align:right}.ft .k{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.ft .k.hit{color:var(--accent)}.ft .p{color:var(--muted)}
.rb{height:4px;border-radius:2px;background:var(--chip);overflow:hidden}.rb i{display:block;height:100%;background:var(--muted);transform-origin:left;transform:scaleX(0);transition:transform .35s cubic-bezier(.2,.9,.2,1)}
.fs{display:flex;flex-direction:column;min-height:0}.st{display:grid;grid-template-columns:minmax(0,1fr) 48px 48px 36px 48px;gap:8px;align-items:center;padding:0 16px}.st.h{min-height:28px;border-bottom:1px solid var(--hover)}.st>:not(:first-child){text-align:right}
#stages{flex:1;display:flex;flex-direction:column}button.st{flex:1 1 0;min-height:48px;width:100%;text-align:left;border-bottom:1px solid var(--hover)}button.st:hover{background:var(--hover)}button.st[aria-pressed=true]{background:var(--raised)}
.sn{display:flex;flex-direction:column;gap:2px;min-width:0}.sn .a{display:flex;align-items:center;gap:8px;min-width:0;white-space:nowrap}.sn b{font-weight:500}.sn .d{min-height:16px;padding-left:14px;color:var(--muted);font-size:12px;line-height:16px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.sd{flex:none;width:6px;height:6px;border-radius:50%;background:var(--done)}.busy .sd{background:var(--muted)}.err .sd{background:var(--err)}.hit .sd{background:var(--accent);box-shadow:0 0 8px 2px color-mix(in srgb,var(--accent) 80%,transparent)}
.st .v{font-size:12px}.hit .v.f{color:var(--accent)}.st .v.g{color:var(--muted)}.st .v.r{color:var(--faint)}.st .v.r.er{color:var(--err)}.st svg{width:48px;height:16px;justify-self:end}.st polyline{fill:none;stroke:var(--done);stroke-width:1.25}.st polyline.er{stroke:var(--err)}
.row3{display:grid;grid-template-columns:minmax(0,1fr) 304px;gap:16px;min-width:0}
.flt{color:var(--faint);font-size:12px;white-space:nowrap}.lnk{color:var(--accent);min-height:28px;font-size:12px;white-space:nowrap}.resume{margin-left:auto;height:24px;padding:0 10px;border-radius:999px;background:var(--accent);color:var(--on-accent);font-size:11px;white-space:nowrap}
.tw{overflow-x:auto}#rc{min-width:460px;list-style:none;margin:0;padding:0}#rc li{height:32px;border-bottom:1px solid var(--hover)}#rc li:last-child{border-bottom:0}
.cr{width:100%;height:100%;display:grid;grid-template-columns:64px 64px minmax(0,1fr) 56px 40px;gap:12px;align-items:center;padding:0 16px;text-align:left;font-size:12px;transition:background-color .6s ease-out}.cr:hover{background:var(--hover)}.cr.on{background:var(--raised)}.cr .v b{font-weight:400}#rc li.in .cr{background:color-mix(in srgb,var(--accent) 9%,var(--paper))}
.cr>span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}.cr .t{color:var(--faint)}#rc li.in .cr .t{color:var(--ink)}.cr .f{color:var(--muted)}.cr .v i{font-style:normal;color:var(--faint)}.cr .ms,.cr .tk{text-align:right;color:var(--faint)}.cr .ms.slow{color:var(--ink)}.cr .ms.w{color:var(--warn)}.cr .ms.e{color:var(--err)}.cr .ms.run{color:var(--accent)}
.bs{display:flex;flex-direction:column}.bs .ph .cap{flex:1;min-width:0;text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.bb{flex:1;display:flex;flex-direction:column;padding:12px 16px;min-height:0}
.bv{display:flex;align-items:baseline;gap:8px;height:24px;margin-bottom:4px;min-width:0}#basis-verdict{font-size:16px;font-weight:500;white-space:nowrap}#basis-code{color:var(--muted);font-size:12px;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
#basis-q{list-style:none;margin:0;padding:0}.bq{display:grid;grid-template-columns:minmax(0,1fr) auto 64px;gap:12px;align-items:center;height:24px;border-top:1px solid var(--hover);font-size:12px}.bq:empty{border-top-color:transparent}.bq .k{color:var(--muted);overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.bq .a{max-width:96px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.qb{display:flex;align-items:center;gap:6px}.qb .tr{position:relative;flex:1;height:2px;background:var(--line)}.qb .tr i{position:absolute;inset:0;background:var(--ink);transform-origin:left}.qb .tr i.lo{background:var(--done)}.qb .tr b{position:absolute;top:-3px;width:1px;height:8px;background:var(--muted)}.qb .p{color:var(--muted)}
.pr{flex:1;display:flex;flex-direction:column;justify-content:flex-end;margin-top:12px;padding-top:8px;border-top:1px solid var(--hover)}.prh{display:flex;align-items:center;gap:8px;height:16px;white-space:nowrap}.prh a{margin-left:auto;text-decoration:none;font-size:12px;color:var(--accent)}.prh a[aria-disabled=true]{visibility:hidden}
.pb{position:relative;flex:1;min-height:24px;max-height:104px;display:flex;align-items:flex-end;gap:2px;margin-top:8px;border-top:1px dashed var(--line);border-bottom:1px solid var(--line)}.pb .s{position:absolute;right:0;top:-9px;padding-left:6px;background:var(--paper)}
.pb i{flex:1;height:100%;border-radius:1px 1px 0 0;background:var(--done);transform-origin:bottom;transform:scaleY(0)}.pb i.on{background:var(--accent)}
#run-list{display:flex;flex-direction:column;min-height:0;contain:size}#run-list .ph{padding-right:16px}
.rt{display:flex;gap:16px;margin-left:auto;align-self:stretch}.rt button{font-size:12px;color:var(--faint);border-bottom:2px solid transparent;padding-top:2px;white-space:nowrap}.rt button:hover{color:var(--ink)}.rt button[aria-pressed=true]{color:var(--ink);border-bottom-color:var(--ink)}.rt .n{color:var(--faint)}.rt .n.er{color:var(--err)}
#runs{list-style:none;margin:0;padding:0;flex:1;min-height:0;overflow:auto;overscroll-behavior:contain}#runs li{border-bottom:1px solid var(--hover)}#runs li.empty{padding:16px;color:var(--muted)}
.row{display:grid;grid-template-columns:minmax(0,1fr) minmax(56px,auto);align-content:center;gap:2px 12px;height:48px;padding:0 16px;text-decoration:none;transition:background-color .15s ease-out}.row:hover{background:var(--hover)}
.row .a{display:flex;align-items:center;gap:8px;min-width:0;line-height:18px}.row .a i{flex:none;width:6px;height:6px;border-radius:50%;background:var(--done)}.row.run .a i{background:var(--accent)}.row.er .a i{background:var(--err)}.row.wa .a i,.row.past .a i{background:var(--muted)}
.row .nm{font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.row .h{flex:none;color:var(--faint);font-size:12px}.row .ago,.row .du{text-align:right;line-height:18px;white-space:nowrap}.row .du{line-height:16px}
.row .sub{padding-left:14px;font-size:12px;line-height:16px;color:var(--muted);overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.row.er .sub{color:var(--err)}
.tg{display:grid;grid-template-columns:minmax(0,1fr) 368px;gap:16px;align-items:start}.rh{grid-column:1/-1}.rh h1{font-size:15px;font-weight:600;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.rh .ph>.cap{flex:none;margin-left:auto}
.rst{display:inline-flex;align-items:center;gap:8px;font-size:12px;color:var(--muted);white-space:nowrap}.rst i{width:6px;height:6px;border-radius:50%;background:var(--done)}.rst.run i{background:var(--accent);animation:blink 1.6s steps(5) infinite}.rst.er i{background:var(--err)}.rst.wa i,.rst.past i{background:var(--muted)}
.rk{display:grid;grid-template-columns:repeat(4,minmax(0,1fr)) 367px}.rk .kpi+.kpi{border-left:1px solid var(--chip)}.rk .kn{font-size:22px;letter-spacing:-.03em;white-space:nowrap}
.tlh,.sx{display:grid;grid-template-columns:200px minmax(0,1fr) 72px;gap:16px;align-items:center;padding:0 16px}.tlh{height:32px;border-bottom:1px solid var(--chip)}.tlh>span{font-family:inherit}.tlh>span:last-child{text-align:right}
.ruler{position:relative;height:16px}.ruler span{position:absolute;white-space:nowrap}
#trace{list-style:none;margin:0;padding:0}#trace li.empty{padding:16px;color:var(--muted)}.sx{width:100%;height:48px;text-align:left;border-bottom:1px solid var(--hover);transition:background-color .15s ease-out}.sx:hover,.sx[aria-pressed=true]{background:var(--hover)}
.sx .nm{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.sx .nm b{font-weight:500}.sx .nm span{color:var(--faint)}.sx .du{text-align:right;font-size:12px;white-space:nowrap}.sx .du.none{color:var(--done)}
.bar{position:relative;display:block;height:20px}.bar:before{content:"";position:absolute;left:0;right:0;top:10px;height:1px;background:var(--chip)}.bar i{position:absolute;top:5px;height:10px;min-width:3px;border-radius:2px;background:var(--muted);transform-origin:left}.grown .bar i{animation:grow .45s cubic-bezier(.2,.8,.2,1) both}
.sx[aria-pressed=true] .bar i,.bar i.run{background:var(--accent)}.bar i.e{background:var(--err)}.bar em{position:absolute;top:2px;font-style:normal;white-space:nowrap;max-width:60%;overflow:hidden;text-overflow:ellipsis}
.sdb{padding:16px}.res{font-size:18px;font-weight:500;margin-top:4px;overflow-wrap:anywhere}.sdb .kl{margin-top:16px}
.kvl{margin:16px 0 0;display:grid;grid-template-columns:88px minmax(0,1fr)}.kvl dt,.kvl dd{font-size:12px;line-height:16px;padding:8px 0;border-top:1px solid var(--chip)}.kvl dt{color:var(--faint);padding-right:8px}.kvl dd{margin:0;min-width:0;overflow-wrap:anywhere}.kvl .line{display:block}
.tag{white-space:nowrap;font-size:11px;padding:0 6px;border-radius:4px;border:1px solid var(--line)}.tag.ok{color:var(--ok)}.tag.er{color:var(--err)}
.raw{border-top:1px solid var(--chip)}.raw summary{cursor:pointer;color:var(--muted);font-size:12px;min-height:40px;display:flex;align-items:center}.raw pre{margin:0 0 4px;padding:12px;border-radius:6px;background:var(--bg);border:1px solid var(--line);font-size:11px;color:var(--muted);white-space:pre-wrap;overflow-wrap:anywhere}.raw .kvl{margin:0 0 12px}
.still .edge-l,.still .live-btn i,.still .rst i{animation:none}.still .roll{transition:none}
@media (prefers-reduced-motion:reduce){*,:before,:after{animation:none!important;transition:none!important}.lane,.stem{display:none}}
@media (max-width:1280px){.kp{grid-template-columns:repeat(4,minmax(0,1fr))}}
@media (max-width:1100px){.grid,.tg{grid-template-columns:minmax(0,1fr);grid-template-rows:none;min-height:0}.kp{grid-template-columns:repeat(2,minmax(0,1fr))}.kp .kpi:nth-child(3){border-left:0}.kp .kpi:nth-child(n+3){border-top:1px solid var(--chip)}.row3{grid-template-columns:minmax(0,1fr)}.jb{flex-wrap:wrap}.rail{flex-basis:100%;border-left:0;border-top:1px solid var(--chip)}#run-list{contain:none}#runs{max-height:480px}.rk{grid-template-columns:repeat(auto-fit,minmax(140px,1fr))}.rk .kpi+.kpi{border-left:0}}
@media (max-width:640px){header,main,#notice{padding-left:16px;padding-right:16px}.tabs{margin-left:0}.ctl{margin-left:0}.kp{grid-template-columns:minmax(0,1fr)}.kp .kpi+.kpi{border-left:0;border-top:1px solid var(--chip)}.crumb{flex-basis:100%}.ph .desc{display:none}#t-rate{order:3;flex-basis:100%;min-height:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.rh h1{flex-basis:100%}.ph{flex-wrap:wrap;padding-top:6px;padding-bottom:6px}.rt{flex-wrap:wrap;gap:4px 16px}.ruler span:nth-child(2),.ruler span:nth-child(4),.ruler span:nth-child(5){display:none}#rc{min-width:0}.cr{grid-template-columns:58px 52px minmax(0,1fr) 48px;gap:8px}.cr .tk{display:none}.st{grid-template-columns:minmax(0,1fr) 40px 40px 32px}.st>:nth-child(5){display:none}.sn .a{overflow:hidden}.tlh,.sx{grid-template-columns:minmax(0,1fr) auto;grid-template-areas:"n d" "b b";row-gap:6px}.tlh>.ruler,.sx>.bar{grid-area:b}.tlh{height:auto;padding-top:8px;padding-bottom:8px}.sx{height:auto;min-height:56px;padding-top:8px;padding-bottom:8px}}
</style></head><body><a class="skip-link" href="#main" data-i18n="skip">본문으로 이동</a>
<div class="top"><header>
<div class="brand"><svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2 22 20H2z" fill="currentColor"/></svg><a class="home" href="#">Jev Gate</a><a class="ver m" id="version-badge" href="https://github.com/MongLong0214/jev-gate/releases/latest" target="_blank" rel="noopener noreferrer" aria-label="플러그인 버전 및 최신 릴리즈" data-en-aria="Plugin version and latest release" hidden></a></div>
<nav class="crumb" id="crumb" aria-label="위치" data-en-aria="Location" hidden><span class="sep" aria-hidden="true">/</span><a href="#" data-i18n="overview">개요</a><span class="sep" aria-hidden="true">/</span><span id="crumb-run"></span><span class="m cap" id="crumb-id"></span></nav>
<div class="tabs" id="host-filters" role="group" aria-label="호스트" data-en-aria="Host"><button type="button" data-host="all" aria-pressed="true" data-i18n="all">전체</button><button type="button" data-host="claude" aria-pressed="false">Claude Code</button><button type="button" data-host="codex" aria-pressed="false">Codex</button></div>
<div class="ctl"><button type="button" class="chk" id="recording" role="checkbox" aria-checked="true" data-i18n="recording">기록</button><button type="button" class="chk" id="dashboard-auto" role="checkbox" aria-checked="true" data-i18n="autoOpen">자동 열기</button><button type="button" class="live-btn" id="pause" aria-pressed="false"><i aria-hidden="true"></i><span class="m" id="connection">연결 중</span></button><button type="button" class="tb" id="theme"></button><button type="button" class="tb" id="language"></button></div>
</header></div>
<p id="notice" role="status"></p>
<main id="main">
<div class="grid" id="overview">
<section class="panel kp" aria-label="지표" data-en-aria="Metrics">
<div class="kpi"><div class="kl" data-i18n="kRuns">진행 중 실행</div><div class="kv"><span class="m kn" id="k-active">0</span><span class="m ks" id="k-hosts">Claude 0 · Codex 0</span></div></div>
<div class="kpi"><div class="kl" data-i18n="kToday">Jev 호출 · 오늘</div><div class="kv"><span class="m kn roller" id="k-today" role="img" aria-label="0"></span><span class="m ks acc" id="k-rate">+0/min</span></div></div>
<div class="kpi"><div class="kl" data-i18n="kLatency">응답 시간</div><div class="kv"><span class="m kn"><span id="j-p50">–</span><small id="j-p50-u"></small></span><span class="m ks" id="j-p95">p50 · p95 –</span></div></div>
<div class="kpi"><div class="kl" data-i18n="kCost">추정 Jev 비용 · 오늘</div><div class="kv"><span class="m kn" id="j-cost">–</span><span class="m ks" id="k-tok">– tok</span><span class="ks er" id="credit"></span></div></div>
</section>
<button type="button" class="panel kpi att" id="attention" aria-controls="run-list"><span class="kl" data-i18n="attention">확인 필요</span><span class="kv"><span class="m kn" id="k-att">0</span><span class="ks" id="k-diag"></span></span></button>
<section class="panel tp" aria-labelledby="tp-h">
<div class="ph"><h2 id="tp-h" data-i18n="traffic">Jev 호출</h2><span class="desc" data-i18n="trafficHint">점 1개 = 호출 1건 · 높이 = 응답 시간</span><span class="m cap" id="t-rate"></span><div class="seg" id="windows" role="group" aria-label="표시 구간" data-en-aria="Window"><button type="button" class="m" data-win="60000" aria-pressed="true">60s</button><button type="button" class="m" data-win="300000" aria-pressed="false">5m</button><button type="button" class="m" data-win="900000" aria-pressed="false">15m</button></div></div>
<div class="jb"><div class="plot">
<div class="sc" id="scatter" role="img">
<div class="yt z" style="bottom:0"><span class="m cap">0</span></div><div class="yt" style="bottom:28.571%"><span class="m cap"></span></div><div class="yt" style="bottom:57.143%"><span class="m cap"></span></div><div class="yt" style="bottom:85.714%"><span class="m cap"></span></div>
<div class="p50l" id="s-p50" aria-hidden="true" hidden><span class="m"></span></div><div class="edge" aria-hidden="true"></div><div class="edge-l" aria-hidden="true"></div><div id="dots"></div>
<div class="tip" id="tip" role="tooltip" hidden><div class="m cap" id="tip-a"></div><div class="m v" id="tip-b"></div><div class="m cap c" id="tip-c"></div></div>
</div>
<div class="m cap ax" id="axis" aria-hidden="true"></div>
<div class="mini"><svg id="mini" role="img" aria-label="최근 60분 Jev 호출 수" data-en-aria="Jev calls in the last 60 minutes" viewBox="0 0 600 40" preserveAspectRatio="none"><path id="mini-a" d=""/><path id="mini-l" d="" vector-effect="non-scaling-stroke"/></svg><div class="band" id="band" aria-hidden="true"></div><span class="m cap" data-i18n="min60">60분</span></div>
</div>
<div class="rail">
<div><div class="rl"><span data-i18n="jLast">마지막 왕복</span><span class="m cap" id="j-last-meta">–</span></div><div class="big"><span class="m" id="j-last">–</span><small class="m" id="j-last-u"></small></div></div>
<div><div class="trk"><span class="m nd">Gate</span><div class="wire" id="j-wire" aria-hidden="true"></div><span class="m nd">Jev</span></div><div class="cap tc" data-i18n="replay">최근 호출의 왕복을 실제 걸린 시간 그대로 재생</div></div>
<div><div class="rl"><span data-i18n="oneSec">1초 기준</span><span class="m cap"><b id="j-within">–</b> <span data-i18n="within">1초 안에 응답</span></span></div><div class="wb" aria-hidden="true"><span class="bg"></span><span class="fl" id="j-p95bar"></span><span class="tkl" id="j-p50tick"><i></i></span></div><div class="m cap wl"><span>0</span><span id="j-pp"></span><span>1000ms</span></div></div>
<div id="j-feats"><div class="m cap ft h"><span data-i18n="thFeature">기능</span><span data-i18n="thCount">건수</span><span>p50</span><span data-i18n="thShare">비율</span></div></div>
</div></div>
</section>
<section class="panel fs" aria-labelledby="fs-h"><div class="ph"><h2 id="fs-h" data-i18n="features">기능별 상태</h2><span class="m cap">24h</span></div><div class="m cap st h"><span></span><span data-i18n="fired">발화</span><span data-i18n="applied">적용</span><span data-i18n="regress">회귀</span><span data-i18n="trend">추이</span></div><div id="stages"></div></section>
<div class="row3">
<section class="panel" aria-labelledby="lg-h"><div class="ph"><h2 id="lg-h" data-i18n="receipts">호출 로그</h2><span class="flt" id="log-filter"></span><button type="button" class="lnk" id="log-clear" data-i18n="clearFilter" hidden>필터 해제</button><button type="button" class="resume m" id="log-resume" hidden></button></div><div class="tw"><ol id="rc"><li></li><li></li><li></li><li></li><li></li><li></li><li></li><li></li></ol></div></section>
<aside class="panel bs" id="basis" aria-labelledby="bs-h"><div class="ph"><h2 id="bs-h" data-i18n="basis">판단 근거</h2><span class="m cap" id="basis-meta">–</span></div><div class="bb"><div class="bv"><span class="m" id="basis-verdict">–</span><span id="basis-code"></span></div><ul id="basis-q"><li class="bq"></li><li class="bq"></li><li class="bq"></li><li class="bq"></li><li class="bq"></li><li class="bq"></li></ul><div class="pr"><div class="cap prh"><span id="basis-peers"></span><a id="basis-trace" href="#" aria-disabled="true" data-i18n="traceLink">트레이스 →</a></div><div class="pb" id="basis-bars" role="img"><span class="m cap s" aria-hidden="true">1s</span></div></div></div></aside>
</div>
<section class="panel" id="run-list" aria-labelledby="rn-h"><div class="ph"><h2 id="rn-h" data-i18n="runs">실행</h2><div class="rt" id="state-filters" role="group" aria-label="상태" data-en-aria="State"><button type="button" data-state="all" aria-pressed="true"><span data-i18n="all">전체</span> <span class="m n" id="n-all">0</span></button><button type="button" data-state="attention" aria-pressed="false"><span data-i18n="attention">확인 필요</span> <span class="m n er" id="n-attention">0</span></button><button type="button" data-state="active" aria-pressed="false"><span data-i18n="active">진행 중</span> <span class="m n" id="n-active">0</span></button></div></div><ul id="runs"></ul></section>
</div>
<div class="tg" id="trace-view" hidden>
<section class="panel rh" aria-labelledby="rd-name"><div class="ph"><h1 id="rd-name"></h1><span class="rst" id="rd-state"><i aria-hidden="true"></i><span></span></span><span class="m cap" id="rd-meta"></span></div><div class="rk" id="rd-stats"></div></section>
<section class="panel" aria-labelledby="tl-h"><div class="ph"><h2 id="tl-h" data-i18n="timeline">타임라인</h2><span class="desc" data-i18n="timelineHint">시작·종료 이벤트를 한 구간으로 묶었습니다</span></div><div class="m cap tlh"><span data-i18n="dStep">단계</span><div class="ruler" id="ruler" aria-hidden="true"></div><span data-i18n="hDuration">소요</span></div><ol id="trace"></ol></section>
<aside class="panel" id="step-detail" aria-labelledby="sd-h"><div class="ph"><h2 id="sd-h"></h2></div><div class="sdb" id="sd-body"></div></aside>
</div>
</main>
<script>
const EN={skip:'Skip to content',overview:'Overview',all:'All',recording:'Recording',autoOpen:'Auto open',kRuns:'Running executions',kToday:'Jev calls · today',kLatency:'Response time',kCost:'Est. Jev cost · today',attention:'Needs review',active:'Running',traffic:'Jev calls',trafficHint:'One dot = one call · height = response time',min60:'60m',jLast:'Last round trip',replay:'Replays recent round trips at their real duration',oneSec:'1 s target',within:'answered within 1 s',thFeature:'Feature',thCount:'Calls',thShare:'Share',features:'Feature status',fired:'Fired',applied:'Applied',regress:'Regr.',trend:'Trend',receipts:'Call log',clearFilter:'Clear filter',basis:'Decision basis',traceLink:'Trace →',runs:'Executions',timeline:'Timeline',timelineHint:'Start and end events merged into one span',dStep:'Stage',hDuration:'Duration'};
const PHRASES=[
['Agent 호출 거절','Agent call denied'],['호출 거절','Call denied'],
['판정 비용 회수 여지 부족 · 원본 유지','Insufficient potential to repay assessment cost · original kept'],
['모델 · 응답 대기','Model · Awaiting response'],['모델 · 요청 실패','Model · Request failed'],['모델 응답 대기','Awaiting model response'],['모델 요청 종료 기록 확인','Model request termination recorded'],['모델 응답 기록 없음 · 현재 활동 미관측','No model response recorded · no current activity observed'],['호스트 모델 요청 실패','Host model request failed'],['전달 모델 ','Submitted model '],['전달 effort ','Submitted effort '],['호스트 기본값','Host default'],

['캐시 재사용을 위해 effort 유지','Effort retained to reuse the cache'],['Jev 제안','Jev proposal'],['요청 설정','Request setting'],
['Jev 호출 생략','Jev assessment skipped'],['Jev 크레딧 소진','Jev credit exhausted'],['Jev가 402(결제 필요)를 반환했습니다. 충전 후 다음 요청부터 자동으로 풀립니다.','Jev returned 402 (payment required). It clears on the first successful request after you top up.'],['Jev 크레딧 소진 · 원래 호스트 설정 유지','Jev credit exhausted · host setting kept'],['Jev 기능이 꺼져 있음','Jev features are off'],['Router가 꺼져 있음','Router is off'],['Jev API 키 없음','No Jev API key'],['턴 중단으로 판단 생략','Assessment skipped because the turn was interrupted'],['호스트 모델 목록에서 현재 모델을 확인할 수 없음','Current model is absent from the host catalog'],['변경 가능한 모델·effort 없음','No mutable model or effort'],
['오류 확인','Error reported'],['결과 미관측','Outcome unobserved'],['사용자 중단','Interrupted by user'],['호스트가 실패를 보고함','Host reported a failure'],['종료 코드','Exit code'],['도구 오류','Tool error'],['Jev 정책 오류와 별도','Separate from a Jev policy error'],['사용자 중단 관측 · 성공이나 기능 오류로 분류하지 않음','User interruption recorded · neither success nor a feature failure'],['턴 또는 세션 종료 · 이 호출의 결과 이벤트는 미관측','Turn or session ended · this call has no observed result'],['결과 이벤트 미관측 · 실행 성공·실패를 판단할 수 없음','No result event observed · execution outcome is unknown'],['호스트 훅이 모든 도구 경로의 종료를 보장하지 않습니다. 원래 호스트에서 해당 도구 결과를 확인하세요.','Host hooks do not cover every tool path. Check the tool result in the original host.'],
['턴 설정 결정','Turn settings selected'],['Codex 적용 확인','Codex application verified'],['선택한 설정 적용 확인','Selected settings verified'],['선택과 실행 설정 불일치','Selected and observed settings differ'],['실제 Codex 모델 요청','Actual Codex inference request'],['선택 결과 · 실제 적용은 모델 요청에서 확인','Selection recorded · application verified at the inference request'],['Codex Ultra 선택 확인','Native Codex Ultra selection verified'],['네이티브 추론 요청 effort','Native inference request effort'],['Codex가 변환한 값','Value resolved by Codex'],['압축 전','Before compaction'],['선택 ','Selected '],['모델 ','Model '],
['에이전트 생성 응답 · 작업 완료 여부는 별도 관측','Agent spawn receipt · completion observed separately'],['종료 훅 관측 · Jev 계약 수락 검사 없음','Stop event observed · no Jev contract acceptance'],['Codex 호스트 이벤트','Codex host event'],['호스트 이벤트','Host event'],['이 호스트에서 미지원','Unsupported on this host'],['관측 전용','Observation only'],['Codex · 도구와 에이전트','Codex · tools and agents'],['Codex · 세션 시작','Codex · session started'],['Codex · 세션 종료','Codex · session ended'],['Codex · 턴 시작','Codex · turn started'],['Codex · 턴 종료 이벤트','Codex · turn stop event'],['Codex · 도구 시작','Codex · tool started'],['Codex · 도구 결과','Codex · tool result'],['Codex · 에이전트 시작','Codex · agent started'],['Codex · 에이전트 종료 이벤트','Codex · agent stop event'],['Codex · 사용자 중단','Codex · interrupted'],['기록원 읽기 불가','Source unavailable'],['실행 기록 없음','No execution record'],['기록원 미설정','Source unavailable'],['기록 대기','Awaiting record'],['읽기 불가','Unreadable'],['새 기록 대기','Waiting for next event'],['관측 기록 없음','No recorded activity'],['개 단계 진행 중',' stages in progress'],['진행 중 · 응답 대기','Running · awaiting response'],['결과 미확인','Result unconfirmed'],['확인 필요','Needs review'],['지난 오류','Past error'],['진행 중','Running'],['건너뜀','Skipped'],['완료','Complete'],['오류','Error'],['실시간 연결','Live connection'],['재연결 중','Reconnecting'],['응답 오류','Response error'],['연결됨 · 화면 일시정지','Connected · view paused'],['실시간 재개','Resume live'],['실시간 일시정지','Pause live'],['갱신 ','Updated '],
['요청의 실행 형태 선택','Choose execution path'],['워커 등급','Worker tier'],['Agent 실행과 수락','Agent execution and acceptance'],['모델·effort 선택','Model and effort selection'],['요약 대신 digest 구성','Build digest instead of summary'],['독립 문맥 인계','Independent context handoff'],['호스트 이벤트별 독립 실행','Independent host event paths'],['직접 처리 ↘ root','Direct ↘ root'],['위임 →','Delegate →'],['후보 검색','Find candidates'],
['선택한 실행','Selected run'],['실행 요청','User request'],['호스트가 제출한 작업','Work submitted by host'],['선택형 판정','Typed judgment'],['코드 정책','Code policy'],['적용 여부 결정','Apply or preserve'],['확률·제약·안전 조건','Probabilities · constraints · rules'],['실제 실행','Actual execution'],['모델·도구·수락 결과','Model · tool · acceptance'],['Jev 응답','Jev response'],['기록 없음','No record'],['선택형 결과 기록 대기','Awaiting typed result'],['유형 판단',' typed judgments'],['결정 기록 대기','Awaiting code decision'],['원래 경로 보존 가능','Original path may be preserved'],['호스트 결과','Host result'],['실행 기록 대기','Awaiting execution record'],['관측된 결과만 표시','Showing observed results only'],
['실제 모델 관측 · 요청 모델 미확인','Actual model observed · requested model unverified'],['Router · 요청 전달 준비','Router · Request preparation'],['변경 설정 전달 준비 · 실행 응답 확인은 별도','Changed settings prepared · response confirmation is separate'],['기존 설정 전달 준비 · 실행 응답 확인은 별도','Native settings prepared · response confirmation is separate'],['요청 전 점검만 기록됨 · Jev 새 호출이나 실제 모델 응답 완료를 뜻하지 않음','Pre-request checks only · not a new Jev call or a completed model response'],['호스트가 에이전트 생성을 거부함 · 실행되지 않음','Host refused agent creation · no execution'],['전체 실행','All executions'],['Gate A · 실행 형태','Gate A · Execution path'],['Gate B · 등급 배정','Gate B · Tier allocation'],['워커 · 수락 검사','Worker · Acceptance'],['Router · 모델과 effort','Router · Model and effort'],['Compact · 요약 대체','Compact · Summary replacement'],
['워커 호출','Worker dispatch'],['백그라운드 실행 준비','Background dispatch prepared'],['백그라운드 워커 실행','Background worker running'],['메인 대화 계속','Main conversation continues'],['백그라운드 워커 종료','Background worker ended'],['원래 작업에 실행 예약 연결 · 시작 확인 대기','Execution reserved for original job · waiting for start'],['시작과 실제 종료 연결됨','Launch linked to observed termination'],['시작 기록 있음 · 종료 결과 미관측','Launch recorded · terminal result unobserved'],['워커 실행 중 · 메인에서 질문 가능','Worker running · main available for questions'],['시작 알림은 완료·수락 결과가 아닙니다','A launch receipt is not completion or acceptance'],['원래 작업 유지 · 종료 결과 대기 ','Original job retained · awaiting terminal results '],['호스트에서 실제 종료 확인 · 계약 수락은 별도 검사','Native termination observed · contract acceptance checked separately'],['호스트에서 중단·실패 확인 · 성공 수락 없음','Native interruption or failure observed · no success accepted'],['이전 작업 결과 · 현재 작업 미진행','Retired result · current task unchanged'],['워커 결과 · 수락 판정','Worker result · Acceptance'],['Agent 호출 결과 · 계약 판정 없음','Agent result · No contract verdict'],['호스트 호출 실패','Host invocation failed'],['턴 종료','Turn ended'],['문맥 선택','Context selection'],['등급 결정','Tier decision'],['실행 형태','Execution path'],['요약 대체','Summary replacement'],['수락 검사','Acceptance'],['의존성','Dependencies'],['압축','Compaction'],
['응답 기록과 연결됨','Matched with response record'],['응답을 기다리는 중','Awaiting response'],['응답 기록 없음 · 진행 여부 미확인','No response record · status unknown'],['전송 없이 원래 경로 유지','Original path preserved without sending'],['응답 기록됨','Response recorded'],['응답 기록 · 선택형 결과 미확인','Response recorded · typed result unavailable'],['선택형 응답 · 코드가 정책 판정에 사용',' typed answers · used by code policy'],['Jev 요청 전송 · 응답 대기','Jev request sent · awaiting response'],['전송 안 함','Not sent'],['등록되지 않은 하위 실행 · 원래 설정 유지','Unregistered child run · host setting kept'],['라우팅이 멈춘 하위 실행 · 원래 설정 유지','Child run with routing stopped · host setting kept'],['Jev 전송 없음','Jev not sent'],['전송 여부 기록 없음','Send status unrecorded'],['사용량 미기록','Usage unrecorded'],['요청 변경 모델','Requested model change'],['요청 변경 effort','Requested effort change'],['기존 모델','Previous model'],['기존 effort','Previous effort'],['모델 이유','Model reason'],['effort 이유','Effort reason'],['실제 적용 effort','Applied effort'],['관측 모델','Observed model'],['요청 모델','Requested model'],['실행 모델','Observed model'],['호출 모델','Called model'],['모델 고정','Model pinned'],['원래 프로필','Original profile'],['요청 등급','Requested tier'],['세션 문맥','Session context'],['실행 floor','Execution floor'],['호스트 창','Host window'],['계산에 사용한 루트 턴','Estimated root turns'],['위임 가격 계산','Delegation cost estimate'],['측정된 절감 아님','Not measured savings'],
['필수','Required'],['근거','Basis'],['Jev 호출','Jev calls'],['캐시','Cache'],['후보','Candidates'],['작업','Tasks'],['요청 ','Requested '],['적용 ','Applied '],['worker 보고 pass','Worker reported pass'],['미실행','Not run'],['실행 기록','Execution record'],['모순','Contradicted'],['미관측','Unobserved'],['변경 전 통과','Passed before the last change'],['계약 판정 없음','No contract verdict'],['계약 수락','Contract accepted'],['계약 미충족','Contract not met'],['판정 미확인','Verdict unknown'],['새 작업으로 교체됨','Replaced by a newer task'],['워커 응답 형식 오류','Invalid worker reply'],['워커 응답 없음','No worker reply'],['통과 보고 검사가 실행 기록에서 실패','Reported pass failed in the worker transcript'],['통과 보고 검사의 실행 미관측','Reported pass not seen in the worker transcript'],['마지막 변경 전의 통과 기록','Pass recorded before the last change'],['워커가 차단·재계획 보고','Worker reported blocked or replan'],['필수 검사 보고 미충족','Required checks not met in the report'],['이전 세대의 늦은 결과 · 현재 작업 미진행','Late result from previous generation · current task unchanged'],['거절','Denied'],['현재 작업에 필요한 근거 선택','Current task dependencies selected'],['기존 최근순 유지','Existing recency kept'],['선별할 과거 결과 없음','No past results to select'],['Jev 선별 꺼짐','Jev selection off'],['민감정보 감지 · 로컬 유지','Sensitive input detected · local compaction kept'],['판정 입력 한도 초과 · 로컬 유지','Judgment input limit · local compaction kept'],['Jev 응답 시간 초과 · 로컬 유지','Jev timed out · local compaction kept'],['유효하지 않은 판정 · 로컬 유지','Invalid judgment · local compaction kept'],['중단 · 판정 미적용','Interrupted · judgment not applied'],['새 턴으로 변경 · 판정 미적용','Turn changed · judgment not applied'],['선별 오류 · 로컬 유지','Selection error · local compaction kept'],['Jev 연결 오류 · 로컬 유지','Jev connection error · local compaction kept'],['Jev 인증 실패 · 로컬 유지','Jev authentication failed · local compaction kept'],['Jev 인증 확인 필요 · 로컬 유지','Jev credentials need review · local compaction kept'],['실행 중인 Jev 요청 한도 · 로컬 유지','Jev request capacity · local compaction kept'],['Jev 입력','Jev input'],['작업 근거 선택 → digest 구성','Dependencies → digest'],['Jev + 로컬','Jev + local'],['Jev 작업 의존 근거 선택','Jev task dependencies'],['Jev 전송 여부 미확인','Jev dispatch unconfirmed'],['필수 근거','Selected dependencies'],['대화 압축 시작','Conversation compaction started'],['호스트 압축으로 넘김','Deferred to host compaction'],['로컬 digest 적용 · 요약 모델 호출 대체','Local digest applied · summarizer call replaced'],['호스트 압축 사용','Host compaction used'],['호스트 건너뜀','Host skipped'],['트리거','Trigger'],['서브에이전트','Subagent'],['메시지','Messages'],['빌드','Build'],['호스트 보고 압축 전','Host reported tokens before'],['파서','Parser'],['Jev 제어','Jev control'],['명확도','Task clarity'],['일반 위험','Ordinary risk'],['점수','Score'],['참 확률','True probability'],['확신','Confidence'],['참','True'],['거짓','False'],['입력','Input'],['출력','Output'],['토큰','tokens']];
PHRASES.push(...[
['게이트 세션','Gate session'],['Router 실행','Router run'],['Compact 실행','Compact run'],['개 기록 단계',' recorded steps'],['개 Jev 지연 측정',' measured Jev calls'],['개 결과 미확인',' unconfirmed results'],['단계 / 출처','Stage / source'],['기록 기준','Recorded time'],['소요','Duration'],['처리 시간','Timing'],['기록된 결과','Recorded outcome'],['기록 필드','Recorded fields'],['기록 사이 경과','Elapsed between records'],['현재 상태','Current state'],['미측정','Not measured'],['Jev 선택형 응답','Jev typed answers'],['응답 확신','Answer confidence'],['작업 의존성','Task dependencies'],['필수 검사','required checks'],['시작','Start'],['표시할 이벤트가 없습니다.','No events to show.'],['조건에 맞는 실행이 없습니다.','No executions match the filters.'],['실행을 선택하면 시간축을 표시합니다.','Select an execution to see its timeline.'],['시간축에서 단계를 선택하세요.','Select a stage on the timeline.'],['결과 요약 없음','No outcome summary'],['기록 없음은 전송 안 함이나 0ms를 뜻하지 않습니다.','No record does not mean no request or 0 ms.'],['연결됨','Connected'],['미설정','Unavailable'],['파일','files'],['읽기 오류','read errors'],['Jev 요청','Jev request'],['정책','Policy'],['워커','Worker'],['호스트','Host'],['로컬','Local'],['단계',' stages'],['미기록','Unrecorded'],['미확인','Unconfirmed'],['도구','Tool'],['예약과 일치하지 않는 호출','Invocation did not match reservation'],['결과 기록','Outcome recorded'],['원격 판정 허용','Remote judgment enabled'],['로컬만','Local only'],['생략','Omitted'],['유지','Retained'],['후','after'],['모드','Mode'],['응답','Answer'],['요청','Request']]);
PHRASES.push(...[
['선택 결과 · 전송과 응답 확인은 별도 기록','Selection recorded · submission and response are separate'],['Codex 요청에 설정 제출','Settings submitted to Codex'],['요청 전송 관측 · 응답 모델과 실제 effort는 아직 미확인','Request submission observed · response model and effort unconfirmed'],['Codex 응답 관측','Codex response observed'],['응답이 보고한 값만 표시','Only response-reported values shown'],['모델 미확인','Model unknown'],['effort 미확인','Effort unknown'],['목록 부분/미확인','Catalog partial or unknown'],['목록 완전','Catalog complete'],['Astra 자동 선택','Automatic Astra selection'],['Fable 자동 선택','Automatic Fable selection'],['model 질문','Model asked'],['effort 질문','Effort asked'],['발견','Discovered'],['적격','Eligible'],['제시','Offered'],['제외','Excluded']]);
PHRASES.push(['선택 모델과 실제 모델 일치','Selected and observed models match'],['선택 모델과 실제 모델 불일치','Selected and observed models differ'],['결정 근거','Decision basis'],['Codex 실행','Codex execution']);
EN.skip='Skip to content';
PHRASES.push(['API 설정 관측 · 요청 종류 미확인','API settings observed · request purpose unknown']);
PHRASES.push(['실행 전 점검 충돌','Preflight conflict'],['부모 권한 전달 불가','Parent permissions unavailable'],['Worktree 생성 불가','Worktree unavailable'],['배정 모델·effort 사용 불가','Allocated model or effort unavailable'],['시작 전 취소','Cancelled before start'],['실행 예약 기록 불가','Reservation unavailable'],['Codex 워커 시작 거부','Codex worker start rejected'],['Codex 워커 턴 실패','Codex worker turn failed'],['워커 중단','Worker interrupted'],['워커 종료 미확인 · 예약 유지','Worker termination unconfirmed · reservation kept'],['워커 미실행 · 완료 주장 없음','Worker not started · no completion claimed']);
// #269: Gate A reasons, Router stage names and Gate B allocation summaries.
PHRASES.push(['검사 중복 보고','Duplicate check report'],['보고된 검사 실패','Reported check failed'],['필수 검사 미실행','Required check not run'],['변경 후 검사 보고 없음','No checks reported after changes'],['검사 실행 확인 불가','Check execution unverified'],['워커 결과 미반환 · 예약 해제','Worker result missing · reservation released'],['워커 실행 실패','Worker execution failed'],['사용자가 워커 취소','Worker cancelled by user'],['요청 문맥 불명확','Unclear request context'],['독립 요청 근거 부족','Insufficient self-contained support'],['빠른 등급 요건 불충족','Fast tier requirements not met']);
PHRASES.push(['위임 이득 부족','Delegation not worth it'],['앞선 대화 문맥 필요','Needs earlier conversation context'],['판정 확신 부족','Low judgment confidence'],['응답 검증 실패','Invalid assessment'],['판정 동률','Tied judgment'],['Jev 판단 보류','Jev abstained'],['실험 설정으로 고정','Fixed by experiment setting'],['요청이 위임을 금지','Request forbids delegation'],['실행 형태 미확인','Execution path unknown'],['필수 원문 전달 불가','Required text cannot be delivered'],['프롬프트 식별자 없음','No prompt id'],['세션 깊이 미확인','Session depth unknown'],['세션이 위임 기준보다 얕음','Session below the delegation floor'],['작업 알림 턴','Task notification turn'],['위임 이득 충분','Delegation worth it'],
  ['세션 설정','Session settings'],['루트 턴 판단','Root turn decision'],['루트 응답 모델 확인','Root response model check'],['루트 판단 중단','Root decision stopped'],['Agent 생성 판단','Agent spawn decision'],['Agent 응답 모델 확인','Agent response model check'],['Agent 판단 중단','Agent decision stopped'],['Agent 생성 거부','Agent spawn denied'],['Agent 항목 미적용','Agent dimension not applied'],['하위 실행 등록','Child run registered'],['하위 단계 판단','Child step decision'],['하위 단계 응답 모델 확인','Child response model check'],['하위 단계 판단 중단','Child decision stopped'],['캐시 기준 복원 생략','Cache baseline restore skipped'],['캐시 기준 복원','Cache baseline restored'],['effort 캐시 유지','Effort kept for cache'],['문맥 초기화','Context reset'],['판단 시간 초과','Assessment timed out'],['늦은 응답','Late response'],
  ['최종 배정 선택 · 실제 전송과 응답 모델은 별도 관측','Final allocation selected · submission and response model observed separately'],['최종 배정','Final allocation'],['기존 모델 유지','Previous model kept'],['effort 필드 생략','Effort field omitted'],['effort 유지','Effort kept'],['Router 변경 ','Router changed to ']);
PHRASES.push(['설정 변경','Setting changed'],['기존 설정 유지','Previous setting kept']);
PHRASES.push(['사람이 입력한 현재 작업 없음','No current human task'],['이전 assistant 메시지 없음','No prior assistant message'],['Jev 선별','Jev selection']);
PHRASES.sort((a,b)=>b[0].length-a[0].length);
PHRASES.push(['연결 중','Connecting']);PHRASES.sort((a,b)=>b[0].length-a[0].length);
let lang='ko';
function tr(value){const named=String(value).replace(/[a-z][a-z0-9_]+/g,code=>REASONS[code]&&(code.includes('_')||String(value)===code)?label(...REASONS[code]):code);if(lang!=='en')return named;let out=named.replace(/(\\S+)에서 변경/g,'Changed from $1');for(const [ko,en] of PHRASES)out=out.replaceAll(ko,en);return out.replace(/([0-9][0-9,.]*)개/g,'$1').replace(/([0-9][0-9,.]*)건/g,'$1 records').replace(/([0-9][0-9,.]*)회/g,'$1 times').replace(/([0-9][0-9,.]*)자/g,'$1 chars')}
function applyLanguage(){document.documentElement.lang=lang;for(const x of document.querySelectorAll('[data-en-aria]')){if(!x.dataset.koAria)x.dataset.koAria=x.getAttribute('aria-label');x.setAttribute('aria-label',lang==='en'?x.dataset.enAria:x.dataset.koAria)}for(const x of document.querySelectorAll('[data-i18n]')){if(!x.dataset.ko)x.dataset.ko=x.textContent;x.textContent=lang==='en'?(EN[x.dataset.i18n]||x.dataset.ko):x.dataset.ko}
  const dark=document.documentElement.dataset.theme==='dark';document.querySelector('meta[name=theme-color]').content=dark?'#08090a':'#f7f8f8';$('theme').textContent=dark?label('화이트','Light'):label('다크','Dark');$('theme').setAttribute('aria-label',label('테마 전환','Change theme'));$('language').textContent=lang==='en'?'KO':'EN';$('language').setAttribute('aria-label',label('언어 전환','Change language'));
  $('pause').setAttribute('aria-label',paused?label('실시간 재개','Resume live'):label('실시간 일시정지','Pause live'));$('recording').title=label('실행 기록','Execution recording');$('dashboard-auto').title=label('대시보드 자동 열기','Open dashboard automatically');document.title=label('Jev Gate · 개요','Jev Gate · Overview');if(data)draw(data);tick(true)}
const $=id=>document.getElementById(id);
const el=(tag,cls,value)=>{const x=document.createElement(tag);if(cls)x.className=cls;if(value!==undefined)x.textContent=tr(String(value));return x};
const time=s=>{const d=new Date(s);if(Number.isNaN(d.getTime()))return '—';const locale=lang==='en'?'en-GB':'ko-KR';const t=new Intl.DateTimeFormat(locale,{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(d);return d.toDateString()===new Date().toDateString()?t:new Intl.DateTimeFormat(locale,{month:'numeric',day:'numeric'}).format(d)+' '+t};
const date=s=>{const d=new Date(s);return Number.isNaN(d.getTime())?'—':d.toLocaleString(lang==='en'?'en-US':'ko-KR',{hour12:false})};
const ms=n=>!Number.isFinite(n)?'–':n<1000?Math.round(n)+'ms':n<60000?(n/1000).toFixed(1)+'s':Math.floor(n/60000)+'m '+Math.floor(n%60000/1000)+'s';
const state={active:'진행 중',attention:'확인 필요',past_error:'지난 오류',done:'완료',error:'오류',unconfirmed:'결과 미관측',interrupted:'사용자 중단',skipped:'건너뜀'};
const RUNST={active:'run',done:'ok',attention:'er',past_error:'past',unconfirmed:'wa',interrupted:'wa'};
const judgmentName=q=>({control:label('요청 명확도','Request clarity'),tier:label('작업 등급','Work tier'),capability:label('필요 역량','Capability needed'),effort:label('추론 강도','Reasoning effort'),action_risk:label('실행 영향','Action risk'),model:label('모델','Model'),forbids_delegation:label('위임 금지','Forbids delegation'),task_context:label('요청 문맥','Task context'),tool_calls:label('도구 호출 규모','Tool call volume'),bounded_tool_work:label('범위 작업 여부','Bounded tool work'),parallel_outcomes:label('독립 결과','Parallel outcomes'),size:label('작업 규모','Work size'),fully_specified:label('명세 완결','Fully specified'),interfaces_fixed:label('인터페이스 확정','Interfaces fixed'),checks_stated:label('검사 명시','Checks stated'),repetitive:label('반복 작업','Repetitive'),unresolved_interaction:label('미해결 상호작용','Unresolved interaction'),prior_reasoning_failure:label('이전 추론 실패','Prior reasoning failure')})[q]||(/^effort_([0-9]+)$/.test(q)?label('추론 강도 ','Effort ')+(+q.slice(7)+1):q);
const choiceName=(q,v)=>({direct:label('직접 처리','Direct'),orchestrated:label('위임','Delegate'),preserve:label('기존 설정 유지','Preserve baseline'),abstain:label('판단 보류','Abstain'),true:label('참','True'),false:label('거짓','False'),task_clear:label('명확한 요청','Clear request'),explicit_lock:label('모델·effort 고정','Model and effort pinned'),model_lock:label('모델 고정','Model pinned'),effort_lock:label('effort 고정','Effort pinned'),bounded:label('범위가 명확한 작업','Bounded work'),other:label('다른 작업 형태','Other work'),needs_context:label('추가 문맥 필요','More context needed'),unclear:label('불명확','Unclear'),ordinary:label('일반 작업','Ordinary'),consequential:label('중대한 영향','Consequential'),fast:label('빠른 처리','Fast'),standard:label('일반 처리','Standard'),deep:label('깊은 분석','Deep'),frontier:label('최상위 분석','Frontier'),low:label('낮음','Low'),medium:label('중간','Medium'),high:label('높음','High'),xhigh:label('매우 높음','Extra high'),ultra:label('최대','Ultra'),self_contained:label('자체 완결','Self-contained'),complex:label('복잡','Complex'),routine:label('일상 작업','Routine'),mechanical:label('기계적 작업','Mechanical'),'참':label('참','True'),'거짓':label('거짓','False')})[v]||(/^[0-9]+$/.test(v)?label('수준 ','Level ')+v:v);
// List prices come from the bench pricing table; the API never reports the credit it charged.
const PRICES=${JSON.stringify(Object.fromEntries(Object.entries(JEV_PRICING).map(([model, price]) => [model, price.usdPerInputMtok])))};
let hostFilter='all';let data=null,view=null,pending=null,pendingNew=0,route=null,selectedStep=null,selectedFeature='all',stateFilter='all',paused=false,frozenAt=null,preferenceError=false,rcPin=null,rcSeen=null,picked=null,lastCallAt=null,win=60000,hover=null;const timers=new Set();
const featureInfo={admission:['Gate A','요청의 실행 형태 선택','Jev'],allocation:['Gate B','워커 등급','Jev'],workers:['워커','Agent 실행과 수락','호스트'],router:['Router','모델·effort 선택','Jev'],compact:['Compact','문맥 선별과 압축','Jev + 호스트']};
const GUIDE={
admission:{what:['요청을 직접 처리할지, 작업을 위임할지 결정합니다.','Decides whether the request stays with the root or is delegated.'],when:['적격한 루트 사용자 요청이 들어올 때 실행합니다.','Runs on an eligible root user request.'],jev:['Jev가 요청의 형태를 빠르게 분류합니다. 코드가 확률과 제약을 보고 최종 경로를 정합니다.','Jev quickly classifies the request. Code uses its typed answer, probabilities, and constraints to choose the path.'],out:['직접 처리 또는 단일 워커 위임으로 이어집니다. 불확실하면 원래 경로를 유지합니다.','The root continues directly, or one worker is delegated. Uncertainty preserves the original path.']},
allocation:{what:['워커에 사용할 등급을 선택합니다.','Selects a tier for a worker.'],when:['위임된 Agent 호출이 실행되기 직전에 판단합니다.','Runs just before an eligible delegated Agent call.'],jev:['Jev가 원문과 작업 근거를 보고 등급을 제안합니다.','Jev proposes a tier from the original request and task evidence.'],out:['코드가 상향 근거와 제약을 검사해 호출 모델을 정합니다. 불확실하면 원래 모델을 유지합니다.','Code checks upgrade grounds and constraints before choosing the called model. Uncertainty preserves it.']},
workers:{what:['Agent가 실제로 수행한 일과 수락 조건을 추적합니다.','Tracks the Agent work and whether it met acceptance conditions.'],when:['워커 호출, 반환, 실패 이벤트를 기록합니다.','Records worker dispatch, return, and failure events.'],jev:['Gate B 등급 판정과 연결됩니다. 작업 수락은 Jev가 아닌 코드가 결정합니다.','Links to Gate B tier choice. Code, not Jev, determines task acceptance.'],out:['요청한 모델과 관측한 모델, 검사 결과를 구분해 보여줍니다.','Shows requested versus observed model and checks.']},
router:{what:['호스트의 모델 또는 effort 선택을 조정합니다.','Adjusts host model or effort selection.'],when:['루트 턴과 상속형 내장 subagent 이벤트에서 실행할 수 있습니다.','May run for root turns and inherited built-in subagent events.'],jev:['필요한 경우 Jev가 모델·effort에 관한 선택형 질문에 답합니다. 발화는 고유 Jev 판정 수, 적용은 요청 설정 적용 수입니다. 캐시 재사용·effort 변경·하위 요청이 포함되어 적용이 발화보다 클 수 있습니다.','When needed, Jev answers typed questions about model and effort. Fired counts unique Jev decisions; applied counts request settings submissions, including cache reuse, effort changes and child requests. Applied can exceed fired.'],out:['제안한 설정과 호스트에서 실제로 관측한 설정을 따로 보여줍니다.','Separates proposed settings from those actually observed in the host.']},
compact:{what:['오래된 도구 출력에서 현재 작업에 필요한 문맥을 보존하며 입력을 줄입니다.','Reduces older tool output while preserving context needed by the current task.'],when:['Claude는 자동 압축에서, Codex는 적격한 추론·압축 요청에서 실행합니다.','Runs at Claude auto-compaction and eligible Codex inference or compaction requests.'],jev:['Jev가 과거 근거를 선별합니다. Codex의 암호화 문맥·호출 연결·최근 출력은 보존합니다.','Jev selects historical evidence. Codex encrypted context, call links and recent output are preserved.'],out:['선별 판정·실제 전송·호스트 압축을 구분합니다. 제외 문자 수와 총 토큰 절감은 별개입니다.','Separates selection, actual transmission and host compaction. Removed characters do not establish total token savings.']},
};
const label=(ko,en)=>lang==='en'?en:ko;
function scoped(ops){
  if(hostFilter==='all')return ops;
  const rows=ops.runs.filter(r=>r.host===hostFilter),all=rows.flatMap(r=>r.steps.map(s=>({...s,host:r.host,runId:r.id,runTitle:r.title}))),ref=frozenAt??Date.now();
  const measured=all.filter(s=>s.lane==='jev'&&Number.isFinite(s.durationMs)).sort((a,b)=>a.at.localeCompare(b.at));
  const values=measured.map(s=>s.durationMs).sort((a,b)=>a-b);const percentile=p=>values.length?values[Math.ceil(values.length*p)-1]:null;
  return {...ops,runs:rows,feed:all.sort((a,b)=>b.at.localeCompare(a.at)).filter((s,i)=>i<160||!s.lifecycle&&ref-Date.parse(s.at)<ACTIVITY_MS),features:ops.features.map(f=>{const matches=all.filter(s=>!s.lifecycle&&s.feature===f.id);return {...f,count:matches.length,lastAt:matches.map(s=>s.at).sort().at(-1)||null,state:matches.length?'observed':f.state==='unsupported'?'unsupported':f.state==='unavailable'?'unavailable':'waiting'}}),latency:{measured:values.length,p50:percentile(.5),p95:percentile(.95),fastest:values[0]??null,latest:measured.at(-1)?.durationMs??null,recent:measured.slice(-16).map(s=>({at:s.at,ms:s.durationMs})),today:{[hostFilter]:ops.latency.today?.[hostFilter]}},scoped:true};
}
const svg=(tag,attrs={})=>{const e=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const [k,v]of Object.entries(attrs))e.setAttribute(k,String(v));return e};
const CIRCUIT=['admission','allocation','workers','router','compact'];
const NODE={admission:[['실행 형태','Execution path'],['형태','Path'],['실행 형태?','Execution path?']],allocation:[['등급 배정','Tier allocation'],['등급','Tier'],['등급?','Tier?']],workers:[['수락 검사','Acceptance check'],['수락','Accept'],['수락?','Accept?']],router:[['모델과 effort','Model and effort'],['모델','Model'],['이 턴 모델?','Model for this turn?']],compact:[['문맥 선별','Context selection'],['선별','Selected'],['이 청크 유지?','Keep these chunks?']]};
// A Jev call is a measured response record; intents, policy follow-ups and host events are not calls.
const isCall=s=>s.lane==='jev'&&s.durationMs!==undefined&&!s.lifecycle;
// Jev traffic is every recorded Jev request and response; only a response is a call.
const isJev=s=>s.lane==='jev'&&!s.lifecycle;
const ACTIVITY_MS=60000;
// Values always reflect the newest frame; motion has its own bounded lifetime.
const isHeld=()=>false;
// A node names the model family, as Claude ids reduce to sonnet or opus; the full id stays in the stage detail.
const modelName=v=>{const m=String(v||'').match(/(haiku|sonnet|opus|fable)|^gpt-[0-9.]+-([a-z]+)$/);return m?m[1]||m[2]:String(v||'').replace(/^claude-/,'')};
const pct=v=>Math.round(v*100)+'%';
// #232: a worker result names its contract verdict; only an accept receipt reads as accepted, and a host end is not one.
const OUTCOME={accepted:['계약 수락','Contract accepted'],rejected:['계약 미충족','Contract not met'],unknown:['판정 미확인','Verdict unknown'],host_ended:['호스트 종료','Host ended']};
function decisionText(s){if(!s)return '–';if(s.feature==='workers'&&!s.outcome)return label('판정 없음','No verdict');if(s.outcome)return label(...OUTCOME[s.outcome]);const c=s.receipt?.choice;
  if(s.feature==='router'){const m=c||(s.model?[s.model.observed||s.model.selected,s.model.observedEffort||s.model.selectedEffort].filter(Boolean).join(' · '):'');return m?m.split(' · ').map((v,i)=>i?v:modelName(v)).join(' · '):tr(state[s.state])}
  const path=s.executionPath||(s.feature==='admission'?c:null);if(path==='direct')return label('직접','Direct');if(path==='orchestrated')return label('위임','Delegate');
  if(c)return s.feature==='allocation'&&/(haiku|sonnet|opus|fable)/.test(c)?modelName(c):choiceName('',c);return tr(state[s.state])}
// Cards own the recorded confidence; Router shows model and effort only.
const valueText=s=>{const v=decisionText(s),c=s?.receipt?.confidence;return s&&s.feature!=='router'&&c!=null?v+' · '+label('확신 ','confidence ')+pct(c):v};
// Completion and model evidence can replace a request in place. Compare recorded facts, not just ids or object identity.
const signalKey=s=>JSON.stringify([s.at,s.state,s.lane,s.durationMs,s.summary,s.cause,s.outcome,s.executionPath,s.receipt?.choice,s.receipt?.status,s.receipt?.code,s.model,s.routing]);
// Existing node lines and inspector rows share doctor's structured activity check.
const activityOf=id=>{const checks=data?.activity24h?.[hostFilter]?.filter(c=>c.feature===id)||[];if(id!=='compact'||checks.length<2)return checks[0];const metrics=Object.assign({},...checks.map(c=>c.metrics));for(const k of ['fired','applied','regression'])metrics[k]=checks.some(c=>c.metrics[k]==null)?null:checks.reduce((n,c)=>n+c.metrics[k],0);metrics.effect=null;return {feature:id,level:['fail','warn','ok','info'].find(l=>checks.some(c=>c.level===l)),metrics}};
const activityLine=a=>{const m=a.metrics;return '24h '+({ok:label('정상','OK'),warn:label('주의','Warn'),fail:label('오류','Fail'),info:label('관측','Info')}[a.level]||a.level)+' · '+label('발화 ','fired ')+num(m.fired)+' · '+label('적용 ','applied ')+(m.applied==null?label('미확인','unknown'):num(m.applied))+' · '+label('회귀 ','regressions ')+num(m.regression)};
const netText=a=>{const effect=a.metrics.effect,usd=n=>(n<0?'−':'+')+'$'+Math.abs(n).toFixed(2);return effect==null?label('미확인','unknown'):Array.isArray(effect)?effect.map(usd).join(' / '):usd(effect)};
function activityDetail(id,a){const m=a.metrics;if(id==='workers')return label('수락 ','accepted ')+num(m.accepted)+' · '+label('거절 ','rejected ')+num(m.rejected)+' · '+label('실행 실패 ','execution failures ')+num(m.failed)+' · '+label('대기 ','pending ')+num(m.pending)+' · '+label('취소 ','cancelled ')+num(m.cancelled);if(id==='compact'){const parts=[];if(m.restored!==undefined)parts.push((m.codexAssessed===undefined?'':'Claude ')+label('복원 ','restored ')+num(m.restored)+' · '+label('예산 ','budget ')+(m.budgetUsed==null?label('미확인','unknown'):num(m.budgetUsed))+' / '+(m.budget==null?label('미확인','unknown'):num(m.budget)));if(m.codexAssessed!==undefined)parts.push((m.restored===undefined?'':'Codex ')+label('Jev 판정 ','Jev assessed ')+num(m.codexAssessed)+' · '+label('전송 적용 ','applied submissions ')+num(m.codexSubmitted)+' · '+label('응답 완료 ','completed responses ')+num(m.codexCompleted)+' · '+label('총 토큰 효과 미측정','total token savings unmeasured'));return parts.join(' · ')||label('효과 미확인','effect unknown')}return (id==='admission'?label('경로 변경 ','path changes ')+num(m.applied)+' · ':id==='allocation'?label('등급 변경 ','tier changes ')+num(m.applied)+' · ':'')+label('효과 ','effect ')+(id==='router'?label('(루트 비용 추정) ','(root cost estimate) '):'')+netText(a)}
${PATCH_SCRIPT}
const num=v=>v==null?'–':Math.round(v).toLocaleString();
const kTokens=v=>v==null?'–':v>=1000?(v/1000).toFixed(1)+'K':String(v);
const usd=v=>v==null?'–':'≈$'+(v<0.01?v.toFixed(5):v.toFixed(2));
// 4xx is a warning; 402, 5xx and timeouts are failures.
const tone=rc=>!rc?'':rc.status===402||rc.status>=500||/timeout|payment|5\\d\\d/.test(rc.code||'')?'e':rc.status>=400||/4\\d\\d|rate|refused|invalid/.test(rc.code||'')?'w':'';
const todayCalls=ops=>Object.values(ops.latency.today||{}).reduce((a,t)=>({calls:a.calls+(t?.calls||0),input:a.input+(t?.input||0),costUsd:a.costUsd+(t?.costUsd||0),unpriced:a.unpriced+(t?.unpriced||0)}),{calls:0,input:0,costUsd:0,unpriced:0});
// One recorded Jev response is one call everywhere: header strip, run list, call log and response panel.
// src keeps the recorded step itself, so its fetched detail stays cached across frames.
const callsOf=ops=>ops.runs.flatMap(r=>r.steps.filter(s=>isCall(s)&&!isHeld(r.id,s.id)).map(s=>({...s,runId:r.id,runTitle:r.title,host:r.host,src:s}))).sort((a,b)=>b.at.localeCompare(a.at));
// A recorded Jev request still waiting for its response.
const pendingOf=ops=>ops.runs.flatMap(r=>r.steps.filter(s=>isJev(s)&&s.state==='active'&&s.durationMs===undefined&&!isHeld(r.id,s.id)).map(s=>({...s,runId:r.id,runTitle:r.title,host:r.host,src:s})));
// Text is written only when it changes, so a clock tick or a repeated frame leaves the DOM alone.
const put=(e,v)=>{v=String(v);if(e.textContent!==v)e.textContent=v};
// An active step carries its start; its elapsed time runs live from there.
const runningSince=s=>s.state==='active'&&s.elapsedMs===undefined?s.startedAt:undefined;
// Compact values for fixed-width cells: ages, spans, clock times and counts.
const ago=t=>{if(!Number.isFinite(t))return '–';const s=Math.max(0,Math.floor(t/1000));return s<60?s+'s':s<3600?Math.floor(s/60)+'m':s<86400?Math.floor(s/3600)+'h':Math.floor(s/86400)+'d'};
const span=t=>{if(!Number.isFinite(t))return '–';const s=Math.max(0,Math.floor(t/1000));return s<60?s+'s':s<3600?Math.floor(s/60)+'m '+s%60+'s':s<86400?Math.floor(s/3600)+'h '+Math.floor(s%3600/60)+'m':Math.floor(s/86400)+'d '+Math.floor(s%86400/3600)+'h'};
const clock=s=>{const d=new Date(s);return Number.isNaN(d.getTime())?'–':[d.getHours(),d.getMinutes(),d.getSeconds()].map(n=>String(n).padStart(2,'0')).join(':')};
const pctile=(v,p)=>{if(!v.length)return null;const s=[...v].sort((a,b)=>a-b);return s[Math.min(s.length-1,Math.ceil(s.length*p)-1)]};
const cnum=v=>v==null?'–':v>=1e5?Math.round(v/1000)+'k':Math.round(v).toLocaleString('en-US');
const mtok=v=>v==null?'–':v>=1e6?(v/1e6).toFixed(2)+'M':v>=1000?(v/1000).toFixed(1)+'k':String(v);
const later=(f,ms)=>{const t=setTimeout(()=>{timers.delete(t);f()},ms);timers.add(t)};
// A duration's number and unit are separate elements, so the unit renders small.
const unit=(id,n)=>{const m=/^([0-9.]+)(ms|s)$/.exec(ms(n));lead($(id),m?m[1]:ms(n));put($(id+'-u'),m?m[2]:'')};
// A value and the text after it on its line are one reading: when the value changes, what follows it is replaced
// rather than moved, so nothing on screen shifts as a neighbour.
function regrow(e){const after=[];for(let n=e;!n.matches('.kv,.big,.bv');n=n.parentElement)for(let f=n.nextElementSibling;f;f=f.nextElementSibling)after.push(f);for(const f of after)f.replaceWith(f.cloneNode(true))}
const lead=(e,v)=>{v=String(v);if(e.textContent!==v){e.textContent=v;regrow(e)}};
// Each digit is a column of 0-9 moved by transform; the columns are rebuilt only when the digit count changes.
function roll(e,n){const text=Math.max(0,n).toLocaleString('en-US'),shape=text.replace(/[0-9]/g,'0');
  if(e._shape!==shape){e._shape=shape;e.replaceChildren(...[...text].map(ch=>{if(ch<'0'||ch>'9')return el('span','sep',ch);const d=el('span','dg'),c=el('span','roll');for(let k=0;k<10;k++)c.append(el('span','',k));d.append(c);return d}));regrow(e)}
  [...text].forEach((ch,k)=>{const c=e.children[k].firstChild;if(ch>='0'&&ch<='9'&&c)c.style.transform='translateY(-'+ch*10+'%)'});e.setAttribute('aria-label',label(text+'회',text+' calls'))}
let pool=[];
function stats(ops,calls){const active=ops.runs.filter(r=>r.state==='active'),cx=active.filter(r=>r.host==='codex').length,today=todayCalls(ops),att=ops.runs.filter(r=>r.state==='attention'),past=ops.runs.filter(r=>r.state==='past_error').length,credit=data.credit,cost=$('j-cost'),price=Object.entries(Object.entries(PRICES).reduce((g,[m,p])=>{(g[p]=g[p]||[]).push(m);return g},{})).map(([p,ms])=>ms.join(' · ')+', '+label('100만 토큰당 $'+p,'$'+p+' per 1M tokens')).join('; ');
  lead($('k-active'),active.length);put($('k-hosts'),'Claude '+(active.length-cx)+' · Codex '+cx);roll($('k-today'),today.calls);rate();
  unit('j-p50',ops.latency.p50);put($('j-p95'),'p50 · p95 '+ms(ops.latency.p95));
  lead(cost,today.calls>today.unpriced?usd(today.costUsd).replace('≈',''):'–');put($('k-tok'),(today.calls?mtok(today.input):'–')+' tok');
  cost.title=label('오늘 입력 토큰 기준 정가 추정입니다 ('+price+'). 실제 차감 크레딧은 API가 알려주지 않습니다.','List-price estimate from input tokens recorded today ('+price+'). The API does not report the credit actually charged.')+(today.unpriced?label(' 가격을 알 수 없는 응답 '+today.unpriced+'회는 제외했습니다.',' Responses without a known price are excluded ('+today.unpriced+').'):'');
  const c=$('credit');c.textContent=credit?.exhausted?label('크레딧 소진','Credit exhausted'):'';c.title=credit?.exhausted?tr('Jev가 402(결제 필요)를 반환했습니다. 충전 후 다음 요청부터 자동으로 풀립니다.'):'';
  lead($('k-att'),att.length);$('k-att').classList.toggle('er',att.length>0);put($('k-diag'),att.length?diagnosis(att)||label('확인이 필요한 실행','Executions to review'):past?label('지난 오류 '+past+'건',past+' past errors'):label('오류·불일치 없음','No errors or mismatches'));$('k-diag').title=$('k-diag').textContent}
const rate=()=>{const ref=frozenAt??Date.now();let n=0;for(const s of pool){if(ref-Date.parse(s.at)>=60000)break;n++}put($('k-rate'),'+'+n+'/min')};
// The y scale is the first step above the window's p95; slower calls sit at the top edge.
const STEPS=[700,1400,3500,7000,14000],AXES={60000:[6,10,'s'],300000:[5,1,'m'],900000:[5,3,'m']};let yMax=700;
const yLabel=v=>v<1000?Math.round(v)+'ms':Math.round(v/100)/10+'s';
function scatter(ops,ref){let n=0,recent=0;const lat=[];for(const s of pool){const age=ref-Date.parse(s.at);if(age>=win)break;if(age<0)continue;n++;lat.push(s.durationMs);if(age<10000)recent++}
  const p95=pctile(lat,.95),p50=ops.latency.p50,line=$('s-p50');yMax=STEPS.find(v=>v>=(p95||0)*1.15)||STEPS.at(-1);
  put($('t-rate'),(recent/10).toFixed(1)+' rps · '+label(n+'건',n+' calls'));
  $('scatter').querySelectorAll('.yt span').forEach((e,k)=>put(e,k?yLabel(yMax*k*2/7):'0'));
  line.hidden=p50==null;if(p50!=null){line.style.transform='translateY(-'+(Math.min(p50,yMax)/yMax*100).toFixed(2)+'%)';put(line.firstChild,'p50 '+ms(p50))}
  $('scatter').setAttribute('aria-label',label('Jev 호출 '+n+'건 · 응답 시간 p50 '+ms(p50),n+' Jev calls · response time p50 '+ms(p50)));placeDots(ref)}
function axis(){const [n,step,u]=AXES[win],labels=[];for(let i=n;i>0;i--)labels.push('-'+i*step+u);labels.push(label('지금','now'));const box=$('axis');if(box._key===labels.join())return;box._key=labels.join();box.replaceChildren(...labels.map(t=>el('span','',t)));$('band').style.width=(win/3600000*100).toFixed(2)+'%'}
// One dot per recorded call: x is its age in the window, y its response time, size its input tokens. Between full passes
// the window moves every dot with one transform, so a dot that would leave it before the next pass is dropped now.
function placeDots(ref){const box=$('dots'),els=box._els||(box._els=new Map()),keep=new Set(),edge=motion()?win-1000:win;let n=0;box._at=ref;box._dx='';box.style.transform='';
  for(const s of pool){const age=ref-Date.parse(s.at);if(age>=edge||n>=500)break;if(age<0)continue;n++;const id=s.runId+' '+s.id;keep.add(id);let w=els.get(id);
    if(!w){w=el('div','dw');const y=el('div','dy'),d=el('i','dot'),z=Math.round(5+Math.min(4,Math.max(0,((s.receipt?.input??1000)-1000)/1100)));d.dataset.call=s.id;d.dataset.run=s.runId;d.style.width=d.style.height=z+'px';d.style.margin='0 0 '+(-z/2)+'px '+(-z/2)+'px';y.append(d);w.append(y);w._dot=d;w._y=y;els.set(id,w);box.append(w)}
    w._s=s;const yv=Math.min(s.durationMs,yMax)/yMax*100;if(w._yv!==yv){w._yv=yv;w._y.style.transform='translateY(-'+yv.toFixed(2)+'%)'}
    const x='translateX(-'+(age/win*100).toFixed(3)+'%)',o=(0.22+0.6*(1-age/win)).toFixed(2);if(w._x!==x){w._x=x;w.style.transform=x}if(w._o!==o){w._o=o;w._dot.style.opacity=o}w._dot.classList.toggle('on',picked?.id===s.id&&picked?.runId===s.runId)}
  for(const [id,w]of els)if(!keep.has(id)){w.remove();els.delete(id)}
  tipAt(ref)}
function slide(ref){const box=$('dots');if(box._at==null||!box._els?.size)return;const dx=((ref-box._at)/win*100).toFixed(1);if(box._dx!==dx){box._dx=dx;box.style.transform='translateX(-'+dx+'%)'}if(hover)tipAt(ref)}
function tipAt(ref){const h=hover&&$('dots')._els?.get(hover),tip=$('tip');tip.hidden=!h;if(h){const s=h._s,f=1-(ref-Date.parse(s.at))/win;put($('tip-a'),clock(s.at)+' · '+tr(featureInfo[s.feature]?.[0]||s.feature));put($('tip-b'),decisionText(s));put($('tip-c'),ms(s.durationMs)+' · '+(s.receipt?.input==null?'–':s.receipt.input.toLocaleString('en-US'))+' tok');tip.style.left=(f*100).toFixed(2)+'%';tip.style.bottom='calc('+h._yv.toFixed(2)+'% + 10px)';tip.style.transform='translateX('+(f>.85?'-100%':f<.15?'0':'-50%')+')'}}
// Calls per minute over the last hour; the band marks the scatter's window.
function mini(ref){const b=new Array(60).fill(0);for(const s of pool){const age=ref-Date.parse(s.at);if(age>=3600000)break;if(age>=0)b[59-Math.floor(age/60000)]++}
  const key=b.join();if($('mini')._key===key)return;$('mini')._key=key;const top=Math.max(4,...b),pts=b.map((v,i)=>[Math.round(i/59*6000)/10,Math.round((38-v/top*30)*10)/10]);
  const d=pts.map((p,i)=>{if(!i)return 'M'+p[0]+','+p[1];const q=pts[i-1],mx=(q[0]+p[0])/2;return ' C'+mx+','+q[1]+' '+mx+','+p[1]+' '+p[0]+','+p[1]}).join('');$('mini-l').setAttribute('d',d);$('mini-a').setAttribute('d',d+' L600,40 L0,40 Z')}
const FEATS=['router','admission','allocation','compact'];
function rail(ops,calls){const c=calls.find(s=>Number.isFinite(s.durationMs)),p50=ops.latency.p50,p95=ops.latency.p95,lat=calls.map(s=>s.durationMs);
  if(c){unit('j-last',c.durationMs);put($('j-last-meta'),tr(featureInfo[c.feature]?.[0]||c.feature)+' · '+clock(c.at))}else{lead($('j-last'),'–');put($('j-last-u'),'');put($('j-last-meta'),'–')}
  put($('j-within'),lat.length?Math.round(lat.filter(v=>v<1000).length/lat.length*100)+'%':'–');$('j-p95bar').style.transform='scaleX('+(p95==null?0:Math.min(1,p95/1000))+')';
  $('j-p50tick').hidden=p50==null;$('j-p50tick').style.transform='translateX('+(p50==null?0:Math.min(100,p50/10))+'%)';put($('j-pp'),'p50 '+ms(p50)+' · p95 '+ms(p95));feats(frozenAt??Date.now())}
function feats(ref){const box=$('j-feats'),inWin=[];for(const s of pool){const age=ref-Date.parse(s.at);if(age>=win)break;if(age>=0)inWin.push(s)}const tot=Math.max(1,inWin.length);
  if(!box._rows)box._rows=FEATS.map(id=>{const r=el('div','ft');r.dataset.feature=id;const b=el('span','rb');b.setAttribute('aria-hidden','true');b.append(el('i'));r.append(el('span','k'),el('span','m'),el('span','m p'),b);box.append(r);return r});
  for(const r of box._rows){const id=r.dataset.feature,ev=inWin.filter(s=>s.feature===id),[k,n,p,b]=r.children;put(k,tr(featureInfo[id][0]));put(n,ev.length);put(p,ev.length?ms(pctile(ev.map(s=>s.durationMs),.5)):'–');b.firstChild.style.transform='scaleX('+(ev.length/tot).toFixed(3)+')'}}
// A packet crosses Gate → Jev → Gate in the call's recorded round-trip time.
function packet(s){const w=$('j-wire');if(w.children.length>=6)return;const d=Math.max(80,s.durationMs),lane=el('i','lane');lane.style.setProperty('--d',d+'ms');lane.append(el('i','pk'));lane.addEventListener('animationend',e=>{if(e.target===lane)lane.remove()});w.append(lane);later(()=>lane.remove(),d+200)}
function buildStages(){$('stages').replaceChildren(...CIRCUIT.map(id=>{const b=el('button','st');b.type='button';b.dataset.feature=id;b.setAttribute('aria-pressed','false');b.setAttribute('aria-controls','rc');
  const sn=el('span','sn'),a=el('span','a'),dot=el('i','sd'),age=el('span','m cap');dot.setAttribute('aria-hidden','true');age.dataset.ago='';a.append(dot,el('b','',featureInfo[id][0]),age);sn.append(a,el('span','d'));
  const sp=svg('svg',{viewBox:'0 0 120 20',preserveAspectRatio:'none','aria-hidden':'true'});sp.append(svg('polyline',{'vector-effect':'non-scaling-stroke'}));b.append(sn,el('span','m v f'),el('span','m v g'),el('span','m v r'),sp);return b}))}
// Fired, applied and regressions are doctor's 24-hour activity facts; the trend is recorded decisions per hour.
function stages(ops){const ref=frozenAt??Date.now(),last={},runOf={},hours=Object.fromEntries(CIRCUIT.map(id=>[id,new Array(24).fill(0)]));
  for(const r of ops.runs)for(const s of r.steps){if(s.lifecycle||!hours[s.feature]||isHeld(r.id,s.id))continue;if(!(last[s.feature]?.at>=s.at)){last[s.feature]=s;runOf[s.feature]=r}const age=ref-Date.parse(s.at);if(age>=0&&age<86400000)hours[s.feature][23-Math.floor(age/3600000)]++}
  for(const b of $('stages').children){const id=b.dataset.feature,s=last[id],r=runOf[id],a=activityOf(id),m=a?.metrics,[sn,f,g,rg,sp]=b.children,[top,line]=sn.children,[,name,age]=top.children,h=hours[id],mx=Math.max(1,...h),regress=m?.regression>0;
    b.hidden=ops.features.find(x=>x.id===id)?.state==='unsupported';put(name,tr(featureInfo[id][0]));age.dataset.ago=s?.at||'';
    // A host end is not a contract verdict, so the stage says so before naming the end.
    const v=!s?label('기록 없음','No record'):s.outcome==='host_ended'?label('판정 없음','No verdict'):valueText(s),n=s?s.routing?note(s,r):s.outcome?decisionText(s):humanText(note(s,r)):'';put(line,[v,n&&n!==v&&!diagnosticText(n)?n:''].filter(Boolean).join(' · '));
    put(f,cnum(m?.fired));put(g,cnum(m?.applied));put(rg,cnum(m?.regression));rg.classList.toggle('er',regress);
    b.classList.toggle('err',regress||!!s&&currentStep(s));b.classList.toggle('busy',!!s&&ref-Date.parse(s.at)<3600000);b.setAttribute('aria-pressed',String(selectedFeature===id));
    const pts=h.map((v,j)=>(j*120/23).toFixed(1)+','+(19-v/mx*17).toFixed(1)).join(' '),pl=sp.firstChild;if(pl.getAttribute('points')!==pts)pl.setAttribute('points',pts);pl.classList.toggle('er',regress);
    b.title=[a?activityLine(a):label('24h 추적 불가','24h untrackable'),a?activityDetail(id,a):'',GUIDE[id].what[lang==='en'?1:0]].filter(Boolean).join('\\n')}}
// Each run keeps one row; a row is rebuilt only when its run or the language changes, and existing links keep their identity.
// Ordinary fills are bounded by ROWS_AT_ONCE; the rest are filled in the next task.
const rowEls=new Map(),ROWS_AT_ONCE=20;let runHold=false;
function runs(ops,top=$('runs').scrollTop){if(runHold)return;const root=$('runs'),focus=document.activeElement,count=k=>ops.runs.filter(r=>k==='all'||r.state===k).length;let rows=ops.runs.filter(r=>stateFilter==='all'||r.state===stateFilter);
  for(const k of ['all','attention','active'])put($('n-'+k),count(k));for(const b of $('state-filters').querySelectorAll('button'))b.setAttribute('aria-pressed',String(b.dataset.state===stateFilter));
  const scope=JSON.stringify([hostFilter,stateFilter]),reset=root._scope!==scope;root._scope=scope;if(reset)top=0;
  const anchor=!reset&&!root._latest&&top===root.scrollTop?[...root.children].find(li=>li.getBoundingClientRect().bottom>root.getBoundingClientRect().top+1):null,anchorY=anchor?.getBoundingClientRect().top;root._latest=false;root._deferred=false;
  // An already-read row stays above the reading anchor during passive updates, and a run new to the list enters above it.
  // Moving it below would undo the scroll correction and disturb the viewport.
  // Returning to the top applies the current latest-first order.
  if(anchor){const prior=new Set([...root.children].slice(0,[...root.children].indexOf(anchor)).map(li=>li.firstElementChild?.dataset.run)),pivot=rows.findIndex(r=>r.id===anchor.firstElementChild?.dataset.run);
    if(pivot>=0){const above=new Set(rows.filter((r,i)=>i<pivot||prior.has(r.id)||!root._ids?.has(r.id)).map(r=>r.id)),ordered=[...rows.filter(r=>above.has(r.id)),...rows.filter(r=>!above.has(r.id))];root._deferred=ordered.some((r,i)=>r!==rows[i]);rows=ordered}}
  root._ids=new Set(rows.map(r=>r.id));
  if(!rows.length){root.style.paddingBottom='';rowEls.clear();root.replaceChildren(el('li','empty',label('조건에 맞는 실행이 없습니다.','No executions match.')));return}
  const shown=new Set(rows.map(r=>r.id));for(const id of rowEls.keys())if(!shown.has(id))rowEls.delete(id);let at=root.firstChild,filled=0,rest=false;
  for(const r of rows){let li=rowEls.get(r.id);if(!li){if(filled>=ROWS_AT_ONCE){rest=true;continue}li=el('li');const a=el('a','row');a.href='#run='+encodeURIComponent(r.id);a.dataset.run=r.id;li.append(a);rowEls.set(r.id,li)}
    if(!(li._key?.[0]===r&&li._key[1]===lang)){if(filled<ROWS_AT_ONCE||!li._key){filled++;fill(li,r)}else rest=true}if(li===at)at=at.nextSibling;else root.insertBefore(li,at)}
  while(at){const next=at.nextSibling;at.remove();at=next}
  // Keep the visible row in place even when a short list gains a new first row.
  // Only the missing scroll range is reserved; returning to the top releases it.
  if(anchor?.isConnected){const target=root.scrollTop+anchor.getBoundingClientRect().top-anchorY,content=root.lastElementChild.getBoundingClientRect().bottom-root.getBoundingClientRect().top+root.scrollTop;const padding=target>0?Math.max(0,target+root.clientHeight-content):0;root.style.paddingBottom=padding?padding+'px':'';root.scrollTop=target}else{root.style.paddingBottom='';root.scrollTop=top}
  if(focus?.isConnected&&root.contains(focus)&&document.activeElement!==focus)focus.focus({preventScroll:true});
  if(rest&&!root._rest)root._rest=setTimeout(()=>{root._rest=0;if(view)runs(view)})}
function fill(li,r){const a=li.firstChild,ref=frozenAt??Date.now(),last=[...r.steps].reverse().find(s=>!s.lifecycle&&!isHeld(r.id,s.id)&&CIRCUIT.includes(s.feature)),calls=r.steps.filter(isCall).length;li._key=[r,lang];
  a.className='row '+(RUNST[r.state]||'ok');const top=el('span','a'),dot=el('i'),host=r.host==='codex'?'Codex':'Claude';dot.setAttribute('aria-hidden','true');top.append(dot,el('span','nm',r.title),el('span','h',host));
  const age=el('span','m cap ago',ago(ref-Date.parse(r.lastAt)));age.dataset.ago=r.lastAt;
  const du=el('span','m cap du',span((r.state==='active'?ref:Date.parse(r.lastAt))-Date.parse(r.firstAt)));if(r.state==='active')du.dataset.since=r.firstAt;
  const sub=el('span','sub',tr(state[r.state])+' · '+(last?decisionText(last):'–'));
  a.setAttribute('aria-label',tr(r.title)+', '+host+', '+tr(state[r.state])+', '+label('Jev 호출 '+calls+'회',calls+' Jev calls'));a.replaceChildren(top,age,sub,du)}
// Routing and typed answers reach a page only with a step's detail, so a shown call fetches it once for its step.
const routed=s=>detailed({id:s.runId},s.src);
const SCOPE={root:['루트 턴','Root turn'],spawn:['Agent 생성','Agent spawn'],child:['하위 단계','Child step'],owned:['Gate B 워커','Gate B worker']};
// A call outside routing names what it judged: the user request, an Agent call or a compaction.
const SCOPE_OF={admission:['사용자 요청','Request'],allocation:['Agent 호출','Agent call'],compact:['문맥 압축','Compaction']};
const scopeOf=x=>x.routing&&SCOPE[x.routing.scope]?label(...SCOPE[x.routing.scope]):SCOPE_OF[x.feature]?label(...SCOPE_OF[x.feature]):'–';
// The reason of a routing decision is the dimension it changed, else its model reason.
const why=g=>routingReason([g.modelReason,g.effortReason].find(v=>v==='selected'||v==='applied')||g.modelReason);
// A Gate response and its code decision are recorded together; the decision's summary names its reason.
// A Router request record shares its decision's time, but it is a lifecycle record, not the decision.
const policyOf=(s,r)=>r?.steps.find(x=>x!==s&&x.lane==='policy'&&!x.lifecycle&&x.feature===s.feature&&x.at===s.at);
// One line on why: a routed change names the baseline it left, else the routing reason; a Gate decision names its policy summary.
// The line never repeats the decision the card already shows. #290: a routing step outside the root turn names its scope first,
// so a child step's or an Agent spawn's choice does not read as the main session's.
const note=(s,r)=>{const g=s.routing;if(g){const v=decisionText(s),from=g.baseline&&modelName(g.baseline),n=from&&s.receipt?.choice&&!v.startsWith(from)?label(from+'에서 변경','Changed from '+from):why(g);return [g.scope!=='root'&&SCOPE[g.scope]&&scopeOf(s),n].filter(Boolean).join(' · ')}const n=tr((policyOf(s,r)||s).summary||'');return n===decisionText(s)?'':n};
const RC_ROWS=8,BASIS_ROWS=6,PEERS=28;let rcHold=false;
// The call log keeps eight rows of fixed height and columns, so nothing around it moves. A request without its response
// counts up in its row until the response replaces it.
function receipts(ops,calls,pend){const all=pend.concat(calls),list=all.filter(s=>selectedFeature==='all'||s.feature===selectedFeature).sort((a,b)=>b.at.localeCompare(a.at)).slice(0,RC_ROWS),root=$('rc'),ref=frozenAt??Date.now(),shown=list.map(routed);
  if(rcPin&&!all.some(s=>s.id===rcPin.id&&s.runId===rcPin.run))rcPin=null;
  put($('log-filter'),selectedFeature==='all'?label('최신순','Latest first'):tr(featureInfo[selectedFeature][0])+label('만',' only'));$('log-clear').hidden=selectedFeature==='all';showResume();
  const key=lang+JSON.stringify(list.map((s,k)=>[s.runId,s.id,signalKey(shown[k]),shown[k].receipt?.input]));
  if(root._key!==key&&!rcHold){root._key=key;root.replaceChildren();
    for(let k=0;k<RC_ROWS;k++){const s=list[k],li=el('li');root.append(li);if(!s)continue;const x=shown[k],rc=x.receipt,wait=x.durationMs===undefined,t=tone(rc),b=el('button','cr'),name=tr(featureInfo[s.feature]?.[0]||s.feature),run=ops.runs.find(r=>r.id===s.runId);
      const verdict=wait?label('응답 대기','Awaiting response'):x.state==='error'?label('요청 오류','Request error'):decisionText(x),why=wait?'':x.routing?note(x,run):humanText(note(x,run)),reason=why&&why!==verdict&&!diagnosticText(why)?why:'';
      const lat=el('span','m ms'+(wait?' run':t?' '+t:x.durationMs>=1000?' slow':''),ms(wait?ref-Date.parse(s.at):s.durationMs)),v=el('span','v');v.append(el('b','m',verdict));if(reason)v.append(el('i','',' '+reason));
      if(wait){lat.dataset.since=s.at;lat.dataset.ms=''}b.type='button';b.dataset.call=s.id;b.dataset.run=s.runId;b.setAttribute('aria-controls','basis');if(rcSeen&&!rcSeen.has(s.id)){li.className='in';setTimeout(()=>li.classList.remove('in'),600)}
      b.setAttribute('aria-label',clock(s.at)+' '+name+', '+verdict+(reason?' · '+reason:'')+', '+(wait?label('응답 대기','awaiting response'):ms(s.durationMs)));
      b.append(el('span','m t',clock(s.at)),el('span','f',name),v,lat,el('span','m tk',rc?.input==null?'–':(rc.input/1000).toFixed(1)+'k'));li.append(b)}
    rcSeen=new Set(list.map(s=>s.id))}
  picked=basis(ops,list,all,calls);
  for(const b of root.querySelectorAll('button[data-call]')){b.classList.toggle('on',picked?.id===b.dataset.call&&picked.runId===b.dataset.run);b.setAttribute('aria-pressed',String(rcPin?.id===b.dataset.call&&rcPin.run===b.dataset.run))}}
const showResume=()=>{const b=$('log-resume');b.hidden=!(paused&&pendingNew>0);put(b,label('새 호출 '+pendingNew+'건 · 재개',pendingNew+' new calls · Resume'))};
// The basis of one call: its verdict and reason code, each question's top answer with its probability against the threshold the
// decision used, and the response times of the same feature's recent calls.
function basis(ops,list,all,calls){const pin=rcPin&&all.find(s=>s.id===rcPin.id&&s.runId===rcPin.run),s=pin||list[0],x=s&&routed(s),done=x&&x.durationMs!==undefined,rc=x?.receipt,root=$('basis-q');
  put($('basis-meta'),s?clock(s.at)+' · '+tr(featureInfo[s.feature]?.[0]||s.feature):label('호출 없음','No calls'));
  lead($('basis-verdict'),!s?'–':!done?label('응답 대기','Awaiting response'):x.state==='error'?label('요청 오류','Request error'):decisionText(x));const codeEl=$('basis-code');
  const g=x?.routing,why=done&&!g?humanText(x.state==='error'&&x.cause||note(x,ops.runs.find(r=>r.id===s.runId))):'',code=!done?'':g?(g.modelReason===g.effortReason?routingReason(g.modelReason):label('모델 ','Model ')+routingReason(g.modelReason)+' · effort '+routingReason(g.effortReason)):diagnosticText(why)?'':why;put(codeEl,code);codeEl.title=rc?.code||x?.cause||code;
  const link=$('basis-trace');link.setAttribute('aria-disabled',String(!s));link.tabIndex=s?0:-1;link.href=s?'#run='+encodeURIComponent(s.runId):'#';
  peers(s,calls);
  if(root._key&&root._key[0]===x&&root._key[1]===lang)return s;root._key=[x,lang];root.replaceChildren();
  const qs=!done?[]:x.judgements?.length?x.judgements.map(j=>{const yes=j.value.startsWith('참 확률')&&j.probabilities.find(p=>p.label==='참')?.value,side=yes===false||yes===undefined?null:yes>=.5?'참':'거짓';return {k:judgmentName(j.question),top:choiceName(j.question,side||j.value),p:side?Math.max(yes,1-yes):j.probabilities.find(p=>p.label===j.value)?.value??j.confidence,th:j.question==='model'||j.question==='capability'?rc?.threshold:null}})
    :rc?.confidence!=null?[{k:NODE[x.feature]?label(...NODE[x.feature][2]):x.feature,top:decisionText(x),p:rc.confidence,th:rc.threshold}]:[],over=qs.length>BASIS_ROWS,rows=over?qs.slice(0,BASIS_ROWS-1):qs;
  for(let k=0;k<BASIS_ROWS;k++){const q=rows[k],li=el('li','bq');root.append(li);
    if(q){const bar=el('span','qb'),track=el('span','tr'),fill=el('i',q.p!=null&&q.p<(q.th??.6)?'lo':'');track.setAttribute('aria-hidden','true');fill.style.transform='scaleX('+(q.p??0)+')';track.append(fill);if(q.th!=null){const tick=el('b');tick.style.left=pct(q.th);track.append(tick)}bar.append(track,el('span','m cap p',q.p==null?'–':q.p.toFixed(2)));
      li.setAttribute('aria-label',q.k+' '+q.top+' '+(q.p==null?'–':q.p.toFixed(2))+(q.th!=null?label(' · 문턱 ',' · threshold ')+q.th.toFixed(2):''));li.append(el('span','k',q.k),el('span','a',q.top),bar)}
    else if(over&&k===BASIS_ROWS-1)li.append(el('span','k',label('외 '+(qs.length-rows.length)+'개','+'+(qs.length-rows.length)+' more')))}
  return s}
// The same feature's last 28 response times, oldest first; bars are scaled against one second.
function peers(s,calls){const box=$('basis-bars');while(box.querySelectorAll('i').length<PEERS)box.append(el('i'));const same=s?calls.filter(c=>c.feature===s.feature).slice(0,PEERS).reverse():[],bars=box.querySelectorAll('i'),name=s?tr(featureInfo[s.feature]?.[0]||s.feature):'';
  bars.forEach((b,k)=>{const c=same[k];b.style.transform='scaleY('+(c?Math.min(c.durationMs,1000)/1000:0).toFixed(3)+')';b.classList.toggle('on',!!c&&c.id===s.id&&c.runId===s.runId)});
  put($('basis-peers'),s?label('같은 기능 최근 '+same.length+'건',name+' · last '+same.length):'');box.setAttribute('aria-label',s?label(name+' 최근 '+same.length+'건 응답 시간',name+' response times, last '+same.length):label('호출 없음','No calls'))}
function effortProof(m){const parts=[];if(m.selectedEffort)parts.push(label('선택 effort ','Selected effort ')+m.selectedEffort);if(m.effortSource)parts.push((m.effortSource==='provider_request'?label('API 전송 effort ','API request effort '):label('호스트 전달 effort ','Host dispatch effort '))+(m.forwardedEffort||label('명시 값 없음','No explicit value')));parts.push(label('응답 effort: ','Response effort: ')+(m.observedEffort||label('호스트 응답에 미제공','Not reported by host')));return parts.join(' · ')}
function issueKind(s){return s.issue||(s.model?.status==='mismatch'?'response_model':s.lane==='jev'?'jev':'host')}
// A failure that a later success settled stays in history, never in the current count.
const failedStep=s=>s.state==='error'||s.model?.status==='mismatch',currentStep=s=>failedStep(s)&&s.impact?.now!=='later_ok';
function diagnosis(runs){const groups=new Map();for(const r of runs)for(const k of new Set(r.steps.filter(currentStep).map(issueKind)))groups.set(k,(groups.get(k)||0)+1);return [...groups].map(([k,n])=>label(...ISSUES[k])+' '+n+label('건',' recorded')).join(' · ')}
const ISSUES={request_model:['API 전송 모델 불일치','API request model mismatch'],request_effort:['API 전송 effort 불일치','API request effort mismatch'],request_unconfirmed:['설정 적용 실패 · 항목 미확인','Setting application failure · dimension unknown'],response_model:['실제 응답 모델 불일치','Response model mismatch'],contract:['워커 계약 미충족','Worker contract not met'],jev:['Jev 판정 오류','Jev assessment error'],host:['호스트 실행·검사 오류','Host execution / check error']};
const IMPACT={ongoing:['이후 기록에서도 실패','Still failing in later records'],unknown:['현재 영향 미확인','Current impact unknown'],later_ok:['이후 같은 작업 정상 기록','Same operation succeeded later']};
// Where a failure happened, why, and what later records of the same operation on that host show now.
function failureFacts(s,r,add){if(!failedStep(s))return;const i=s.impact;
  add(label('원인','Cause'),[s.cause&&humanText(s.cause),!s.cause&&label(...ISSUES[issueKind(s)])].filter(Boolean).join(' · '));
  add(label('현재 영향','Current impact'),label(...IMPACT[i?.now||'unknown']));if(i)add(label('마지막 관측','Last observation'),date(i.lastAt)+' · '+tr(state[i.lastState]));
  add(label('호스트','Host'),r?.host==='codex'?'Codex':'Claude');add(label('세션','Session'),s.sessionId||label('세션 기록 없음','Session not recorded'))}
const REASONS={check_unobserved:['보고 검사의 실행 미관측','Reported check execution unobserved'],same_value:['현재 모델·설정 유지','Keep current setting'],selected:['변경 선택','Change selected'],not_applied:['선택한 변경 미적용 · 유지','Selected change not applied · kept'],confidence_below_threshold:['변경 기준 미충족 · 유지','Below change threshold · kept'],low_confidence:['변경 기준 미충족 · 유지','Below change threshold · kept'],answer_invalid:['응답 검증 실패 · 유지','Invalid assessment · kept'],control_invalid:['요청 해석 응답 검증 실패 · 유지','Invalid control assessment · kept'],context_missing:['판단할 문맥 부족 · 유지','Insufficient context · kept'],control_unclear:['요청 해석 불명확 · 유지','Unclear request · kept'],control_low_confidence:['요청 해석 기준 미충족 · 유지','Low control confidence · kept'],effort_lock:['추론 강도가 고정됨 · 유지','Effort locked · kept'],model_lock:['모델이 고정됨 · 유지','Model locked · kept'],explicit_model:['호출에 명시된 모델 유지','Keep explicit caller model'],subagent_model_pinned:['호스트 자식 모델 고정 · 유지','Host child model pinned · kept'],routing_off:['라우팅 꺼짐 · 유지','Routing off · kept'],cache_preserved:['캐시 재사용을 위해 유지','Kept for cache reuse'],gate_allocated:['Gate B 최종 배정 사용','Final Gate B allocation'],applied:['변경 선택','Change selected'],not_asked:['이 항목은 판단하지 않음','Dimension not assessed'],control_needs_context:['판단할 문맥 부족 · 유지','Insufficient context · kept'],control_lock:['사용자가 고정 · 유지','User locked · kept'],model_pinned:['명시 모델 고정 · 유지','Explicit model pin · kept'],gate_routed:['Gate B가 이미 배정','Already allocated by Gate B'],fork:['호스트 fork 상속','Host fork inheritance'],definition_unverified:['에이전트 정의 미확인 · 유지','Unverified agent definition · kept'],nothing_to_change:['변경 가능한 항목 없음','No mutable dimension'],timeout:['판단 시간 초과 · 유지','Assessment timeout · kept'],capability_unclear:['필요 역량 판단 불가 · 유지','Capability unclear · kept'],retry_step_up:['재시도 · 한 단계 상향','Retry · one role up'],superseded_baseline:['구버전 모델 · 최신 버전으로 교체','Superseded model · newest successor'],risk_blocks_downgrade:['실행 위험 · 하향 안 함','Action risk · no downgrade'],cost_hold:['전환 비용 · 모델 유지','Switch cost · model kept'],cost_unknown_hold:['전환 비용 미확인 · 모델 유지','Switch cost unknown · model kept'],baseline_reach:['기준 모델 캐시 범위 · 모델 유지','Baseline cache reach · model kept'],candidate_unavailable:['대상 모델 없음 · 유지','Target unavailable · kept'],
tool_editing_floor:['편집 작업 최소 모델 유지','Editing model floor'],
tool_read_only:['읽기 전용 도구 작업','Read-only tool work'],
tool_editing:['편집 도구 작업','Editing tool work'],
tool_unknown:['도구 범위 미확인 · 모델 유지','Unknown tool scope · model kept'],
tool_ceiling:['도구 작업 모델 상한 유지','Tool model ceiling kept'],
price_unknown:['모델 가격 미확인','Model price unknown'],
price_invalid:['모델 가격 오류','Invalid model price'],
usage_partial:['사용량 일부 미관측','Partial usage observed'],
usage_invalid:['사용량 기록 오류','Invalid usage record'],
write_ttl_unknown:['캐시 쓰기 TTL 미확인','Cache write TTL unknown'],
unresolved_contract_reasoning:['계약 추론 미해결','Unresolved contract reasoning'],
observed_reasoning_failure:['추론 실패 관측','Observed reasoning failure'],
no_specific_basis:['구체적 상향 근거 없음','No specific upgrade basis'],
not_checked:['전환 비용 미검사','Switch cost not checked'],
upgrade_allowed:['상향 전환 허용','Upgrade allowed'],
cost_allows:['전환 비용 기준 충족','Switch cost allows'],
pair_invalid:['모델·effort 조합 불가','Invalid model and effort pair'],
target_effort_unresolved:['대상 effort 미확인','Target effort unresolved'],
input_secret:['민감정보 감지','Sensitive input detected'],
input_too_large:['판정 입력 한도 초과','Judgment input too large'],
no_alternative:['대체 모델 없음','No alternative model'],
configuration_update_native_history:['설정 변경 · 네이티브 기록 유지','Settings changed; native history kept'],
child_step_limit:['하위 단계 한도','Child step limit'],
child_context_unavailable:['하위 실행 문맥 없음','Child context unavailable'],
child_pair_changed_before_submission:['전송 전 하위 모델·effort 변경','Child model or effort changed before submission'],
child_unregistered:['등록되지 않은 하위 실행','Unregistered child'],
child_stopped:['하위 라우팅 중지','Child routing stopped'],
native_child:['네이티브 하위 실행 유지','Native child kept'],
key_missing:['Jev API 키 없음','Jev API key missing'],
key_invalid:['Jev API 키 형식 오류','Invalid Jev API key'],
no_key:['Jev API 키 없음','Jev API key missing'],
disabled:['기능 꺼짐','Feature disabled'],
router_disabled:['Router 꺼짐','Router disabled'],
model_catalog_missing:['호스트 모델 목록 없음','Host model catalog missing'],
capability_unknown:['모델 역량 미확인','Model capability unknown'],
host_unverified:['호스트 호환 미확인','Host compatibility unverified'],
alias_remapped:['모델 별칭 변경','Model alias remapped'],
baseline_unknown:['기준 모델 미확인','Baseline model unknown'],
no_applicable_target:['적용 가능한 대상 없음','No applicable target'],
rank_unknown:['모델 등급 미확인','Model rank unknown'],
turn_retired:['종료된 턴','Retired turn'],
internal_error:['내부 오류','Internal error'],
incoming_divergence:['호스트 설정 변경','Host settings diverged'],
effort_pinned:['effort 고정','Effort pinned'],
model_not_allowed:['허용되지 않은 모델','Model not allowed'],
target_not_allowed:['허용되지 않은 대상','Target not allowed'],
context_unverified:['문맥 호환 미확인','Context compatibility unverified'],
no_record:['기록 없음','No record'],
no_cache:['캐시 없음','No cache'],
shorter_request:['이전보다 짧은 요청','Shorter request'],
task_notification_without_request:['요청 없는 작업 알림','Task notification without request'],
no_task_text:['사용자 작업 입력 없음','No user task text'],
first_step_native:['첫 단계 네이티브 유지','Native first step'],
next_turn:['다음 턴','Next turn'],
step_abandoned:['단계 중단','Step abandoned'],
step_failed:['단계 실패','Step failed'],
session_ended:['세션 종료','Session ended'],
host_request_failed:['호스트 요청 실패','Host request failed'],
effort_unknown:['effort 미확인','Effort unknown'],
policy_unavailable:['정책 확인 불가','Policy unavailable'],
policy_denied:['정책이 호출 거부','Policy denied'],
no_eligible_model:['적격 모델 없음','No eligible model'],
restricted_baseline:['제한된 기준 모델','Restricted baseline'],
unverified:['미검증','Unverified'],
child_history_full:['하위 실행 기록 한도','Child history full'],
resumed:['기존 실행 재개','Existing run resumed'],
observed_miss_floor_restored:['관측 누락 · 최소 effort 복원','Observed miss; effort floor restored'],
incoming_changed:['호스트 effort 변경','Incoming effort changed'],
admission_answer_only:['응답만 필요한 요청','Answer-only request'],
admission_too_small:['위임하기 작은 요청','Request too small to delegate'],
admission_external_tools:['외부 도구 요청 유지','External tool request kept'],
route_invalid:['등급 응답 검증 실패','Invalid tier assessment'],
route_tie:['등급 판정 동률','Tier assessment tied'],
route_abstain:['등급 판단 보류','Tier assessment abstained'],
route_low_confidence:['등급 확신 부족','Low tier confidence'],
basis_invalid:['상향 근거 검증 실패','Invalid upgrade basis'],
basis_tie:['상향 근거 동률','Upgrade basis tied'],
basis_absent:['상향 근거 없음','Upgrade basis absent'],
basis_low_confidence:['상향 근거 확신 부족','Low upgrade basis confidence'],
generation_changed:['현재 작업 세대 변경','Task generation changed'],
pinned:['호출 설정 고정','Caller settings pinned'],
dispatch_ineligible:['실행 적격 조건 미충족','Dispatch ineligible'],
task_active:['작업 실행 중','Task already active'],
attempt_mismatch:['실행 시도 불일치','Attempt mismatch'],
stale_generation:['이전 작업 세대','Stale task generation'],
bounds_exhausted:['실행 시도 한도','Attempt limit reached'],
preflight_conflict:['실행 전 점검 충돌','Preflight conflict'],
permissions_unavailable:['부모 권한 전달 불가','Parent permissions unavailable'],
worktree_unavailable:['작업 공간 생성 불가','Worktree unavailable'],
allocation_unavailable:['배정 설정 사용 불가','Allocation unavailable'],
cancelled:['시작 전 취소','Cancelled before start'],
reservation_unavailable:['실행 예약 기록 불가','Reservation unavailable'],
native_start_rejected:['호스트가 시작 거부','Host rejected start'],
native_failed_turn:['호스트 워커 턴 실패','Native worker turn failed'],
interrupted:['워커 중단','Worker interrupted'],
termination_unconfirmed:['워커 종료 미확인','Worker termination unconfirmed'],
credential_refused:['인증 확인 필요','Credentials need review'],
aborted:['중단됨','Aborted'],
saturated:['동시 요청 한도','Concurrent request limit'],
network:['연결 오류','Network error'],
rejected_input:['입력 거절','Input rejected'],
context_exceeded:['문맥 길이 한도 초과','Context limit exceeded'],
unauthorized:['인증 실패','Unauthorized'],
payment_required:['크레딧 소진','Credits exhausted'],
rate_limited:['요청 속도 한도','Rate limited'],
overloaded:['서버 과부하','Server overloaded'],
http_other:['HTTP 오류','HTTP error'],
response_too_large:['응답 크기 한도 초과','Response too large'],
response_invalid:['응답 검증 실패','Invalid response'],
malformed:['응답 형식 오류','Malformed response'],
model_mismatch:['응답 모델 불일치','Response model mismatch'],
invalid_answers:['판정 형식 오류','Invalid assessment'],
not_eligible:['추출 적격 조건 미충족','Not eligible for extraction'],
superseded:['새 턴으로 교체됨','Superseded by a new turn'],
error:['선별 오류','Selection error'],
mode_off:['Gate 꺼짐','Gate off'],
mode_native:['호스트 기본 모드','Native host mode'],
not_agent_tool:['Agent 외 도구','Non-Agent tool'],
child_caller:['하위 실행의 호출','Child caller'],
custom_agent_session:['사용자 정의 에이전트 세션','Custom agent session'],
missing_ids:['호출 식별자 없음','Missing call identifiers'],
bad_tool_input:['도구 입력 형식 오류','Invalid tool input'],
role_not_owned:['Gate 소유 역할 아님','Role outside Gate ownership'],
not_foreground:['전면 호출 아님','Not a foreground call'],
execution_control_present:['호스트 실행 제어 유지','Host execution control kept'],
subagent_model_override:['하위 모델 재정의 유지','Subagent model override kept'],
fork_or_background_override:['fork·백그라운드 재정의 유지','Fork or background override kept'],
prompt_too_large:['프롬프트 크기 한도','Prompt too large'],
prompt_invalid_unicode:['프롬프트 문자 오류','Invalid prompt Unicode'],
request_too_large:['요청 크기 한도','Request too large'],
config_invalid:['설정 검증 실패','Invalid configuration'],
trace_intent_failed:['요청 의도 기록 실패','Trace intent write failed'],
output_too_large:['훅 출력 크기 한도','Hook output too large'],
no_state:['작업 상태 없음','No job state'],
host_unsupported:['지원하지 않는 호스트','Unsupported host'],
deadline_exhausted:['훅 시간 한도 소진','Hook deadline exhausted'],
state_corrupt:['상태 기록 손상','Corrupt state'],
state_too_large:['상태 크기 한도','State too large'],
state_locked:['상태 잠금 중','State locked'],
state_symlink:['상태 심볼릭 링크 거부','State symlink refused'],
state_write_failed:['상태 기록 실패','State write failed'],
stdin_too_large:['입력 크기 한도','Input too large'],
stdin_invalid_json:['입력 JSON 오류','Invalid input JSON'],
stdin_invalid_utf8:['입력 UTF-8 오류','Invalid input UTF-8'],
stdin_read_failed:['입력 읽기 실패','Input read failed'],
internal:['내부 오류','Internal error'],
precompute:['사전 계산 생략','Precompute skipped'],
request_identity_unknown:['요청 식별 미확인','Request identity unknown'],
response_unconfirmed:['응답 미관측','Response unconfirmed'],
response_model_confirmed:['응답 모델 일치','Response model confirmed'],
request_applied:['요청 설정 적용','Request settings applied'],
http_400:['HTTP 400 오류','HTTP 400 error'],
http_401:['HTTP 401 오류','HTTP 401 error'],
http_402:['HTTP 402 오류','HTTP 402 error'],
http_413:['HTTP 413 오류','HTTP 413 error'],
http_415:['HTTP 415 오류','HTTP 415 error'],
http_422:['HTTP 422 오류','HTTP 422 error'],
http_429:['HTTP 429 오류','HTTP 429 error'],
http_529:['HTTP 529 오류','HTTP 529 error'],
admission_not_worth:['위임 이득 부족','Delegation not worth it'],
admission_needs_context:['앞선 대화 문맥 필요','Needs earlier conversation context'],
admission_low_confidence:['판정 확신 부족','Low judgment confidence'],
admission_invalid:['응답 검증 실패','Invalid assessment'],
admission_tie:['판정 동률','Tied judgment'],
admission_abstain:['Jev 판단 보류','Jev abstained'],
admission_forced:['실험 설정으로 고정','Fixed by experiment setting'],
admission_forbids_delegation:['요청이 위임을 금지','Request forbids delegation'],
admission_shape_unknown:['실행 형태 미확인','Execution path unknown'],
admission_delivery_failed:['필수 원문 전달 불가','Required text cannot be delivered'],
prompt_id_absent:['프롬프트 식별자 없음','No prompt id'],
depth_unknown:['세션 깊이 미확인','Session depth unknown'],
depth_below_floor:['세션이 위임 기준보다 얕음','Session below the delegation floor'],
task_notification:['작업 알림 턴','Task notification turn'],ok:['정상','OK'],invalid:['유효하지 않음','Invalid'],unknown_model:['모델 미확인','Unknown model'],ambiguous:['판정 모호','Ambiguous']};
const routingReason=value=>value?REASONS[value]?label(...REASONS[value]):label('기록된 사유 · 진단 정보 참고','Recorded reason · see diagnostics'):label('기록 없음','Not recorded');
const humanText=value=>String(tr(value||'')).split(' · ').map(v=>({single:label('단일 워커','Single worker'),incomplete:label('작업 완료 조건 미충족','Completion conditions not met'),legacy_model:label('이전 모델 기록','Historical model record'),fable_disabled_by_config:label('설정에서 최상위 모델 제외','Frontier model excluded by settings')}[v]||REASONS[v]&&label(...REASONS[v])||(/^[a-z][a-z_]+$/.test(v)&&v.includes('_')?label('추가 진단 기록','Additional diagnostic record'):v))).join(' · ');
const diagnosticsOf=(s,r,a)=>({host:r?.host,runId:r?.id,recordId:s?.id,sessionId:s?.sessionId,at:s?.at,reason:s?.cause,modelReason:s?.routing?.modelReason,effortReason:s?.routing?.effortReason,source:(s?.details||[]).filter(x=>diagnosticText(x)&&!s.judgements?.some(j=>x.startsWith(j.question+':'))),current:a?.current?{runId:a.current.runId,at:a.current.at}:undefined});
const diagnosticText=value=>/loaded.hook|excluded|effort.source|incoming.field|\\b[a-z][a-z0-9]*_[a-z0-9_]+\\b|\\b(?:legacy_model|fable_disabled_by_config)\\b|\\b[a-f0-9]{8,}\\b/i.test(value);
const elapsed=(s,cls)=>{const e=el('span',cls||'',ms((frozenAt??Date.now())-Date.parse(runningSince(s))));e.dataset.since=runningSince(s);e.dataset.ms='';return e};
// Only recorded values become facts; an absent value is left out rather than shown as zero.
function stepFacts(s,r){const f=[],add=(k,v,wide)=>{if(v!=null&&v!=='')f.push([k,v,wide])},rc=s.receipt,m=s.model;
  add(label('상태','State'),tr(state[s.state]));add(label('요약','Summary'),humanText(s.summary||'결과 요약 없음'),true);failureFacts(s,r,add);
  if(rc){add(label('토큰','Tokens'),rc.input==null&&rc.output==null?null:kTokens(rc.input)+' → '+kTokens(rc.output));add(label('추정 비용','Est. cost'),rc.costUsd==null?null:usd(rc.costUsd));add(label('Jev 모델','Jev model'),rc.model);add('HTTP',rc.status>=400?[rc.status,rc.code].filter(Boolean).join(' · '):null)}
  if(m){add(label('선택','Selected'),[m.selected,m.selectedEffort].filter(Boolean).join(' · ')||label('선택값 기록 없음','Selection not recorded'));const o=document.createDocumentFragment();o.append(m.observed||(s.state==='active'?label('응답 대기','Awaiting response'):label('응답 모델 기록 없음','No response model recorded')));if(m.status==='confirmed'||m.status==='mismatch')o.append(' ',el('span','tag '+(m.status==='confirmed'?'ok':'er'),m.status==='confirmed'?label('일치','Match'):label('불일치','Mismatch')));add(label('실제 응답','Observed response'),o);
    if(m.requestApplied!==undefined)add(label('API 전송 설정','API request settings'),m.requestApplied?label('일치','Match'):label('불일치','Mismatch'));if(m.selectedEffort||m.effortSource||m.observedEffort)add('effort',effortProof(m),true)}
  if(s.routing){const scopes={root:['메인 턴','Main turn'],spawn:['일반 에이전트 생성','Native agent spawn'],child:['자식 실행 단계','Child execution step'],owned:['Jev 소유 워커 · Gate B','Jev owned worker · Gate B']},r=s.routing;add(label('라우팅 대상','Routing scope'),scopes[r.scope]?label(...scopes[r.scope]):r.scope);if(!(s.details||[]).some(x=>x.startsWith('기존 모델 '+r.baseline)))add(label('기존 모델','Baseline model'),r.baseline);add(label('Jev 제안 모델','Jev proposed model'),r.proposedModel);if(r.proposedModel&&!isCall(s)){add(label('제안 확률','Proposal probability'),r.probability===undefined?null:pct(r.probability));add(label('적용 기준','Change threshold'),r.threshold===undefined?null:pct(r.threshold))}add(label('모델 판단 이유','Model decision'),routingReason(r.modelReason));add(label('effort 판단 이유','Effort decision'),routingReason(r.effortReason))}
  if(s.durationMs!==undefined)add(s.lane==='jev'?label('Jev 응답','Jev response'):label('처리 시간','Timing'),ms(s.durationMs));if(s.elapsedMs!==undefined&&s.durationMs===undefined)add(label('기록 사이 경과','Elapsed between records'),ms(s.elapsedMs));
  for(const j of s.judgements||[])add(judgmentName(j.question),choiceName(j.question,j.value)+(j.confidence!==null?' · '+pct(j.confidence):'')+(j.probabilities.length?' ('+j.probabilities.map(p=>choiceName(j.question,p.label)+' '+pct(p.value)).join(' · ')+')':''),true);
  const evidence=(s.details||[]).filter(x=>!diagnosticText(x)&&!x.includes('?')&&!x.includes('미기록')&&!s.judgements?.some(j=>x.startsWith(j.question+':'))&&!(rc&&(x.startsWith('Jev 요청 · ')||x.startsWith('Jev 입력 '))));if(evidence.length){const o=document.createDocumentFragment();for(const x of evidence)o.append(el('span','line',humanText(x)));add(label('결정 근거','Decision basis'),o,true)}
  add(label('기록 시각','Recorded'),date(s.at));return f}
// Frames leave out the fields only an opened stage shows; they are fetched for that stage and kept while it is unchanged.
const stepDetails=new Map();
function detailed(r,s){if(s.details)return s;const k=r.id+' '+s.id,d=stepDetails.get(k);if(d?.base===s)return d.step||s;const e={base:s,step:null};stepDetails.set(k,e);
  fetch('/api/step?run='+encodeURIComponent(r.id)+'&step='+encodeURIComponent(s.id)).then(x=>x.ok?x.json():null).then(full=>{if(!full||stepDetails.get(k)!==e)return;e.step={...full,...s};clearTimeout(detailed.t);detailed.t=setTimeout(()=>{$('trace')._key=null;if(data)draw(data)},30)},()=>{});return s}
// A stage's result: its decision, else the model it observed and whether that matched, else its state.
const resultOf=s=>{const m=s.model;return s.receipt||s.outcome?decisionText(s):m?.observed||m?.selected?(m.observed||m.selected)+(m.status==='confirmed'?label(' · 일치',' · match'):m.status==='mismatch'?label(' · 불일치',' · mismatch'):''):tr(state[s.state])};
// Bars share the run's time span. While a stage runs, tick() places them again, so its bar grows with its duration label.
const took=(s,ref)=>s.durationMs??s.elapsedMs??(runningSince(s)?ref-Date.parse(runningSince(s)):undefined),spanStart=(s,ref)=>s.startedAt?Date.parse(s.startedAt):Date.parse(s.at)-(took(s,ref)??0),spanEnd=(s,ref)=>s.startedAt?Date.parse(s.startedAt)+(took(s,ref)??0):Date.parse(s.at);
function place(bars,ref){const min=Math.min(...bars.map(([,s])=>spanStart(s,ref))),range=Math.max(1,Math.max(...bars.map(([,s])=>spanEnd(s,ref)))-min);
  // A stage's tag follows its bar, or precedes it when the bar ends near the right edge; with no room on either side it is hidden.
  for(const [i,s,tag] of bars){const x=Math.max(0,Math.min(99,100*(spanStart(s,ref)-min)/range)),w=Math.max(.4,Math.min(100-x,100*Math.max(1,took(s,ref)??1)/range)),end=x+w;i.style.left=x+'%';i.style.width=w+'%';
    if(tag){tag.hidden=x<20&&end>=80;tag.style.left=end<80?'calc('+end+'% + 8px)':'';tag.style.right=end<80?'':'calc('+(100-x)+'% + 8px)';tag.style.maxWidth='calc('+(end<80?100-end:x)+'% - 8px)'}}
  return range}
// The trace is its own view at #run=<id>; the overview keeps its state underneath.
function showRoute(){const m=/^#run=(.+)$/.exec(location.hash);let next=null;try{next=m?decodeURIComponent(m[1]):null}catch{}if(next!==route)selectedStep=null;route=next;
  $('overview').hidden=!!route;$('trace-view').hidden=!route;$('crumb').hidden=!route;$('host-filters').hidden=!!route;if(data)draw(data);else trace(null);window.scrollTo?.(0,0)}
function ruler(range){const box=$('ruler');if(box.children.length!==6)box.replaceChildren(...[0,1,2,3,4,5].map(i=>{const e=el('span');e.style.left=i*20+'%';e.style.transform='translateX('+(i?i===5?'-100%':'-50%':'0')+')';return e}));[...box.children].forEach((e,i)=>put(e,(range<60000?ms:span)(range*i/5)))}
function runStats(r,n){const ref=frozenAt??Date.now(),compact=r?r.steps.filter(s=>s.feature==='compact'&&Number.isFinite(s.durationMs)):[],att=r?r.steps.filter(currentStep).length:0;
  const cells=[[label('소요','Duration'),r?span((r.state==='active'?ref:Date.parse(r.lastAt))-Date.parse(r.firstAt)):'–',r?.state==='active'?r.firstAt:''],[label('단계','Stages'),r?n:'–'],[label('Jev 호출','Jev calls'),r?r.steps.filter(isCall).length:'–'],[label('압축 시간','Compaction time'),compact.length?ms(compact.reduce((a,s)=>a+s.durationMs,0)):'–'],[label('확인 필요','Needs review'),r?att:'–','',att>0]];
  $('rd-stats').replaceChildren(...cells.map(([k,v,since,er])=>{const d=el('div','kpi'),x=el('div','m kn'+(er?' er':''),v);if(since)x.dataset.since=since;d.append(el('div','kl',k),x);return d}))}
// Rows are rebuilt only when the run or the language changes; selecting a stage updates its row and the detail in place.
function trace(r){const root=$('trace'),ref=frozenAt??Date.now(),missing=!r&&!!data;
  put($('rd-name'),r?tr(r.title):missing?label('실행을 찾을 수 없습니다','Execution not found'):'');$('rd-name').title=r?tr(r.title):'';put($('crumb-run'),r?tr(r.title):'');put($('crumb-id'),route?route.slice(0,8):'');
  const st=$('rd-state');st.className='rst'+(r?' '+(RUNST[r.state]||'ok'):'');st.hidden=!r;put(st.lastChild,r?tr(state[r.state]):'');put($('rd-meta'),r?[r.host==='codex'?'Codex':'Claude',label('시작 ','Started ')+time(r.firstAt)].join(' · '):'');
  if(!(root._key?.[0]===r&&root._key[1]===lang&&root._key[2]===missing)){root._key=[r,lang,missing];root._bars=null;root.replaceChildren();root._model=null;
    if(!r){runStats(null,0);ruler(0);if(missing)root.append(el('li','empty',label('48시간 기록에 이 실행이 없습니다.','This execution is not in the 48-hour records.')))}
    else{
      // A Gate response and its code decision are one stage: the decision names it and gives its outcome.
      const decided=new Map();for(const s of r.steps)if(s.lane==='jev'){const p=policyOf(s,r);if(p)decided.set(s,p)}const policies=new Set(decided.values());
      const substantive=r.steps.filter(s=>(!s.lifecycle||s.state==='error'||s.state==='active'||s.outcome==='host_ended')&&!policies.has(s));
      // Consecutive settled records that say the same thing (a response check on every inference step) are one row with their count.
      const groups=[],same=(a,b)=>a.title===b.title&&a.summary===b.summary&&resultOf(a)===resultOf(b)&&a.state==='done'&&b.state==='done'&&!a.receipt&&!b.receipt&&!decided.has(a)&&!decided.has(b);
      for(const s of substantive.length?substantive:r.steps.slice(-12)){const g=groups.at(-1);if(g&&same(g.s,s)){g.s=s;g.ids.push(s.id)}else groups.push({first:s,s,ids:[s.id]})}
      const shownGroups=groups.slice(-100),steps=shownGroups.map(g=>g.s),repeat=new Map(shownGroups.filter(g=>g.ids.length>1).map(g=>[g.s,g])),bars=[];root._model={steps,decided,policies,repeat};
      root.classList.toggle('grown',root._for!==r.id&&motion());root._for=r.id;
      for(const s of steps){const g=repeat.get(s),li=el('li'),b=el('button','sx'),nm=el('span','nm'),bar=el('span','bar'),i=el('i',s.state==='error'?'e':s.state==='active'?'run':''),result=resultOf(s),tag=el('em','m cap',result),t=g?Date.parse(s.at)-Date.parse(g.first.at):took(s,ref),f=featureInfo[s.feature],title=tr((decided.get(s)||s).title),head=f&&tr(f[0]),name=head&&title.startsWith(head+' · ')?title.slice(head.length+3):title;
        b.type='button';b.dataset.step=s.id;b.setAttribute('aria-controls','step-detail');bar.setAttribute('aria-hidden','true');if(head)nm.append(el('b','',head),' ');nm.append(el('span','',name+(g?' ×'+g.ids.length:'')));
        // A repeated row's bar spans its first record to its last.
        bars.push([i,g?{...s,startedAt:g.first.at,durationMs:Date.parse(s.at)-Date.parse(g.first.at)}:s,tag]);bar.append(i,tag);
        const du=s.durationMs===undefined&&runningSince(s)?elapsed(s,'m du'):el('span','m du'+(t===undefined?' none':''),t===undefined?'–':ms(t));b.setAttribute('aria-label',[head,name+(g?' ×'+g.ids.length:''),result,du.textContent].filter(Boolean).join(', '));b.append(nm,bar,du);li.append(b);root.append(li)}
      runStats(r,steps.length);ruler(place(bars,ref));if(bars.some(([,s])=>runningSince(s)))root._bars=bars}}
  const mdl=root._model;if(!mdl){detail(r,null);return}
  const {steps,decided,policies,repeat}=mdl,policy=r.steps.find(s=>s.id===selectedStep);if(policy&&policies.has(policy))selectedStep=[...decided].find(([,p])=>p===policy)[0].id;for(const g of repeat.values())if(g.ids.includes(selectedStep))selectedStep=g.s.id;
  if(!steps.some(s=>s.id===selectedStep)){const issue=[...steps].reverse().find(currentStep)||[...steps].reverse().find(failedStep);selectedStep=(issue||[...steps].reverse().find(s=>s.receipt||s.judgements?.length)||steps.at(-1))?.id||null}
  for(const b of root.querySelectorAll('button[data-step]'))b.setAttribute('aria-pressed',String(b.dataset.step===selectedStep));
  const s=steps.find(s=>s.id===selectedStep);detail(r,s,s&&repeat.get(s),s&&decided.get(s))}
function detail(r,s,g,p){const h=$('sd-h'),body=$('sd-body'),full=s&&detailed(r,s),key=[r&&full,lang,g?.ids.length,p];if(body._key?.every((v,k)=>v===key[k]))return;body._key=key;
  if(!s){put(h,label('단계 상세','Stage detail'));body.replaceChildren();return}
  const f=featureInfo[s.feature],ref=frozenAt??Date.now(),start=g?Date.parse(g.first.at):spanStart(s,ref),t=g?Date.parse(s.at)-start:took(s,ref);
  const head=f?tr(f[0]):'',title=tr((p||s).title);put(h,head&&!title.startsWith(head+' · ')?head+' · '+title:title);
  const facts=stepFacts(p?{...full,summary:p.summary}:full,r);if(g)facts.splice(1,0,[label('반복 기록','Repeated records'),label(g.ids.length+'건 · ',g.ids.length+' records · ')+time(g.first.at)+' – '+time(s.at)]);
  // Session, host, record time and coded values belong to the raw event; the list keeps what a reader acts on.
  const dl=el('dl','kvl'),raw=el('dl','kvl'),diag=[label('기록 시각','Recorded'),label('세션','Session'),label('호스트','Host')];
  // The detail leaves out the state and the time its header and result already show.
  const result=resultOf(s),du=t?ms(t):'',shown=[label('상태','State'),label('요약','Summary'),label('Jev 응답','Jev response'),label('처리 시간','Timing'),label('기록 사이 경과','Elapsed between records')];
  for(const [k,v] of facts){if(shown.includes(k)&&(v===du||v===result))continue;const dd=el('dd');if(typeof v==='string')dd.textContent=v;else dd.append(v);(diag.includes(k)||typeof v==='string'&&diagnosticText(v)?raw:dl).append(el('dt','',k),dd)}
  const det=el('details','raw'),pre=el('pre','m');pre.textContent=JSON.stringify(diagnosticsOf(full,r),null,2);det.append(el('summary','',label('원시 이벤트','Raw event')),raw,pre);
  body.replaceChildren(el('div','m cap',clock(start)+(t?' → '+clock(start+t)+' · '+ms(t):'')),el('div','kl',label('결과','Result')),el('div','res',result),dl,det)}
function settings(snapshot){showVersion(snapshot.version);$('recording').setAttribute('aria-checked',String(snapshot.recording?.enabled!==false));$('dashboard-auto').setAttribute('aria-checked',String(snapshot.dashboard?.enabled!==false));const n=$('notice');n.textContent=preferenceError?label('설정을 저장하지 못했습니다. 다시 시도해 주세요.','Could not save this setting. Please retry.'):snapshot.recording?.enabled===false?label('실행 기록이 꺼져 있습니다. 기존 기록을 표시하며 Jev 기능은 계속 동작합니다.','Recording is off. Showing existing records; Jev features continue.'):snapshot.unreadable?label('일부 기록을 읽지 못했습니다. doctor로 기록 경로를 확인하세요.','Some records could not be read. Check recording paths with doctor.'):'';n.title=n.textContent}
function versionState(v){const release=v?.release,latest=release?.latest,valid=value=>typeof value==='string'&&/^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$/.test(value);if(!valid(v?.running))return{state:'unknown',none:true,text:label('버전 확인 불가','Version unknown')};if(v.installed&&v.installed!==v.running)return{state:'mismatch',text:'v'+v.running+' · '+label('설치 버전 다름','Installed version differs')};if(!valid(latest)||release.error)return{state:'unknown',text:'v'+v.running+' · '+label('최신 여부 미확인','Update status unknown')};const a=v.running.split('.').map(Number),b=latest.split('.').map(Number);let cmp=0;for(let i=0;i<3;i++)if(a[i]!==b[i]){cmp=a[i]<b[i]?-1:1;break}return{state:cmp<0?'update':cmp===0?'current':'unreleased',text:'v'+v.running+' · '+(cmp<0?label('v'+latest+' 업데이트','v'+latest+' available'):cmp===0?label('최신','Current'):label('배포 전 빌드','Unreleased build'))}}
function showVersion(v){const status=versionState(v),badge=$('version-badge');badge.hidden=!!status.none;badge.textContent=status.none?'':status.state==='update'?'v'+v.running+' → '+v.release.latest:status.state==='mismatch'?'v'+v.running+' ≠ v'+v.installed:'v'+v.running;badge.dataset.state=status.state;badge.title=label('실행 중인 대시보드','Running dashboard')+': '+(v?.running||label('미확인','unknown'))+' · '+label('설치된 Claude 플러그인','Installed Claude plugin')+': '+(v?.installed||label('미확인','unknown'))+' · '+label('최신 릴리즈','Latest release')+': '+(v?.release?.latest||label('미확인','unknown'))+(v?.release?.checkedAt?' · '+date(v.release.checkedAt):'')+(status.state==='mismatch'?' · '+label('설치 후에도 기존 세션은 이전 훅을 사용합니다. 새 네이티브 세션에서 로드된 버전을 확인하세요.','Existing sessions can retain older hooks after installation. Verify loaded versions in a fresh native session.'):'');badge.ariaLabel=status.text+' · '+badge.title}
// Records that landed or changed since the previous frame. The first frame of a scope marks nothing, so opening the page,
// resuming or switching hosts never replays history.
let seen=null,seenScope='';
function arrivals(ops){const ref=frozenAt??Date.now(),fresh=new Map();
  if(seen&&hostFilter===seenScope)for(const r of ops.runs){const old=seen.get(r.id);if(old===r)continue;const had=new Map(old?.steps.map(s=>[s.id,s]));for(const s of r.steps){const p=had.get(s.id);if(CIRCUIT.includes(s.feature)&&!s.lifecycle&&(!p||signalKey(p)!==signalKey(s))&&ref-Date.parse(s.at)<ACTIVITY_MS)fresh.set(r.id+' '+s.id,{...s,runId:r.id})}}
  seen=new Map(ops.runs.map(r=>[r.id,r]));seenScope=hostFilter;return fresh}
// Motion runs after the values are painted; no value waits for it.
function flash(s){const stage=$('stages').querySelector('[data-feature="'+s.feature+'"]');if(stage){stage.classList.add('hit');later(()=>stage.classList.remove('hit'),700)}if(!isCall(s))return;
  const w=$('dots')._els?.get(s.runId+' '+s.id);if(w&&!w._dot.classList.contains('fresh')){const stem=el('i','stem');stem.setAttribute('aria-hidden','true');stem.style.transform='scaleY('+(w._yv/100).toFixed(3)+')';w.prepend(stem);w._dot.classList.add('fresh');later(()=>{w._dot.classList.remove('fresh');stem.remove()},1000)}
  const k=$('j-feats')._rows?.find(r=>r.dataset.feature===s.feature)?.firstChild;if(k){k.classList.add('hit');later(()=>k.classList.remove('hit'),300)}
  if(s===freshest){$('j-last').classList.add('hot');later(()=>$('j-last').classList.remove('hot'),400)}packet(s)}
let freshest=null;
// Both lists' scroll positions are read before any write, so a draw lays the page out once instead of once per list.
function draw(snapshot){const f=document.activeElement,d=f?.dataset||{},key=d.call?['call',d.call]:d.step?['step',d.step]:d.run?['run',d.run]:d.feature?['feature',d.feature]:null,box=f?.closest?.('[id]')?.id,top=$('runs').scrollTop;
  data=snapshot;if(!snapshot.operations)return;settings(snapshot);const ops=view=scoped(snapshot.operations),moving=motion();
  if(selectedFeature!=='all'&&ops.features.find(f=>f.id===selectedFeature)?.state==='unsupported')selectedFeature='all';
  let fresh=new Map();if(moving)fresh=arrivals(ops);else{cancelMotion();seen=null}document.body.classList.toggle('still',!moving);
  for(const b of $('host-filters').querySelectorAll('button'))b.setAttribute('aria-pressed',String(b.dataset.host===hostFilter));$('pause').setAttribute('aria-pressed',String(paused));
  const calls=callsOf(ops),pend=pendingOf(ops),ref=frozenAt??Date.now();pool=calls;lastCallAt=calls[0]?Date.parse(calls[0].at):null;
  if(!route){stats(ops,calls);receipts(ops,calls,pend);axis();scatter(ops,ref);mini(ref);rail(ops,calls);stages(ops);runs(ops,top)}
  const run=route&&snapshot.operations.runs.find(r=>r.id===route)||null;if(route)trace(run);
  document.title=route?'Jev Gate · '+(run?tr(run.title):label('실행','Execution')):label('Jev Gate · 개요','Jev Gate · Overview');
  if(fresh.size&&!route){freshest=[...fresh.values()].filter(isCall).sort((a,b)=>b.at.localeCompare(a.at))[0]||null;requestAnimationFrame(()=>{if(motion())for(const s of fresh.values())flash(s)})}
  if(key&&document.activeElement!==f)(f.isConnected?f:[...($(box)?.querySelectorAll('[data-'+key[0]+']')||[])].find(e=>e.dataset[key[0]]===key[1]))?.focus({preventScroll:true});tick(true)}
const motion=()=>!paused&&!$('connection').classList.contains('warn')&&!matchMedia('(prefers-reduced-motion: reduce)').matches;
function cancelMotion(){for(const t of timers)clearTimeout(t);timers.clear();for(const e of document.querySelectorAll('.lane,.stem'))e.remove();for(const e of document.querySelectorAll('.fresh,.hit,.hot'))e.classList.remove('fresh','hit','hot')}
// Calls a held frame adds beyond the frame on screen.
const countNew=next=>{if(!data?.operations||!next?.operations)return 0;const newest=callsOf(scoped(data.operations))[0]?.at||'';let n=0;for(const s of callsOf(scoped(next.operations))){if(s.at<=newest)break;n++}return n};
let tickSec=-1;
// Ages and elapsed spans change once a second; only a running call's millisecond count needs every tick. A hidden tab does
// nothing until it is shown again.
function tick(all){if(document.hidden)return;const ref=frozenAt??Date.now(),c=$('connection'),since=lastCallAt==null?NaN:ref-lastCallAt,sec=Math.floor(ref/1000),whole=all===true||sec!==tickSec;
  put(c,!c.dataset.label?tr('연결 중'):c.classList.contains('warn')?tr(c.dataset.label):paused?label('일시정지 · +'+pendingNew,'Paused · +'+pendingNew):'Live'+(Number.isFinite(since)?' · '+(since<1000?'now':ago(since)):''));
  if(whole)for(const e of document.querySelectorAll('[data-ago]'))put(e,e.dataset.ago?ago(ref-Date.parse(e.dataset.ago)):'–');
  for(const e of document.querySelectorAll(whole?'[data-since]':'[data-since][data-ms]'))put(e,('ms' in e.dataset?ms:span)(ref-Date.parse(e.dataset.since)));if($('trace')._bars)ruler(place($('trace')._bars,ref));
  if(!view||route)return;if(sec!==tickSec){tickSec=sec;rate();scatter(view,ref);mini(ref);feats(ref)}else if(motion())slide(ref)}
// Freezing and resuming redraw once.
const connection=(ok,text)=>{const was=frozenAt;frozenAt=!ok||paused?(frozenAt??Date.now()):null;const c=$('connection');c.classList.toggle('warn',!ok);$('pause').classList.toggle('warn',!ok);c.dataset.label=text;if((was===null)!==(frozenAt===null)&&data)draw(data);tick(true)};
$('stages').addEventListener('click',e=>{const b=e.target.closest('button[data-feature]');if(!b||!data)return;selectedFeature=selectedFeature===b.dataset.feature?'all':b.dataset.feature;draw(data)});
$('log-clear').addEventListener('click',()=>{selectedFeature='all';if(data)draw(data);$('stages').querySelector('button:not([hidden])')?.focus({preventScroll:true})});
$('windows').addEventListener('click',e=>{const b=e.target.closest('button[data-win]');if(!b)return;win=+b.dataset.win;for(const x of $('windows').querySelectorAll('button'))x.setAttribute('aria-pressed',String(x===b));if(data)draw(data)});
$('scatter').addEventListener('click',e=>{const d=e.target.closest('.dot');if(!d||!data)return;rcPin={run:d.dataset.run,id:d.dataset.call};selectedFeature='all';draw(data)});
$('scatter').addEventListener('pointerover',e=>{const d=e.target.closest('.dot');hover=d?d.dataset.run+' '+d.dataset.call:null;tipAt(frozenAt??Date.now())});
$('scatter').addEventListener('pointerleave',()=>{hover=null;$('tip').hidden=true});
$('state-filters').addEventListener('click',e=>{const b=e.target.closest('button[data-state]');if(b&&data){stateFilter=b.dataset.state;draw(data)}});
$('attention').addEventListener('click',()=>{stateFilter='attention';if(data)draw(data);$('run-list').scrollIntoView({block:'start',behavior:'instant'});$('state-filters').querySelector('[aria-pressed=true]')?.focus({preventScroll:true})});
$('runs').addEventListener('scroll',()=>{const root=$('runs');if(root.scrollTop===0){root.style.paddingBottom='';if(root._deferred&&view){root._latest=true;runs(view,0)}}});
$('runs').addEventListener('pointerdown',()=>{runHold=true});for(const t of ['pointerup','pointercancel'])addEventListener(t,()=>{if(runHold)setTimeout(()=>{runHold=false;if(data)draw(data)})});
$('trace').addEventListener('click',e=>{const b=e.target.closest('button[data-step]');if(b&&data){selectedStep=b.dataset.step;draw(data)}});
// A row under a press keeps its element until the click that ends the press has run.
$('rc').addEventListener('pointerdown',()=>{rcHold=true});for(const t of ['pointerup','pointercancel'])addEventListener(t,()=>{if(rcHold)setTimeout(()=>{rcHold=false;if(data)draw(data)})});
$('rc').addEventListener('click',e=>{const b=e.target.closest('button[data-call]');if(!b||!data)return;rcPin=rcPin?.id===b.dataset.call&&rcPin.run===b.dataset.run?null:{run:b.dataset.run,id:b.dataset.call};draw(data)});
// Resuming takes the held frame as the new baseline, so calls that landed during the pause never replay.
$('pause').addEventListener('click',()=>{paused=!paused;if(!paused){pendingNew=0;if(pending){data=pending;pending=null}}applyLanguage();if(!$('connection').classList.contains('warn'))connection(true,paused?'연결됨 · 화면 일시정지':'실시간 연결');else if(data)draw(data)});
$('log-resume').addEventListener('click',()=>{if(paused)$('pause').click()});
$('host-filters').addEventListener('click',e=>{const b=e.target.closest('button[data-host]');if(!b)return;hostFilter=b.dataset.host;rcSeen=null;rcPin=null;hover=null;if(data)draw(data)});
addEventListener('hashchange',showRoute);
// A background tab keeps its stream but draws nothing; the newest frame is drawn when it is shown.
document.addEventListener('visibilitychange',()=>{if(document.hidden)return;if(!paused&&pending){const next=pending;pending=null;draw(next)}else tick(true)});
buildStages();roll($('k-today'),0);
try{lang=localStorage.getItem('jev-dashboard-lang')==='en'?'en':'ko';document.documentElement.dataset.theme=localStorage.getItem('jev-dashboard-theme')||'dark'}catch{document.documentElement.dataset.theme='dark'}showRoute();applyLanguage();axis();feats(Date.now());$('theme').addEventListener('click',()=>{const next=document.documentElement.dataset.theme==='dark'?'light':'dark';document.documentElement.dataset.theme=next;try{localStorage.setItem('jev-dashboard-theme',next)}catch{}applyLanguage()});$('language').addEventListener('click',()=>{lang=lang==='en'?'ko':'en';try{localStorage.setItem('jev-dashboard-lang',lang)}catch{}applyLanguage()});
const viewer=crypto.randomUUID();let stream,lastHeartbeat=0;function connect(){stream=new EventSource('/api/live?viewer='+viewer);stream.onopen=()=>{lastHeartbeat=Date.now();connection(true,paused?'연결됨 · 화면 일시정지':'실시간 연결')};stream.addEventListener?.('heartbeat',()=>{lastHeartbeat=Date.now();connection(true,paused?'연결됨 · 화면 일시정지':'실시간 연결')});const frame=next=>{lastHeartbeat=Date.now();if(paused){pending=next;pendingNew=countNew(next);showResume()}else if(document.hidden)pending=next;else{pending=null;draw(next)}connection(true,paused?'연결됨 · 화면 일시정지':'실시간 연결')};stream.onmessage=e=>{try{const next=JSON.parse(e.data);if(e.data.length<1e6){frame(next);return}pending=next;setTimeout(()=>{if(pending===next)frame(next)})}catch{connection(false,'응답 오류')}};stream.addEventListener?.('patch',e=>{try{const next=applyPatch(pending??data,JSON.parse(e.data));if(next)frame(next);else{stream.close();connect()}}catch{connection(false,'응답 오류')}});stream.onerror=()=>connection(false,'재연결 중')}connect();let versionCheckAt=0;async function refreshVersion(){if(Date.now()-versionCheckAt<300000)return;versionCheckAt=Date.now();try{const response=await fetch('/api/version');if(response.ok){const version=await response.json();showVersion(version);if(data)data.version=version}}catch{}}const firstVersion=/*JEV_VERSION*/null;if(firstVersion){showVersion(firstVersion);versionCheckAt=Date.now()}refreshVersion();addEventListener('focus',refreshVersion);setInterval(()=>{if(!document.hidden)refreshVersion()},300000);addEventListener('pagehide',()=>{stream.close();navigator.sendBeacon('/api/viewer-close?viewer='+viewer)});addEventListener('pageshow',e=>{if(e.persisted)connect()});setInterval(tick,100);
for(const [id,path,key]of [['recording','recording','recording'],['dashboard-auto','dashboard','dashboard']])$(id).addEventListener('click',async()=>{const button=$(id);button.disabled=true;try{const response=await fetch('/api/'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({enabled:button.getAttribute('aria-checked')!=='true'})});if(!response.ok)throw Error('preference');const value=await response.json();preferenceError=false;if(data){data[key]=value;draw(data)}}catch{preferenceError=true;const n=$('notice');n.textContent=n.title=label('설정을 저장하지 못했습니다. 다시 시도해 주세요.','Could not save this setting. Please retry.')}finally{button.disabled=false}});
</script></body></html>`;
