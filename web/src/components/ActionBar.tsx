import { useRef, useState } from "react";
import { client } from "@/lib/edgespark";
import type { Participant, PendingGeneration, PlayerControl, StoryChoice } from "@/types/live";

const VIEWER_PROMPT_MAX = 300;
const CLIP_SECONDS = 10;

const fallbackChoices: StoryChoice[] = [
  { id: "signal", title: "追踪异常信号", detail: "沿着断续电波深入雨林。", participantHint: "等待直播状态", round: 0, recentEvent: null },
  { id: "beacon", title: "强修信标", detail: "冒雨尝试恢复坐标。", participantHint: "等待直播状态", round: 0, recentEvent: null },
  { id: "shelter", title: "抢建庇护", detail: "先争取一个避风点。", participantHint: "等待直播状态", round: 0, recentEvent: null },
];

export function ActionBar({ participant, roster, control, choices, pendingGeneration, onUpdated }: {
  participant: Participant;
  /** Everyone else on the roster, offered as @mentions to pull into the shot. */
  roster: Participant[];
  control: PlayerControl;
  choices: StoryChoice[];
  /** This contestant's own channel, if it is currently generating. App drives the sync polling. */
  pendingGeneration: PendingGeneration | null;
  onUpdated: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  // Index of the "@" that opened the picker, or -1 when it is closed.
  const [mentionAt, setMentionAt] = useState(-1);
  const [mentionQuery, setMentionQuery] = useState("");
  const [mentionIndex, setMentionIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Only this contestant's channel blocks them; other channels run in parallel.
  const channelBusy = Boolean(pendingGeneration);
  const locked = busy || channelBusy;
  const mentionable = roster.filter((item) => item.id !== participant.id && item.status !== "eliminated");
  const suggestions = mentionAt >= 0
    ? mentionable.filter((item) => item.display_name.toLowerCase().includes(mentionQuery.toLowerCase()))
    : [];

  function closeMentions() {
    setMentionAt(-1);
    setMentionQuery("");
    setMentionIndex(0);
  }

  function trackMention(value: string, caret: number) {
    const before = value.slice(0, caret);
    const at = before.lastIndexOf("@");
    // Only an unbroken run of non-space characters after "@" is still an open mention.
    if (at === -1 || /\s/.test(before.slice(at + 1))) {
      closeMentions();
      return;
    }
    setMentionAt(at);
    setMentionQuery(before.slice(at + 1));
    setMentionIndex(0);
  }

  function applyMention(name: string) {
    const caret = inputRef.current?.selectionStart ?? draft.length;
    const next = `${draft.slice(0, mentionAt)}@${name} ${draft.slice(caret)}`.slice(0, VIEWER_PROMPT_MAX);
    const cursor = mentionAt + name.length + 2;
    setDraft(next);
    closeMentions();
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(cursor, cursor);
    });
  }

  async function submit() {
    const viewerPrompt = draft.trim();
    if (viewerPrompt.length < 2) {
      setNotice("先写下你想让角色做什么");
      return;
    }
    if (locked) {
      setNotice("你的视角通道还在生成上一段，完成后会自动开放");
      return;
    }
    setBusy(true);
    setNotice("");
    try {
      const response = await client.api.fetch("/api/public/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...control, viewerPrompt }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "指令提交失败");
      setDraft("");
      closeMentions();
      setNotice(result.guests?.length
        ? `${result.message || "指令已生效"}，联动 ${result.guests.join("、")}`
        : result.message || "指令已生效，正在生成你的视角片段");
      onUpdated();
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "指令提交失败");
    } finally {
      setBusy(false);
    }
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (suggestions.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setMentionIndex((current) => (current + 1) % suggestions.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setMentionIndex((current) => (current - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        applyMention(suggestions[mentionIndex].display_name);
        return;
      }
      if (event.key === "Escape") {
        closeMentions();
        return;
      }
    }
    if (event.key === "Enter") void submit();
  }

  const visibleChoices = choices.length ? choices : fallbackChoices;
  const statusText = notice
    || (channelBusy ? `你的视角通道正在生成 ${CLIP_SECONDS} 秒片段…` : mentionable.length
      ? "写下你想让角色做什么，输入 @ 可以把其他角色拉进画面"
      : "写下你想让角色做什么，会生成你自己的视角片段");

  return (
    <section className="action-bar">
      <div className="my-state">
        <span className="eyebrow">YOUR MOVE</span>
        <strong>{participant.display_name}</strong>
        <div className="stat-pair"><span>HP {participant.health}</span><span>STA {participant.stamina}</span><span>HUN {participant.hunger}</span></div>
      </div>
      <div className="action-compose">
        <div className="action-shortcuts">
          {visibleChoices.map((choice) => (
            <button
              key={choice.id}
              type="button"
              title={choice.participantHint}
              disabled={locked}
              onClick={() => setDraft(choice.detail.slice(0, VIEWER_PROMPT_MAX))}
            >
              {choice.title}
            </button>
          ))}
        </div>
        <div className="action-input">
          {suggestions.length > 0 ? (
            <ul className="mention-popover">
              {suggestions.map((item, index) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className={index === mentionIndex ? "active" : ""}
                    // mousedown fires before blur, so the field keeps focus and the caret survives.
                    onMouseDown={(event) => { event.preventDefault(); applyMention(item.display_name); }}
                  >
                    <b>@{item.display_name}</b>
                    <small>{item.archetype}</small>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <input
            ref={inputRef}
            value={draft}
            maxLength={VIEWER_PROMPT_MAX}
            placeholder={mentionable.length ? "例如：顶着暴雨爬上礁石，@ 队友从下面接应" : "例如：顶着暴雨爬上礁石，把信号弹举过头顶"}
            disabled={locked}
            onChange={(event) => {
              setDraft(event.target.value);
              trackMention(event.target.value, event.target.selectionStart ?? event.target.value.length);
            }}
            onKeyUp={(event) => trackMention(event.currentTarget.value, event.currentTarget.selectionStart ?? 0)}
            onBlur={() => closeMentions()}
            onKeyDown={handleKeyDown}
          />
          <button type="button" className="primary-action" disabled={locked || draft.trim().length < 2} onClick={() => void submit()}>
            {busy ? "提交中" : channelBusy ? "生成中" : "生成这一段"}
          </button>
        </div>
      </div>
      <p className="action-notice">{statusText}</p>
    </section>
  );
}
