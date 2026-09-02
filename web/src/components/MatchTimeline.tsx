import { useEffect, useRef, useState } from "react";
import type { BroadcastClip, Participant } from "@/types/live";

const LANE_H = 52;
const STEP = 46;
const PAD_X = 30;
const PAD_Y = 24;
const WOBBLE = 9;

/** Deterministic per-clip jitter: the line wanders, but never re-wanders between renders. */
function wobble(seed: number) {
  const value = Math.sin(seed * 12.9898) * 43758.5453;
  return ((value - Math.floor(value)) - 0.5) * 2 * WOBBLE;
}

/** Catmull-Rom through the points, emitted as cubic beziers — a drawn line, not a chart axis. */
function smoothPath(points: Array<{ x: number; y: number }>) {
  if (points.length === 0) return "";
  if (points.length === 1) return `M ${points[0].x - 30},${points[0].y} L ${points[0].x + 30},${points[0].y}`;
  let d = `M ${points[0].x},${points[0].y}`;
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[i - 1] ?? points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] ?? p2;
    d += ` C ${p1.x + (p2.x - p0.x) / 6},${p1.y + (p2.y - p0.y) / 6}`
      + ` ${p2.x - (p3.x - p1.x) / 6},${p2.y - (p3.y - p1.y) / 6}`
      + ` ${p2.x},${p2.y}`;
  }
  return d;
}

interface Mark {
  clip: BroadcastClip;
  x: number;
  y: number;
  own: boolean;
  /** Nth guest on this clip, so co-located guests draw as concentric rings instead of overlapping. */
  ring: number;
}

export function MatchTimeline({ participants, clips, activeChannel, onSelectChannel, onComposeChannel }: {
  participants: Participant[];
  clips: BroadcastClip[];
  activeChannel: string;
  onSelectChannel: (key: string) => void;
  onComposeChannel?: { key: string; label: string };
}) {
  const viewRef = useRef<HTMLDivElement | null>(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const drag = useRef<{ px: number; py: number; ox: number; oy: number; moved: boolean } | null>(null);
  const [grabbing, setGrabbing] = useState(false);

  const ordered = clips
    .filter((clip) => clip.channel === "participant" && clip.channel_participant_id != null)
    .slice()
    .reverse();
  const xOf = new Map(ordered.map((clip, index) => [clip.id, PAD_X + index * STEP]));
  const baseY = new Map(participants.map((item, index) => [item.id, PAD_Y + index * LANE_H]));

  // Where two contestants share a clip their lines lean toward each other, so a meeting reads as
  // the lines converging rather than as a symbol placed on top of them.
  const lines = participants.map((participant) => {
    const marks: Mark[] = [];
    for (const clip of ordered) {
      const involved = clip.participant_ids.includes(participant.id) || clip.channel_participant_id === participant.id;
      if (!involved) continue;
      const others = clip.participant_ids.filter((id) => id !== participant.id && baseY.has(id));
      const home = baseY.get(participant.id)!;
      // Everyone in a shared clip lands on the same point — the centroid of the lines involved —
      // so the lines actually meet rather than merely leaning at each other.
      const involvedYs = [home, ...others.map((id) => baseY.get(id)!)];
      const meeting = involvedYs.reduce((sum, value) => sum + value, 0) / involvedYs.length;
      const guests = clip.participant_ids.filter((id) => id !== clip.channel_participant_id && baseY.has(id));
      marks.push({
        clip,
        x: xOf.get(clip.id)!,
        y: others.length ? meeting : home + wobble(clip.id + participant.id),
        own: clip.channel_participant_id === participant.id,
        ring: Math.max(guests.indexOf(participant.id), 0),
      });
    }
    return { participant, marks, home: baseY.get(participant.id)! };
  });

  const contentW = PAD_X * 2 + Math.max(ordered.length - 1, 0) * STEP;
  const latestId = ordered[ordered.length - 1]?.id ?? null;

  // Open on the newest end of the story — that is where the live edge is — with the lines centred
  // vertically, since a few contestants leave the square canvas mostly empty otherwise.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const contentH = PAD_Y * 2 + Math.max(participants.length - 1, 0) * LANE_H;
    setPan({
      x: Math.min(0, view.clientWidth - contentW - PAD_X),
      y: Math.max(0, (view.clientHeight - contentH) / 2),
    });
  }, [contentW, participants.length]);

  // Listeners go on window rather than the element: with pointer capture the drag stalled as soon
  // as the cursor left the canvas, and it never started at all under synthetic events.
  function onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    const view = viewRef.current;
    if (!view) return;
    const start = { px: event.clientX, py: event.clientY, ox: pan.x, oy: pan.y, moved: false };
    drag.current = start;
    setGrabbing(true);
    const slackX = Math.max(120, contentW * 0.5);
    const slackY = Math.max(60, LANE_H * participants.length);
    const move = (moveEvent: PointerEvent) => {
      const dx = moveEvent.clientX - start.px;
      const dy = moveEvent.clientY - start.py;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) start.moved = true;
      // Lower bound is only negative once the story is wider than the view; slack on both sides
      // keeps a short story draggable rather than frozen.
      const minX = Math.min(0, view.clientWidth - contentW - PAD_X) - slackX;
      setPan({
        x: Math.max(minX, Math.min(slackX, start.ox + dx)),
        y: Math.max(-slackY, Math.min(slackY, start.oy + dy)),
      });
    };
    const up = () => {
      setGrabbing(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      // Cleared a tick later so the click that follows can still see it was a drag.
      window.setTimeout(() => { drag.current = null; }, 0);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function selectClip(clip: BroadcastClip) {
    // A drag should not also count as a click on whatever was under the cursor.
    if (drag.current?.moved) return;
    onSelectChannel(`p:${clip.channel_participant_id}`);
  }

  const latest = ordered[ordered.length - 1];

  return (
    <aside className="story-panel">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">STORY MAP</span>
          <h2>故事线</h2>
        </div>
        <span className="signal">{ordered.length} 段</span>
      </div>

      <div
        ref={viewRef}
        className={grabbing ? "story-canvas is-grabbing" : "story-canvas"}
        onPointerDown={onPointerDown}
      >
        <svg className="story-svg" width="100%" height="100%">
          <g transform={`translate(${pan.x},${pan.y})`}>
            {lines.map(({ participant, marks, home }) => {
              const active = activeChannel === `p:${participant.id}`;
              // Every line runs the full width: a contestant with no recent clip has a quiet stretch,
              // not a missing line, and the canvas opens at the newest end where that stretch lands.
              const lastX = marks[marks.length - 1]?.x ?? PAD_X;
              const tailX = Math.max(lastX + 46, contentW + PAD_X);
              // Settle back onto the baseline right after the last clip, so a long quiet stretch
              // runs flat instead of sloping across the whole canvas.
              const tail = lastX + 46 < tailX
                ? [{ x: lastX + 46, y: home }, { x: tailX, y: home }]
                : [{ x: tailX, y: home }];
              const path = smoothPath(marks.length
                ? [{ x: PAD_X - 34, y: home }, ...marks, ...tail]
                : [{ x: PAD_X - 34, y: home }, { x: contentW + PAD_X, y: home }]);
              return (
                <g key={participant.id}>
                  <path
                    d={path}
                    fill="none"
                    stroke={participant.accent}
                    strokeWidth={active ? 3 : 2}
                    strokeLinecap="round"
                    opacity={marks.length ? (active ? 0.95 : 0.6) : 0.22}
                  />
                </g>
              );
            })}

            {lines.flatMap(({ participant, marks }) => marks.map((mark) => (
              <g key={`${participant.id}-${mark.clip.id}`} className="story-node" onClick={() => selectClip(mark.clip)}>
                <title>{mark.clip.summary ?? "等待概要"}</title>
                <circle cx={mark.x} cy={mark.y} r={14} fill="transparent" />
                {mark.clip.id === latestId && mark.own ? (
                  <circle cx={mark.x} cy={mark.y} r={10} fill="none" stroke={participant.accent} strokeWidth={1.5} opacity={0.4} />
                ) : null}
                {mark.own ? (
                  <circle cx={mark.x} cy={mark.y} r={5.5} fill={participant.accent} />
                ) : (
                  // A guest sits on the same point as the owner, so it reads as a ring around it.
                  <circle
                    cx={mark.x}
                    cy={mark.y}
                    r={9 + mark.ring * 3.5}
                    fill="none"
                    stroke={participant.accent}
                    strokeWidth={2}
                  />
                )}
              </g>
            )))}
          </g>
          {/* Names ride the vertical pan only, so they stay legible however far the map is dragged. */}
          <g transform={`translate(0,${pan.y})`}>
            {lines.map(({ participant, home }) => (
              <text key={`name-${participant.id}`} x={10} y={home - 14} className="story-name" fill={participant.accent}>
                {participant.display_name}
              </text>
            ))}
          </g>
        </svg>
      </div>

      <div className="story-note">
        {latest?.summary
          ? <p>{latest.summary}</p>
          : <p className="is-empty">还没有片段。写一条指令，故事线就会从这里长出去。</p>}
        {onComposeChannel && activeChannel !== onComposeChannel.key ? (
          <button type="button" className="timeline-compose" onClick={() => onSelectChannel(onComposeChannel.key)}>
            给 {onComposeChannel.label} 下指令 <span>→</span>
          </button>
        ) : null}
      </div>
    </aside>
  );
}
