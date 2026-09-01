import { useRef, useState } from "react";
import { client } from "@/lib/edgespark";
import type { LinkOffer, Participant, PendingGeneration, PlayerControl, StoryChoice } from "@/types/live";

const VIEWER_PROMPT_MAX = 300;
const CLIP_SECONDS = 10;

const fallbackChoices: StoryChoice[] = [
  { id: "signal", title: "追踪异常信号", detail: "沿着断续电波深入雨林。", participantHint: "等待直播状态", round: 0, recentEvent: null },
  { id: "beacon", title: "强修信标", detail: "冒雨尝试恢复坐标。", participantHint: "等待直播状态", round: 0, recentEvent: null },
  { id: "shelter", title: "抢建庇护", detail: "先争取一个避风点。", participantHint: "等待直播状态", round: 0, recentEvent: null },
];

export function ActionBar({ participant, roster, myCharacters, onSwitchCharacter, linkOffers, control, choices, pendingGeneration, onUpdated }: {
  participant: Participant;
  /** Everyone else on the roster, offered as @mentions to pull into the shot. */
  roster: Participant[];
  /** Every character this viewer holds a control token for, when they hold more than one. */
  myCharacters: Participant[];
  onSwitchCharacter: (participantId: number) => void;
  /** Clips that wrote this contestant in, offered with "/" as an opening frame. */
  linkOffers: LinkOffer[];
  control: PlayerControl;
  choices: StoryChoice[];
  /** This contestant's own channel, if it is currently generating. App drives the sync polling. */
  pendingGeneration: PendingGeneration | null;
  onUpdated: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  // The "@" or "/" that opened the picker, and how far the viewer has typed since.
  const [trigger, setTrigger] = useState<{ char: "@" | "/"; at: number; query: string } | null>(null);
  const [pickIndex, setPickIndex] = useState(0);
  const [linkFrom, setLinkFrom] = useState<LinkOffer | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Only this contestant's channel blocks them; other channels run in parallel.
  const channelBusy = Boolean(pendingGeneration);
  const locked = busy || channelBusy;
  const mentionable = roster.filter((item) => item.id !== participant.id && item.status !== "eliminated");
  const query = trigger?.query.toLowerCase() ?? "";
  const mentionHits = trigger?.char === "@"
    ? mentionable.filter((item) => item.display_name.toLowerCase().includes(query))
    : [];
  const linkHits = trigger?.char === "/"
    ? linkOffers.filter((item) => item.fromName.toLowerCase().includes(query))
    : [];
  const pickCount = mentionHits.length + linkHits.length;

  function closePicker() {
    setTrigger(null);
    setPickIndex(0);
  }

  function trackTrigger(value: string, caret: number) {
    const before = value.slice(0, caret);
    const at = Math.max(before.lastIndexOf("@"), before.lastIndexOf("/"));
    // Only an unbroken run of non-space characters after the marker keeps the picker open.
    if (at === -1 || /\s/.test(before.slice(at + 1))) {
      closePicker();
      return;
    }
    setTrigger({ char: before[at] as "@" | "/", at, query: before.slice(at + 1) });
    setPickIndex(0);
  }

  /** Drop the "@name" / "/" run the viewer typed; the marker itself is never part of the prompt. */
  function replaceTrigger(insert: string) {
    if (!trigger) return;
    const caret = inputRef.current?.selectionStart ?? draft.length;
    const next = `${draft.slice(0, trigger.at)}${insert}${draft.slice(caret)}`.slice(0, VIEWER_PROMPT_MAX);
    const cursor = trigger.at + insert.length;
    setDraft(next);
    closePicker();
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(cursor, cursor);
    });
  }

  function applyPick(index: number) {
    if (index < mentionHits.length) {
      replaceTrigger(`@${mentionHits[index].display_name} `);
      return;
    }
    // A link is metadata, not prompt text, so it becomes a chip instead of going into the field.
    setLinkFrom(linkHits[index - mentionHits.length]);
    replaceTrigger("");
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
        body: JSON.stringify({ ...control, viewerPrompt, linkFromGenerationId: linkFrom?.id ?? null }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "指令提交失败");
      setDraft("");
      setLinkFrom(null);
      closePicker();
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
    if (pickCount > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setPickIndex((current) => (current + 1) % pickCount);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setPickIndex((current) => (current - 1 + pickCount) % pickCount);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        applyPick(pickIndex);
        return;
      }
      if (event.key === "Escape") {
        closePicker();
        return;
      }
    }
    if (event.key === "Enter") void submit();
  }

  const visibleChoices = choices.length ? choices : fallbackChoices;
  const hints = [mentionable.length ? "@ 拉人进画面" : "", linkOffers.length ? "/ 接续别人的画面" : ""].filter(Boolean);
  const statusText = notice
    || (channelBusy ? `你的视角通道正在生成 ${CLIP_SECONDS} 秒片段…` : hints.length
      ? `写下你想让角色做什么，输入 ${hints.join("、")}`
      : "写下你想让角色做什么，会生成你自己的视角片段");

  return (
    <section className="action-bar">
      <div className="my-state">
        {myCharacters.length > 1 ? (
          <div className="my-switch">
            {myCharacters.map((item) => (
              <button
                key={item.id}
                type="button"
                title={`切换到 ${item.display_name}`}
                className={item.id === participant.id ? "active" : ""}
                onClick={() => onSwitchCharacter(item.id)}
              >
                {item.avatar_url
                  ? <img src={item.avatar_url} alt="" />
                  : <i>{item.display_name.slice(0, 1)}</i>}
                <span>{item.display_name}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="my-identity">
            {participant.avatar_url
              ? <img className="my-avatar" src={participant.avatar_url} alt="" />
              : <i className="my-avatar">{participant.display_name.slice(0, 1)}</i>}
            <div>
              <span className="eyebrow">YOUR MOVE</span>
              <strong>{participant.display_name}</strong>
            </div>
          </div>
        )}
        <div className="stat-pair"><span>HP {participant.health}</span><span>STA {participant.stamina}</span><span>HUN {participant.hunger}</span></div>
      </div>
      <div className="action-compose">
        <div className="action-shortcuts">
          {linkFrom ? (
            <button type="button" className="link-chip" onClick={() => setLinkFrom(null)} title="移除这个起始画面">
              接续 {linkFrom.fromName} 的画面 ✕
            </button>
          ) : null}
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
          {pickCount > 0 ? (
            <ul className="mention-popover">
              {mentionHits.map((item, index) => (
                <li key={`mention-${item.id}`}>
                  <button
                    type="button"
                    className={index === pickIndex ? "active" : ""}
                    // mousedown fires before blur, so the field keeps focus and the caret survives.
                    onMouseDown={(event) => { event.preventDefault(); applyPick(index); }}
                  >
                    <b>@{item.display_name}</b>
                    <small>{item.archetype}</small>
                  </button>
                </li>
              ))}
              {linkHits.map((item, offset) => {
                const index = mentionHits.length + offset;
                return (
                  <li key={`link-${item.id}`}>
                    <button
                      type="button"
                      className={index === pickIndex ? "active" : ""}
                      onMouseDown={(event) => { event.preventDefault(); applyPick(index); }}
                    >
                      <b>接续 {item.fromName} 的画面</b>
                      <small>{item.summary ?? "以那一帧为起点"}</small>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}
          <input
            ref={inputRef}
            value={draft}
            maxLength={VIEWER_PROMPT_MAX}
            placeholder={linkFrom ? "从那一帧接着往下拍…" : mentionable.length ? "例如：顶着暴雨爬上礁石，@ 队友从下面接应" : "例如：顶着暴雨爬上礁石，把信号弹举过头顶"}
            disabled={locked}
            onChange={(event) => {
              setDraft(event.target.value);
              trackTrigger(event.target.value, event.target.selectionStart ?? event.target.value.length);
            }}
            onKeyUp={(event) => trackTrigger(event.currentTarget.value, event.currentTarget.selectionStart ?? 0)}
            onBlur={() => closePicker()}
            onKeyDown={handleKeyDown}
          />
          <button type="button" className="primary-action" disabled={locked || draft.trim().length < 2} onClick={() => void submit()}>
            {busy ? "提交中" : channelBusy ? "生成中" : "生成这一段"}
          </button>
        </div>
        <p className="action-notice">{statusText}</p>
      </div>
    </section>
  );
}
