// 카메라 변환. worldToScreen은 뷰포트 중심을 더하는데 screenToWorld는 빼지 않아서 둘이 역함수가 아니다.
export const createCamera = ({ cx = 0, cy = 0, zoom = 1, viewportW, viewportH }) => ({ cx, cy, zoom, viewportW, viewportH });

export const worldToScreen = (cam, point) => ({
  x: (point.x - cam.cx) * cam.zoom + cam.viewportW / 2,
  y: (point.y - cam.cy) * cam.zoom + cam.viewportH / 2,
});

export const screenToWorld = (cam, point) => ({
  x: point.x / cam.zoom + cam.cx,
  y: point.y / cam.zoom + cam.cy,
});

export const pan = (cam, dx, dy) => ({ ...cam, cx: cam.cx + dx, cy: cam.cy + dy });
