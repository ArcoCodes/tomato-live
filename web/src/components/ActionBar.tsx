import { useRef, useState } from "react";
import { client } from "@/lib/edgespark";
import type { LinkOffer, Participant, PendingGeneration, PlayerControl, StoryChoice } from "@/types/live";

const VIEWER_PROMPT_MAX = 300;
const CLIP_SECONDS = 10;

const fallbackChoices: StoryChoice[] = [
  { id: "signal", title: "Chase the signal", detail: "Follow the broken transmission deeper into the rainforest.", participantHint: "Waiting on the feed", round: 0, recentEvent: null },
  { id: "beacon", title: "Force the beacon", detail: "Try to restore the coordinates in the rain.", participantHint: "Waiting on the feed", round: 0, recentEvent: null },
  { id: "shelter", title: "Throw up shelter", detail: "Get something between you and the wind first.", participantHint: "Waiting on the feed", round: 0, recentEvent: null },
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
      setNotice("Write what your contestant should do");
      return;
    }
    if (locked) {
      setNotice("Your channel is still filming the last clip; it opens up when that lands");
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
      if (!response.ok) throw new Error(result.error || "Could not submit");
      setDraft("");
      setLinkFrom(null);
      closePicker();
      // The prompt work runs on the first sync, so kick it now rather than waiting up to 2.5s
      // for the next poll tick.
      if (result.generation?.id) {
        void client.api.fetch(`/api/public/generations/${result.generation.id}/sync`, { method: "POST" });
      }
      setNotice(result.guests?.length
        ? `${result.message || "Filming now"} — with ${result.guests.join(", ")}`
        : result.message || "Filming now — your channel is making the clip");
      onUpdated();
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "Could not submit");
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
  const hints = [mentionable.length ? "@ to cast someone" : "", linkOffers.length ? "/ to continue a shot" : ""].filter(Boolean);
  const busyText = pendingGeneration?.stage === "video"
    ? `Footage is coming back from the island, a ${CLIP_SECONDS}s clip, nearly there…`
    : "Acquiring the signal to record this move…";
  const statusText = notice
    || (channelBusy ? busyText : hints.length
      ? `Write what your contestant does — ${hints.join(", ")}`
      : "Write what your contestant does and your channel films it");

  return (
    <section className="action-bar">
      <div className="my-state">
        {myCharacters.length > 1 ? (
          <div className="my-switch">
            {myCharacters.map((item) => (
              <button
                key={item.id}
                type="button"
                title={`Switch to ${item.display_name}`}
                className={item.id === participant.id ? "active" : ""}
                onClick={() => onSwitchCharacter(item.id)}
              >
                {(item.portrait_url ?? item.avatar_url)
                  ? <img src={item.portrait_url ?? item.avatar_url!} alt="" />
                  : <i>{item.display_name.slice(0, 1)}</i>}
                <span>{item.display_name}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="my-identity">
            {(participant.portrait_url ?? participant.avatar_url)
              ? <img className="my-avatar" src={participant.portrait_url ?? participant.avatar_url!} alt="" />
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
            <button type="button" className="link-chip" onClick={() => setLinkFrom(null)} title="Drop this opening frame">
              Continuing {linkFrom.fromName} ✕
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
                      <b>Continue from {item.fromName}</b>
                      <small>{item.summary ?? "Open on that frame"}</small>
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
            placeholder={linkFrom ? "Pick up from that frame…" : mentionable.length ? "e.g. climb the rocks through the squall, @someone bracing below" : "e.g. climb the rocks through the squall, flare held overhead"}
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
            {busy ? "Sending" : channelBusy ? (pendingGeneration?.stage === "video" ? "Feed incoming" : "Acquiring signal") : "Film this"}
          </button>
        </div>
        <p className="action-notice">{statusText}</p>
      </div>
    </section>
  );
}
