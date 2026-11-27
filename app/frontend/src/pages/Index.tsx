import { Fragment, useEffect, useRef, useState } from "react";
import {
  Boxes,
  Loader2,
  MessageSquarePlus,
  Plus,
  Send,
  Trash2,
} from "lucide-react";
import { useWorkbench } from "@/hooks/useWorkbench";
import type { Session } from "@/lib/workbench/types";
import { cn } from "@/lib/utils";
import { RightPanel } from "@/components/workbench/RightPanel";
import { StageCards } from "@/components/workbench/StageCards";
import {
  Btn,
  Placeholder,
  STAGE_LABEL,
  StageRail,
} from "@/components/workbench/ui";

const EXAMPLES = [
  "做一个任务清单，可以添加、完成、删除",
  "做一个读书记录，记录书名、作者和是否读完",
  "做个网页",
];

function stageDot(s: Session) {
  if (s.stage === "failed") return "bg-[#C92A2A]";
  if (s.stage === "preview")
    return s.state.running ? "bg-[#2563EB]" : "bg-[#B5AFA2]";
  return "bg-[#E8590C]";
}

export default function Index() {
  const wb = useWorkbench();
  const { sessions, active } = wb;
  const [input, setInput] = useState("");
  const [creating, setCreating] = useState(false);
  const feed = useRef<HTMLDivElement>(null);

  const progress = active
    ? [
        active.sid,
        active.stage,
        active.state.messages.length,
        active.state.checks.map((c) => c.status).join(),
        active.state.tasks.map((t) => t.status).join(),
        JSON.stringify(active.state.anchors ?? {}),
        active.state.revision ? 1 : 0,
        active.state.suggestNew,
        wb.busy[active.sid] ? 1 : 0,
      ].join("|")
    : "";

  // Keep the newest entry (message or card) in view; scroll only the feed container.
  useEffect(() => {
    const el = feed.current;
    if (!el) return;
    const id = requestAnimationFrame(() =>
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" }),
    );
    return () => cancelAnimationFrame(id);
  }, [progress]);

  const canRevise =
    !!active && active.stage === "preview" && !wb.busy[active.sid];

  const createNew = async (value: string) => {
    setCreating(true);
    await wb.createSession(value);
    setCreating(false);
  };

  const submit = async (text: string) => {
    const value = text.trim();
    if (!value || creating) return;
    setInput("");
    if (active && canRevise) {
      await wb.revise(active.sid, value);
      return;
    }
    await createNew(value);
  };

  const remove = (s: Session) => {
    if (
      window.confirm(`删除会话「${s.title}」？应用将停止，其数据将不可再访问。`)
    )
      void wb.removeSession(s.sid);
  };

  const busy = active ? !!wb.busy[active.sid] : false;

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-[#F4F1EA] font-['IBM_Plex_Sans','PingFang_SC','Microsoft_YaHei',sans-serif] text-[#16181D] md:flex-row">
      {/* 会话栏 */}
      <aside className="flex shrink-0 flex-col border-b border-[#DCD6C8] bg-[#ECE8DE] md:w-16 md:border-b-0 md:border-r xl:w-[260px]">
        <div className="flex items-center gap-2 px-4 py-3 md:justify-center xl:justify-start">
          <Boxes className="h-5 w-5 text-[#E8590C]" />
          <h1 className="text-[18px] font-semibold leading-tight md:hidden xl:block">
            Atoms Demo
          </h1>
          <Btn
            variant="ghost"
            aria-label="新建会话"
            title="新建会话"
            className="ml-auto w-8 rounded-full px-0 md:hidden xl:inline-flex"
            onClick={() => wb.setActiveSid(null)}
          >
            <Plus className="h-4 w-4" />
          </Btn>
        </div>
        <Btn
          variant="ghost"
          aria-label="新建会话"
          className="mx-auto mb-2 hidden w-8 rounded-full px-0 md:inline-flex xl:hidden"
          onClick={() => wb.setActiveSid(null)}
        >
          <Plus className="h-4 w-4" />
        </Btn>
        <div className="md:hidden px-4 pb-3">
          <select
            aria-label="选择会话"
            value={active?.sid ?? ""}
            onChange={(e) => wb.setActiveSid(e.target.value || null)}
            className="h-8 w-full rounded-[6px] border border-[#DCD6C8] bg-white px-2 text-sm"
          >
            <option value="">+ 新建会话</option>
            {sessions.map((s) => (
              <option key={s.sid} value={s.sid}>
                {s.title}（{STAGE_LABEL[s.stage]}）
              </option>
            ))}
          </select>
        </div>
        <ul className="hidden min-h-0 flex-1 space-y-1 overflow-auto px-2 pb-3 md:block">
          {wb.loading && (
            <li className="flex items-center gap-2 px-2 py-2 text-xs text-[#6B6A64]">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span className="md:hidden xl:inline">加载会话…</span>
            </li>
          )}
          {!wb.loading && !sessions.length && (
            <li className="px-2 py-2 text-xs text-[#6B6A64] md:hidden xl:block">
              还没有会话，输入一句需求开始。
            </li>
          )}
          {sessions.map((s) => (
            <li key={s.sid}>
              <div
                className={cn(
                  "group flex min-h-10 cursor-pointer items-center gap-2 rounded-[6px] px-2 py-1.5 transition-colors md:justify-center xl:justify-start",
                  s.sid === active?.sid
                    ? "bg-white shadow-[0_1px_2px_rgba(22,24,29,.06)]"
                    : "hover:bg-[#F4F1EA]",
                )}
                onClick={() => wb.setActiveSid(s.sid)}
                title={s.title}
              >
                <span className="relative hidden h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#16181D] text-xs text-white md:flex xl:hidden">
                  {s.title.slice(0, 1)}
                </span>
                <span
                  className={cn(
                    "h-2 w-2 shrink-0 rounded-full md:hidden xl:block",
                    stageDot(s),
                  )}
                />
                <span className="min-w-0 flex-1 md:hidden xl:block">
                  <span className="block truncate text-[13px] font-medium">
                    {s.title}
                  </span>
                  <span className="block text-xs text-[#6B6A64]">
                    {STAGE_LABEL[s.stage]}
                    {s.stage === "preview" && !s.state.running
                      ? " · 未运行"
                      : ""}
                  </span>
                </span>
                <button
                  aria-label={`删除会话 ${s.title}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    remove(s);
                  }}
                  disabled={!!wb.busy[s.sid]}
                  className="hidden h-8 w-8 items-center justify-center rounded-full text-[#6B6A64] opacity-0 transition-opacity hover:bg-[#ECE8DE] hover:text-[#C92A2A] focus:opacity-100 group-hover:opacity-100 disabled:hidden xl:flex"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      </aside>

      {/* 中栏 */}
      <main className="flex min-h-0 min-w-0 flex-1 flex-col md:min-w-[420px]">
        <div className="border-b border-[#DCD6C8] px-4 py-3">
          <div className="mb-2 flex items-center gap-2">
            <h2 className="truncate text-[14px] font-semibold">
              {active ? active.title : "新会话"}
            </h2>
            {active?.state.revision && (
              <span className="rounded-[6px] bg-[#E8590C] px-2 py-0.5 text-xs font-medium text-white">
                修改中
              </span>
            )}
            {busy && (
              <span className="flex items-center gap-1 text-xs text-[#E8590C]">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {STAGE_LABEL[active!.stage]}中
              </span>
            )}
          </div>
          <StageRail stage={active?.stage ?? "intent"} />
        </div>

        <div
          ref={feed}
          className="min-h-0 flex-1 space-y-2.5 overflow-auto px-4 py-4"
        >
          {wb.loadError && (
            <div className="rounded-[8px] border border-[#C92A2A] bg-white p-3 text-sm text-[#C92A2A]">
              {wb.loadError}{" "}
              <Btn
                variant="outline"
                className="ml-2"
                onClick={() => wb.reload()}
              >
                重试
              </Btn>
            </div>
          )}
          {!active ? (
            <Placeholder
              icon={<MessageSquarePlus className="h-8 w-8" />}
              text="输入一句需求，系统会依次判断、规划、生成、检查，并在右侧启动可操作的应用。"
              action={
                <div className="flex flex-col gap-2">
                  {EXAMPLES.map((e) => (
                    <Btn
                      key={e}
                      variant="outline"
                      disabled={creating}
                      onClick={() => submit(e)}
                    >
                      {e}
                    </Btn>
                  ))}
                </div>
              }
            />
          ) : (
            <>
              {Array.from(
                { length: active.state.messages.length + 1 },
                (_, slot) => {
                  const m = slot > 0 ? active.state.messages[slot - 1] : null;
                  return (
                    <Fragment key={`${active.sid}-${slot}`}>
                      {m &&
                        (m.role === "system" ? (
                          <p className="text-center text-xs text-[#6B6A64]">
                            {m.text}
                          </p>
                        ) : (
                          <div
                            className={cn(
                              "flex",
                              m.role === "user" && "justify-end",
                            )}
                          >
                            <div
                              className={cn(
                                "max-w-[85%] whitespace-pre-wrap break-words text-sm leading-relaxed",
                                m.role === "user"
                                  ? "rounded-[8px] bg-[#ECE8DE] px-3 py-2"
                                  : "px-1",
                              )}
                            >
                              {m.text}
                            </div>
                          </div>
                        ))}
                      <StageCards
                        session={active}
                        wb={wb}
                        slot={slot}
                        creating={creating}
                        onNewSession={(text) => void createNew(text)}
                      />
                    </Fragment>
                  );
                },
              )}
              {busy && (
                <p className="flex items-center gap-2 text-xs text-[#6B6A64]">
                  <Loader2 className="h-4 w-4 animate-spin text-[#E8590C]" />
                  正在{STAGE_LABEL[active.stage]}…
                </p>
              )}
            </>
          )}
        </div>

        <form
          className="border-t border-[#DCD6C8] p-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit(input);
          }}
        >
          <div className="flex gap-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void submit(input);
                }
              }}
              rows={2}
              maxLength={2000}
              placeholder={
                !active
                  ? "用一句话描述你要的应用，例如：做一个任务清单，可以添加、完成、删除"
                  : active.stage === "preview"
                    ? "提一个修改要求，例如：加一个截止日期 / 列表按截止日期排序"
                    : "输入新需求将新建一个会话；应用进入预览后可在此提修改要求"
              }
              className="min-h-[44px] flex-1 resize-none rounded-[6px] border border-[#DCD6C8] bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8590C]"
            />
            <Btn
              type="submit"
              disabled={
                !input.trim() ||
                creating ||
                (active?.stage === "preview" && busy)
              }
              className="self-end"
            >
              {creating ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
              {active?.stage === "preview" ? "修改" : "生成"}
            </Btn>
          </div>
        </form>
      </main>

      {/* 右栏 */}
      <section className="h-[60vh] shrink-0 border-t border-[#DCD6C8] md:h-auto md:w-1/2 md:border-l md:border-t-0 xl:w-[44%]">
        <RightPanel session={active} wb={wb} />
      </section>
    </div>
  );
}
