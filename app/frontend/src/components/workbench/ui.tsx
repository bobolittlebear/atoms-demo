import { Check, Circle, Loader2, X } from 'lucide-react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/utils';
import type { ItemStatus, Stage } from '@/lib/workbench/types';

export const STAGES: { key: Exclude<Stage, 'failed'>; label: string }[] = [
  { key: 'intent', label: '判断' },
  { key: 'plan', label: '规划' },
  { key: 'generate', label: '生成' },
  { key: 'check', label: '检查' },
  { key: 'preview', label: '预览' },
];

export const STAGE_LABEL: Record<Stage, string> = {
  intent: '判断',
  plan: '规划',
  generate: '生成',
  check: '检查',
  preview: '预览',
  failed: '失败',
};

export function Btn({
  variant = 'primary',
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'outline' | 'ghost' }) {
  return (
    <button
      {...props}
      className={cn(
        'inline-flex min-h-8 items-center justify-center gap-1.5 rounded-[6px] px-3 text-[13px] font-medium transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8590C] disabled:cursor-not-allowed disabled:opacity-50',
        variant === 'primary' && 'bg-[#E8590C] text-white hover:bg-[#CF4F0A]',
        variant === 'outline' && 'border border-[#DCD6C8] !bg-transparent text-[#16181D] hover:border-[#16181D]',
        variant === 'ghost' && 'text-[#6B6A64] hover:bg-[#ECE8DE] hover:text-[#16181D]',
        className,
      )}
    />
  );
}

export function StatusIcon({ status }: { status: ItemStatus }) {
  if (status === 'running') return <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[#E8590C]" aria-label="进行中" />;
  if (status === 'done') return <Check className="h-4 w-4 shrink-0 text-[#1F8A4C]" aria-label="通过" />;
  if (status === 'error') return <X className="h-4 w-4 shrink-0 text-[#C92A2A]" aria-label="失败" />;
  return <Circle className="h-4 w-4 shrink-0 text-[#B5AFA2]" aria-label="等待" />;
}

export function Card({ title, children, footer, tone }: { title: ReactNode; children: ReactNode; footer?: ReactNode; tone?: 'error' }) {
  return (
    <section className="rounded-[8px] border border-[#DCD6C8] bg-white shadow-[0_1px_2px_rgba(22,24,29,.06)]">
      <header className={cn('flex items-center gap-2 border-b border-[#ECE8DE] px-4 py-2.5 text-sm font-semibold', tone === 'error' && 'text-[#C92A2A]')}>
        {title}
      </header>
      <div className="px-4 py-3 text-sm leading-relaxed">{children}</div>
      {footer && <footer className="flex flex-wrap items-center gap-2 border-t border-[#ECE8DE] px-4 py-2.5">{footer}</footer>}
    </section>
  );
}

export function StageRail({ stage }: { stage: Stage }) {
  const failed = stage === 'failed';
  const current = failed ? 3 : STAGES.findIndex((s) => s.key === stage);
  return (
    <ol className="flex gap-1" aria-label="阶段">
      {STAGES.map((s, i) => {
        const state = i < current ? 'done' : i === current ? (failed ? 'failed' : 'current') : 'todo';
        return (
          <li
            key={s.key}
            aria-current={state === 'current' ? 'step' : undefined}
            className={cn(
              'flex h-8 flex-1 items-center justify-center gap-1.5 rounded-[6px] border text-[13px] font-medium transition-colors duration-150',
              state === 'done' && 'border-[#16181D] bg-[#16181D] text-white',
              state === 'current' && 'border-[#E8590C] bg-[#E8590C] text-white',
              state === 'failed' && 'border-[#C92A2A] bg-[#C92A2A] text-white',
              state === 'todo' && 'border-[#DCD6C8] text-[#6B6A64]',
            )}
          >
            {state === 'current' && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" />}
            {state === 'failed' ? '失败' : s.label}
          </li>
        );
      })}
    </ol>
  );
}

export function Placeholder({ icon, text, action }: { icon: ReactNode; text: string; action?: ReactNode }) {
  return (
    <div className="flex h-full min-h-40 flex-col items-center justify-center gap-3 p-6 text-center text-sm text-[#6B6A64]">
      <div className="text-[#B5AFA2]">{icon}</div>
      <p>{text}</p>
      {action}
    </div>
  );
}
