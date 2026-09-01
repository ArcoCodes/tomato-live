import { useCallback, useEffect, useMemo, useState } from "react";
import { ActionBar } from "@/components/ActionBar";
import { Broadcast, type ChannelTab } from "@/components/Broadcast";
import { DirectorDialog } from "@/components/DirectorDialog";
import { EventFeed } from "@/components/EventFeed";
import { JoinDialog } from "@/components/JoinDialog";
import { LoginDialog } from "@/components/LoginDialog";
import { Roster } from "@/components/Roster";
import { useAuth } from "@/hooks/useAuth";
import { useTailFrameHarvester } from "@/hooks/useTailFrameHarvester";
import { client } from "@/lib/edgespark";
import type { BroadcastClip, LinkOffer, LiveData, PlayerControl } from "@/types/live";

const DIRECTOR_CHANNEL = "director";

function channelKeyFor(clip: BroadcastClip) {
  return clip.channel === "director" ? DIRECTOR_CHANNEL : `p:${clip.channel_participant_id}`;
}

const CONTROLS_KEY = "tomato-live-controls";
const LEGACY_CONTROL_KEY = "tomato-live-control";

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

function LoadingScreen() {
  return (
    <main className="loading-screen">
      <div className="loading-mark"><i /><span>TOMATO LIVE</span></div>
      <p>正在连接北岸直播信号</p>
      <div className="loading-line"><i /></div>
    </main>
  );
}

function App() {
  const [live, setLive] = useState<LiveData | null>(null);
  const [error, setError] = useState("");
  const [joinOpen, setJoinOpen] = useState(false);
  const [directorOpen, setDirectorOpen] = useState(false);
  const [controls, setControls] = useState<PlayerControl[]>(() => readControls());
  const [activeParticipantId, setActiveParticipantId] = useState<number | null>(() => readControls()[0]?.participantId ?? null);
  const [loginOpen, setLoginOpen] = useState(false);
  const [accountCharacterIds, setAccountCharacterIds] = useState<number[]>([]);
  const [quota, setQuota] = useState<{ used: number; limit: number; remaining: number } | null>(null);
  const [activeChannel, setActiveChannel] = useState(DIRECTOR_CHANNEL);
  const { user, isAuthenticated, signOut } = useAuth();

  const refresh = useCallback(async (quiet = false) => {
    try {
      const response = await client.api.fetch("/api/public/live");
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "直播状态不可用");
      setLive(result);
      setError("");
    } catch (cause) {
      if (!quiet) setError(cause instanceof Error ? cause.message : "直播状态不可用");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(true), 9000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  // Characters owned by the signed-in account need no browser token at all; the legacy localStorage
  // records stay valid for characters created before accounts were required.
  const ownedIds = useMemo(() => {
    const ids = new Set<number>(accountCharacterIds);
    for (const item of controls) ids.add(item.participantId);
    return [...ids];
  }, [accountCharacterIds, controls]);

  const activeId = activeParticipantId != null && ownedIds.includes(activeParticipantId)
    ? activeParticipantId
    : ownedIds[0] ?? null;
  const control: PlayerControl | null = activeId == null
    ? null
    : controls.find((item) => item.participantId === activeId) ?? { participantId: activeId, controlToken: "" };

  // Channels generate in parallel now, so one heartbeat drives every pending task. ActionBar and
  // DirectorDialog read state from `live` instead of running polls of their own.
  const pendingIds = (live?.pending_generations ?? []).map((item) => item.id).join(",");

  useEffect(() => {
    if (!pendingIds) return;
    const ids = pendingIds.split(",").map(Number);
    let active = true;
    const sync = async () => {
      let completed = false;
      for (const id of ids) {
        if (!active) return;
        try {
          const response = await client.api.fetch(`/api/public/generations/${id}/sync`, { method: "POST" });
          const result = await response.json();
          if (response.ok && result.generation?.stage === "completed") completed = true;
        } catch {
          // Keep the live page calm; ActionBar shows submission errors for the user who clicked.
        }
      }
      if (active && completed) void refresh(true);
    };
    void sync();
    const timer = window.setInterval(sync, 2500);
    return () => { active = false; window.clearInterval(timer); };
  }, [pendingIds, refresh]);

  const tailFrameKey = (live?.tail_frame_wanted ?? []).join(",");
  const tailFrameWanted = useMemo(
    () => (tailFrameKey ? tailFrameKey.split(",").map(Number) : []),
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
      label: "总导播",
      detail: directorCount ? `${directorCount} 段串播` : "等待素材",
      pending: pending.some((item) => item.channel === "director"),
    }];
    for (const participant of live.participants) {
      const count = live.clips.filter((clip) => clip.channel_participant_id === participant.id).length;
      tabs.push({
        key: `p:${participant.id}`,
        label: participant.display_name,
        detail: count ? `${count} 段视角` : "尚无片段",
        pending: pending.some((item) => item.channel_participant_id === participant.id),
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
      fromName: live.participants.find((item) => item.id === author)?.display_name ?? "其他选手",
      summary: clip.summary,
    }));
  }, [control?.participantId, live]);

  const channelClips = useMemo(
    () => (live?.clips ?? []).filter((clip) => channelKeyFor(clip) === activeChannel),
    [activeChannel, live?.clips],
  );

  const myParticipant = useMemo(
    () => live?.participants.find((participant) => participant.id === control?.participantId),
    [control?.participantId, live?.participants],
  );

  useEffect(() => {
    if (!isAuthenticated) {
      setAccountCharacterIds([]);
      setQuota(null);
      return;
    }
    let active = true;
    void (async () => {
      try {
        const response = await client.api.fetch("/api/public/my-characters");
        const result = await response.json();
        if (!active || !response.ok) return;
        setAccountCharacterIds((result.characters ?? []).map((item: { id: number }) => item.id));
        setQuota(result.quota ?? null);
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
    setActiveParticipantId(next.participantId);
  }

  function openJoin() {
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
        <h1>直播信号中断</h1>
        <p>{error}</p>
        <button onClick={() => refresh()}>重新连接</button>
      </main>
    );
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <span className="brand-mark"><i /><b /></span>
          <div><strong>TOMATO LIVE</strong><span>AI SURVIVAL BROADCAST</span></div>
        </div>
        <div className="match-title">
          <span>{live.match.title}</span>
          <b>{live.match.subtitle}</b>
        </div>
        <div className="topbar-actions">
          <span className="viewer-count"><i /> {live.match.viewers.toLocaleString()} WATCHING</span>
          <button className="text-action" onClick={openDirector}>生成下一段</button>
          <button className="join-action" onClick={openJoin}>{myParticipant ? "角色档案" : "加入挑战"}<span>↗</span></button>
        </div>
      </header>

      <div className="status-strip">
        <span><i className="pulse-dot" /> LIVE EVENT</span>
        <span>ZONE / {live.match.zone}</span>
        <span>ROUND / {String(live.match.current_round).padStart(2, "0")}</span>
        <span>MODEL / MINIMAX H3 MAX</span>
        <span className="weather-alert">⚠ TROPICAL STORM APPROACHING</span>
      </div>

      <main className="live-grid">
        <Roster participants={live.participants} selectedId={control?.participantId} />
        <Broadcast
          clips={channelClips}
          channels={channels}
          activeChannel={activeChannel}
          onSelectChannel={setActiveChannel}
        />
        <EventFeed events={live.events} />
      </main>

      {myParticipant && control ? (
        <ActionBar
          participant={myParticipant}
          roster={live.participants}
          myCharacters={myCharacters}
          onSwitchCharacter={setActiveParticipantId}
          linkOffers={linkOffers}
          control={control}
          choices={live.story_choices}
          pendingGeneration={(live.pending_generations ?? []).find((item) => item.channel_participant_id === myParticipant.id) ?? null}
          onUpdated={() => refresh(true)}
        />
      ) : (
        <section className="spectator-bar">
          <div><span className="eyebrow">SPECTATOR MODE</span><strong>你正在以观众身份观看</strong></div>
          <p>{quota && quota.remaining <= 0
          ? `你的账号已创建 ${quota.used} 个角色，达到上限 ${quota.limit} 个。`
          : "创建角色，下一轮就有机会进入直播画面。"}</p>
          <button onClick={openJoin}>{isAuthenticated ? "创建参赛角色" : "登录后创建角色"} <span>→</span></button>
        </section>
      )}

      <footer>
        <span>© 2026 TOMATO LIVE / POWERED BY EDGESPARK + MINIMAX</span>
        <div>
          {isAuthenticated && <button onClick={() => signOut()}>{user?.email} · 退出</button>}
          <span>LIVE LATENCY 12.4S</span>
          <span>GENERATION BUFFER 01</span>
        </div>
      </footer>

      <LoginDialog open={loginOpen} onClose={() => setLoginOpen(false)} />
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
