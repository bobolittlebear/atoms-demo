import { client } from '@/lib/api';
import type { FilePath, Intent, Message, Plan, RevisionResult, Session, SessionState, Stage } from './types';
import { emptyState } from './types';

type AnyRes = { data?: unknown } | unknown;
const unwrap = <T,>(res: AnyRes): T => ((res as { data?: T })?.data ?? res) as T;

const STATUS_HINT: Record<number, string> = {
  402: 'AI 余额不足，模型调用被拒绝。请在 Atoms 设置中充值后点击「继续」重试。',
  502: '模型服务返回错误，请稍后点击「继续」重试。',
  503: '模型服务或后端暂时不可用（503），请稍后点击「继续」重试。',
  504: '模型调用超时（超过 90 秒），请点击「继续」重试。',
};

export function errorText(e: unknown): string {
  const err = e as {
    response?: { status?: number; data?: { detail?: unknown } };
    status?: number;
    data?: { detail?: unknown };
    message?: string;
  };
  const detail = err?.response?.data?.detail ?? err?.data?.detail;
  if (typeof detail === 'string' && detail.trim()) return detail;
  if (detail) return JSON.stringify(detail);
  const status = err?.response?.status ?? err?.status;
  if (status && STATUS_HINT[status]) return STATUS_HINT[status];
  return err?.message || '请求失败';
}

interface RawSession {
  id: number;
  sid: string;
  title: string;
  stage: Stage;
  state: string;
  updated_at?: string;
}

function parseSession(raw: RawSession): Session {
  let state: SessionState;
  try {
    state = { ...emptyState(''), ...JSON.parse(raw.state) };
  } catch {
    state = emptyState(raw.title);
  }
  return { ...raw, state };
}

const sessions = () => client.entities.atoms_sessions;
const docs = () => client.entities.atoms_docs;

export const sessionApi = {
  async list(): Promise<Session[]> {
    const res = await sessions().query({ sort: '-updated_at', limit: 100 });
    return unwrap<{ items: RawSession[] }>(res).items.map(parseSession);
  },
  async create(requirement: string): Promise<Session> {
    const sid = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
    const res = await sessions().create({
      data: { sid, title: requirement.slice(0, 40), stage: 'intent', state: JSON.stringify(emptyState(requirement)) },
    });
    return parseSession(unwrap<RawSession>(res));
  },
  async save(s: Session): Promise<void> {
    await sessions().update({
      id: String(s.id),
      data: { title: s.title, stage: s.stage, state: JSON.stringify(s.state) },
    });
  },
  async remove(s: Session): Promise<void> {
    const res = await docs().query({ query: { sid: s.sid }, limit: 200 });
    for (const d of unwrap<{ items: { id: number }[] }>(res).items) {
      await docs().delete({ id: String(d.id) });
    }
    await sessions().delete({ id: String(s.id) });
  },
};

/** Persistent key-value document scoped to one session (app data lives here). */
export const docApi = {
  async read(sid: string, kind: string): Promise<{ id: number; content: string } | null> {
    const res = await docs().query({ query: { sid, kind }, limit: 1 });
    return unwrap<{ items: { id: number; content: string }[] }>(res).items[0] ?? null;
  },
  async write(sid: string, kind: string, content: string, id?: number): Promise<number> {
    if (id) {
      try {
        await docs().update({ id: String(id), data: { content } });
        return id;
      } catch {
        /* record removed externally: recreate below */
      }
    }
    const res = await docs().create({ data: { sid, kind, name: `${kind}.json`, content } });
    return unwrap<{ id: number }>(res).id;
  },
  async clear(sid: string, kind: string): Promise<void> {
    const res = await docs().query({ query: { sid, kind }, limit: 50 });
    for (const d of unwrap<{ items: { id: number }[] }>(res).items) await docs().delete({ id: String(d.id) });
  },
};

const invoke = async <T,>(url: string, data: Record<string, unknown>): Promise<T> =>
  unwrap<T>(await client.apiCall.invoke({ url, method: 'POST', data, options: { timeout: 240_000 } }));

export const agentApi = {
  intent: (requirement: string) => invoke<Intent>('/api/v1/agent/intent', { requirement }),
  plan: (requirement: string, intent: Intent | null, feedback: string, previous: Plan | null) =>
    invoke<Plan>('/api/v1/agent/plan', { requirement, intent, feedback, previous }),
  generate: (
    plan: Plan,
    path: FilePath,
    files: Partial<Record<FilePath, string>>,
    repair?: { error: string; attempt: number; current: string },
    change = '',
  ) => invoke<{ content: string }>('/api/v1/agent/generate', { plan, path, files, repair: repair ?? null, change }),
  revise: (plan: Plan, files: Partial<Record<FilePath, string>>, request: string) =>
    invoke<RevisionResult>('/api/v1/agent/revise', { plan, files, request }),
  summary: (messages: Message[]) =>
    invoke<{ summary: string }>('/api/v1/agent/summary', {
      messages: messages.map((m) => ({ role: m.role, text: m.text })),
    }),
};
