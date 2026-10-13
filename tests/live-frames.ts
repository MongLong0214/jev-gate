import { PATCH_SCRIPT } from '../src/dashboard-patch.js';

/** The page's own patch function, run as the page runs it. */
export const applyPatch = new Function(`${PATCH_SCRIPT}; return applyPatch;`)() as (prev: unknown, message: unknown) => Record<string, unknown> | null;

/** Reads the live stream as the page does: a whole frame, then each patch applied to it. Heartbeats are skipped. */
export const liveFrames = (reader: ReadableStreamDefaultReader<Uint8Array>) => {
  const decoder = new TextDecoder();
  let buffer = '', current: Record<string, unknown> | null = null;
  const take = (): Record<string, unknown> | null => {
    for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
      const lines = buffer.slice(0, end).split('\n'); buffer = buffer.slice(end + 2);
      const event = lines.find(line => line.startsWith('event: '))?.slice(7), data = lines.find(line => line.startsWith('data: '))?.slice(6);
      if (!data || event === 'heartbeat') continue;
      if (event === 'patch') {
        const next = applyPatch(current, JSON.parse(data));
        if (!next) throw new Error('a patch did not follow the frame held');
        return current = next;
      }
      return current = JSON.parse(data) as Record<string, unknown>;
    }
    return null;
  };
  return {
    async next<T>(timeoutMs = 2500, label = 'live frame'): Promise<T> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const frame = take();
        if (frame) return frame as T;
        const chunk = await Promise.race([reader.read(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), Math.max(1, deadline - Date.now())))]);
        if (chunk.done) throw new Error('SSE ended');
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    },
  };
};
