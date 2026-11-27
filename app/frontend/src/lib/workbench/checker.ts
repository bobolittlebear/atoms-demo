import { parse } from 'acorn';
import { AppInstance, allocatePort } from './runtime';
import type { AppResponse } from './runtime';
import { docApi } from './api';
import type { CheckItem, Field, FilePath, Plan } from './types';
import { FILE_PATHS } from './types';

const MAX_LINES = 500;
const LEGACY_ID = 'legacy-check';
const LEGACY_KEY = 'legacyNote';

export interface CheckFailure {
  file: FilePath;
  message: string;
}

export interface StaticResult {
  items: CheckItem[];
  failure: CheckFailure | null;
}

function jsSyntax(path: FilePath, code: string): string | null {
  try {
    parse(code, { ecmaVersion: 'latest', sourceType: 'script', allowAwaitOutsideFunction: false });
    return null;
  } catch (e) {
    const err = e as SyntaxError & { loc?: { line: number; column: number } };
    const line = err.loc?.line ?? '?';
    const snippet = err.loc ? code.split('\n')[err.loc.line - 1]?.trim().slice(0, 120) : '';
    return `${path}:${line}:${(err.loc?.column ?? 0) + 1} 语法错误：${err.message.replace(/\s*\(\d+:\d+\)$/, '')}${snippet ? `\n  > ${snippet}` : ''}`;
  }
}

function lineOf(code: string, pattern: RegExp): number {
  const index = code.search(pattern);
  return index < 0 ? 0 : code.slice(0, index).split('\n').length;
}

/** Static shape checks, ordered so the first failure points at a single file and line. */
export function staticCheck(files: Partial<Record<FilePath, string>>, plan?: Plan | null): StaticResult {
  const items: CheckItem[] = [];
  let failure: CheckFailure | null = null;
  const fail = (file: FilePath, message: string) => {
    if (!failure) failure = { file, message };
    return message;
  };
  const declared = new Set((plan?.fields ?? []).map((f) => f.name));
  const removed = (plan?.removed ?? []).filter((n) => !declared.has(n) && /^[a-zA-Z]\w*$/.test(n));

  for (const path of FILE_PATHS) {
    const code = files[path];
    let detail: string | null = null;
    if (!code || !code.trim()) detail = fail(path, `${path}:1 文件缺失或为空`);
    else {
      const lines = code.split('\n').length;
      if (lines > MAX_LINES) detail = fail(path, `${path}:${MAX_LINES + 1} 文件共 ${lines} 行，超过 ${MAX_LINES} 行上限`);
      if (!detail && path !== 'index.html') {
        detail = jsSyntax(path, code);
        if (detail) fail(path, detail);
      }
      if (!detail) {
        const external = /(\brequire\s*\(|^\s*import\s|\bimport\s*\(|https?:\/\/(?!www\.w3\.org))/m;
        const ln = lineOf(code, external);
        if (ln) detail = fail(path, `${path}:${ln} 引用了外部依赖或外网资源（生成物必须零外部依赖）`);
      }
      if (!detail && path === 'server.js' && !/(async\s+)?function\s+handle\s*\(/.test(code))
        detail = fail(path, 'server.js:1 缺少顶层函数声明 handle(req, store)');
      if (!detail && path === 'index.html') {
        if (!/<html[\s>]/i.test(code)) detail = fail(path, 'index.html:1 不是完整 HTML 文档');
        else if (!/<script[^>]*src=["']\.?\/?app\.js["']/i.test(code))
          detail = fail(path, 'index.html:1 未通过 <script src="app.js"> 引入脚本');
      }
      if (!detail && path === 'app.js') {
        const ln = lineOf(code, /\b(localStorage|sessionStorage|indexedDB)\b/);
        if (ln) detail = fail(path, `app.js:${ln} 使用了浏览器本地存储，数据必须只来自接口`);
      }
      if (!detail && path !== 'server.js') {
        for (const name of removed) {
          const ln = lineOf(code, new RegExp(`\\b${name}\\b`));
          if (ln) {
            detail = fail(path, `${path}:${ln} 仍引用已删除的字段「${name}」，页面可能空白或报错`);
            break;
          }
        }
      }
    }
    items.push({ name: `形态检查 · ${path}`, status: detail ? 'error' : 'done', detail: detail ?? '通过' });
  }
  return { items, failure };
}

function sampleValue(field: Field, variant: number): unknown {
  if (field.type === 'number') return 1 + variant;
  if (field.type === 'boolean') return variant === 1;
  if (field.type === 'date') return new Date(Date.now() + variant * 86_400_000).toISOString().slice(0, 10);
  return `${variant ? '已修改' : '测试'}${field.label}`.slice(0, field.max_length ?? 200);
}

const same = (a: unknown, b: unknown) => (typeof b === 'number' ? Number(a) === b : JSON.stringify(a) === JSON.stringify(b));

interface Item {
  id: string | number;
  [key: string]: unknown;
}
const show = (v: unknown) => JSON.stringify(v)?.slice(0, 400);
const listOf = (r: AppResponse): Item[] | null => {
  const body = r.body as { items?: unknown };
  return Array.isArray(body?.items) ? (body.items as Item[]) : null;
};

export type RuntimeStep = (item: CheckItem) => void;

/**
 * Real run on a dedicated check instance and check-only data. Probes are derived from the
 * currently declared fields, so fields added by revisions are written and read back too.
 */
export async function runtimeCheck(
  sid: string,
  plan: Plan,
  serverCode: string,
  log: (line: string) => void,
  onStep: RuntimeStep,
): Promise<CheckFailure | null> {
  const kind = 'check-data';
  await docApi.clear(sid, kind);
  const now = new Date().toISOString();
  await docApi.write(
    sid,
    kind,
    JSON.stringify({ items: [{ id: LEGACY_ID, requestId: LEGACY_ID, createdAt: now, updatedAt: now, [LEGACY_KEY]: 'keep' }] }),
  );
  let instance = new AppInstance(sid, kind, allocatePort(), log);
  const step = async (name: string, fn: () => Promise<string>): Promise<boolean> => {
    onStep({ name, status: 'running' });
    try {
      const detail = await fn();
      onStep({ name, status: 'done', detail });
      return true;
    } catch (e) {
      onStep({ name, status: 'error', detail: (e as Error).message });
      throw e;
    }
  };
  const call = async (method: string, path: string, body: unknown = null) => {
    const res = await instance.request({ method, path, query: {}, body });
    log(`[check] ${method} ${path} → ${res.status}`);
    return res;
  };
  const expect = (op: string, cond: boolean, req: string, res: AppResponse, why: string) => {
    if (!cond) throw new Error(`「${op}」不符合预期：${why}\n请求：${req}\n响应：${res.status} ${show(res.body)}`);
  };
  const mismatched = (item: Item | undefined, values: Record<string, unknown>) =>
    plan.fields.filter((f) => !item || !same(item[f.name], values[f.name])).map((f) => `${f.label}(${f.name})`);

  const create: Record<string, unknown> = { requestId: `check-${Date.now()}` };
  plan.fields.forEach((f) => (create[f.name] = sampleValue(f, 0)));
  const patch: Record<string, unknown> = {};
  plan.fields.forEach((f) => (patch[f.name] = sampleValue(f, 1)));
  let id: string | number = '';
  const fieldList = plan.fields.map((f) => f.name).join('、');

  try {
    await step('运行 · 启动应用实例', async () => {
      await instance.start(serverCode);
      return `实例在端口 ${instance.port} 就绪`;
    });
    await step('运行 · 查（兼容旧数据）', async () => {
      const r = await call('GET', '/api/items');
      const items = listOf(r);
      expect('查', r.status === 200 && items !== null, 'GET /api/items', r, '应返回 200 和 { items: [] }');
      expect('查', items!.some((i) => String(i.id) === LEGACY_ID), 'GET /api/items', r, '缺少部分字段的旧记录应原样返回');
      return `200，${items!.length} 条（含 1 条缺字段的旧记录）`;
    });
    await step('运行 · 增', async () => {
      const req = `POST /api/items ${show(create)}`;
      const r = await call('POST', '/api/items', create);
      const body = r.body as Item;
      expect('增', (r.status === 201 || r.status === 200) && body?.id !== undefined, req, r, '应返回 201 和带 id 的记录');
      id = body.id;
      const dup = await call('POST', '/api/items', create);
      expect('增', dup.status < 500, `${req}（重复提交）`, dup, '重复提交不得返回服务端错误');
      return `新增记录 id=${id}，重复提交返回 ${dup.status}`;
    });
    await step('运行 · 查（全部字段读回、无重复）', async () => {
      const r = await call('GET', '/api/items');
      const items = (listOf(r) ?? []).filter((i) => String(i.id) !== LEGACY_ID);
      const found = items.find((i) => String(i.id) === String(id));
      expect('查', !!found, 'GET /api/items', r, '列表中应包含刚新增的记录');
      expect('增', items.length === 1, 'GET /api/items', r, `相同 requestId 提交两次后应只有 1 条，实际 ${items.length} 条`);
      const bad = mismatched(found, create);
      expect('增', !bad.length, 'GET /api/items', r, `字段 ${bad.join('、')} 写入后未能读回（数据接口未存储该字段）`);
      return `字段 ${fieldList} 均已读回`;
    });
    await step('运行 · 改（全部字段）', async () => {
      const r = await call('PUT', `/api/items/${id}`, patch);
      expect('改', r.status === 200, `PUT /api/items/${id} ${show(patch)}`, r, '应返回 200');
      return `已修改 ${fieldList}`;
    });
    await step('运行 · 重启后再查（持久化）', async () => {
      instance.stop();
      instance = new AppInstance(sid, kind, allocatePort(instance.port), log);
      await instance.start(serverCode);
      const r = await call('GET', '/api/items');
      const items = listOf(r) ?? [];
      const found = items.find((i) => String(i.id) === String(id));
      expect('查', !!found, 'GET /api/items（重启后）', r, '重启实例后记录丢失，数据未通过 store 持久化');
      const bad = mismatched(found, patch);
      expect('改', !bad.length, 'GET /api/items（重启后）', r, `字段 ${bad.join('、')} 修改后重启未保持`);
      const legacy = items.find((i) => String(i.id) === LEGACY_ID);
      expect('改', legacy?.[LEGACY_KEY] === 'keep', 'GET /api/items（重启后）', r, `旧记录中未声明的键 ${LEGACY_KEY} 被清理，删除后再加回的字段会丢值`);
      return `新端口 ${instance.port} 上全部字段保持，旧数据键原样保留`;
    });
    await step('运行 · 删', async () => {
      const r = await call('DELETE', `/api/items/${id}`);
      expect('删', r.status === 200, `DELETE /api/items/${id}`, r, '应返回 200');
      const again = await call('DELETE', `/api/items/${id}`);
      expect('删', again.status === 404, `DELETE /api/items/${id}（不存在）`, again, '删除不存在的记录应返回 404');
      return '删除成功，删除不存在记录返回 404';
    });
    await step('运行 · 删后再查', async () => {
      const r = await call('GET', '/api/items');
      const items = listOf(r) ?? [];
      expect('删', !items.some((i) => String(i.id) === String(id)), 'GET /api/items', r, '删除后列表仍包含该记录');
      expect('删', items.some((i) => String(i.id) === LEGACY_ID), 'GET /api/items', r, '删除一条记录时误删了其它记录');
      return '列表已不含该记录，其它记录完好';
    });
    return null;
  } catch (e) {
    return { file: 'server.js', message: (e as Error).message };
  } finally {
    instance.stop();
    await docApi.clear(sid, kind).catch(() => undefined);
  }
}
