import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActionBar } from "@/components/ActionBar";
import { Broadcast, type ChannelTab } from "@/components/Broadcast";
import { DirectorDialog } from "@/components/DirectorDialog";
import { JoinDialog } from "@/components/JoinDialog";
import { ChatRoom } from "@/components/ChatRoom";
import { LoginDialog } from "@/components/LoginDialog";
import { ViewerCount } from "@/components/ViewerCount";
import { useAuth } from "@/hooks/useAuth";
import { useTailFrameHarvester, type TailFrameTarget } from "@/hooks/useTailFrameHarvester";
import { deviceHeaders } from "@/lib/device";
import { client } from "@/lib/edgespark";
import type { BroadcastClip, LinkOffer, LiveData, PlayerControl } from "@/types/live";

const DIRECTOR_CHANNEL = "director";

// Matches the server's page size. Ten thumbnails is a page that lands quickly on a phone.
const ARCHIVE_PAGE = 10;

// Same source and medium the unlock links already use, so Renoise sees one campaign; utm_content is
// what separates this header button from those.
const RENOISE_URL = "https://renoise.ai/?utm_medium=renoiselive&utm_source=tomato-renoise-live&utm_content=join-button";
// Mirrors CHARACTER_CREATION_OPEN on the server; the endpoint refuses regardless, this just keeps
// viewers out of a flow that would fail at the end.
const CHARACTER_CREATION_OPEN = false;
const CHARACTER_CREATION_CLOSED_NOTICE = "Character creation opens soon — hang tight.";

function channelKeyFor(clip: BroadcastClip) {
  return clip.channel === "director" ? DIRECTOR_CHANNEL : `p:${clip.channel_participant_id}`;
}

const CONTROLS_KEY = "tomato-live-controls";
const LEGACY_CONTROL_KEY = "tomato-live-control";

// The heartbeat cadence when the feed is healthy, how far it backs off while the server is
// struggling, and how long a single request may hang before it is cut loose. The old fixed
// setInterval kept firing regardless of whether the last request had returned, so a slow server
// meant an ever-growing pile of pending requests — which is what took the whole tab down.
const LIVE_POLL_MS = 9000;
const LIVE_POLL_MAX_MS = 60000;
const LIVE_TIMEOUT_MS = 12000;
const SYNC_POLL_MS = 2500;
const SYNC_TIMEOUT_MS = 8000;

function isControl(value: unknown): value is PlayerControl {
  const candidate = value as PlayerControl | null;
  return Boolean(candidate && Number.isInteger(candidate.participantId) && typeof candidate.controlToken === "string");
}

// One viewer can hold several characters. This used to be a single record that every join
// overwrote, which silently destroyed the previous character's token.
function readControls(): PlayerControl[] {
  try {
    const stored = localStorage.getItem(CONTROLS_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed)) return parsed.filter(isControl);
    }
    const legacy = localStorage.getItem(LEGACY_CONTROL_KEY);
    if (legacy) {
      const parsed = JSON.parse(legacy);
      if (isControl(parsed)) {
        localStorage.setItem(CONTROLS_KEY, JSON.stringify([parsed]));
        return [parsed];
      }
    }
  } catch {
    // Private browsing or corrupt payload: fall through to spectator mode.
  }
  return [];
}

function writeControls(list: PlayerControl[]) {
  try {
    localStorage.setItem(CONTROLS_KEY, JSON.stringify(list));
  } catch {
    // Nothing to do; the session just will not survive a reload.
  }
}

function BrandMark({ className }: { className: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" role="img" aria-label="Renoise Live">
      <rect width="24" height="24" rx="5.625" fill="#2B2B2B" />
      <path d="M7.90091 4.98244C8.01653 4.96096 8.44335 4.96764 8.56497 4.98341C10.3141 5.21201 12.1809 6.44425 13.4771 7.58986C14.5835 8.56775 17.8404 11.8392 17.8404 13.1797C17.8397 14.5204 14.2176 18.0506 13.271 18.6309C12.8931 18.8242 12.4822 18.9462 12.0601 18.9912C11.1559 19.0903 10.2493 18.8268 9.53958 18.2578C8.3317 17.2807 7.80664 15.4835 8.54447 14.0537C9.05128 13.0718 9.02771 13.2368 8.2681 12.6885C7.04681 11.8069 5.58851 7.25461 6.42435 5.95412C6.84193 5.30459 7.18051 5.15526 7.90091 4.98244ZM13.1822 9.47365C13.1059 9.47374 13.0401 9.49887 12.9849 9.54884C12.9323 9.59886 12.8982 9.66457 12.8824 9.74611C12.8165 10.2467 12.7436 10.667 12.6646 11.0068C12.5855 11.3467 12.4799 11.626 12.3482 11.8447C12.2164 12.0635 12.0428 12.2381 11.8267 12.3672C11.6133 12.4963 11.339 12.5972 11.0044 12.6709C10.6725 12.7447 10.2644 12.8087 9.77982 12.8613C9.69549 12.8692 9.62646 12.902 9.57376 12.96C9.52118 13.0152 9.49471 13.0822 9.49466 13.1611C9.49466 13.2376 9.52106 13.3053 9.57376 13.3633C9.62635 13.4184 9.69352 13.4501 9.77493 13.458C10.1807 13.5134 10.5316 13.5725 10.8267 13.6358C11.1244 13.6964 11.3773 13.773 11.5855 13.8652C11.7937 13.9548 11.9683 14.0693 12.1079 14.209C12.2501 14.3486 12.3673 14.5238 12.4595 14.7344C12.5543 14.9451 12.6336 15.2007 12.6968 15.501C12.7627 15.8013 12.8244 16.1599 12.8824 16.5762C12.8982 16.6579 12.9335 16.7244 12.9888 16.7744C13.044 16.8243 13.1086 16.8495 13.1822 16.8496C13.2586 16.8496 13.3251 16.8245 13.3804 16.7744C13.4357 16.7244 13.4698 16.6566 13.4829 16.5723C13.5462 16.0743 13.6178 15.6553 13.6968 15.3154C13.7785 14.9757 13.8845 14.6962 14.0161 14.4776C14.1479 14.2588 14.3225 14.0852 14.5386 13.9561C14.7547 13.8243 15.0289 13.7225 15.3609 13.6514C15.6927 13.5777 16.101 13.5133 16.5855 13.458C16.6671 13.4501 16.7349 13.4186 16.7876 13.3633C16.843 13.3053 16.8706 13.2376 16.8706 13.1611C16.8706 13.0823 16.8441 13.0152 16.7915 12.96C16.7388 12.902 16.6698 12.8692 16.5855 12.8613C16.1035 12.806 15.6954 12.7407 15.3609 12.667C15.029 12.5933 14.7546 12.4923 14.5386 12.3633C14.3252 12.2342 14.1528 12.0595 14.021 11.8408C13.8893 11.6221 13.7824 11.3429 13.7007 11.0029C13.6217 10.663 13.5488 10.2441 13.4829 9.74611C13.4698 9.66459 13.4356 9.59886 13.3804 9.54884C13.3251 9.49877 13.2586 9.47365 13.1822 9.47365Z" fill="white" />
    </svg>
  );
}

function LoadingScreen() {
  return (
    <main className="loading-screen">
      <div className="loading-mark"><BrandMark className="brand-mark" /><span>Renoise Live</span></div>
      <p>Acquiring the north shore feed</p>
      <div className="loading-line"><i /></div>
    </main>
  );
}

function App() {
  const [live, setLive] = useState<LiveData | null>(null);
  const [error, setError] = useState("");
  const [joinOpen, setJoinOpen] = useState(false);
  const [toast, setToast] = useState("");
  const [jumpRequest, setJumpRequest] = useState<number | null>(null);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [directorOpen, setDirectorOpen] = useState(false);
  const [controls, setControls] = useState<PlayerControl[]>(() => readControls());
  const [loginOpen, setLoginOpen] = useState(false);
  const [accountCharacterIds, setAccountCharacterIds] = useState<number[]>([]);
  const [isHost, setIsHost] = useState(false);
  const [activeChannel, setActiveChannel] = useState(DIRECTOR_CHANNEL);
  const { user, isAuthenticated, signOut } = useAuth();

  // Single-flight: while a live request is on the wire, every caller — the poll, a chat send, a
  // tail-frame landing — shares that request instead of stacking a new one behind it.
  const liveInFlightRef = useRef<Promise<boolean> | null>(null);
  // The version of the payload this tab already holds. Sent back as If-None-Match so an unchanged
  // feed costs a 304 — no body, no JSON parse, no re-render.
  const liveEtagRef = useRef<string | null>(null);

  const refresh = useCallback((quiet = false): Promise<boolean> => {
    const inFlight = liveInFlightRef.current;
    if (inFlight) return inFlight;
    const run = (async () => {
      const controller = new AbortController();
      const kill = window.setTimeout(() => controller.abort(), LIVE_TIMEOUT_MS);
      try {
        // The allowance on the payload is this browser's, so the id has to ride along.
        const headers: Record<string, string> = { ...deviceHeaders };
        if (liveEtagRef.current) headers["If-None-Match"] = liveEtagRef.current;
        const response = await client.api.fetch("/api/public/live", { headers, signal: controller.signal });
        // Nothing changed since the copy on screen — keep it, and skip the parse and render.
        if (response.status === 304) {
          setError("");
          return true;
        }
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "The live feed is unavailable");
        liveEtagRef.current = response.headers.get("etag");
        setLive(result);
        setError("");
        return true;
      } catch (cause) {
        if (!quiet) {
          setError(cause instanceof Error && cause.name !== "AbortError" ? cause.message : "The live feed is unavailable");
        }
        return false;
      } finally {
        window.clearTimeout(kill);
        liveInFlightRef.current = null;
      }
    })();
    liveInFlightRef.current = run;
    return run;
  }, []);

  useEffect(() => {
    let disposed = false;
    let timer: number | null = null;
    let backoff = LIVE_POLL_MS;
    const schedule = (delay: number) => {
      if (disposed) return;
      // Jitter, so a whole audience recovering from the same outage does not retry in lockstep.
      timer = window.setTimeout(() => void tick(), delay + Math.random() * 800);
    };
    async function tick() {
      if (disposed) return;
      // Park while hidden: no requests from background tabs. visibilitychange resumes the chain.
      if (document.visibilityState === "hidden") return;
      const ok = await refresh(true);
      backoff = ok ? LIVE_POLL_MS : Math.min(backoff * 2, LIVE_POLL_MAX_MS);
      schedule(backoff);
    }
    const onVisibility = () => {
      if (document.visibilityState !== "visible" || disposed) return;
      if (timer != null) window.clearTimeout(timer);
      void tick();
    };
    // The first load fetches loudly (errors show), then the quiet self-scheduling chain takes over:
    // the next request is only planned once the previous one has finished.
    void refresh().finally(() => schedule(backoff));
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      disposed = true;
      if (timer != null) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refresh]);

  // Characters owned by the signed-in account need no browser token at all; the legacy localStorage
  // records stay valid for characters created before accounts were required.
  const ownedIds = useMemo(() => {
    const ids = new Set<number>(accountCharacterIds);
    for (const item of controls) ids.add(item.participantId);
    return [...ids];
  }, [accountCharacterIds, controls]);

  // The channel you are watching is the character you are directing — keeping "viewed" and
  // "controlled" as separate states meant opening your other character's channel left the composer
  // pointed at the first one, so the bar fell back to the timeline.
  const viewedId = activeChannel.startsWith("p:") ? Number(activeChannel.slice(2)) : null;
  const activeId = viewedId != null && ownedIds.includes(viewedId) ? viewedId : null;
  const control: PlayerControl | null = activeId == null
    ? null
    : controls.find((item) => item.participantId === activeId) ?? { participantId: activeId, controlToken: "" };

  // A browser drives only the channels it owns — the director line if it is the host, the
  // contestants it holds a token for. Every viewer polling every pending clip meant one upstream
  // call per viewer per clip every 2.5 seconds, and only the first of them could ever do anything;
  // the rest just read the row back. Everyone else takes pending state off the live payload, and
  // the server's own backstop advances a generation nobody is left to drive. ActionBar and
  // DirectorDialog read state from `live` instead of running polls of their own.
  const pendingIds = (live?.pending_generations ?? [])
    .filter((item) => (
      (item.channel === "director" && isHost)
      || (item.channel_participant_id != null && ownedIds.includes(item.channel_participant_id))
    ))
    .map((item) => item.id)
    .join(",");

  useEffect(() => {
    if (!pendingIds) return;
    const ids = pendingIds.split(",").map(Number);
    let active = true;
    let timer: number | null = null;
    const schedule = () => {
      if (!active) return;
      timer = window.setTimeout(() => void sync(), SYNC_POLL_MS);
    };
    // Self-scheduling: the next round is only planned after this one has fully returned, so a slow
    // server stretches the cadence instead of stacking overlapping rounds.
    const sync = async () => {
      if (!active) return;
      // A hidden tab does not need to drive the pipeline; keep the timer alive cheaply instead.
      if (document.visibilityState === "hidden") {
        schedule();
        return;
      }
      let completed = false;
      for (const id of ids) {
        if (!active) return;
        const controller = new AbortController();
        const kill = window.setTimeout(() => controller.abort(), SYNC_TIMEOUT_MS);
        try {
          const response = await client.api.fetch(`/api/public/generations/${id}/sync`, { method: "POST", signal: controller.signal });
          const result = await response.json();
          if (response.ok && result.generation?.stage === "completed") completed = true;
        } catch {
          // Keep the live page calm; ActionBar shows submission errors for the user who clicked.
        } finally {
          window.clearTimeout(kill);
        }
      }
      if (active && completed) void refresh(true);
      schedule();
    };
    void sync();
    return () => { active = false; if (timer != null) window.clearTimeout(timer); };
  }, [pendingIds, refresh]);

  const tailFrameKey = (live?.tail_frame_wanted ?? []).join(",");
  const clipsForTailFrames = live?.clips;
  const tailFrameWanted = useMemo<TailFrameTarget[]>(
    () => (tailFrameKey ? tailFrameKey.split(",").map(Number) : []).map((id) => ({
      id,
      // The clip's own address (public bucket when available); the proxy covers a clip the list lacks.
      src: clipsForTailFrames?.find((clip) => clip.id === id)?.result_url ?? `/api/public/clips/${id}/video`,
    })),
    // Keyed on the id list on purpose: the clip addresses are stable, and re-running on every
    // heartbeat would restart captures that are already in flight.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tailFrameKey],
  );
  const onTailFrameCaptured = useCallback(() => void refresh(true), [refresh]);
  useTailFrameHarvester(tailFrameWanted, onTailFrameCaptured);

  const channels = useMemo<ChannelTab[]>(() => {
    if (!live) return [];
    const pending = live.pending_generations ?? [];
    const directorCount = live.clips.filter((clip) => clip.channel === "director").length;
    const tabs: ChannelTab[] = [{
      key: DIRECTOR_CHANNEL,
      label: "Director",
      detail: directorCount ? `${directorCount} cuts` : "Waiting on footage",
      pending: pending.some((item) => item.channel === "director"),
      pendingStage: pending.find((item) => item.channel === "director")?.stage,
      avatarUrl: "/director.png",
      isMark: true,
    }];
    for (const participant of live.participants) {
      const count = live.clips.filter((clip) => clip.channel_participant_id === participant.id).length;
      tabs.push({
        key: `p:${participant.id}`,
        label: participant.display_name,
        detail: count ? `${count} clips` : "No footage yet",
        pending: pending.some((item) => item.channel_participant_id === participant.id),
        pendingStage: pending.find((item) => item.channel_participant_id === participant.id)?.stage,
        avatarUrl: participant.portrait_url ?? participant.avatar_url,
      });
    }
    return tabs;
  }, [live]);

  // Clips made by someone else that wrote me in, still carrying an unused tail frame. That frame holds
  // both contestants in one real composition — the only way two people share a scene on H3-Max.
  const linkOffers = useMemo<LinkOffer[]>(() => {
    const mine = control?.participantId;
    if (!live || mine == null) return [];
    const consumed = new Set(live.clips
      .filter((clip) => clip.channel_participant_id === mine && clip.source_generation_id != null)
      .map((clip) => clip.source_generation_id!));
    const newestByAuthor = new Map<number, BroadcastClip>();
    // live.clips arrives newest-first, so the first hit per author is the one that supersedes the rest.
    for (const clip of live.clips) {
      const author = clip.channel_participant_id;
      if (clip.channel !== "participant" || author == null || author === mine) continue;
      if (!clip.participant_ids.includes(mine) || !clip.has_tail_frame || consumed.has(clip.id)) continue;
      if (!newestByAuthor.has(author)) newestByAuthor.set(author, clip);
    }
    return [...newestByAuthor.entries()].map(([author, clip]) => ({
      id: clip.id,
      fromName: live.participants.find((item) => item.id === author)?.display_name ?? "another contestant",
      summary: clip.summary,
    }));
  }, [control?.participantId, live]);


  const channelClips = useMemo(
    () => (live?.clips ?? []).filter((clip) => channelKeyFor(clip) === activeChannel),
    [activeChannel, live?.clips],
  );

  // The live payload carries a recent window only — it is polled every few seconds by everyone, so
  // it cannot also be the archive. Older footage is pulled a page at a time and kept beside it,
  // never merged into `clips`: the player reads that list, and prepending history to it would
  // change what "the latest clip" means mid-playback.
  const [archive, setArchive] = useState<{ clips: BroadcastClip[]; cursor: number | null; done: boolean }>(
    { clips: [], cursor: null, done: false },
  );
  const [archiveLoading, setArchiveLoading] = useState(false);
  // Each channel has its own history, so switching away discards what was loaded for the last one.
  useEffect(() => {
    setArchive({ clips: [], cursor: null, done: false });
    setArchiveLoading(false);
  }, [activeChannel]);

  const loadOlderClips = useCallback(async () => {
    if (archiveLoading || archive.done) return;
    // Continue from the cursor, or from the oldest clip already on screen the first time.
    const onScreenOldest = channelClips.length
      ? Math.min(...channelClips.map((clip) => clip.id))
      : null;
    const before = archive.cursor ?? onScreenOldest;
    setArchiveLoading(true);
    try {
      const params = new URLSearchParams({ channel: activeChannel, limit: String(ARCHIVE_PAGE) });
      if (before != null) params.set("before", String(before));
      const response = await fetch(`/api/public/clips?${params.toString()}`, { headers: deviceHeaders });
      if (!response.ok) throw new Error("archive page failed");
      const data = await response.json() as { clips: BroadcastClip[]; next_cursor: number | null };
      setArchive((current) => {
        // A page can overlap what is already held if the live window moved under us.
        const seen = new Set(current.clips.map((clip) => clip.id));
        const added = data.clips.filter((clip) => !seen.has(clip.id));
        return {
          clips: [...current.clips, ...added],
          cursor: data.next_cursor,
          done: data.next_cursor == null,
        };
      });
    } catch {
      // Leave the cursor alone so the same page can be asked for again.
    } finally {
      setArchiveLoading(false);
    }
  }, [activeChannel, archive.cursor, archive.done, archiveLoading, channelClips]);

  const myParticipant = useMemo(
    () => live?.participants.find((participant) => participant.id === control?.participantId),
    [control?.participantId, live?.participants],
  );

  useEffect(() => {
    if (!isAuthenticated) {
      setAccountCharacterIds([]);
      setIsHost(false);
      return;
    }
    let active = true;
    void (async () => {
      try {
        const response = await client.api.fetch("/api/public/my-characters");
        const result = await response.json();
        if (!active || !response.ok) return;
        setAccountCharacterIds((result.characters ?? []).map((item: { id: number }) => item.id));
        setIsHost(Boolean(result.isHost));
      } catch {
        // Spectator mode still works without this.
      }
    })();
    return () => { active = false; };
  }, [isAuthenticated, live?.participants.length]);

  const myCharacters = useMemo(
    () => ownedIds
      .map((id) => live?.participants.find((participant) => participant.id === id))
      .filter((participant): participant is NonNullable<typeof participant> => Boolean(participant)),
    [ownedIds, live?.participants],
  );

  function addControl(next: PlayerControl) {
    setControls((current) => {
      const merged = [...current.filter((item) => item.participantId !== next.participantId), next];
      writeControls(merged);
      return merged;
    });
    setActiveChannel(`p:${next.participantId}`);
  }

  async function handleSignOut() {
    // Drop the browser tokens for characters this account owns, so signing out actually gives up
    // control instead of falling back to the legacy token path.
    const accountOwned = new Set(accountCharacterIds);
    await signOut();
    setControls((current) => {
      const kept = current.filter((item) => !accountOwned.has(item.participantId));
      writeControls(kept);
      return kept;
    });
    setActiveChannel(DIRECTOR_CHANNEL);
  }

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 3600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  // Tell the person who asked for a shot when it could not be filmed. Only theirs, only once: the
  // heartbeat repeats the same list every few seconds, so a told line is remembered on the device
  // rather than announced again — and a toast nobody can dismiss is worse than no toast.
  const toldRef = useRef<Set<number>>(new Set());
  useEffect(() => {
    const abandoned = live?.abandoned_lines ?? [];
    if (!abandoned.length) return;
    const fresh = abandoned.filter((line) => !toldRef.current.has(line.id));
    if (!fresh.length) return;
    for (const line of fresh) toldRef.current.add(line.id);
    setToast(fresh.length > 1
      ? `${fresh.length} of your lines could not be filmed — try wording them differently`
      : `"${fresh[0].body}" could not be filmed — try wording it differently`);
  }, [live?.abandoned_lines]);

  function openJoin() {
    if (!CHARACTER_CREATION_OPEN) {
      setToast(CHARACTER_CREATION_CLOSED_NOTICE);
      return;
    }
    // Creating a character now requires an account, so send anonymous viewers to sign in first.
    if (!isAuthenticated) {
      setLoginOpen(true);
      return;
    }
    setJoinOpen(true);
  }

  function openDirector() {
    setDirectorOpen(true);
  }

  if (!live && !error) return <LoadingScreen />;

  if (!live) {
    return (
      <main className="fatal-screen">
        <span>NO SIGNAL</span>
        <h1>Feed lost</h1>
        <p>{error}</p>
        <button onClick={() => refresh()}>Reconnect</button>
      </main>
    );
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <BrandMark className="brand-mark" />
          <div><strong>Renoise Live</strong><span>AI SURVIVAL BROADCAST</span></div>
        </div>
        <div className="match-title">
          <span>{live.match.title}</span>
          <b>{live.match.subtitle}</b>
        </div>
        <div className="topbar-actions">
          <ViewerCount
            count={live.match.viewers}
            handles={(live.chat ?? []).slice(-24).map((item) => item.display_name).reverse()}
          />
          {/* Manual cuts are a host tool: the director channel advances on its own. */}
          {isHost ? <button className="text-action" onClick={openDirector}>Cut next</button> : null}
          {/* Character creation is closed, so for everyone without a contestant this button was a
              dead end that only said "coming soon". It sends them to Renoise instead, tagged so the
              header placement can be told apart from the unlock links in analytics. */}
          {myParticipant
            ? <button className="join-action" onClick={openJoin}>My contestant<span>↗</span></button>
            : (
              <a
                className="join-action"
                href={RENOISE_URL}
                target="_blank"
                rel="noopener noreferrer"
              >
                Join<span>↗</span>
              </a>
            )}
        </div>
      </header>

      <main className="live-grid">
        <Broadcast
          clips={channelClips}
          participants={live.participants}
          channels={channels}
          activeChannel={activeChannel}
          onSelectChannel={setActiveChannel}
          jumpRequest={jumpRequest}
          onJumpHandled={() => setJumpRequest(null)}
          archiveOpen={archiveOpen}
          olderClips={archive.clips}
          moreOlder={!archive.done}
          loadingOlder={archiveLoading}
          onLoadOlder={loadOlderClips}
        />
        <ChatRoom
          messages={live.chat ?? []}
          waiting={live.chat_waiting ?? 0}
          allowance={live.chat_allowance ?? null}
          participants={live.participants}
          onShowClip={(generationId) => {
            // A chat line's clip lives on whichever channel filmed it, so switch there first.
            const clip = live.clips.find((item) => item.id === generationId);
            if (!clip) {
              setToast("That clip is not in the broadcast queue yet");
              return;
            }
            setActiveChannel(channelKeyFor(clip));
            setJumpRequest(generationId);
            setArchiveOpen(false);
          }}
          onSent={() => void refresh(true)}
          archiveOpen={archiveOpen}
          onToggleArchive={() => setArchiveOpen((open) => !open)}
        />
      </main>

      {myParticipant && control ? (
        <ActionBar
          participant={myParticipant}
          roster={live.participants}
          myCharacters={myCharacters}
          onSwitchCharacter={(id) => setActiveChannel(`p:${id}`)}
          linkOffers={linkOffers}
          control={control}
          choices={live.story_choices}
          pendingGeneration={(live.pending_generations ?? []).find((item) => item.channel_participant_id === myParticipant.id) ?? null}
          onUpdated={() => refresh(true)}
        />
      ) : null}

      <footer>
        <span>© 2026 RENOISE LIVE / POWERED BY EDGESPARK + MINIMAX</span>
        <span className="legal-note">Any resemblance to real persons is purely coincidental.</span>
        <div>
          {isAuthenticated && <button onClick={() => void handleSignOut()}>{user?.email} · Sign out</button>}
          <span>LIVE LATENCY 12.4S</span>
          <span>GENERATION BUFFER 01</span>
        </div>
      </footer>

      <LoginDialog open={loginOpen} onClose={() => setLoginOpen(false)} />
      {toast ? <div className="app-toast" role="status">{toast}</div> : null}

      <JoinDialog open={joinOpen} onClose={() => setJoinOpen(false)} onJoined={(next) => { addControl(next); void refresh(true); }} />
      <DirectorDialog
        open={directorOpen}
        onClose={() => setDirectorOpen(false)}
        participants={live.participants}
        pendingGeneration={(live.pending_generations ?? []).find((item) => item.channel === "director") ?? null}
        onCompleted={() => refresh(true)}
      />
    </div>
  );
}

export default App;
