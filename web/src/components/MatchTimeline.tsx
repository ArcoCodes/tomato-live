import type { BroadcastClip, Participant } from "@/types/live";

const LANE_H = 30;
const STEP = 46;
const PAD_X = 22;
const PAD_Y = 14;

/**
 * A line per contestant, drawn along a shared time axis. When a clip holds more than one contestant
 * — someone pulled in with @ — the lines involved bend off their rails and meet on a single node,
 * then split again. That braid is the point: it is the only place the channels actually touch.
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

  // Contestant clips only, oldest first — live.clips arrives newest-first.
  const ordered = clips
    .filter((clip) => clip.channel === "participant" && clip.channel_participant_id != null)
    .slice()
    .reverse();

  const nodes = ordered.map((clip, index) => {
    const ownerY = laneY.get(clip.channel_participant_id!) ?? PAD_Y;
    const guestYs = clip.participant_ids
      .filter((id) => id !== clip.channel_participant_id && laneY.has(id))
      .map((id) => laneY.get(id)!);
    const involved = [ownerY, ...guestYs];
    return {
      clip,
      x: PAD_X + index * STEP,
      // A braided node sits between the lines it joins; a solo one stays on its own rail.
      y: involved.reduce((sum, value) => sum + value, 0) / involved.length,
      ownerY,
      guestYs,
    };
  });

  const width = Math.max(PAD_X * 2 + Math.max(ordered.length - 1, 0) * STEP + PAD_X, 320);
  const height = PAD_Y * 2 + lanes.length * LANE_H;

  return (
    <section className="match-timeline">
      <div className="timeline-head">
        <div>
          <span className="eyebrow">MATCH TIMELINE</span>
          <b>{ordered.length} 段角色片段 · {participants.length} 名选手在场</b>
        </div>
        {onComposeChannel ? (
          <button type="button" className="timeline-compose" onClick={() => onSelectChannel(onComposeChannel.key)}>
            给 {onComposeChannel.label} 下指令 <span>→</span>
          </button>
        ) : null}
      </div>

      <div className="timeline-canvas">
        <div className="timeline-names" style={{ paddingTop: PAD_Y }}>
          {lanes.map((lane) => (
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
              <b style={{ color: lane.participant.accent }}>{lane.participant.display_name}</b>
            </button>
          ))}
        </div>

        <div className="timeline-scroll">
          <svg width={width} height={height} className="timeline-svg">
            {lanes.map((lane) => (
              <line
                key={`rail-${lane.participant.id}`}
                x1={PAD_X - 10}
                y1={lane.y}
                x2={width - 6}
                y2={lane.y}
                stroke={lane.participant.accent}
                strokeWidth={2}
                strokeLinecap="round"
                opacity={0.22}
              />
            ))}

            {nodes.filter((node) => node.guestYs.length > 0).map((node) => (
              <g key={`braid-${node.clip.id}`}>
                {[node.ownerY, ...node.guestYs].map((y, index) => (
                  <path
                    key={index}
                    d={`M ${node.x - STEP * 0.5},${y} C ${node.x - STEP * 0.2},${y} ${node.x - STEP * 0.16},${node.y} ${node.x},${node.y}`
                      + ` C ${node.x + STEP * 0.16},${node.y} ${node.x + STEP * 0.2},${y} ${node.x + STEP * 0.5},${y}`}
                    fill="none"
                    stroke="var(--brand)"
                    strokeWidth={2}
                    strokeLinecap="round"
                    opacity={0.85}
                  />
                ))}
              </g>
            ))}

            {nodes.map((node) => {
              const braided = node.guestYs.length > 0;
              const current = `p:${node.clip.channel_participant_id}` === activeChannel;
              return (
                <g
                  key={node.clip.id}
                  className="timeline-node"
                  onClick={() => onSelectChannel(`p:${node.clip.channel_participant_id}`)}
                >
                  <title>{node.clip.summary ?? "等待概要"}</title>
                  <circle cx={node.x} cy={node.y} r={braided ? 12 : 9} fill="transparent" />
                  {braided ? <circle cx={node.x} cy={node.y} r={7} fill="none" stroke="var(--brand)" strokeWidth={2} opacity={0.4} /> : null}
                  <circle
                    cx={node.x}
                    cy={node.y}
                    r={braided ? 4.5 : 3.5}
                    fill={braided ? "var(--brand)" : (participants.find((p) => p.id === node.clip.channel_participant_id)?.accent ?? "var(--muted)")}
                    stroke="#fff"
                    strokeWidth={current ? 2 : 0}
                  />
                </g>
              );
            })}
          </svg>
        </div>
      </div>
    </section>
  );
}
