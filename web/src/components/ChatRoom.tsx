import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
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
  isAuthenticated: boolean;
  onRequireLogin: () => void;
  onSent: () => void;
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

export function ChatRoom({ messages, participants, waiting, allowance, onShowClip, isAuthenticated, onRequireLogin, onSent }: ChatRoomProps) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [trigger, setTrigger] = useState<{ at: number; query: string } | null>(null);
  const [unlock, setUnlock] = useState<ChatUnlock | null>(null);
  const [unlocking, setUnlocking] = useState(false);
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
    if (!isAuthenticated) {
      onRequireLogin();
      return;
    }
    setBusy(true);
    setNotice("");
    try {
      const response = await client.api.fetch("/api/public/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      });
      const result = await response.json();
      if (response.status === 403) {
        // Out of turns: the dialog is the only place the next step is offered.
        setUnlock(result.allowance?.next ?? null);
        setSpent(!result.allowance?.next);
        return;
      }
      if (!response.ok) throw new Error(result.error || "发送失败");
      setDraft("");
      pinnedRef.current = true;
      onSent();
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "发送失败");
    } finally {
      setBusy(false);
    }
  }

  async function claimUnlock(step: ChatUnlock) {
    setUnlocking(true);
    try {
      const response = await client.api.fetch("/api/public/chat/unlock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ step: step.key }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "解锁失败");
      setUnlock(null);
      onSent();
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "解锁失败");
    } finally {
      setUnlocking(false);
    }
  }

  const quotaLabel = !allowance || allowance.unlimited
    ? null
    : `${allowance.remaining} / ${allowance.allowance} 次发言`;

  return (
    <aside className="chat-panel" aria-label="直播间聊天">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">LIVE CHAT</span>
          <h2>聊天室</h2>
        </div>
        <span className="alive-count">{quotaLabel ?? `${waiting} 条待拍`}</span>
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
          ? <p className="chat-empty">还没有人说话。写一条，导演会把它拍成下一段画面。<br />用 <b>@角色名</b> 点名，被点到的人就会一起出现。</p>
          : messages.map((message) => (
            <div className={message.filmed ? "chat-line is-filmed" : "chat-line"} key={message.id}>
              <span className="chat-who">{message.display_name}</span>
              <p>{renderBody(message.body, byName)}</p>
              {message.filmed ? (
                message.generation_id != null
                  ? <button type="button" className="chat-jump" onClick={() => onShowClip(message.generation_id!)}>看这一段 <span>→</span></button>
                  : <em>已拍成画面</em>
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
          <input
            ref={inputRef}
            value={draft}
            maxLength={CHAT_MAX}
            placeholder={isAuthenticated ? "说点什么，或 @角色名 点名" : "登录后即可发言"}
            onChange={(event) => {
              setDraft(event.target.value);
              trackTrigger(event.target.value, event.target.selectionStart ?? event.target.value.length);
            }}
            onKeyUp={(event) => trackTrigger(event.currentTarget.value, event.currentTarget.selectionStart ?? 0)}
            onBlur={() => closePicker()}
            onFocus={() => { if (!isAuthenticated) onRequireLogin(); }}
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
            {busy ? "…" : "发送"}
          </button>
        </div>
        {notice ? <p className="chat-notice">{notice}</p> : null}
        {spent && !unlock ? <p className="chat-notice">发言机会已经全部用完了，谢谢你把故事推到这里。</p> : null}
      </div>

      {unlock ? createPortal((
        // Portalled to the body: the panel clips its overflow, and the card is wider than the panel.
        <div className="chat-unlock" role="dialog" aria-label={unlock.title}>
          <div className="chat-unlock-card">
            <span className="eyebrow">再来 {unlock.grant} 次</span>
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
              {unlocking ? "解锁中…" : unlock.cta} <span>↗</span>
            </a>
            <button type="button" className="chat-unlock-close" onClick={() => setUnlock(null)}>以后再说</button>
          </div>
        </div>
      ), document.body) : null}
    </aside>
  );
}
