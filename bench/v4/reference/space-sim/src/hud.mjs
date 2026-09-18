export function renderHud(simState, selectedId = null) {
  const sel = selectedId ? simState.bodies.find((b) => b.id === selectedId) : null;
  const speed = sel ? Math.hypot(sel.vx, sel.vy) : null;
  return [
    `t=${(simState.timeMs / 1000).toFixed(2)}s`,
    `scale=${simState.timeScale}x`,
    simState.paused ? 'PAUSED' : 'RUNNING',
    `bodies=${simState.bodies.length}`,
    sel ? `selected=${sel.id} speed=${speed.toFixed(1)}` : 'selected=none',
  ].join('\n');
}
