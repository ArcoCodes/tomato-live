import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { deviceHeaders } from "@/lib/device";
import { client } from "@/lib/edgespark";
import type { ChatAllowance, ChatMessage, ChatUnlock, Participant } from "@/types/live";

const CHAT_MAX = 140;

interface ChatRoomProps {
  messages: ChatMessage[];
  participants: Participant[];
  waiting: number;
  allowance: ChatAllowance | null;
  /** Told which clip a message became, so the badge can take the viewer to it. */
  onShowClip: (generationId: number) => void;
  onSent: () => void;
  /** Phone only: shows and hides the archive strip over the picture. */
  archiveOpen: boolean;
  onToggleArchive: () => void;
}

/** Renders "@name" runs in the accent of whoever was named. */
function renderBody(body: string, byName: Map<string, Participant>) {
  const parts = body.split(/(@[^\s@]{1,20})/g);
  return parts.map((part, index) => {
    if (!part.startsWith("@")) return <span key={index}>{part}</span>;
    const hit = byName.get(part.slice(1).toLowerCase());
    if (!hit) return <span key={index}>{part}</span>;
    return <b key={index} style={{ color: hit.accent }}>{part}</b>;
  });
}

export function ChatRoom({ messages, participants, waiting, allowance, onShowClip, onSent, archiveOpen, onToggleArchive }: ChatRoomProps) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [trigger, setTrigger] = useState<{ at: number; query: string } | null>(null);
  const [unlock, setUnlock] = useState<ChatUnlock | null>(null);
  const [unlocking, setUnlocking] = useState(false);
  const [unlockError, setUnlockError] = useState("");
  const [spent, setSpent] = useState(false);
  const [pickIndex, setPickIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);

  const byName = new Map(participants.map((item) => [item.display_name.toLowerCase(), item]));
  const query = trigger?.query.toLowerCase() ?? "";
  const hits = trigger
    ? participants.filter((item) => item.status !== "eliminated" && item.display_name.toLowerCase().includes(query)).slice(0, 5)
    : [];

  // Follow the room only while the reader is already at the bottom, so scrolling back to read
  // something is not yanked away by the next message.
  useEffect(() => {
    const list = listRef.current;
    if (list && pinnedRef.current) list.scrollTop = list.scrollHeight;
  }, [messages.length]);

  function closePicker() {
    setTrigger(null);
    setPickIndex(0);
  }

  function trackTrigger(value: string, caret: number) {
    const before = value.slice(0, caret);
    const at = before.lastIndexOf("@");
    if (at === -1 || /\s/.test(before.slice(at + 1))) {
      closePicker();
      return;
    }
    setTrigger({ at, query: before.slice(at + 1) });
    setPickIndex(0);
  }

  function applyPick(index: number) {
    const hit = hits[index];
    if (!hit || !trigger) return;
    const caret = inputRef.current?.selectionStart ?? draft.length;
    const insert = `@${hit.display_name} `;
    const next = `${draft.slice(0, trigger.at)}${insert}${draft.slice(caret)}`.slice(0, CHAT_MAX);
    const cursor = trigger.at + insert.length;
    setDraft(next);
    closePicker();
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(cursor, cursor);
    });
  }

  async function send() {
    const body = draft.trim();
    if (body.length < 2 || busy) return;
    setBusy(true);
    setNotice("");
    try {
      const response = await client.api.fetch("/api/public/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...deviceHeaders },
        body: JSON.stringify({ body }),
      });
      const result = await response.json();
      if (response.status === 403) {
        // Out of turns: the dialog is the only place the next step is offered.
        setUnlock(result.allowance?.next ?? null);
        setSpent(!result.allowance?.next);
        return;
      }
      if (!response.ok) throw new Error(result.error || "Could not send");
      setDraft("");
      pinnedRef.current = true;
      onSent();
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "Could not send");
    } finally {
      setBusy(false);
    }
  }

  async function claimUnlock(step: ChatUnlock) {
    setUnlocking(true);
    setUnlockError("");
    try {
      const response = await client.api.fetch("/api/public/chat/unlock", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...deviceHeaders },
        body: JSON.stringify({ step: step.key }),
        // The click opens a tab and this page goes to the background mid-request, which is exactly
        // what keepalive is for — without it the browser is free to drop it and the turns are lost.
        keepalive: true,
      });
      const result = await response.json();
      // Already claimed is a success from here: the turns are on the account either way.
      if (!response.ok && response.status !== 409) throw new Error(result.error || "Could not unlock");
      setUnlock(null);
      onSent();
    } catch (cause) {
      // Keep the dialog up so the viewer can try again; the notice behind it is not visible.
      setUnlockError(cause instanceof Error ? cause.message : "Could not unlock");
    } finally {
      setUnlocking(false);
    }
  }

  const quotaLabel = !allowance || allowance.unlimited
    ? null
    : `${allowance.remaining} / ${allowance.allowance} messages`;

  return (
    <aside className="chat-panel" aria-label="Live chat">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">LIVE CHAT</span>
          <h2>Live chat</h2>
        </div>
        <span className="alive-count">{quotaLabel ?? `${waiting} queued`}</span>
      </div>

      <div
        className="chat-list"
        ref={listRef}
        onScroll={(event) => {
          const el = event.currentTarget;
          pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {messages.length === 0
          ? <p className="chat-empty">Nobody has spoken yet. Write a line and the director films it as the next clip.<br />Use <b>@name</b> to cast someone — everyone you name shows up in the same shot.</p>
          : messages.map((message) => (
            <div className={message.filmed ? "chat-line is-filmed" : "chat-line"} key={message.id}>
              <span className="chat-who">{message.display_name}</span>
              <p>{renderBody(message.body, byName)}</p>
              {/* A failed render used to be offered as "Watch it", and the player answered that the
                  clip was not in the queue yet — which reads as "wait" for something that is never
                  coming. Say what happened instead. */}
              {message.filmed ? (
                message.generation_stage === "failed"
                  ? <em className="is-lost">COULD NOT BE FILMED</em>
                  : message.generation_id != null && message.generation_stage === "completed"
                  ? <button type="button" className="chat-jump" onClick={() => onShowClip(message.generation_id!)}>Watch it <span>→</span></button>
                  : <em>FILMING…</em>
              ) : null}
            </div>
          ))}
      </div>

      <div className="chat-compose">
        {trigger && hits.length ? (
          <div className="chat-picker" role="listbox">
            {hits.map((item, index) => (
              <button
                type="button"
                key={item.id}
                className={index === pickIndex ? "active" : ""}
                style={{ "--accent": item.accent } as CSSProperties}
                onMouseDown={(event) => { event.preventDefault(); applyPick(index); }}
              >
                {item.portrait_url ? <img src={item.portrait_url} alt="" /> : <i>{item.display_name.slice(0, 1)}</i>}
                <b>@{item.display_name}</b>
              </button>
            ))}
          </div>
        ) : null}
        <div className="chat-field">
          <button
            type="button"
            className={archiveOpen ? "chat-archive-toggle is-open" : "chat-archive-toggle"}
            onClick={onToggleArchive}
            aria-pressed={archiveOpen}
          >
            Replay
          </button>
          <input
            ref={inputRef}
            value={draft}
            maxLength={CHAT_MAX}
            placeholder="Say something, or @name to cast"
            onChange={(event) => {
              setDraft(event.target.value);
              trackTrigger(event.target.value, event.target.selectionStart ?? event.target.value.length);
            }}
            onKeyUp={(event) => trackTrigger(event.currentTarget.value, event.currentTarget.selectionStart ?? 0)}
            onBlur={() => closePicker()}
            onKeyDown={(event) => {
              if (trigger && hits.length) {
                if (event.key === "ArrowDown") { event.preventDefault(); setPickIndex((i) => (i + 1) % hits.length); return; }
                if (event.key === "ArrowUp") { event.preventDefault(); setPickIndex((i) => (i - 1 + hits.length) % hits.length); return; }
                if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); applyPick(pickIndex); return; }
                if (event.key === "Escape") { closePicker(); return; }
              }
              if (event.key === "Enter") { event.preventDefault(); void send(); }
            }}
          />
          <button type="button" onClick={() => void send()} disabled={busy || draft.trim().length < 2}>
            {busy ? "…" : "Send"}
          </button>
        </div>
        {notice ? <p className="chat-notice">{notice}</p> : null}
        <p className="legal-note is-phone">Any resemblance to real persons is purely coincidental.</p>
        {spent && !unlock ? <p className="chat-notice">You are out of messages. Thanks for pushing the story this far.</p> : null}
      </div>

      {unlock ? createPortal((
        // Portalled to the body: the panel clips its overflow, and the card is wider than the panel.
        <div className="chat-unlock" role="dialog" aria-label={unlock.title}>
          <div className="chat-unlock-card">
            <span className="eyebrow">{unlock.grant} more</span>
            <h3>{unlock.title}</h3>
            <p>{unlock.detail}</p>
            {/* Going there is the whole ask — nothing on this side can check what happens next, so
                asking again afterwards would only add a step. */}
            <a
              className="chat-unlock-go"
              href={unlock.url}
              target="_blank"
              rel="noreferrer noopener"
              onClick={() => void claimUnlock(unlock)}
            >
              {unlocking ? "Unlocking…" : unlock.cta} <span>↗</span>
            </a>
            {unlockError ? <p className="chat-unlock-error">{unlockError} — tap again to retry.</p> : null}
            <button type="button" className="chat-unlock-close" onClick={() => { setUnlock(null); setUnlockError(""); }}>Maybe later</button>
          </div>
        </div>
      ), document.body) : null}
    </aside>
  );
}
