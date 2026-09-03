import { useCallback, useEffect, useMemo, useState } from "react";
import { ActionBar } from "@/components/ActionBar";
import { Broadcast, type ChannelTab } from "@/components/Broadcast";
import { DirectorDialog } from "@/components/DirectorDialog";
import { JoinDialog } from "@/components/JoinDialog";
import { ChatRoom } from "@/components/ChatRoom";
import { LoginDialog } from "@/components/LoginDialog";
import { Roster } from "@/components/Roster";
import { useAuth } from "@/hooks/useAuth";
import { useTailFrameHarvester } from "@/hooks/useTailFrameHarvester";
import { deviceHeaders } from "@/lib/device";
import { client } from "@/lib/edgespark";
import type { BroadcastClip, LinkOffer, LiveData, PlayerControl } from "@/types/live";

const DIRECTOR_CHANNEL = "director";
// Mirrors CHARACTER_CREATION_OPEN on the server; the endpoint refuses regardless, this just keeps
// viewers out of a flow that would fail at the end.
const CHARACTER_CREATION_OPEN = false;
const CHARACTER_CREATION_CLOSED_NOTICE = "Character creation opens soon — hang tight.";

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

  const refresh = useCallback(async (quiet = false) => {
    try {
      // The allowance on the payload is this browser's, so the id has to ride along.
      const response = await client.api.fetch("/api/public/live", { headers: deviceHeaders });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "The live feed is unavailable");
      setLive(result);
      setError("");
    } catch (cause) {
      if (!quiet) setError(cause instanceof Error ? cause.message : "The live feed is unavailable");
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

  // The channel you are watching is the character you are directing — keeping "viewed" and
  // "controlled" as separate states meant opening your other character's channel left the composer
  // pointed at the first one, so the bar fell back to the timeline.
  const viewedId = activeChannel.startsWith("p:") ? Number(activeChannel.slice(2)) : null;
  const activeId = viewedId != null && ownedIds.includes(viewedId) ? viewedId : null;
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

  const myPendingStage = (live?.pending_generations ?? [])
    .find((item) => item.channel_participant_id === activeId)?.stage;

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
          <span className="viewer-count"><i /> {live.match.viewers.toLocaleString()} WATCHING</span>
          {/* Manual cuts are a host tool: the director channel advances on its own. */}
          {isHost ? <button className="text-action" onClick={openDirector}>Cut next</button> : null}
          <button className="join-action" onClick={openJoin}>{myParticipant ? "My contestant" : "Join"}<span>↗</span></button>
        </div>
      </header>

      <main className="live-grid">
        <Roster participants={live.participants} selectedId={control?.participantId} />
        <Broadcast
          clips={channelClips}
          participants={live.participants}
          channels={channels}
          activeChannel={activeChannel}
          onSelectChannel={setActiveChannel}
          myPendingStage={myPendingStage}
          jumpRequest={jumpRequest}
          onJumpHandled={() => setJumpRequest(null)}
          archiveOpen={archiveOpen}
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
