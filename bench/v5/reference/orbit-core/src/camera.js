// Screen = (world - center) * zoom + viewport/2. Both axes point the same way, so the two transforms are exact inverses.
export const createCamera = ({ cx = 0, cy = 0, zoom = 1, viewportW, viewportH }) => {
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) throw new RangeError('cx and cy must be finite numbers');
  if (!Number.isFinite(zoom) || zoom <= 0) throw new RangeError('zoom must be a finite positive number');
  if (!Number.isFinite(viewportW) || viewportW <= 0 || !Number.isFinite(viewportH) || viewportH <= 0) throw new RangeError('viewportW and viewportH must be finite positive numbers');
  return { cx, cy, zoom, viewportW, viewportH };
};

export const worldToScreen = (cam, point) => ({
  x: (point.x - cam.cx) * cam.zoom + cam.viewportW / 2,
  y: (point.y - cam.cy) * cam.zoom + cam.viewportH / 2,
});

export const screenToWorld = (cam, point) => ({
  x: (point.x - cam.viewportW / 2) / cam.zoom + cam.cx,
  y: (point.y - cam.viewportH / 2) / cam.zoom + cam.cy,
});

export const pan = (cam, dx, dy) => {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) throw new RangeError('dx and dy must be finite numbers');
  return { ...cam, cx: cam.cx + dx / cam.zoom, cy: cam.cy + dy / cam.zoom };
};

export const zoomAt = (cam, screenPoint, factor) => {
  if (!Number.isFinite(factor) || factor <= 0) throw new RangeError('factor must be a finite positive number');
  const anchor = screenToWorld(cam, screenPoint);
  const zoom = cam.zoom * factor;
  // Solve screenToWorld({…zoom}, screenPoint) === anchor for the new centre, so the point under the cursor cannot move.
  return { ...cam, zoom, cx: anchor.x - (screenPoint.x - cam.viewportW / 2) / zoom, cy: anchor.y - (screenPoint.y - cam.viewportH / 2) / zoom };
};
