import { useCallback, useEffect, useRef, useState } from 'react';
import { agentApi, docApi, errorText, sessionApi } from '@/lib/workbench/api';
import { runtimeCheck, staticCheck } from '@/lib/workbench/checker';
import type { CheckFailure } from '@/lib/workbench/checker';
import { buildExport, download } from '@/lib/workbench/exporter';
import { AppInstance, allocatePort, parseUrl } from '@/lib/workbench/runtime';
import type { AppResponse } from '@/lib/workbench/runtime';
import type { CheckItem, FilePath, Message, Session, Stage } from '@/lib/workbench/types';
import { FILE_PATHS, MAX_PLAN_REJECTS, MAX_REPAIRS, SUMMARY_TRIGGER } from '@/lib/workbench/types';

const APP_DATA = 'app-data';
const MAX_LOGS = 600;
const time = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });

/** Restore an interrupted session to a state that a single click can continue (platform restart). */
function recover(s: Session): Session {
  const state = { ...s.state, running: false };
  // Sessions created before cards were anchored: pin existing cards after the current messages,
  // so anything sent from now on is appended below them.
  const here = state.messages.length;
  state.anchors = {
    ask: here,
    plan: here,
    tasks: here,
    checks: here,
    failed: here,
    revision: here,
    suggestNew: here,
    ...(state.anchors ?? {}),
  };
  let stage: Stage = s.stage;
  if (stage === 'generate' || stage === 'check') {
    stage = FILE_PATHS.every((p) => state.files[p]) ? 'check' : 'generate';
    state.tasks = state.tasks.map((t) => (t.status === 'running' ? { ...t, status: 'pending' } : t));
    state.checks = state.checks.map((c) => (c.status === 'running' ? { ...c, status: 'pending' } : c));
  }
  return { ...s, stage, state };
}

export function useWorkbench() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSid, setActiveSid] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [summarizing, setSummarizing] = useState<Record<string, boolean>>({});

  const store = useRef(new Map<string, Session>());
  const order = useRef<string[]>([]);
  const instances = useRef(new Map<string, AppInstance>());
  const locks = useRef(new Set<string>());
  const dirty = useRef(new Set<string>());
  const saving = useRef(new Set<string>());

  const publish = useCallback(() => {
    setSessions(order.current.map((sid) => store.current.get(sid)!).filter(Boolean));
  }, []);

  const get = (sid: string) => store.current.get(sid)!;

  const persist = useCallback(async (sid: string) => {
    dirty.current.add(sid);
    if (saving.current.has(sid)) return;
    saving.current.add(sid);
    while (dirty.current.has(sid)) {
      dirty.current.delete(sid);
      const s = store.current.get(sid);
      if (!s) break;
      try {
        await sessionApi.save(s);
      } catch (e) {
        console.warn('保存会话失败', errorText(e));
      }
    }
    saving.current.delete(sid);
  }, []);

  const update = useCallback(
    (sid: string, fn: (s: Session) => void) => {
      const cur = store.current.get(sid);
      if (!cur) return;
      const next: Session = { ...cur, state: { ...cur.state } };
      fn(next);
      store.current.set(sid, next);
      publish();
      void persist(sid);
    },
    [persist, publish],
  );

  const log = useCallback(
    (sid: string, line: string) =>
      update(sid, (s) => {
        s.state.logs = [...s.state.logs, `${time()} ${line}`].slice(-MAX_LOGS);
      }),
    [update],
  );

  const summarize = useCallback(
    async (sid: string) => {
      const s = store.current.get(sid);
      if (!s || summarizing[sid] || !s.state.messages.length) return;
      setSummarizing((m) => ({ ...m, [sid]: true }));
      try {
        const { summary } = await agentApi.summary(s.state.messages);
        update(sid, (x) => {
          x.state.summary = summary;
          x.state.summarizedAt = x.state.messages.length;
        });
        log(sid, '[agent] 已生成上下文摘要');
      } catch (e) {
        log(sid, `[agent] 摘要生成失败：${errorText(e)}`);
      } finally {
        setSummarizing((m) => ({ ...m, [sid]: false }));
      }
    },
    [log, summarizing, update],
  );

  const say = useCallback(
    (sid: string, role: Message['role'], text: string) => {
      update(sid, (s) => {
        s.state.messages = [...s.state.messages, { role, text, ts: Date.now() }];
      });
      const s = store.current.get(sid);
      if (s && s.state.messages.length - s.state.summarizedAt >= SUMMARY_TRIGGER) void summarize(sid);
    },
    [summarize, update],
  );

  const setStage = (sid: string, stage: Stage) =>
    update(sid, (s) => {
      s.stage = stage;
    });

  /** Pin a stage card right after the messages that exist now, so the feed stays chronological. */
  const mark = (sid: string, card: string) =>
    update(sid, (s) => {
      s.state.anchors = { ...(s.state.anchors ?? {}), [card]: s.state.messages.length };
    });

  const withLock = useCallback(async (sid: string, fn: () => Promise<void>) => {
    if (locks.current.has(sid)) return;
    locks.current.add(sid);
    setBusy((b) => ({ ...b, [sid]: true }));
    try {
      await fn();
    } catch (e) {
      const msg = errorText(e);
      update(sid, (s) => {
        s.state.lastError = msg;
      });
      say(sid, 'system', `执行中断：${msg}。可点击继续按钮重试。`);
      log(sid, `[error] ${msg}`);
    } finally {
      locks.current.delete(sid);
      setBusy((b) => ({ ...b, [sid]: false }));
    }
  }, [log, say, update]);

  /* ---------- pipeline ---------- */

  const startPreview = async (sid: string): Promise<CheckFailure | null> => {
    instances.current.get(sid)?.stop();
    instances.current.delete(sid);
    update(sid, (s) => {
      s.state.running = false;
    });
    const code = get(sid).state.files['server.js'] ?? '';
    let lastErr = '';
    let previous = get(sid).state.port;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const inst = new AppInstance(sid, APP_DATA, allocatePort(previous), (l) => log(sid, l));
      try {
        log(sid, `[preview] 在端口 ${inst.port} 启动预览实例`);
        await inst.start(code);
        instances.current.set(sid, inst);
        update(sid, (s) => {
          s.stage = 'preview';
          s.state.port = inst.port;
          s.state.running = true;
          s.state.lastError = '';
        });
        return null;
      } catch (e) {
        lastErr = (e as Error).message;
        previous = inst.port;
        log(sid, `[preview] 端口 ${inst.port} 启动失败，${attempt === 0 ? '重新分配端口' : '放弃'}`);
      }
    }
    return { file: 'server.js', message: `预览实例启动失败：${lastErr}` };
  };

  const runGenerate = async (
    sid: string,
    paths: FilePath[],
    repair?: { error: string; attempt: number },
    change = '',
  ) => {
    setStage(sid, 'generate');
    mark(sid, 'tasks');
    update(sid, (s) => {
      s.state.tasks = s.state.tasks.map((t) => (paths.includes(t.path) ? { ...t, status: 'pending' } : t));
    });
    for (const path of paths) {
      update(sid, (s) => {
        s.state.tasks = s.state.tasks.map((t) => (t.path === path ? { ...t, status: 'running' } : t));
      });
      log(sid, `[generate] ${repair ? '修复' : change ? '修改' : '生成'} ${path}`);
      const s = get(sid);
      try {
        const { content } = await agentApi.generate(
          s.state.plan!,
          path,
          s.state.files,
          repair ? { ...repair, current: s.state.files[path] ?? '' } : undefined,
          change,
        );
        update(sid, (x) => {
          x.state.files = { ...x.state.files, [path]: content };
          x.state.tasks = x.state.tasks.map((t) => (t.path === path ? { ...t, status: 'done' } : t));
        });
        const lines = content.split('\n').length;
        log(sid, `[generate] ${path} 完成，${lines} 行`);
        say(sid, 'agent', `${repair ? '已修复' : change ? '已修改' : '已完成'} ${path}（${lines} 行）`);
      } catch (e) {
        update(sid, (x) => {
          x.state.tasks = x.state.tasks.map((t) => (t.path === path ? { ...t, status: 'error' } : t));
        });
        throw e;
      }
    }
  };

  const handleFailure = async (sid: string, failure: CheckFailure): Promise<void> => {
    log(sid, `[check] 未通过：${failure.message.split('\n')[0]}`);
    const s = get(sid);
    update(sid, (x) => {
      x.state.lastError = failure.message;
    });
    if (s.state.repairs >= MAX_REPAIRS && s.state.revision) {
      const rev = s.state.revision;
      update(sid, (x) => {
        x.state.files = { ...rev.backupFiles };
        x.state.lastGood = { ...rev.backupFiles };
        x.state.lastGoodPassed = true;
        x.state.plan = rev.backupPlan;
        x.state.revision = null;
        x.state.tasks = FILE_PATHS.map((path) => ({ path, status: 'done' }));
      });
      log(sid, `[revise] 修复 ${MAX_REPAIRS} 次仍未通过，代码已回滚到修改前，数据未改动`);
      const previewFailure = await startPreview(sid);
      if (previewFailure) {
        update(sid, (x) => {
          x.stage = 'failed';
        });
        say(sid, 'agent', `修改未成功，回滚后的版本也未能启动：${previewFailure.message}`);
        return;
      }
      say(
        sid,
        'agent',
        `这次修改未成功（自动修复 ${MAX_REPAIRS} 次仍未通过），应用已恢复为修改前的版本，数据仍在，可以继续操作。最后一次错误：${failure.message.split('\n')[0]}`,
      );
      return;
    }
    if (s.state.repairs >= MAX_REPAIRS) {
      instances.current.get(sid)?.stop();
      update(sid, (x) => {
        x.stage = 'failed';
        x.state.running = false;
      });
      say(sid, 'agent', `自动修复 ${MAX_REPAIRS} 次仍未通过，已进入失败态并保留备份版本。最后一次错误：${failure.message.split('\n')[0]}`);
      mark(sid, 'failed');
      log(sid, `[failed] 修复次数用尽（${MAX_REPAIRS}/${MAX_REPAIRS}）`);
      return;
    }
    const attempt = s.state.repairs + 1;
    update(sid, (x) => {
      x.state.repairs = attempt;
    });
    say(sid, 'agent', `检查未通过，开始第 ${attempt}/${MAX_REPAIRS} 次自动修复，只重新生成 ${failure.file}。`);
    try {
      await runGenerate(sid, [failure.file], { error: failure.message, attempt });
    } catch (e) {
      return handleFailure(sid, { file: failure.file, message: `修复调用失败：${errorText(e)}` });
    }
    await runCheck(sid);
  };

  const runCheck = async (sid: string): Promise<void> => {
    setStage(sid, 'check');
    update(sid, (s) => {
      s.state.checks = [];
      s.state.lastError = '';
    });
    mark(sid, 'checks');
    log(sid, `[check] 开始检查（已修复 ${get(sid).state.repairs} 次）`);
    const files = get(sid).state.files;
    const result = staticCheck(files, get(sid).state.plan);
    update(sid, (s) => {
      s.state.checks = result.items;
    });
    if (result.failure) return handleFailure(sid, result.failure);

    const upsert = (item: CheckItem) =>
      update(sid, (s) => {
        const idx = s.state.checks.findIndex((c) => c.name === item.name);
        s.state.checks = idx < 0 ? [...s.state.checks, item] : s.state.checks.map((c, i) => (i === idx ? item : c));
      });
    const runtimeFailure = await runtimeCheck(sid, get(sid).state.plan!, files['server.js']!, (l) => log(sid, l), upsert);
    if (runtimeFailure) return handleFailure(sid, runtimeFailure);

    update(sid, (s) => {
      s.state.lastGood = { ...s.state.files };
      s.state.lastGoodPassed = true;
    });
    say(sid, 'agent', '形态检查与真实运行检查全部通过，正在启动预览实例。');
    const previewFailure = await startPreview(sid);
    if (previewFailure) return handleFailure(sid, previewFailure);
    const rev = get(sid).state.revision;
    update(sid, (s) => {
      s.state.revision = null;
    });
    say(
      sid,
      'agent',
      rev
        ? `修改「${rev.change || rev.request}」已生效，应用已在新端口 127.0.0.1:${get(sid).state.port} 重新启动，已有数据未改动。`
        : `应用已在 127.0.0.1:${get(sid).state.port} 运行，可在右侧预览中操作。`,
    );
  };

  /** Incremental change in preview: only affected files are regenerated; data is never written. */
  const revise = (sid: string, request: string) =>
    withLock(sid, async () => {
      const s = get(sid);
      update(sid, (x) => {
        x.state.suggestNew = '';
      });
      say(sid, 'user', request);
      if (s.stage !== 'preview' || !s.state.plan || !FILE_PATHS.every((p) => s.state.files[p])) {
        say(sid, 'system', '只有处于预览阶段的应用才能修改。');
        return;
      }
      log(sid, '[revise] 判定修改类型与影响面');
      const result = await agentApi.revise(s.state.plan, s.state.files, request);
      if (result.kind !== 'increment') {
        update(sid, (x) => {
          x.state.suggestNew = result.kind === 'new_app' ? request : '';
        });
        const prefix = result.kind === 'new_app' ? '判定为新应用：' : result.kind === 'type_change' ? '不支持字段类型变更：' : '超出能力范围：';
        say(sid, 'agent', `${prefix}${result.reason} 当前应用未做任何改动。`);
        mark(sid, 'suggestNew');
        log(sid, `[revise] 未执行（${result.kind}）`);
        return;
      }
      const plan = s.state.plan;
      const fields = result.fields ?? plan.fields;
      const names = new Set(fields.map((f) => f.name));
      const removed = [...new Set([...(plan.removed ?? []), ...(result.removed ?? [])])].filter((n) => !names.has(n));
      const change = result.change || request;
      const affected = (result.affected?.length ? result.affected : ['app.js']) as FilePath[];
      update(sid, (x) => {
        x.state.revision = {
          request,
          change,
          affected,
          added: result.added ?? [],
          removed: result.removed ?? [],
          backupFiles: { ...s.state.files },
          backupPlan: plan,
        };
        x.state.plan = { ...plan, fields, removed, changes: [...(plan.changes ?? []), change] };
        x.state.repairs = 0;
        x.state.checks = [];
      });
      const parts = [
        `影响面：${affected.join('、')}`,
        result.added?.length ? `新增字段 ${result.added.join('、')}` : '',
        result.removed?.length ? `删除字段 ${result.removed.join('、')}（已有数据中的取值保留）` : '',
      ].filter(Boolean);
      say(sid, 'agent', `判定为增量修改：${change}。${parts.join('；')}。只重新生成受影响的文件。`);
      mark(sid, 'revision');
      await runGenerate(sid, affected, undefined, change);
      await runCheck(sid);
    });

  const exportApp = async (sid: string) => {
    const s = get(sid);
    if (!s) return;
    const files = s.state.revision ? s.state.revision.backupFiles : s.state.files;
    const plan = s.state.revision ? s.state.revision.backupPlan : s.state.plan;
    if (!FILE_PATHS.every((p) => files[p]?.trim())) {
      say(sid, 'system', '还没有可导出的生成物，未生成压缩包。');
      return;
    }
    let data: string | null = null;
    try {
      data = (await docApi.read(sid, APP_DATA))?.content ?? null;
    } catch {
      data = null;
    }
    const blob = buildExport(files, plan, data);
    if (!blob) {
      say(sid, 'system', '还没有可导出的生成物，未生成压缩包。');
      return;
    }
    const name = `${(plan?.title || s.title || 'atoms-app').replace(/[\\/:*?"<>|\s]+/g, '-')}.zip`;
    download(blob, name);
    log(sid, `[export] 已导出 ${name}（${Math.ceil(blob.size / 1024)} KB）`);
  };

  const runPlan = async (sid: string, feedback = '') => {
    setStage(sid, 'plan');
    const s = get(sid);
    const previous = s.state.planRejects > 0 ? s.state.plan : null;
    update(sid, (x) => {
      x.state.awaitingConfirm = false;
    });
    log(sid, `[plan] ${previous ? '根据意见重新规划' : '生成任务计划'}`);
    const plan = await agentApi.plan(s.state.requirement, s.state.intent, feedback, previous);
    update(sid, (x) => {
      x.state.plan = plan;
      x.state.awaitingConfirm = true;
      x.state.lastError = '';
      x.title = plan.title || x.title;
    });
    say(sid, 'agent', `已给出任务计划「${plan.title}」：3 个文件、4 条接口，请确认。`);
    mark(sid, 'plan');
  };

  const startGeneration = async (sid: string) => {
    update(sid, (s) => {
      s.state.awaitingConfirm = false;
      s.state.repairs = 0;
    });
    await runGenerate(sid, FILE_PATHS);
    update(sid, (s) => {
      if (!s.state.lastGoodPassed) s.state.lastGood = { ...s.state.files };
    });
    await runCheck(sid);
  };

  const runIntent = async (sid: string) => {
    setStage(sid, 'intent');
    log(sid, '[intent] 判断需求信息是否足够');
    const s = get(sid);
    const intent = await agentApi.intent(s.state.requirement);
    update(sid, (x) => {
      x.state.intent = intent;
      x.state.lastError = '';
    });
    if (!intent.sufficient && !s.state.asked) {
      update(sid, (x) => {
        x.state.asked = true;
        x.state.awaitingAnswer = true;
      });
      say(sid, 'agent', intent.question);
      mark(sid, 'ask');
      log(sid, '[intent] 信息不足，发起一次追问');
      return;
    }
    say(sid, 'agent', `已识别为「${intent.app_type || intent.entity || '数据管理应用'}」，进入规划。`);
    await runPlan(sid);
  };

  /* ---------- user actions ---------- */

  const createSession = useCallback(
    async (requirement: string) => {
      const s = await sessionApi.create(requirement);
      store.current.set(s.sid, s);
      order.current = [s.sid, ...order.current];
      setActiveSid(s.sid);
      publish();
      say(s.sid, 'user', requirement);
      await withLock(s.sid, () => runIntent(s.sid));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [publish, say, withLock],
  );

  const answer = (sid: string, text: string) =>
    withLock(sid, async () => {
      say(sid, 'user', text);
      update(sid, (s) => {
        s.state.awaitingAnswer = false;
        s.state.requirement = `${s.state.requirement}\n补充说明：${text}`;
      });
      say(sid, 'system', '已收到回答，不再追问，未说明的部分将在计划中以默认值补齐。');
      await runPlan(sid);
    });

  const confirmPlan = (sid: string) =>
    withLock(sid, async () => {
      say(sid, 'user', '确认计划');
      await startGeneration(sid);
    });

  const rejectPlan = (sid: string, feedback: string) =>
    withLock(sid, async () => {
      say(sid, 'user', feedback ? `不认可计划：${feedback}` : '不认可计划');
      const rejects = get(sid).state.planRejects;
      if (rejects >= MAX_PLAN_REJECTS) {
        say(sid, 'system', '计划已重来过一次，按当前计划强制继续生成。');
        await startGeneration(sid);
        return;
      }
      update(sid, (s) => {
        s.state.planRejects = rejects + 1;
      });
      await runPlan(sid, feedback);
    });

  const recheck = (sid: string, restoreBackup = false) =>
    withLock(sid, async () => {
      instances.current.get(sid)?.stop();
      update(sid, (s) => {
        s.state.repairs = 0;
        s.state.running = false;
        if (restoreBackup) s.state.files = { ...s.state.lastGood };
      });
      say(sid, 'user', restoreBackup ? '回退到备份版本并重新检查' : '重新检查');
      await runCheck(sid);
    });

  const restart = (sid: string) =>
    withLock(sid, async () => {
      say(sid, 'user', '重启应用');
      const failure = await startPreview(sid);
      if (failure) return handleFailure(sid, failure);
      say(sid, 'agent', `应用已在新端口 127.0.0.1:${get(sid).state.port} 重新启动。`);
    });

  const resume = (sid: string) =>
    withLock(sid, async () => {
      const s = get(sid);
      if (s.stage === 'intent') return runIntent(sid);
      if (s.stage === 'plan') return runPlan(sid);
      if (s.stage === 'generate') {
        const missing = FILE_PATHS.filter((p) => !s.state.files[p]);
        if (missing.length) await runGenerate(sid, missing);
        return runCheck(sid);
      }
      if (s.stage === 'preview') {
        const failure = await startPreview(sid);
        if (failure) return handleFailure(sid, failure);
        return;
      }
      update(sid, (x) => {
        x.state.repairs = 0;
      });
      return runCheck(sid);
    });

  const editFile = (sid: string, path: FilePath, content: string) => {
    if (locks.current.has(sid)) return;
    update(sid, (s) => {
      s.state.files = { ...s.state.files, [path]: content };
    });
    log(sid, `[user] 手动修改 ${path}`);
  };

  const removeSession = useCallback(
    async (sid: string) => {
      const s = store.current.get(sid);
      if (!s || locks.current.has(sid)) return;
      instances.current.get(sid)?.stop();
      instances.current.delete(sid);
      await sessionApi.remove(s);
      store.current.delete(sid);
      order.current = order.current.filter((x) => x !== sid);
      publish();
      setActiveSid((cur) => (cur === sid ? order.current[0] ?? null : cur));
    },
    [publish],
  );

  const appRequest = useCallback(
    async (sid: string, url: string, method: string, body: unknown): Promise<AppResponse> => {
      const inst = instances.current.get(sid);
      if (!inst?.running) throw new Error('应用未运行，请点击重启');
      try {
        return await inst.request(parseUrl(url, method, body));
      } catch (e) {
        if (!inst.running) {
          update(sid, (s) => {
            s.state.running = false;
          });
        }
        throw e;
      }
    },
    [update],
  );

  /* ---------- boot / teardown ---------- */

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const list = (await sessionApi.list()).map(recover);
      store.current = new Map(list.map((s) => [s.sid, s]));
      order.current = list.map((s) => s.sid);
      publish();
      setActiveSid((cur) => cur ?? list[0]?.sid ?? null);
      list.forEach((s) => void persist(s.sid));
    } catch (e) {
      setLoadError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, [persist, publish]);

  useEffect(() => {
    void load();
    const map = instances.current;
    return () => map.forEach((i) => i.stop());
  }, [load]);

  return {
    sessions,
    active: sessions.find((s) => s.sid === activeSid) ?? null,
    activeSid,
    setActiveSid,
    loading,
    loadError,
    reload: load,
    busy,
    summarizing,
    createSession: (r: string) => createSession(r).catch((e) => setLoadError(errorText(e))),
    answer,
    revise,
    exportApp,
    confirmPlan,
    rejectPlan,
    recheck,
    restart,
    resume,
    editFile,
    removeSession,
    summarize,
    appRequest,
    clearAppData: (sid: string) => docApi.clear(sid, APP_DATA),
  };
}

export type Workbench = ReturnType<typeof useWorkbench>;
