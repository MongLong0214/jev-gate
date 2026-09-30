import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { obj, type Obj } from './source.js';

/** Bidirectional App Server transport. Internal, client and server request ids occupy separate namespaces. */
export class CodexRpc {
  private sequence = 0;
  private pending = new Map<string, { resolve: (value: Obj) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private clients = new Map<string, { id: unknown; method: string; params: Obj }>();
  private servers = new Map<string, unknown>();
  private closed = false;
  onNotification: (message: Obj) => void = () => undefined;
  onRequest: (message: Obj) => Promise<boolean> = async () => false;
  onResponse: (result: Obj, method: string, params: Obj) => Promise<Obj> = async r => r;
  emit: (message: Obj) => void = () => undefined;
  onClose: () => void = () => undefined;
  constructor(input: Readable, private output: Writable) {
    const lines = createInterface({ input, crlfDelay: Infinity });
    lines.on('line', line => { try { const m = obj(JSON.parse(line)); if (m) void this.receive(m).catch(() => this.close()); } catch { this.close(); } });
    lines.on('close', () => this.close());
    output.on('error', () => this.close());
  }
  send(message: Obj): void { if (this.closed) throw new Error('Codex App Server disconnected'); this.output.write(JSON.stringify(message) + '\n'); }
  request(method: string, params: Obj, timeoutMs = 30_000): Promise<Obj> {
    if (this.closed || this.pending.size >= 512) return Promise.reject(new Error('Codex request unavailable'));
    const id = `jev-internal-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Codex request timed out')); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); } catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }
  forward(message: Obj): void {
    if (typeof message['method'] === 'string' && 'id' in message) {
      if (this.clients.size >= 512) throw new Error('too many Codex requests');
      const id = `jev-client-${++this.sequence}`;
      this.clients.set(id, { id: message['id'], method: message['method'], params: obj(message['params']) ?? {} });
      this.send({ ...message, id });
    } else if ('id' in message) {
      const original = this.servers.get(String(message['id']));
      if (original === undefined) throw new Error('unknown Codex server request');
      this.servers.delete(String(message['id'])); this.send({ ...message, id: original });
    } else this.send(message);
  }
  private async receive(message: Obj): Promise<void> {
    const id = String(message['id']);
    if (typeof message['method'] === 'string') {
      if (!('id' in message)) { this.onNotification(message); this.emit(message); return; }
      if (await this.onRequest(message)) return;
      const mapped = `jev-server-${++this.sequence}`;
      this.servers.set(mapped, message['id']); this.emit({ ...message, id: mapped }); return;
    }
    const pending = this.pending.get(id);
    if (pending) {
      clearTimeout(pending.timer); this.pending.delete(id);
      if (message['error']) pending.reject(new Error('Codex rejected request'));
      else pending.resolve(obj(message['result']) ?? {});
      return;
    }
    const client = this.clients.get(id);
    if (client) {
      this.clients.delete(id);
      const result = obj(message['result']);
      this.emit({ ...message, id: client.id, ...(result ? { result: await this.onResponse(result, client.method, client.params) } : {}) });
    }
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Codex App Server disconnected')); }
    this.pending.clear(); this.clients.clear(); this.servers.clear();
    this.onClose();
  }
}
