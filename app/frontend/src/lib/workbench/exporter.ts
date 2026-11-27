/** Package the generated app as a standalone, zero-dependency zip runnable with plain Node.js. */
import type { FilePath, Plan } from './types';
import { FILE_PATHS } from './types';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Minimal "stored" (uncompressed) zip writer with UTF-8 names. */
export function zip(entries: { name: string; content: string }[]): Blob {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  const d = new Date();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  let offset = 0;
  for (const entry of entries) {
    const name = enc.encode(entry.name);
    const data = enc.encode(entry.content);
    const crc = crc32(data);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true);
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    parts.push(local, data);

    const cen = new Uint8Array(46 + name.length);
    const cv = new DataView(cen.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    cen.set(name, 46);
    central.push(cen);
    offset += local.length + data.length;
  }
  const size = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, size, true);
  ev.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end] as BlobPart[], { type: 'application/zip' });
}

const RUN_JS = [
  "'use strict';",
  '// 独立启动器：只使用 Node.js 内置模块，无需安装依赖、无需联网。',
  "const http = require('http');",
  "const fs = require('fs');",
  "const path = require('path');",
  "const vm = require('vm');",
  '',
  'const ROOT = __dirname;',
  "const DATA = path.join(ROOT, 'data.json');",
  'const PORT = Number(process.env.PORT) || 3000;',
  '',
  "const context = vm.createContext({ console: console, crypto: globalThis.crypto });",
  "vm.runInContext(fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8'), context, { filename: 'server.js' });",
  "const handle = vm.runInContext('handle', context);",
  '',
  'const store = {',
  '  read: async function () {',
  "    try { return JSON.parse(fs.readFileSync(DATA, 'utf8')); } catch (e) { return null; }",
  '  },',
  '  write: async function (obj) {',
  "    const tmp = DATA + '.tmp';",
  '    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));',
  '    fs.renameSync(tmp, DATA);',
  '  },',
  '};',
  '',
  'const STATIC = {',
  "  '/': ['index.html', 'text/html; charset=utf-8'],",
  "  '/index.html': ['index.html', 'text/html; charset=utf-8'],",
  "  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],",
  '};',
  '',
  'http.createServer(function (req, res) {',
  "  const url = new URL(req.url, 'http://localhost');",
  '  const send = function (status, body, type) {',
  "    res.writeHead(status, { 'Content-Type': type || 'application/json; charset=utf-8' });",
  '    res.end(body);',
  '  };',
  "  if (url.pathname.startsWith('/api/')) {",
  "    let raw = '';",
  "    req.on('data', function (chunk) { raw += chunk; if (raw.length > 1e6) req.destroy(); });",
  "    req.on('end', async function () {",
  '      let body = null;',
  "      try { body = raw ? JSON.parse(raw) : null; } catch (e) { return send(400, JSON.stringify({ error: '请求体不是合法 JSON' })); }",
  '      try {',
  "        const r = await handle({ method: req.method, path: url.pathname.replace(/\\/+$/, ''), query: Object.fromEntries(url.searchParams), body: body }, store);",
  '        send(r.status, JSON.stringify(r.body === undefined ? null : r.body));',
  '      } catch (e) {',
  '        console.error(e);',
  "        send(500, JSON.stringify({ error: '服务内部错误' }));",
  '      }',
  '    });',
  '    return;',
  '  }',
  '  const file = STATIC[url.pathname];',
  "  if (!file) return send(404, 'Not Found', 'text/plain; charset=utf-8');",
  '  send(200, fs.readFileSync(path.join(ROOT, file[0])), file[1]);',
  "}).listen(PORT, '127.0.0.1', function () {",
  "  console.log('应用已启动：http://127.0.0.1:' + PORT + '/');",
  '});',
  '',
].join('\n');

function readme(plan: Plan | null, withData: boolean): string {
  return [
    `# ${plan?.title ?? '生成的应用'}`,
    '',
    plan?.summary ?? '',
    '',
    '## 运行',
    '',
    '只需要 Node.js 18 及以上版本，不需要安装任何依赖，也不需要联网。',
    '',
    '```bash',
    'node run.js',
    '# 指定端口：PORT=8080 node run.js',
    '```',
    '',
    '然后在浏览器打开 http://127.0.0.1:3000/ 。',
    '',
    '## 文件',
    '',
    '- `server.js`：数据接口 handle(req, store)',
    '- `index.html`：页面结构与样式',
    '- `app.js`：页面逻辑',
    '- `run.js`：独立启动器（静态文件 + /api/items 接口 + data.json 持久化）',
    withData ? '- `data.json`：导出时的应用数据' : '- `data.json`：首次写入数据时自动创建',
    '',
  ].join('\n');
}

export function buildExport(
  files: Partial<Record<FilePath, string>>,
  plan: Plan | null,
  data: string | null,
): Blob | null {
  if (!FILE_PATHS.every((p) => files[p]?.trim())) return null;
  const folder = 'atoms-app';
  const entries = FILE_PATHS.map((p) => ({ name: `${folder}/${p}`, content: files[p]! }));
  entries.push({ name: `${folder}/run.js`, content: RUN_JS });
  entries.push({ name: `${folder}/README.md`, content: readme(plan, !!data) });
  if (data) entries.push({ name: `${folder}/data.json`, content: data });
  return zip(entries);
}

export function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
