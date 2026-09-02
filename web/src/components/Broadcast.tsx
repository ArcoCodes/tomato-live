import { useEffect, useMemo, useRef, useState, type RefObject, type SyntheticEvent } from "react";
import type { BroadcastClip } from "@/types/live";

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

export function Broadcast({ clips, channels, activeChannel, onSelectChannel }: {
  clips: BroadcastClip[];
  channels: ChannelTab[];
  activeChannel: string;
  onSelectChannel: (key: string) => void;
}) {
  const playable = useMemo(
    () => clips
      .filter((clip) => clip.result_url)
      .slice()
      .sort((a, b) => a.id - b.id),
    [clips],
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
    <section className="broadcast" aria-label="生存挑战直播">
      <div className="channel-bar" role="tablist" aria-label="直播通道">
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
              <small className={item.pending ? "is-pending" : ""}>{item.pending ? (item.pendingStage === "video" ? "生成画面中…" : "编写分镜中…") : item.detail}</small>
            </span>
          </button>
        ))}
      </div>

      <div className="broadcast-media">
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
            aria-label="风暴前的荒岛雨林直播模拟画面"
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
            <span>{activeChannel === "director" ? "现场解说" : "画面记录"}</span>
            <p>{clip.summary}</p>
          </div>
        ) : null}
        {clip?.result_url ? (
          <button
            type="button"
            className={muted ? "sound-toggle" : "sound-toggle is-live"}
            aria-label={muted ? "开启声音" : "静音"}
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
            {muted ? (soundOn ? "🔇 点击任意处开启声音" : "🔇 已静音") : "🔊 声音已开"}
          </button>
        ) : null}
      </div>

      <div className="clip-history" aria-label="历史片段">
        <div className="clip-history-heading">
          <span>ARCHIVE</span>
          <b>{history.length ? `${history.length} 段已生成` : "暂无历史片段"}</b>
        </div>
        <div className="clip-history-track">
          {history.length ? history.map((item, index) => (
            <button
              key={item.id}
              className={item.id === (queuedClipId ?? currentClipId) ? "active" : ""}
              onClick={() => jumpToClip(item.id)}
            >
              <span>{item.id === latestClipId ? "最新" : "回看"}</span>
              {/* Position within this channel, not the database id — ids never restart. */}
              <strong>SHOT {String(history.length - index).padStart(3, "0")}</strong>
              <small>{item.duration_seconds}s · R{String(item.round).padStart(2, "0")}</small>
            </button>
          )) : <p>生成第一段后，这里会出现可回看的历史视频。</p>}
        </div>
      </div>
    </section>
  );
}
