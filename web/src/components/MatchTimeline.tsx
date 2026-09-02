import type { BroadcastClip, Participant } from "@/types/live";

interface Lane {
  key: string;
  label: string;
  avatar: string | null;
  isMark: boolean;
  accent: string;
}

/**
 * The director channel is for watching, not authoring, so the bar under it shows where every
 * contestant stands instead of a prompt field. One lane per channel makes it obvious at a glance
 * who is advancing and who has stalled — something the strictly chronological event feed cannot show.
 */
export function MatchTimeline({ participants, clips, activeChannel, onSelectChannel, onComposeChannel }: {
  participants: Participant[];
  clips: BroadcastClip[];
  activeChannel: string;
  onSelectChannel: (key: string) => void;
  /** Present when this viewer holds a character, so they can jump straight back to writing. */
  onComposeChannel?: { key: string; label: string };
}) {
  const lanes: Lane[] = [
    { key: "director", label: "总导播", avatar: "/director.png", isMark: true, accent: "#e64b22" },
    ...participants.map((item) => ({
      key: `p:${item.id}`,
      label: item.display_name,
      avatar: item.avatar_url,
      isMark: false,
      accent: item.accent,
    })),
  ];

  function clipsOf(key: string) {
    // live.clips arrives newest-first; a lane reads left to right in time order.
    return clips
      .filter((clip) => (clip.channel === "director" ? "director" : `p:${clip.channel_participant_id}`) === key)
      .slice()
      .reverse();
  }

  return (
    <section className="match-timeline">
      <div className="timeline-head">
        <div>
          <span className="eyebrow">MATCH TIMELINE</span>
          <b>{clips.length} 段已播出 · {participants.length} 名选手在场</b>
        </div>
        {onComposeChannel ? (
          <button type="button" className="timeline-compose" onClick={() => onSelectChannel(onComposeChannel.key)}>
            给 {onComposeChannel.label} 下指令 <span>→</span>
          </button>
        ) : null}
      </div>
      <div className="timeline-lanes">
        {lanes.map((lane) => {
          const own = clipsOf(lane.key);
          const latest = own[own.length - 1];
          return (
            <button
              key={lane.key}
              type="button"
              className={lane.key === activeChannel ? "timeline-lane active" : "timeline-lane"}
              onClick={() => onSelectChannel(lane.key)}
            >
              <span className={lane.isMark ? "lane-avatar is-mark" : "lane-avatar"}>
                {lane.avatar ? <img src={lane.avatar} alt="" /> : <i>{lane.label.slice(0, 1)}</i>}
              </span>
              <span className="lane-name">{lane.label}</span>
              <span className="lane-dots">
                {own.length
                  ? own.map((clip) => (
                    <i
                      key={clip.id}
                      title={clip.summary ?? undefined}
                      style={{ background: lane.accent }}
                    />
                  ))
                  : <em>尚无片段</em>}
              </span>
              <span className="lane-latest">{latest?.summary ?? "等待第一段画面"}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
