/**
 * Process-level isolated runtime for generated apps.
 * Each app instance runs server.js inside a dedicated Web Worker with network APIs removed;
 * persistence goes only through a store backed by a per-session document. Not a security sandbox.
 */
import { docApi } from './api';
import type { FilePath } from './types';

export interface AppRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
}
export interface AppResponse {
  status: number;
  body: unknown;
}

const READY_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 5_000;
const MAX_WRITE_BYTES = 1_000_000;

const WORKER_PRELUDE = `
"use strict";
for (const k of ['fetch','XMLHttpRequest','WebSocket','EventSource','importScripts','indexedDB','caches','BroadcastChannel']) {
  try { Object.defineProperty(self, k, { value: undefined, configurable: false }); } catch (e) {}
}
let __seq = 0; const __pending = new Map();
const store = {
  read: () => new Promise((res, rej) => { const id = ++__seq; __pending.set(id, [res, rej]); postMessage({ t: 'store', op: 'read', id }); }),
  write: (obj) => new Promise((res, rej) => { const id = ++__seq; __pending.set(id, [res, rej]); postMessage({ t: 'store', op: 'write', id, value: JSON.stringify(obj) }); }),
};
`;

const WORKER_EPILOGUE = `
;self.onmessage = async (e) => {
  const m = e.data;
  if (m.t === 'store-res') { const p = __pending.get(m.id); if (!p) return; __pending.delete(m.id); m.error ? p[1](new Error(m.error)) : p[0](m.value); return; }
  if (m.t === 'req') {
    try {
      const r = await handle(m.req, store);
      if (!r || typeof r.status !== 'number') throw new Error('handle 必须返回 { status, body }');
      postMessage({ t: 'res', id: m.id, res: { status: r.status, body: JSON.parse(JSON.stringify(r.body ?? null)) } });
    } catch (err) { postMessage({ t: 'res', id: m.id, error: String((err && err.stack) || err) }); }
  }
};
if (typeof handle !== 'function') throw new Error('server.js 未定义顶层函数 handle(req, store)');
postMessage({ t: 'ready' });
`;

type Log = (line: string) => void;

export class AppInstance {
  private worker: Worker | null = null;
  private url = '';
  private seq = 0;
  private pending = new Map<number, { resolve: (r: AppResponse) => void; reject: (e: Error) => void }>();
  private docId: number | undefined;
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly sid: string,
    private readonly kind: string,
    readonly port: number,
    private readonly log: Log,
  ) {}

  async start(serverCode: string): Promise<void> {
    this.stop();
    const blob = new Blob([WORKER_PRELUDE, serverCode, WORKER_EPILOGUE], { type: 'text/javascript' });
    this.url = URL.createObjectURL(blob);
    const worker = new Worker(this.url);
    this.worker = worker;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.stop();
        reject(new Error(`应用 ${READY_TIMEOUT_MS / 1000} 秒内未就绪`));
      }, READY_TIMEOUT_MS);
      worker.onerror = (ev) => {
        ev.preventDefault();
        const line = `[app:${this.port}] 启动失败 server.js:${ev.lineno ? ev.lineno - WORKER_PRELUDE.split('\n').length + 1 : '?'} ${ev.message}`;
        this.log(line);
        clearTimeout(timer);
        this.stop();
        reject(new Error(line));
      };
      worker.onmessage = (ev) => this.onMessage(ev.data, () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.log(`[app:${this.port}] 已就绪，监听 127.0.0.1:${this.port}`);
  }

  private onMessage(m: { t: string; id: number; op?: string; value?: string; res?: AppResponse; error?: string }, ready: () => void) {
    if (m.t === 'ready') return ready();
    if (m.t === 'store') return void this.handleStore(m.id, m.op!, m.value);
    if (m.t === 'res') {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) {
        this.log(`[app:${this.port}] 运行错误：${m.error.split('\n')[0]}`);
        p.reject(new Error(m.error));
      } else p.resolve(m.res!);
    }
  }

  private async handleStore(id: number, op: string, value?: string) {
    const reply = (payload: { value?: unknown; error?: string }) => this.worker?.postMessage({ t: 'store-res', id, ...payload });
    try {
      if (op === 'read') {
        const doc = await docApi.read(this.sid, this.kind);
        this.docId = doc?.id;
        let parsed: unknown = null;
        try {
          parsed = doc ? JSON.parse(doc.content) : null;
        } catch {
          parsed = null;
        }
        reply({ value: parsed });
      } else {
        if ((value ?? '').length > MAX_WRITE_BYTES) {
          this.log(`[app:${this.port}] 超出单文件写入上限 ${MAX_WRITE_BYTES} 字节，实例已终止`);
          this.stop();
          return;
        }
        this.writeChain = this.writeChain.then(async () => {
          this.docId = await docApi.write(this.sid, this.kind, value ?? 'null', this.docId);
        });
        await this.writeChain;
        reply({});
      }
    } catch (e) {
      reply({ error: (e as Error).message || '存储失败' });
    }
  }

  request(req: AppRequest): Promise<AppResponse> {
    const worker = this.worker;
    if (!worker) return Promise.reject(new Error('应用未运行'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.log(`[app:${this.port}] 请求超过 ${REQUEST_TIMEOUT_MS / 1000} 秒（CPU 时间上限），实例已终止`);
        this.stop();
        reject(new Error('请求超时，应用已被终止'));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (r) => (clearTimeout(timer), resolve(r)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      worker.postMessage({ t: 'req', id, req });
    });
  }

  get running() {
    return this.worker !== null;
  }

  stop() {
    this.worker?.terminate();
    this.worker = null;
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = '';
    this.pending.forEach((p) => p.reject(new Error('应用已停止')));
    this.pending.clear();
  }
}

export function allocatePort(previous?: number | null): number {
  let port = 0;
  do port = 40000 + Math.floor(Math.random() * 20000);
  while (port === previous);
  return port;
}

export function parseUrl(url: string, method: string, body: unknown): AppRequest {
  const u = new URL(url, 'http://app.local/');
  return { method: method.toUpperCase(), path: u.pathname.replace(/\/+$/, '') || '/', query: Object.fromEntries(u.searchParams), body };
}

const SHIM = `<script>(function(){var seq=0,wait={};
window.addEventListener('message',function(e){var m=e.data||{};if(m.t!=='app-res'||!wait[m.id])return;var w=wait[m.id];delete wait[m.id];
 if(m.error){w[1](new TypeError(m.error));return;}
 w[0](new Response(JSON.stringify(m.body),{status:m.status,headers:{'Content-Type':'application/json'}}));});
window.fetch=function(input,init){init=init||{};var url=typeof input==='string'?input:input.url;var body=null;
 try{body=init.body?JSON.parse(init.body):null}catch(e){body=null}
 return new Promise(function(res,rej){var id=++seq;wait[id]=[res,rej];parent.postMessage({t:'app-req',id:id,url:url,method:init.method||'GET',body:body},'*');});};
try{Object.defineProperty(window,'localStorage',{value:null});Object.defineProperty(window,'sessionStorage',{value:null});}catch(e){}
})();</script>`;

/** Build same-origin preview document: requests are proxied to the instance via postMessage. */
export function buildPreviewDoc(files: Partial<Record<FilePath, string>>): string {
  const html = files['index.html'] ?? '<html><body>缺少 index.html</body></html>';
  const appJs = (files['app.js'] ?? '').replace(/<\/script/gi, '<\\/script');
  const withScript = html.replace(/<script[^>]*src=["']\.?\/?app\.js["'][^>]*>\s*<\/script>/i, `<script>${appJs}</script>`);
  return withScript.includes('<head>') ? withScript.replace('<head>', `<head>${SHIM}`) : SHIM + withScript;
}
