import { useCallback, useEffect, useState } from "react";
import { LoginDialog } from "@/components/LoginDialog";
import { useAuth } from "@/hooks/useAuth";
import { client } from "@/lib/edgespark";

interface Tier {
  key: string;
  label: string;
  detail: string;
  concurrent: number;
  gapSeconds: number;
}

interface QueueLine {
  id: number;
  display_name: string;
  body: string;
  mentions: string[];
  generation_id: number | null;
  stage: string | null;
  created_at: string;
  consumed_at: string | null;
}

interface SelfDriven {
  id: number;
  stage: string;
  channel: string;
  cast: string[];
}

interface SeedTier {
  key: string;
  label: string;
  detail: string;
  floor: number;
  gapSeconds: number;
}

interface TierState {
  current: string;
  tiers: Tier[];
  chatSeed: { current: string; tiers: SeedTier[] };
  realViewers: number;
  audience: { synthetic: number; windowSeconds: number };
  board: {
    visitors: number; visitorsToday: number;
    spoke: number; spokeToday: number; messages: number;
    followedX: number; followedJp: number; registered: number;
  };
  story: {
    chapter: number; phase: string; setting: string; goal: string;
    clock: string; directive: string; tension: number;
    beat: number; target: number; pushes: number; pushTrigger: number;
    advancedAt: string | null;
  };
  running: number;
  houseUsed: number;
  houseLimit: number;
  queue: {
    waiting: QueueLine[];
    filming: QueueLine[];
    aired: QueueLine[];
    selfDriven: SelfDriven[];
  };
}

const STAGE_LABEL: Record<string, string> = {
  queued: "Queued",
  keyframe: "Writing the shot",
  video: "Rendering",
  completed: "Aired",
};

function pace(tier: Tier) {
  if (tier.gapSeconds >= 3600) return `one every ${Math.round(tier.gapSeconds / 3600)}h`;
  if (tier.gapSeconds >= 60) return `one every ${Math.round(tier.gapSeconds / 60)} min`;
  return `one every ${tier.gapSeconds}s`;
}

export function AdminChange() {
  const { user, isAuthenticated, signOut } = useAuth();
  const [state, setState] = useState<TierState | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState("");
  const [loginOpen, setLoginOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await client.api.fetch("/api/admin/generation-tier");
      const result = await response.json();
      // The framework answers an anonymous caller with its own code; that is not a message.
      if (response.status === 401 || result.error === "UNAUTHENTICATED") {
        throw new Error("Sign in with the host account first");
      }
      if (!response.ok) throw new Error(result.error || "Could not read the generation tier");
      setState(result);
      setError("");
    } catch (cause) {
      setState(null);
      setError(cause instanceof Error ? cause.message : "Could not read the generation tier");
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 6000);
    return () => window.clearInterval(timer);
  }, [load, isAuthenticated]);

  async function pickSeed(key: string) {
    if (busy || state?.chatSeed?.current === key) return;
    setBusy(key);
    setNote("");
    try {
      const response = await client.api.fetch("/api/admin/chat-seed-tier", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tier: key }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not switch");
      setNote(result.message ?? "Switched");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not switch");
    } finally {
      setBusy("");
    }
  }

  async function pick(key: string) {
    if (busy || state?.current === key) return;
    setBusy(key);
    setNote("");
    try {
      const response = await client.api.fetch("/api/admin/generation-tier", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tier: key }),
      });
      const result = await response.json();
      if (response.status === 401 || result.error === "UNAUTHENTICATED") {
        throw new Error("Session expired — sign in again");
      }
      if (!response.ok) throw new Error(result.error || "Could not switch");
      setNote(result.message ?? "Switched");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not switch");
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="admin-shell">
      <header className="admin-head">
        <div>
          <span className="eyebrow">RENOISE LIVE / ADMIN</span>
          <h1>Generation tier</h1>
          <p>Rendering is nearly the whole cost of this project. Drop the tier when nobody is watching — the broadcast keeps running, it just films more slowly.</p>
        </div>
        {isAuthenticated
          ? <button className="admin-signout" onClick={() => void signOut()}>{user?.email} · Sign out</button>
          : <button className="admin-signin" onClick={() => setLoginOpen(true)}>Sign in</button>}
      </header>

      {error ? (
        <div className="admin-error">
          <strong>{error}</strong>
          {!isAuthenticated ? <button onClick={() => setLoginOpen(true)}>Sign in as host</button> : null}
        </div>
      ) : null}

      {state ? (
        <>
          <div className="admin-stats">
            <div><span>CURRENT TIER</span><strong>{state.tiers.find((item) => item.key === state.current)?.label ?? state.current}</strong></div>
            <div><span>RENDERING</span><strong>{state.running} clips</strong></div>
            <div><span>CAST LINE TOTAL</span><strong>{state.houseUsed} / {state.houseLimit}</strong></div>
            {state.audience ? (
              <div>
                <span>REAL VIEWERS</span>
                <strong>{state.realViewers}</strong>
                <small>{state.realViewers + state.audience.synthetic} on air · seen in the last {state.audience.windowSeconds}s</small>
              </div>
            ) : null}
          </div>

          <div className="admin-tiers">
            {state.tiers.map((tier) => (
              <button
                type="button"
                key={tier.key}
                className={tier.key === state.current ? "admin-tier is-current" : "admin-tier"}
                disabled={Boolean(busy)}
                onClick={() => void pick(tier.key)}
              >
                <span className="admin-tier-top">
                  <strong>{tier.label}</strong>
                  {tier.key === state.current ? <em>ACTIVE</em> : null}
                </span>
                <p>{tier.detail}</p>
                <span className="admin-tier-meta">{tier.concurrent} at once · {pace(tier)}</span>
              </button>
            ))}
          </div>

          {state.story ? (
            <section className="admin-story">
              <h2>Story</h2>
              <div className="admin-story-head">
                <span>CHAPTER {state.story.chapter}</span>
                <strong>{state.story.phase}</strong>
                <em>{state.story.clock}</em>
              </div>
              <dl className="admin-story-facts">
                <div><dt>Where</dt><dd>{state.story.setting}</dd></div>
                <div><dt>Objective</dt><dd>{state.story.goal}</dd></div>
                <div><dt>Cast is acting on</dt><dd>{state.story.directive}</dd></div>
              </dl>
              <div className="admin-story-meters">
                {/* The beat counter is what actually decides when the story turns, so show it as the
                    race it is. Viewer messages pull the target down; a stalled bar is a stalled show. */}
                {/* The room is the primary trigger now; the clip count only carries a quiet show. */}
                <div>
                  <span>VIEWERS STEERING<b>{state.story.pushes} / {state.story.pushTrigger} lines</b></span>
                  <i><u style={{ width: `${Math.min(100, Math.round(state.story.pushes / Math.max(1, state.story.pushTrigger) * 100))}%` }} /></i>
                </div>
                <div>
                  <span>NEXT TURN<b>{state.story.beat} / {state.story.target} clips</b></span>
                  <i><u style={{ width: `${Math.min(100, Math.round(state.story.beat / Math.max(1, state.story.target) * 100))}%` }} /></i>
                </div>
                <div>
                  <span>TENSION<b>{state.story.tension} / 100</b></span>
                  <i><u className="is-hot" style={{ width: `${state.story.tension}%` }} /></i>
                </div>
              </div>
            </section>
          ) : null}

          {state.board ? (
            <section className="admin-board">
              <h2>Audience</h2>
              <div className="admin-board-grid">
                <div>
                  <span>VISITED</span>
                  <strong>{state.board.visitors.toLocaleString()}</strong>
                  <small>{state.board.visitorsToday} today · unique browsers</small>
                </div>
                <div>
                  <span>SPOKE</span>
                  <strong>{state.board.spoke.toLocaleString()}</strong>
                  <small>
                    {state.board.spokeToday} today · {state.board.messages} messages
                    {state.board.visitors ? ` · ${Math.round(state.board.spoke / state.board.visitors * 100)}% of visitors` : ""}
                  </small>
                </div>
                {/* A rung is only granted when the viewer opens that link, so the tier is the click. */}
                <div>
                  <span>FOLLOWED ON X</span>
                  <strong>{state.board.followedX.toLocaleString()}</strong>
                  <small>opened @renoiseai</small>
                </div>
                <div>
                  <span>FOLLOWED JP</span>
                  <strong>{state.board.followedJp.toLocaleString()}</strong>
                  <small>opened @renoiseaijp</small>
                </div>
                <div>
                  <span>WENT TO RENOISE</span>
                  <strong>{state.board.registered.toLocaleString()}</strong>
                  <small>opened renoise.ai</small>
                </div>
              </div>
            </section>
          ) : null}

          {state.chatSeed ? (
            <>
              <h2 className="admin-section-title">Seeded chat</h2>
              <div className="admin-tiers">
                {state.chatSeed.tiers.map((tier) => (
                  <button
                    type="button"
                    key={tier.key}
                    className={tier.key === state.chatSeed.current ? "admin-tier is-current" : "admin-tier"}
                    disabled={Boolean(busy)}
                    onClick={() => void pickSeed(tier.key)}
                  >
                    <span className="admin-tier-top">
                      <strong>{tier.label}</strong>
                      {tier.key === state.chatSeed.current ? <em>ACTIVE</em> : null}
                    </span>
                    <p>{tier.detail}</p>
                    <span className="admin-tier-meta">
                      {tier.floor > 0 ? `queue floor ${tier.floor} · one every ${tier.gapSeconds}s` : "no seeded lines"}
                    </span>
                  </button>
                ))}
              </div>
            </>
          ) : null}

          <section className="admin-queue">
            <h2>Chat queue</h2>

            <div className="admin-queue-group">
              <span className="admin-queue-head">WAITING <b>{state.queue.waiting.length}</b></span>
              {state.queue.waiting.length === 0
                ? <p className="admin-queue-empty">Queue is empty — the director keeps the story moving on its own.</p>
                : state.queue.waiting.map((line) => (
                  <div className="admin-queue-line" key={line.id}>
                    <span>{line.display_name}</span>
                    <p>{line.body}</p>
                    {line.mentions.length ? <em>cast {line.mentions.join(", ")}</em> : null}
                  </div>
                ))}
            </div>

            {state.queue.filming.length ? (
              <div className="admin-queue-group">
                <span className="admin-queue-head">FILMING <b>{state.queue.filming.length}</b></span>
                {state.queue.filming.map((line) => (
                  <div className="admin-queue-line is-filming" key={line.id}>
                    <span>{line.display_name}</span>
                    <p>{line.body}</p>
                    <em>{STAGE_LABEL[line.stage ?? ""] ?? line.stage} · clip #{line.generation_id}</em>
                  </div>
                ))}
              </div>
            ) : null}

            {state.queue.selfDriven.length ? (
              <div className="admin-queue-group">
                <span className="admin-queue-head">SELF-DRIVEN <b>{state.queue.selfDriven.length}</b></span>
                {state.queue.selfDriven.map((item) => (
                  <div className="admin-queue-line is-auto" key={item.id}>
                    <p>{item.channel === "director" ? "Director cut" : `${item.cast.join(", ")} POV`}</p>
                    <em>{STAGE_LABEL[item.stage] ?? item.stage} · clip #{item.id}</em>
                  </div>
                ))}
              </div>
            ) : null}

            {state.queue.aired.length ? (
              <div className="admin-queue-group">
                <span className="admin-queue-head">RECENTLY AIRED</span>
                {state.queue.aired.map((line) => (
                  <div className="admin-queue-line is-aired" key={line.id}>
                    <span>{line.display_name}</span>
                    <p>{line.body}</p>
                    <em>clip #{line.generation_id}</em>
                  </div>
                ))}
              </div>
            ) : null}
          </section>

          <ClipArchive />

          {note ? <p className="admin-note">{note}</p> : null}
          {state.houseUsed >= state.houseLimit ? (
            <p className="admin-warn">The cast line has hit its cumulative cap, so no tier will produce anything further. Raising HOUSE_CAST_MAX_CLIPS on the server is what restarts it.</p>
          ) : null}
        </>
      ) : null}

      <LoginDialog open={loginOpen} onClose={() => { setLoginOpen(false); void load(); }} />
    </div>
  );
}


interface AdminClip {
  id: number;
  channel: string;
  stage: string;
  created_by: string;
  created_at: string;
  summary: string | null;
  error_message: string | null;
  cast: string[];
  instruction: string | null;
  asked_by: string | null;
  opening_frame: string | null;
  prompt: string | null;
  thumbnail_url: string | null;
  result_url: string | null;
  favourite: boolean;
}

const CLIP_SOURCES = [
  { key: "", label: "All" },
  { key: "chat", label: "Asked for" },
  { key: "auto", label: "Show's own" },
  { key: "director", label: "Director" },
  { key: "starred", label: "★ Kept" },
];

/**
 * A contact sheet, not a list. Finding something worth keeping in thousands of ten-second clips is
 * scanning, and scanning needs pictures at a size the eye can judge — a 42px thumbnail beside a
 * paragraph is a reading layout, and reading four thousand rows is not a thing anyone will do.
 * Hovering plays the clip muted, which is the whole trick: it turns "open it to find out" into
 * "sweep the mouse across the page".
 */
function ClipArchive() {
  const [clips, setClips] = useState<AdminClip[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);
  const [source, setSource] = useState("");
  const [open, setOpen] = useState<AdminClip | null>(null);
  const [hover, setHover] = useState<number | null>(null);

  async function loadPage(from: number | null, forSource: string, replace = false) {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: "24" });
      if (from != null) params.set("before", String(from));
      if (forSource) params.set("source", forSource);
      const response = await fetch(`/api/admin/clips?${params.toString()}`);
      if (!response.ok) throw new Error("clip page failed");
      const data = await response.json() as { clips: AdminClip[]; next_cursor: number | null };
      setClips((current) => {
        const base = replace ? [] : current;
        const held = new Set(base.map((item) => item.id));
        return [...base, ...data.clips.filter((item) => !held.has(item.id))];
      });
      setCursor(data.next_cursor);
      setDone(data.next_cursor == null);
    } catch {
      setDone(true);
    } finally {
      setLoading(false);
    }
  }

  // Refetches from the top whenever the filter changes; the cursor belongs to the old filter.
  async function toggleFavourite(clip: AdminClip) {
    const next = !clip.favourite;
    // Flipped first so the grid answers the click immediately; put back if the write fails.
    setClips((current) => current.map((item) => (item.id === clip.id ? { ...item, favourite: next } : item)));
    try {
      const response = await fetch(`/api/admin/clips/${clip.id}/favourite`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ favourite: next }),
      });
      if (!response.ok) throw new Error("favourite failed");
    } catch {
      setClips((current) => current.map((item) => (item.id === clip.id ? { ...item, favourite: clip.favourite } : item)));
    }
  }

  useEffect(() => {
    setClips([]);
    setCursor(null);
    setDone(false);
    void loadPage(null, source, true);
  }, [source]);

  return (
    <section className="admin-board">
      <div className="admin-clips-top">
        <h2>Every clip</h2>
        <div className="admin-filters">
          {CLIP_SOURCES.map((item) => (
            <button
              type="button"
              key={item.key || "all"}
              className={item.key === source ? "is-on" : ""}
              onClick={() => setSource(item.key)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      <div className="admin-grid">
        {clips.map((clip) => (
          // Wrapped, because the cell is a button and the star cannot live inside another button.
          <div
            className="admin-cell-slot"
            key={clip.id}
            onMouseEnter={() => setHover(clip.id)}
            onMouseLeave={() => setHover((at) => (at === clip.id ? null : at))}
          >
          <button
            type="button"
            className="admin-cell"
            onClick={() => setOpen(clip)}
            title={clip.instruction ?? clip.summary ?? undefined}
          >
            {/* preload="none" so a page of twenty-four downloads nothing until a mouse arrives. */}
            {hover === clip.id && clip.result_url
              ? <video src={clip.result_url} autoPlay muted loop playsInline preload="none" />
              : clip.thumbnail_url
              ? <img src={clip.thumbnail_url} alt="" loading="lazy" />
              : <i />}
            <span className="admin-cell-tag">
              {clip.created_by === "house:chat" ? "ASKED" : clip.channel === "director" ? "CUT" : "AUTO"}
            </span>
            <span className="admin-cell-foot">#{clip.id} · {clip.cast.join(", ")}</span>
          </button>
          {/* Marked without leaving the grid: picking things out is a sweep, and a dialog per clip
              would turn a hundred judgements into a hundred round trips. */}
          <button
            type="button"
            className={clip.favourite ? "admin-star is-on" : "admin-star"}
            aria-label={clip.favourite ? "Remove from kept" : "Keep this clip"}
            onClick={() => void toggleFavourite(clip)}
          >
            {clip.favourite ? "★" : "☆"}
          </button>
          </div>
        ))}
      </div>

      {!done ? (
        <button type="button" className="admin-more" disabled={loading} onClick={() => void loadPage(cursor, source)}>
          {loading ? "Loading…" : "Load 24 more"}
        </button>
      ) : <p className="admin-clips-end">{clips.length ? "That is every clip." : "Nothing matches that filter."}</p>}

      {open ? (
        <div className="prompt-backdrop" onClick={() => setOpen(null)} role="presentation">
          <div className="prompt-dialog admin-review" onClick={(event) => event.stopPropagation()} role="dialog" aria-label="Clip review">
            <div className="prompt-head">
              <span className="eyebrow">#{open.id} · {open.channel} · {open.created_by}</span>
              <button type="button" className="prompt-close" onClick={() => setOpen(null)} aria-label="Close">✕</button>
            </div>
            {open.result_url ? <video className="admin-review-video" src={open.result_url} controls autoPlay playsInline /> : null}
            <div className="prompt-block is-lead">
              <span className="eyebrow">
                {open.asked_by ? `ASKED FOR BY ${open.asked_by.toUpperCase()}` : "THE SHOW'S OWN CUE"}
              </span>
              <p>{open.instruction ?? open.summary ?? "(director cut)"}</p>
            </div>
            {open.summary && open.instruction ? (
              <div className="prompt-block"><span className="eyebrow">WHAT HAPPENED</span><p>{open.summary}</p></div>
            ) : null}
            <div className="prompt-block">
              <span className="eyebrow">SENT TO THE MODEL</span>
              <pre>{open.prompt ?? "This clip predates prompt capture."}</pre>
            </div>
            <p className="prompt-foot">{open.cast.join(", ")} · {open.created_at}</p>
          </div>
        </div>
      ) : null}
    </section>
  );
}
