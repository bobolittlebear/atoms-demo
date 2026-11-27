import { Component, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Code2, Download, FileText, Maximize2, MonitorPlay, Minimize2, RefreshCw, RotateCcw, Save, TerminalSquare } from 'lucide-react';
import Markdown from 'markdown-to-jsx';
import type { Workbench } from '@/hooks/useWorkbench';
import { buildPreviewDoc } from '@/lib/workbench/runtime';
import type { FilePath, Session } from '@/lib/workbench/types';
import { FILE_PATHS } from '@/lib/workbench/types';
import { cn } from '@/lib/utils';
import { Btn, Placeholder, STAGE_LABEL } from './ui';

type Tab = 'preview' | 'code' | 'terminal' | 'records';
const TABS: { key: Tab; label: string; icon: typeof Code2 }[] = [
  { key: 'preview', label: '预览', icon: MonitorPlay },
  { key: 'code', label: '代码', icon: Code2 },
  { key: 'terminal', label: '终端', icon: TerminalSquare },
  { key: 'records', label: '记录', icon: FileText },
];

function Preview({ session, wb }: { session: Session; wb: Workbench }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [full, setFull] = useState(false);
  const [nonce, setNonce] = useState(0);
  const { state, sid } = session;
  const ready = session.stage === 'preview' && state.running;
  const doc = useMemo(() => (ready ? buildPreviewDoc(state.files) : ''), [ready, state.files]);

  useEffect(() => {
    const onMessage = async (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow) return;
      const m = e.data as { t?: string; id: number; url: string; method: string; body: unknown };
      if (m?.t !== 'app-req') return;
      const reply = (payload: object) => frame.current?.contentWindow?.postMessage({ t: 'app-res', id: m.id, ...payload }, '*');
      try {
        const res = await wb.appRequest(sid, m.url, m.method, m.body);
        reply({ status: res.status, body: res.body });
      } catch (err) {
        reply({ error: (err as Error).message });
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [sid, wb]);

  if (!ready) {
    return (
      <Placeholder
        icon={<MonitorPlay className="h-8 w-8" />}
        text={
          session.stage === 'preview'
            ? '应用未运行。点击重启，在新端口启动应用，数据仍保留。'
            : `当前处于「${STAGE_LABEL[session.stage]}」阶段，检查通过后应用将在这里运行。`
        }
        action={session.stage === 'preview' && <Btn disabled={!!wb.busy[sid]} onClick={() => wb.restart(sid)}>重启应用</Btn>}
      />
    );
  }
  const address = `127.0.0.1:${state.port}/`;
  return (
    <div className={cn('flex h-full flex-col bg-white', full && 'fixed inset-4 z-50 rounded-[8px] border border-[#DCD6C8] shadow-[0_12px_40px_rgba(22,24,29,.25)]')}>
      <div className="flex items-center gap-2 border-b border-[#DCD6C8] px-3 py-2">
        <span className="h-2 w-2 rounded-full bg-[#2563EB]" aria-label="运行中" />
        <code className="flex-1 truncate rounded-[6px] bg-[#ECE8DE] px-2 py-1 font-mono text-[12px]">{address}</code>
        <Btn variant="ghost" aria-label="刷新预览" title="刷新预览" className="w-8 px-0" onClick={() => setNonce((n) => n + 1)}><RefreshCw className="h-4 w-4" /></Btn>
        <Btn variant="outline" disabled={!!wb.busy[sid]} onClick={() => wb.restart(sid)}><RotateCcw className="h-4 w-4" />重启</Btn>
        <Btn variant="outline" disabled={!!wb.busy[sid]} onClick={() => wb.recheck(sid)}>重新检查</Btn>
        <Btn variant="ghost" aria-label={full ? '退出全屏' : '全屏预览'} className="w-8 px-0" onClick={() => setFull((f) => !f)}>
          {full ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
        </Btn>
      </div>
      <iframe
        ref={frame}
        key={`${state.port}-${nonce}`}
        title="应用预览"
        sandbox="allow-scripts allow-forms allow-modals"
        srcDoc={doc}
        className="min-h-0 w-full flex-1 bg-white"
      />
    </div>
  );
}

function CodeTab({ session, wb }: { session: Session; wb: Workbench }) {
  const [path, setPath] = useState<FilePath>('server.js');
  const content = session.state.files[path] ?? '';
  const [draft, setDraft] = useState(content);
  useEffect(() => setDraft(content), [content, path]);
  const busy = !!wb.busy[session.sid];
  const changed = draft !== content;
  if (!FILE_PATHS.some((p) => session.state.files[p])) {
    return <Placeholder icon={<Code2 className="h-8 w-8" />} text="尚未生成代码，确认计划后将逐个文件生成。" />;
  }
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b border-[#DCD6C8] px-3 py-2">
        {FILE_PATHS.map((p) => (
          <button
            key={p}
            onClick={() => setPath(p)}
            className={cn('h-8 rounded-[6px] px-2.5 font-mono text-[12px]', p === path ? 'bg-[#16181D] text-white' : 'text-[#6B6A64] hover:bg-[#ECE8DE]')}
          >
            {p}
          </button>
        ))}
        <span className="ml-auto text-xs text-[#6B6A64]">{draft.split('\n').length} 行</span>
        <Btn variant="outline" disabled={!changed || busy} onClick={() => wb.editFile(session.sid, path, draft)}><Save className="h-4 w-4" />保存</Btn>
        <Btn disabled={busy} onClick={() => { if (changed) wb.editFile(session.sid, path, draft); void wb.recheck(session.sid); }}>保存并重新检查</Btn>
      </div>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        spellCheck={false}
        disabled={busy}
        aria-label={`编辑 ${path}`}
        className="min-h-0 flex-1 resize-none bg-[#121417] p-3 font-mono text-[12px] leading-[1.55] text-[#D7DCE2] focus:outline-none"
      />
    </div>
  );
}

function TerminalTab({ session, visible }: { session: Session; visible: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  // Scroll only the terminal container; scrollIntoView would also scroll overflow-hidden ancestors
  // and push the whole three-column layout out of view (blank screen).
  useEffect(() => {
    if (visible && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [session.state.logs.length, visible]);
  return (
    <div ref={box} className="h-full overflow-auto bg-[#121417] p-3 font-mono text-[12px] leading-[1.55] text-[#D7DCE2]">
      {session.state.logs.length === 0 ? (
        <p className="text-[#8B949E]">$ 暂无执行日志，流程开始后输出会实时出现在这里。</p>
      ) : (
        session.state.logs.map((l, i) => (
          <div key={i} className={cn('whitespace-pre-wrap break-all', /error|失败|未通过|终止/.test(l) && 'text-[#FF8A80]')}>{l}</div>
        ))
      )}
    </div>
  );
}

function Section({ title, empty, children, action }: { title: string; empty: string | false; children?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className="rounded-[8px] border border-[#DCD6C8] bg-white">
      <header className="flex items-center border-b border-[#ECE8DE] px-4 py-2 text-sm font-semibold">{title}<span className="ml-auto">{action}</span></header>
      <div className="px-4 py-3 text-[13px] leading-relaxed">{empty ? <p className="text-[#6B6A64]">{empty}</p> : children}</div>
    </section>
  );
}

function RecordsTab({ session, wb }: { session: Session; wb: Workbench }) {
  const { state, sid } = session;
  return (
    <div className="h-full space-y-3 overflow-auto p-4">
      <Section title="对话" empty={!state.messages.length && '还没有对话记录。'}>
        <ul className="space-y-1">
          {state.messages.map((m, i) => (
            <li key={i} className="break-words"><b className="mr-1">{m.role === 'user' ? '用户' : m.role === 'agent' ? '智能体' : '系统'}：</b>{m.text}</li>
          ))}
        </ul>
      </Section>
      <Section title="计划" empty={!state.plan && '计划尚未生成，判断阶段结束后会出现在这里。'}>
        {state.plan && (
          <div className="space-y-1">
            <p><b>{state.plan.title}</b> — {state.plan.summary}</p>
            <p>字段：{state.plan.fields.map((f) => `${f.label}(${f.type})`).join('、')}</p>
            <p>默认值：{state.plan.defaults.join('；') || '无'}</p>
            <p>计划不认可次数：{state.planRejects}</p>
          </div>
        )}
      </Section>
      <Section title="执行日志" empty={!state.logs.length && '暂无执行日志。'}>
        <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-all font-mono text-[12px]">{state.logs.slice(-80).join('\n')}</pre>
      </Section>
      <Section
        title="摘要"
        empty={!state.summary && `摘要尚未生成。对话超过 12 条时自动生成，也可手动生成。`}
        action={
          <Btn variant="outline" disabled={!!wb.summarizing[sid] || !state.messages.length} onClick={() => wb.summarize(sid)}>
            {wb.summarizing[sid] ? '生成中…' : '生成摘要'}
          </Btn>
        }
      >
        <div className="prose prose-sm max-w-none"><Markdown>{String(state.summary || '')}</Markdown></div>
      </Section>
    </div>
  );
}

class TabBoundary extends Component<{ children: ReactNode; resetKey: string }, { error: string }> {
  state = { error: '' };
  static getDerivedStateFromError(e: Error) {
    return { error: e?.message || '渲染失败' };
  }
  componentDidUpdate(prev: { resetKey: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: '' });
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <Placeholder
        icon={<FileText className="h-8 w-8" />}
        text={`该标签内容加载失败：${this.state.error}`}
        action={<Btn variant="outline" onClick={() => this.setState({ error: '' })}>重试</Btn>}
      />
    );
  }
}

export function RightPanel({ session, wb }: { session: Session | null; wb: Workbench }) {
  const [tab, setTab] = useState<Tab>('preview');
  useEffect(() => {
    if (session?.stage === 'preview' && session.state.running) setTab('preview');
  }, [session?.stage, session?.state.running, session?.state.port]);
  const exportable = !!session && FILE_PATHS.every((p) => session.state.files[p]);
  const panes: Record<Tab, ReactNode> = session
    ? {
        preview: <Preview session={session} wb={wb} />,
        code: <CodeTab session={session} wb={wb} />,
        terminal: <TerminalTab session={session} visible={tab === 'terminal'} />,
        records: <RecordsTab session={session} wb={wb} />,
      }
    : ({} as Record<Tab, ReactNode>);
  return (
    <div className="flex h-full min-h-0 flex-col bg-[#FFFFFF]">
      <nav className="flex items-center gap-1 border-b border-[#DCD6C8] px-3 py-2" role="tablist">
        {TABS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={cn('inline-flex h-8 items-center gap-1.5 rounded-[6px] px-3 text-[13px] font-medium transition-colors', tab === key ? 'bg-[#16181D] text-white' : 'text-[#6B6A64] hover:bg-[#ECE8DE]')}
          >
            <Icon className="h-4 w-4" />{label}
          </button>
        ))}
        {session && (
          <Btn
            variant="outline"
            className="ml-auto"
            disabled={!exportable}
            title={exportable ? '下载可独立运行的压缩包' : '还没有可导出的生成物'}
            onClick={() => void wb.exportApp(session.sid)}
          >
            <Download className="h-4 w-4" />导出
          </Btn>
        )}
      </nav>
      <div className="relative min-h-0 flex-1 bg-[#F4F1EA]">
        {!session ? (
          <Placeholder icon={<MonitorPlay className="h-8 w-8" />} text="新建一个会话后，这里会显示应用预览、代码、终端与过程记录。" />
        ) : (
          TABS.map(({ key }) => (
            <div key={key} role="tabpanel" hidden={tab !== key} className={cn('absolute inset-0', tab !== key && 'hidden')}>
              <TabBoundary resetKey={`${session.sid}-${key}`}>{panes[key]}</TabBoundary>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
