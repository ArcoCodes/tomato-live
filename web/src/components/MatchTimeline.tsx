import type { BroadcastClip, Participant } from "@/types/live";

const LANE_H = 34;
const STEP = 38;
const PAD_X = 18;
const PAD_Y = 10;

/**
 * One rail per contestant along a shared time axis.
 *
 * A linked clip belongs to exactly one channel — the guest was written into someone else's shot and
 * has no clip of their own — so the guest gets a hollow marker on their own rail joined to the solid
 * one by a tie line. Bending both rails into a symmetric braid would have implied two clips.
 */
export function MatchTimeline({ participants, clips, activeChannel, onSelectChannel, onComposeChannel }: {
  participants: Participant[];
  clips: BroadcastClip[];
  activeChannel: string;
  onSelectChannel: (key: string) => void;
  onComposeChannel?: { key: string; label: string };
}) {
  const lanes = participants.map((item, index) => ({ participant: item, y: PAD_Y + index * LANE_H + LANE_H / 2 }));
  const laneY = new Map(lanes.map((lane) => [lane.participant.id, lane.y]));
  const accentOf = new Map(participants.map((item) => [item.id, item.accent]));

  // Contestant clips only, oldest first — live.clips arrives newest-first.
  const ordered = clips
    .filter((clip) => clip.channel === "participant" && clip.channel_participant_id != null)
    .slice()
    .reverse();
  const latestId = ordered[ordered.length - 1]?.id ?? null;

  const nodes = ordered.map((clip, index) => {
    const owner = clip.channel_participant_id!;
    const guests = clip.participant_ids.filter((id) => id !== owner && laneY.has(id));
    return {
      clip,
      x: PAD_X + index * STEP,
      ownerY: laneY.get(owner) ?? PAD_Y,
      guestYs: guests.map((id) => laneY.get(id)!),
      accent: accentOf.get(owner) ?? "var(--muted)",
    };
  });

  const width = PAD_X * 2 + Math.max(ordered.length - 1, 0) * STEP;
  const height = PAD_Y * 2 + lanes.length * LANE_H;

  return (
    <section className="match-timeline">
      <div className="timeline-head">
        <div>
          <span className="eyebrow">MATCH TIMELINE</span>
          <b>{ordered.length} 段 · 实心为本人片段，空心为客串</b>
        </div>
        {onComposeChannel ? (
          <button type="button" className="timeline-compose" onClick={() => onSelectChannel(onComposeChannel.key)}>
            给 {onComposeChannel.label} 下指令 <span>→</span>
          </button>
        ) : null}
      </div>

      <div className="timeline-canvas">
        <div className="timeline-names" style={{ paddingTop: PAD_Y }}>
          {lanes.map((lane) => {
            const own = ordered.filter((clip) => clip.channel_participant_id === lane.participant.id).length;
            return (
              <button
                key={lane.participant.id}
                type="button"
                style={{ height: LANE_H }}
                className={activeChannel === `p:${lane.participant.id}` ? "timeline-name active" : "timeline-name"}
                onClick={() => onSelectChannel(`p:${lane.participant.id}`)}
              >
                <span className="lane-avatar">
                  {lane.participant.avatar_url
                    ? <img src={lane.participant.avatar_url} alt="" />
                    : <i>{lane.participant.display_name.slice(0, 1)}</i>}
                </span>
                <span className="lane-text">
                  <b>{lane.participant.display_name}</b>
                  <em>{own} 段</em>
                </span>
              </button>
            );
          })}
        </div>

        <div className="timeline-scroll">
          <svg width={Math.max(width, 240)} height={height} className="timeline-svg">
            {lanes.map((lane) => (
              <line
                key={`rail-${lane.participant.id}`}
                x1={0}
                y1={lane.y}
                x2={Math.max(width, 240)}
                y2={lane.y}
                stroke={lane.participant.accent}
                strokeWidth={1.5}
                opacity={0.3}
              />
            ))}

            {/* Tie line: this clip reached across channels. */}
            {nodes.filter((node) => node.guestYs.length > 0).map((node) => {
              const ys = [node.ownerY, ...node.guestYs];
              return (
                <line
                  key={`tie-${node.clip.id}`}
                  x1={node.x}
                  y1={Math.min(...ys)}
                  x2={node.x}
                  y2={Math.max(...ys)}
                  stroke={node.accent}
                  strokeWidth={1.5}
                  opacity={0.55}
                />
              );
            })}

            {nodes.map((node) => (
              <g
                key={node.clip.id}
                className="timeline-node"
                onClick={() => onSelectChannel(`p:${node.clip.channel_participant_id}`)}
              >
                <title>{node.clip.summary ?? "等待概要"}</title>
                <rect x={node.x - STEP / 2} y={0} width={STEP} height={height} fill="transparent" />
                {node.clip.id === latestId ? (
                  <circle cx={node.x} cy={node.ownerY} r={9} fill="none" stroke={node.accent} strokeWidth={1.5} opacity={0.45} />
                ) : null}
                <circle cx={node.x} cy={node.ownerY} r={5} fill={node.accent} />
                {node.guestYs.map((y, index) => (
                  <circle key={index} cx={node.x} cy={y} r={4.5} fill="var(--surface)" stroke={node.accent} strokeWidth={2} />
                ))}
              </g>
            ))}
          </svg>
        </div>
      </div>
    </section>
  );
}
