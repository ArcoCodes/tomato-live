import { useEffect, useMemo, useRef, useState, type RefObject, type SyntheticEvent } from "react";
import type { BroadcastClip, Participant } from "@/types/live";

// Playback tracing: add ?debug to the URL, or set localStorage.broadcastDebug = "1".
const DEBUG = (() => {
  try {
    return new URLSearchParams(window.location.search).has("debug")
      || window.localStorage.getItem("broadcastDebug") === "1";
  } catch {
    return false;
  }
})();

function log(event: string, detail: Record<string, unknown> = {}) {
  if (!DEBUG) return;
  console.info(`[broadcast] ${event}`, { at: Math.round(performance.now()), ...detail });
}

function shortSrc(url: string) {
  if (!url) return "";
  try {
    const parsed = new URL(url, window.location.origin);
    const tail = parsed.pathname.split("/").filter(Boolean).slice(-2).join("/");
    return parsed.search ? `${tail}?${parsed.search.length - 1}b` : tail;
  } catch {
    return url.slice(-48);
  }
}

// SQLite hands back "YYYY-MM-DD HH:MM:SS" in UTC, which Safari refuses to parse as-is. Normalising
// it is what makes the clock read correctly in the viewer's own timezone.
// Matches the page size the app asks for, so the button promises what it delivers.
const ARCHIVE_PAGE_HINT = 10;

function clipClock(createdAt: string) {
  const parsed = new Date(`${createdAt.replace(" ", "T")}${/[Zz]|[+-]\d\d:?\d\d$/.test(createdAt) ? "" : "Z"}`);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

const SOUND_KEY = "tomato-live-sound";

// Sound is on unless the viewer turned it off. Whether it can actually play is a separate question
// the browser answers — see the unlock effect below.
function readSoundPreference() {
  try {
    return window.localStorage.getItem(SOUND_KEY) !== "off";
  } catch {
    return true;
  }
}

export interface ChannelTab {
  key: string;
  label: string;
  detail: string;
  pending: boolean;
  /** Which half of the pipeline it is in: writing the shot, or rendering it. */
  pendingStage?: "queued" | "keyframe" | "video";
  /** The contestant's character sheet, or the director mascot. */
  avatarUrl: string | null;
  /** A transparent mascot rather than a photo, so it needs a backing tint. */
  isMark?: boolean;
}

export function Broadcast({ clips, participants, channels, activeChannel, onSelectChannel, jumpRequest, onJumpHandled, archiveOpen, olderClips = [], moreOlder = false, loadingOlder = false, onLoadOlder }: {
  clips: BroadcastClip[];
  /** Needed to show whose clip each archive card is, by character sheet rather than by name. */
  participants: Participant[];
  channels: ChannelTab[];
  activeChannel: string;
  onSelectChannel: (key: string) => void;
  /** A clip the chat asked to show. Cleared once played so the same request cannot re-fire. */
  jumpRequest?: number | null;
  onJumpHandled?: () => void;
  /** Phone only: the archive is off screen until the viewer asks for it. */
  archiveOpen?: boolean;
  /** Pages of older footage. Kept out of `clips` so the player's idea of "latest" cannot shift. */
  olderClips?: BroadcastClip[];
  moreOlder?: boolean;
  loadingOlder?: boolean;
  onLoadOlder?: () => void;
}) {
  // Loaded history belongs here, not only in the strip below. Kept out of this list, the archive
  // rendered cards the player could not find: a click set the queued id, the lookup came back empty
  // and nothing happened. Ids only climb, so older clips land at the front — the newest is still the
  // newest, and the progression through the live window is untouched.
  const playable = useMemo(
    () => {
      const seen = new Set<number>();
      const all: BroadcastClip[] = [];
      for (const item of [...clips, ...olderClips]) {
        if (!item.result_url || seen.has(item.id)) continue;
        seen.add(item.id);
        all.push(item);
      }
      return all.sort((a, b) => a.id - b.id);
    },
    [clips, olderClips],
  );
  const [currentClipId, setCurrentClipId] = useState<number | null>(null);
  const [queuedClipId, setQueuedClipId] = useState<number | null>(null);
  const [activeSlot, setActiveSlot] = useState<0 | 1>(0);
  const [handoff, setHandoff] = useState(false);
  const [firstFrameShown, setFirstFrameShown] = useState(false);
  const [placeholderGone, setPlaceholderGone] = useState(false);
  // What the viewer wants, remembered across visits.
  const [soundOn, setSoundOn] = useState(readSoundPreference);
  // What the browser actually allows right now. Autoplay policy forbids unmuted autoplay until the
  // page has seen a gesture, so these two can disagree for the first few seconds of a visit.
  const [muted, setMuted] = useState(true);
  const soundUnlockedRef = useRef(false);
  const slotARef = useRef<HTMLVideoElement | null>(null);
  const slotBRef = useRef<HTMLVideoElement | null>(null);
  const handoffStartedRef = useRef(false);
  const pendingHandoffRef = useRef(false);
  const handoffTimerRef = useRef<number | null>(null);
  const standbyReadyKeyRef = useRef("");
  const holdingRef = useRef(false);
  const seenUrlsRef = useRef(new Map<number, string>());
  const archiveRef = useRef<HTMLDivElement | null>(null);
  const [archiveNav, setArchiveNav] = useState({ left: false, right: false });
  const currentIndex = playable.findIndex((item) => item.id === currentClipId);
  const normalizedIndex = currentIndex >= 0 ? currentIndex : 0;
  const clip = playable[normalizedIndex];
  const followingClip = playable[normalizedIndex + 1] ?? null;
  const queuedClip = queuedClipId == null ? null : playable.find((item) => item.id === queuedClipId) ?? null;
  // The standby slot always holds whatever plays next: a viewer's pick wins over the natural next clip.
  const standbyClip = queuedClip ?? followingClip;
  const standbySlot = activeSlot === 0 ? 1 : 0;
  const standbyReadyKey = standbyClip ? `${standbySlot}:${standbyClip.id}` : "";
  const latestClipId = playable[playable.length - 1]?.id ?? null;
  const history = [...playable].reverse();

  // Owner first so their sheet sits on top of the fan; guests peek out behind it.
  function castOf(clip: BroadcastClip) {
    const ids = [clip.channel_participant_id, ...clip.participant_ids]
      .filter((id): id is number => id != null);
    const seen = new Set<number>();
    return ids
      .filter((id) => (seen.has(id) ? false : seen.add(id)))
      .map((id) => participants.find((item) => item.id === id))
      .filter((item): item is Participant => Boolean(item));
  }

  useEffect(() => {
    if (playable.length === 0) {
      setCurrentClipId(null);
      return;
    }
    if (!currentClipId || !playable.some((item) => item.id === currentClipId)) {
      setCurrentClipId(playable[0].id);
    }
  }, [currentClipId, playable]);

  useEffect(() => {
    if (queuedClipId != null && !playable.some((item) => item.id === queuedClipId)) setQueuedClipId(null);
  }, [playable, queuedClipId]);

  useEffect(() => {
    if (!DEBUG) return;
    // A non-empty urlChanged means the server handed back a different address for a clip already on
    // screen, which forces that <video> to reload and restart from zero.
    const urlChanged: number[] = [];
    for (const item of playable) {
      const seen = seenUrlsRef.current.get(item.id);
      if (seen && seen !== item.result_url) urlChanged.push(item.id);
      seenUrlsRef.current.set(item.id, item.result_url ?? "");
    }
    log("clips:update", { count: playable.length, ids: playable.map((item) => item.id), urlChanged });
  }, [playable]);

  useEffect(() => {
    if (!firstFrameShown) return;
    const timer = window.setTimeout(() => setPlaceholderGone(true), 280);
    return () => window.clearTimeout(timer);
  }, [firstFrameShown]);

  useEffect(() => {
    // Switching channels necessarily swaps the visible slot's src, so hand the placeholder back over
    // the load instead of letting the black video background show through.
    setCurrentClipId(null);
    setQueuedClipId(null);
    setFirstFrameShown(false);
    setPlaceholderGone(false);
    holdingRef.current = false;
    pendingHandoffRef.current = false;
    handoffStartedRef.current = false;
  }, [activeChannel]);

  useEffect(() => {
    handoffStartedRef.current = false;
    pendingHandoffRef.current = false;
    holdingRef.current = false;
    setHandoff(false);
    if (handoffTimerRef.current != null) {
      window.clearTimeout(handoffTimerRef.current);
      handoffTimerRef.current = null;
    }
  }, [currentClipId]);

  useEffect(() => {
    standbyReadyKeyRef.current = "";
    const standbyVideo = activeSlot === 0 ? slotBRef.current : slotARef.current;
    // Buffering the standby clip early would starve the very first clip of bandwidth.
    if (!firstFrameShown || !standbyClip?.result_url || !standbyVideo) return;
    standbyVideo.preload = "auto";
    try {
      standbyVideo.load();
    } catch {
      // Some browsers may reject load() during rapid source changes; onCanPlay will still retry.
    }
  }, [activeSlot, firstFrameShown, standbyClip?.id, standbyClip?.result_url]);

  useEffect(() => {
    try {
      window.localStorage.setItem(SOUND_KEY, soundOn ? "on" : "off");
    } catch {
      // Private browsing: the preference just does not persist.
    }
  }, [soundOn]);

  useEffect(() => {
    if (!soundOn) {
      soundUnlockedRef.current = false;
      setMuted(true);
      return;
    }
    let cancelled = false;
    async function tryUnmute() {
      const video = activeSlot === 0 ? slotARef.current : slotBRef.current;
      if (!video || cancelled) return;
      video.muted = false;
      try {
        await video.play();
        if (cancelled) return;
        soundUnlockedRef.current = true;
        setMuted(false);
      } catch {
        // Refused by autoplay policy — keep playing silently and wait for a gesture.
        video.muted = true;
        if (!cancelled) setMuted(true);
      }
    }
    // Any gesture anywhere on the page counts, so switching a channel or typing a prompt is enough.
    const unlock = () => { if (!soundUnlockedRef.current) void tryUnmute(); };
    document.addEventListener("pointerdown", unlock);
    document.addEventListener("keydown", unlock);
    void tryUnmute();
    return () => {
      cancelled = true;
      document.removeEventListener("pointerdown", unlock);
      document.removeEventListener("keydown", unlock);
    };
  }, [soundOn, activeSlot, clip?.id]);

  useEffect(() => {
    // Both slots track the viewer's choice, so a handoff never flips the sound back on its own.
    if (slotARef.current) slotARef.current.muted = muted;
    if (slotBRef.current) slotBRef.current.muted = muted;
  }, [muted, activeSlot, clip?.id, standbyClip?.id]);

  useEffect(() => {
    // A viewer pick, or a clip landing on top of a frozen last frame, must take over as soon as it can play.
    if ((queuedClipId != null || holdingRef.current) && standbyClip?.id != null) pendingHandoffRef.current = true;
  }, [currentClipId, queuedClipId, standbyClip?.id]);

  // Explicit paging beats a scrollbar here: macOS renders overlay scrollbars that fade when idle,
  // so on some setups the strip gave no hint that it scrolls at all.
  useEffect(() => {
    const el = archiveRef.current;
    if (!el) return;
    const update = () => setArchiveNav({
      left: el.scrollLeft > 4,
      right: el.scrollLeft + el.clientWidth < el.scrollWidth - 4,
    });
    update();
    el.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      observer.disconnect();
    };
    // Everything that changes how far the strip can scroll. It used to watch the live window alone,
    // so a page of history arrived, the track grew, and the arrow that would have revealed it never
    // appeared — the observer watches the track's own box, which a longer row of cards does not
    // change, so nothing recomputed until a scroll happened to fire. The loading state counts too:
    // the button it swaps between spinner and label is itself part of the width.
  }, [history.length, loadingOlder, moreOlder]);

  function pageArchive(direction: 1 | -1) {
    const el = archiveRef.current;
    if (!el) return;
    el.scrollBy({ left: direction * Math.max(el.clientWidth * 0.8, 280), behavior: "smooth" });
  }

  function isReadyToShow(video: HTMLVideoElement | null) {
    return Boolean(video && video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA);
  }

  async function switchToNext(standbyVideo: HTMLVideoElement) {
    if (!standbyClip || handoffStartedRef.current || standbyReadyKeyRef.current !== standbyReadyKey || !isReadyToShow(standbyVideo)) return;
    handoffStartedRef.current = true;
    pendingHandoffRef.current = false;
    holdingRef.current = false;
    const takingOver = standbyClip.id;
    log("handoff:start", { from: clip?.id, to: takingOver, readyState: standbyVideo.readyState });
    try {
      standbyVideo.currentTime = 0;
      standbyVideo.muted = muted;
      await standbyVideo.play();
    } catch {
      // Autoplay with sound can be refused mid-show; drop back to muted rather than stall the feed.
      standbyVideo.muted = true;
      setMuted(true);
      try {
        await standbyVideo.play();
      } catch (error) {
        handoffStartedRef.current = false;
        pendingHandoffRef.current = true;
        log("handoff:play-rejected", { to: takingOver, error: String(error) });
        return;
      }
    }
    setHandoff(true);
    handoffTimerRef.current = window.setTimeout(() => {
      setActiveSlot((slot) => (slot === 0 ? 1 : 0));
      setCurrentClipId(takingOver);
      setQueuedClipId((id) => (id === takingOver ? null : id));
      handoffTimerRef.current = null;
    }, 60);
  }

  function requestHandoff() {
    if (handoffStartedRef.current || !standbyClip) return;
    const standbyVideo = activeSlot === 0 ? slotBRef.current : slotARef.current;
    if (standbyReadyKeyRef.current === standbyReadyKey && isReadyToShow(standbyVideo)) {
      void switchToNext(standbyVideo!);
      return;
    }
    log("handoff:waiting-for-buffer", { to: standbyClip.id, readyState: standbyVideo?.readyState ?? -1 });
    pendingHandoffRef.current = true;
    const activeVideo = activeSlot === 0 ? slotARef.current : slotBRef.current;
    if (activeVideo && Number.isFinite(activeVideo.duration)) {
      activeVideo.currentTime = Math.max(0, activeVideo.duration - 0.04);
      activeVideo.pause();
    }
    standbyVideo?.load();
  }

  function holdOnLastFrame() {
    log("hold", { clip: clip?.id });
    holdingRef.current = true;
    const activeVideo = activeSlot === 0 ? slotARef.current : slotBRef.current;
    if (!activeVideo) return;
    activeVideo.pause();
    if (Number.isFinite(activeVideo.duration)) activeVideo.currentTime = Math.max(0, activeVideo.duration - 0.04);
  }

  function handleVideoReady(slot: 0 | 1, clipId: number) {
    if (activeSlot === slot) setFirstFrameShown(true);
    if (slot !== standbySlot || standbyClip?.id !== clipId) return;
    if (standbyReadyKeyRef.current !== `${slot}:${clipId}`) log("standby:ready", { slot, clip: clipId });
    standbyReadyKeyRef.current = `${slot}:${clipId}`;
    if (!pendingHandoffRef.current) return;
    const standbyVideo = slot === 0 ? slotARef.current : slotBRef.current;
    if (isReadyToShow(standbyVideo)) void switchToNext(standbyVideo!);
  }

  function handleTimeUpdate(event: SyntheticEvent<HTMLVideoElement>) {
    const video = event.currentTarget;
    if (!standbyClip || handoffStartedRef.current || !Number.isFinite(video.duration)) return;
    if (video.duration - video.currentTime <= 0.28) requestHandoff();
  }

  function playNextOrHold() {
    if (standbyClip) {
      requestHandoff();
      return;
    }
    holdOnLastFrame();
  }

  useEffect(() => {
    if (jumpRequest == null) return;
    if (!playable.some((item) => item.id === jumpRequest)) return;
    jumpToClip(jumpRequest);
    onJumpHandled?.();
    // jumpToClip is stable enough for this: it only reads refs and setState.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpRequest, playable]);

  function jumpToClip(id: number) {
    if (id === clip?.id && !handoffStartedRef.current) {
      setQueuedClipId(null);
      pendingHandoffRef.current = false;
      holdingRef.current = false;
      const activeVideo = activeSlot === 0 ? slotARef.current : slotBRef.current;
      if (!activeVideo) return;
      activeVideo.currentTime = 0;
      void activeVideo.play();
      return;
    }
    // Never swap the src of the visible slot — the pick is staged in the hidden slot and faded in.
    log("jump:queued", { to: id, from: clip?.id, standby: standbyClip?.id ?? null });
    setQueuedClipId(id);
    pendingHandoffRef.current = true;
    if (standbyClip?.id !== id) return;
    const standbyVideo = activeSlot === 0 ? slotBRef.current : slotARef.current;
    if (standbyReadyKeyRef.current === standbyReadyKey && isReadyToShow(standbyVideo)) void switchToNext(standbyVideo!);
  }

  function slotClass(slot: 0 | 1) {
    const active = activeSlot === slot;
    if (handoff && active) return "stream-video is-leaving";
    if (handoff && !active) return "stream-video is-entering";
    return active ? "stream-video is-active" : "stream-video is-standby";
  }

  function slotClip(slot: 0 | 1) {
    return activeSlot === slot ? clip : standbyClip;
  }

  function debugProps(slot: 0 | 1, item: BroadcastClip) {
    if (!DEBUG) return undefined;
    const record = (kind: string) => (event: SyntheticEvent<HTMLVideoElement>) => {
      const video = event.currentTarget;
      log(`video:${kind}`, {
        slot,
        clip: item.id,
        active: activeSlot === slot,
        readyState: video.readyState,
        time: Number(video.currentTime.toFixed(2)),
        src: shortSrc(video.currentSrc || video.src),
      });
    };
    return {
      onEmptied: record("emptied"),
      onLoadStart: record("loadstart"),
      onStalled: record("stalled"),
      onWaiting: record("waiting"),
      onPlaying: record("playing"),
      onPause: record("pause"),
      onError: record("error"),
    };
  }

  function renderVideoSlot(slot: 0 | 1, ref: RefObject<HTMLVideoElement | null>) {
    const item = slotClip(slot);
    if (!item?.result_url) return null;
    const active = activeSlot === slot;
    return (
      <video
        ref={ref}
        className={slotClass(slot)}
        src={item.result_url}
        autoPlay={active}
        muted={muted}
        playsInline
        preload={active || firstFrameShown ? "auto" : "none"}
        onTimeUpdate={active ? handleTimeUpdate : undefined}
        onEnded={active ? playNextOrHold : undefined}
        onLoadedData={() => handleVideoReady(slot, item.id)}
        onCanPlay={() => handleVideoReady(slot, item.id)}
        {...debugProps(slot, item)}
      />
    );
  }

  const showPlaceholder = !clip?.result_url || !placeholderGone;

  return (
    <section className="broadcast" aria-label="Survival broadcast">
      <div className="channel-bar" role="tablist" aria-label="Channels">
        {channels.map((item) => (
          <button
            key={item.key}
            role="tab"
            aria-selected={item.key === activeChannel}
            className={item.key === activeChannel ? "active" : ""}
            onClick={() => onSelectChannel(item.key)}
          >
            <span className={`channel-thumb${item.isMark ? " is-mark" : ""}${item.pending ? " is-pending" : ""}`}>
              {item.avatarUrl ? <img src={item.avatarUrl} alt="" /> : <i />}
            </span>
            <span className="channel-copy">
              <strong>{item.label}</strong>
              <small className={item.pending ? "is-pending" : ""}>{item.pending ? (item.pendingStage === "video" ? "Feed incoming…" : "Acquiring signal…") : item.detail}</small>
            </span>
          </button>
        ))}
      </div>

      {/* A portrait clip cannot fill a landscape column, so the band beside it carries a blurred
          bleed of the picture itself rather than reading as dead space. */}
      <div
        className="broadcast-media"
        style={clip?.thumbnail_url ? { "--bleed": `url(${clip.thumbnail_url})` } as React.CSSProperties : undefined}
      >
        <div className="broadcast-frame">
          {clip?.result_url ? (
            <>
              {renderVideoSlot(0, slotARef)}
              {renderVideoSlot(1, slotBRef)}
            </>
          ) : null}
          {showPlaceholder ? (
            <div
              className={`generated-scene${clip?.result_url ? " is-cover" : ""}${firstFrameShown ? " is-dimmed" : ""}`}
              role="img"
              aria-label="Simulated island rainforest feed before the storm"
            >
              <div className="moon" />
              <div className="ridge ridge-back" />
              <div className="ridge ridge-front" />
              <div className="watchtower"><i /><b /></div>
              <div className="camp-light" />
              <div className="fog fog-a" />
              <div className="fog fog-b" />
              <div className="rain" />
            </div>
          ) : null}
          <div className="scan-lines" />
          {/* The timeline summary doubles as a caption, so the show reads even with the sound off. */}
          {clip?.summary && firstFrameShown ? (
            <div className="broadcast-subtitle">
              <span>
                {/* The word carried the whole broadcast claim as plain text among the others. As a
                    badge it reads before anything is read at all. */}
                <b className="live-badge"><i />LIVE</b>
                {activeChannel === "director" ? "COMMENTARY" : "FIELD LOG"}
                <time>{clipClock(clip.created_at)}</time>
              </span>
              <p>{clip.summary}</p>
            </div>
          ) : null}
          {clip?.result_url ? (
            <button
              type="button"
              className={muted ? "sound-toggle" : "sound-toggle is-live"}
              aria-label={muted ? "Unmute" : "Mute"}
              title={muted ? "Unmute" : "Mute"}
              onClick={() => {
                if (!muted) {
                  setSoundOn(false);
                  return;
                }
                // A click is a gesture, so unmuting from here always succeeds.
                setSoundOn(true);
                const video = activeSlot === 0 ? slotARef.current : slotBRef.current;
                if (!video) return;
                video.muted = false;
                void video.play().then(() => {
                  soundUnlockedRef.current = true;
                  setMuted(false);
                }).catch(() => undefined);
              }}
            >
              <svg viewBox="0 0 1024 1024" width="17" height="17" fill="currentColor" aria-hidden="true">
                <path d="M505.813333 151.509333a137.130667 137.130667 0 0 0-148.010666 20.736l-110.933334 94.976a10.325333 10.325333 0 0 1-6.869333 2.56h-31.488a113.152 113.152 0 0 0-112.725333 113.066667v258.176a113.194667 113.194667 0 0 0 112.768 113.066667h31.402666c2.56 0 5.034667 0.853333 6.954667 2.56l110.677333 94.976a137.344 137.344 0 0 0 147.84 20.821333 137.557333 137.557333 0 0 0 81.066667-126.250667V277.76a137.386667 137.386667 0 0 0-80.682667-126.250667z m17.066667 594.688a74.624 74.624 0 0 1-123.178667 56.917334l-110.634666-94.933334a74.88 74.88 0 0 0-48.554667-18.005333H209.066667a49.066667 49.066667 0 0 1-48.853334-49.066667V382.933333A49.066667 49.066667 0 0 1 209.066667 333.866667h31.445333c17.792 0 34.986667-6.4 48.512-17.962667l110.72-94.933333c13.269333-11.690667 30.293333-18.176 48-18.261334 10.922667 0.042667 21.674667 2.474667 31.573333 7.082667 26.922667 11.946667 44.074667 38.826667 43.562667 68.266667v468.352-0.213334z m185.514667-381.568a245.504 245.504 0 0 1 0 294.741334 32.085333 32.085333 0 0 1-51.2-38.698667 181.162667 181.162667 0 0 0 0-217.258667 32.128 32.128 0 0 1 51.2-38.784zM928 512a414.165333 414.165333 0 0 1-106.325333 277.333333 32 32 0 1 1-47.616-42.666666 351.104 351.104 0 0 0 0-469.333334 32 32 0 0 1 47.616-42.666666A414.208 414.208 0 0 1 928 512z" />
                {muted ? (
                  <>
                    {/* A darker pass first so the slash reads over the speaker rather than merging with it. */}
                    <path d="M214 810 810 214" stroke="rgb(12 9 7 / .55)" strokeWidth="150" strokeLinecap="round" fill="none" />
                    <path d="M214 810 810 214" stroke="currentColor" strokeWidth="78" strokeLinecap="round" fill="none" />
                  </>
                ) : null}
              </svg>
            </button>
          ) : null}
        </div>
      </div>

      <div className={archiveOpen ? "clip-history is-open" : "clip-history"} aria-label="Clip archive">
        {archiveNav.left ? (
          <button type="button" className="clip-nav is-left" aria-label="Earlier clips" onClick={() => pageArchive(-1)}>
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M15 5l-7 7 7 7" /></svg>
          </button>
        ) : null}
        {archiveNav.right ? (
          <button type="button" className="clip-nav is-right" aria-label="Later clips" onClick={() => pageArchive(1)}>
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M9 5l7 7-7 7" /></svg>
          </button>
        ) : null}
        <div className="clip-history-track" ref={archiveRef}>
          {history.length ? history.map((item) => (
            <button
              key={item.id}
              className={item.id === (queuedClipId ?? currentClipId) ? "active" : ""}
              title={item.summary ?? undefined}
              onClick={() => jumpToClip(item.id)}
            >
              <span className="clip-cast">
                {castOf(item).slice(0, 3).map((member, index, all) => (
                  <span
                    key={member.id}
                    className="clip-card"
                    title={member.display_name}
                    style={{
                      // Fanned around centre when there are several; a lone sheet still gets a tilt
                      // so it reads as a card rather than a pasted-on badge. The tilt lives in a
                      // variable so the hover lift can compose with it.
                      "--tilt": `${all.length === 1 ? 7 : (index - (all.length - 1) / 2) * 8}deg`,
                      zIndex: all.length - index,
                    } as React.CSSProperties}
                  >
                    {(member.portrait_url ?? member.avatar_url)
                      ? <img src={member.portrait_url ?? member.avatar_url!} alt="" loading="lazy" />
                      : <i>{member.display_name.slice(0, 1)}</i>}
                  </span>
                ))}
              </span>
              <span className="clip-thumb">
                {item.thumbnail_url
                  ? <img src={item.thumbnail_url} alt="" loading="lazy" />
                  : <i />}
                {item.id === latestClipId ? <em>NEW</em> : null}
              </span>
              <span className="clip-meta">
                <small>{item.duration_seconds}s</small>
              </span>
            </button>
          )) : <p>Once the first clip is filmed, the archive shows up here.</p>}
          {history.length && (moreOlder || loadingOlder) ? (
            <button
              type="button"
              className="clip-more"
              onClick={() => onLoadOlder?.()}
              disabled={loadingOlder}
              aria-label="Load earlier clips"
            >
              {loadingOlder
                ? <><i className="clip-more-spinner" /><span>Loading…</span></>
                : <><b>+{ARCHIVE_PAGE_HINT}</b><span>Earlier clips</span></>}
            </button>
          ) : null}
        </div>
      </div>
    </section>
  );
}
