export function createCamera({ viewportWidth, viewportHeight, x = 0, y = 0, zoom = 1 } = {}) {
  const cam = { x, y, zoom, viewportWidth, viewportHeight };
  return {
    pan(dxScreen, dyScreen) { cam.x -= dxScreen / cam.zoom; cam.y -= dyScreen / cam.zoom; },
    zoomBy(factor, anchorScreen) {
      if (!(factor > 0) || !Number.isFinite(factor)) throw new RangeError('zoom factor must be positive');
      const anchorWorld = anchorScreen ? this.screenToWorld(anchorScreen) : null;
      cam.zoom = Math.min(64, Math.max(1 / 64, cam.zoom * factor));
      if (anchorWorld) { const after = this.worldToScreen(anchorWorld); cam.x += (after.x - anchorScreen.x) / cam.zoom; cam.y += (after.y - anchorScreen.y) / cam.zoom; }
    },
    worldToScreen({ x: wx, y: wy }) { return { x: (wx - cam.x) * cam.zoom + cam.viewportWidth / 2, y: (wy - cam.y) * cam.zoom + cam.viewportHeight / 2 }; },
    screenToWorld({ x: sx, y: sy }) { return { x: (sx - cam.viewportWidth / 2) / cam.zoom + cam.x, y: (sy - cam.viewportHeight / 2) / cam.zoom + cam.y }; },
    state: () => ({ ...cam }),
  };
}
