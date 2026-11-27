import { useState } from 'react';
import { AlertTriangle, ClipboardList, HelpCircle, ListChecks, Play, RotateCcw, Wrench } from 'lucide-react';
import type { Workbench } from '@/hooks/useWorkbench';
import type { Session } from '@/lib/workbench/types';
import { MAX_PLAN_REJECTS, MAX_REPAIRS } from '@/lib/workbench/types';
import { Btn, Card, StatusIcon } from './ui';

function Detail({ text }: { text?: string }) {
  if (!text) return null;
  return (
    <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-[6px] bg-[#ECE8DE] p-2 font-mono text-[12px] leading-[1.55] text-[#16181D]">
      {text}
    </pre>
  );
}

/**
 * Renders the stage cards anchored at `slot` (number of messages preceding them), so cards and
 * messages form one chronological feed. Cards without an anchor (older sessions) go to the end.
 */
export function StageCards({
  session,
  wb,
  slot,
  onNewSession,
  creating,
}: {
  session: Session;
  wb: Workbench;
  slot: number;
  onNewSession: (text: string) => void;
  creating: boolean;
}) {
  const { state, stage, sid } = session;
  const busy = !!wb.busy[sid];
  const total = state.messages.length;
  const position = (key: string) => {
    const at = state.anchors?.[key];
    return at === undefined || at > total ? total : at;
  };
  const [feedback, setFeedback] = useState('');
  const [custom, setCustom] = useState('');
  const cards = [];

  if (state.awaitingAnswer && state.intent) {
    cards.push(
      <Card key="ask" title={<><HelpCircle className="h-4 w-4 text-[#E8590C]" />需要补充一句</>}>
        <p className="mb-3">{state.intent.question}</p>
        <div className="flex flex-col gap-2">
          {state.intent.options.slice(0, 3).map((o) => (
            <Btn key={o} variant="outline" disabled={busy} className="justify-start text-left" onClick={() => wb.answer(sid, o)}>
              {o}
            </Btn>
          ))}
        </div>
        <form
          className="mt-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (custom.trim()) wb.answer(sid, custom.trim());
          }}
        >
          <input
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            placeholder="或者自己补充一句"
            maxLength={300}
            className="h-8 flex-1 rounded-[6px] border border-[#DCD6C8] px-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8590C]"
          />
          <Btn type="submit" disabled={busy || !custom.trim()}>提交</Btn>
        </form>
      </Card>,
    );
  }

  if (state.plan && (stage === 'plan' || state.awaitingConfirm)) {
    const p = state.plan;
    const forced = state.planRejects >= MAX_PLAN_REJECTS;
    cards.push(
      <Card
        key="plan"
        title={<><ClipboardList className="h-4 w-4" />任务计划 · {p.title}</>}
        footer={
          state.awaitingConfirm && (
            <>
              <Btn disabled={busy} onClick={() => wb.confirmPlan(sid)}>确认计划，开始生成</Btn>
              <input
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                placeholder={forced ? '已重来过一次，再次不认可将强制继续' : '不认可的原因（可选）'}
                maxLength={200}
                className="h-8 min-w-40 flex-1 rounded-[6px] border border-[#DCD6C8] px-2 text-[13px] focus:outline-none focus:ring-2 focus:ring-[#E8590C]"
              />
              <Btn variant="outline" disabled={busy} onClick={() => wb.rejectPlan(sid, feedback.trim())}>
                不认可{forced ? '（强制继续）' : ''}
              </Btn>
            </>
          )
        }
      >
        {p.summary && <p className="mb-2 text-[#6B6A64]">{p.summary}</p>}
        <h4 className="mb-1 text-xs font-semibold text-[#6B6A64]">数据对象「{p.entity}」字段</h4>
        <ul className="mb-3 flex flex-wrap gap-1.5">
          {p.fields.map((f) => (
            <li key={f.name} className="rounded-[6px] bg-[#ECE8DE] px-2 py-0.5 font-mono text-[12px]">
              {f.label} · {f.name}:{f.type}
              {f.required ? ' · 必填' : ''}
              {f.max_length ? ` · ≤${f.max_length}字` : ''}
            </li>
          ))}
        </ul>
        <h4 className="mb-1 text-xs font-semibold text-[#6B6A64]">文件</h4>
        <ul className="mb-3 space-y-1">
          {p.files.map((f) => (
            <li key={f.path}><span className="font-mono text-[12px] font-medium">{f.path}</span> — {f.purpose}</li>
          ))}
        </ul>
        <h4 className="mb-1 text-xs font-semibold text-[#6B6A64]">接口</h4>
        <ul className="mb-3 space-y-1 font-mono text-[12px]">
          {p.api.map((a) => (
            <li key={a.method + a.path} className="break-words"><b>{a.method} {a.path}</b> <span className="font-sans text-[#6B6A64]">{a.desc}</span></li>
          ))}
        </ul>
        <h4 className="mb-1 text-xs font-semibold text-[#6B6A64]">已用默认值补齐</h4>
        {p.defaults.length ? (
          <ul className="list-inside list-disc text-[13px]">{p.defaults.map((d) => <li key={d}>{d}</li>)}</ul>
        ) : (
          <p className="text-[13px] text-[#6B6A64]">需求已完整，无需补齐默认值。</p>
        )}
        <p className="mt-2 text-xs text-[#6B6A64]">单条文本长度上限 {p.max_length} 字 · 计划不认可最多重来 {MAX_PLAN_REJECTS} 次（已用 {state.planRejects} 次）</p>
      </Card>,
    );
  }

  if (['generate', 'check', 'preview', 'failed'].includes(stage)) {
    cards.push(
      <Card key="tasks" title={<><ListChecks className="h-4 w-4" />生成任务</>}>
        <ul className="space-y-1.5">
          {state.tasks.map((t) => (
            <li key={t.path} className="flex items-center gap-2">
              <StatusIcon status={t.status} />
              <span className="font-mono text-[13px]">{t.path}</span>
              <span className="text-xs text-[#6B6A64]">{state.plan?.files.find((f) => f.path === t.path)?.purpose}</span>
            </li>
          ))}
        </ul>
      </Card>,
    );
  }

  if (state.checks.length && ['check', 'preview', 'failed', 'generate'].includes(stage)) {
    cards.push(
      <Card key="checks" title={<><Wrench className="h-4 w-4" />检查项 · 已自动修复 {state.repairs}/{MAX_REPAIRS} 次</>}>
        <ul className="space-y-1.5">
          {state.checks.map((c) => (
            <li key={c.name}>
              <div className="flex items-center gap-2"><StatusIcon status={c.status} />{c.name}</div>
              {c.status === 'error' ? <Detail text={c.detail} /> : c.detail && <p className="ml-6 text-xs text-[#6B6A64]">{c.detail}</p>}
            </li>
          ))}
        </ul>
      </Card>,
    );
  }

  if (stage === 'failed') {
    cards.push(
      <Card
        key="failed"
        tone="error"
        title={<><AlertTriangle className="h-4 w-4" />生成失败</>}
        footer={
          <>
            <Btn disabled={busy} onClick={() => wb.recheck(sid)}><RotateCcw className="h-4 w-4" />重新检查</Btn>
            <Btn variant="outline" disabled={busy} onClick={() => wb.recheck(sid, true)}>回退到备份版本并检查</Btn>
          </>
        }
      >
        <p>已自动修复 {state.repairs}/{MAX_REPAIRS} 次仍未通过。最后一次错误：</p>
        <Detail text={state.lastError} />
        <p className="mt-2 text-xs text-[#6B6A64]">
          已保留{state.lastGoodPassed ? '最后一份通过检查的' : '首次生成的'}代码备份，可在「代码」标签中修改后重新检查。
        </p>
      </Card>,
    );
  }

  const stalled =
    !busy &&
    ((stage === 'intent' && !state.awaitingAnswer) ||
      (stage === 'plan' && !state.awaitingConfirm) ||
      stage === 'generate' ||
      stage === 'check' ||
      (stage === 'preview' && !state.running));
  if (stalled) {
    const label = stage === 'preview' ? '应用未运行' : '流程已暂停';
    cards.push(
      <Card
        key="resume"
        title={<><Play className="h-4 w-4" />{label}</>}
        footer={
          <>
            <Btn onClick={() => (stage === 'preview' ? wb.restart(sid) : wb.resume(sid))}>
              {stage === 'preview' ? '重启应用' : stage === 'check' || stage === 'generate' ? '继续 / 重新检查' : '继续'}
            </Btn>
            {stage === 'preview' && <Btn variant="outline" onClick={() => wb.recheck(sid)}>重新检查</Btn>}
          </>
        }
      >
        <p className="text-[#6B6A64]">
          {stage === 'preview'
            ? '平台重启或实例被终止后，应用视为已停止。点击重启即可在新端口运行，数据仍保留。'
            : '流程被中断（平台重启或调用失败），点击按钮从当前阶段继续。'}
        </p>
        {state.lastError && <Detail text={state.lastError} />}
      </Card>,
    );
  }

  if (state.revision) {
    cards.push(
      <Card key="revision" title={<><Wrench className="h-4 w-4 text-[#E8590C]" />修改中</>}>
        <p><b>正在修改：</b>{state.revision.change || state.revision.request}</p>
        <p className="mt-1 text-xs text-[#6B6A64]">
          只重新生成 {state.revision.affected.join('、')}。重启完成前预览可能暂时不可用，这是正常的；修改不会改写已有数据，失败时会自动回到修改前的版本。
        </p>
      </Card>,
    );
  }

  if (state.suggestNew && !busy) {
    cards.push(
      <Card
        key="suggestNew"
        title={<><AlertTriangle className="h-4 w-4 text-[#E8590C]" />这是一个新应用</>}
        footer={
          <Btn disabled={creating} onClick={() => onNewSession(state.suggestNew)}>
            新建会话生成「{state.suggestNew.slice(0, 20)}」
          </Btn>
        }
      >
        <p>这次要求相当于一个新应用，不会在当前会话中执行，当前应用保持不变。</p>
      </Card>,
    );
  }

  const visible = cards.filter((card) => position(String(card.key)) === slot);
  if (!visible.length) return null;
  return <div className="space-y-3">{visible}</div>;
}
