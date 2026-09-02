import { useEffect, useRef, useState } from "react";
import type { BroadcastClip, Participant } from "@/types/live";

const LANE_H = 46;
const STEP = 74;
const PAD_X = 40;
const PAD_Y = 26;
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

  // Open on the newest end of the story; that is where the live edge is.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    setPan({ x: Math.min(0, view.clientWidth - contentW - PAD_X), y: 0 });
  }, [contentW]);

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

  return (
    <section className="match-timeline">
      <div className="timeline-head">
        <div>
          <span className="eyebrow">STORY MAP</span>
          <b>{ordered.length} 段 · 可拖动查看 · 线交汇处是两人同框的时刻</b>
        </div>
        {onComposeChannel ? (
          <button type="button" className="timeline-compose" onClick={() => onSelectChannel(onComposeChannel.key)}>
            给 {onComposeChannel.label} 下指令 <span>→</span>
          </button>
        ) : null}
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
              const path = smoothPath(marks.length
                ? [{ x: PAD_X - 34, y: home }, ...marks, { x: (marks[marks.length - 1]?.x ?? PAD_X) + 46, y: home }]
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
          {/* Names ride the vertical pan only, so they stay legible however far the story is dragged. */}
          <g transform={`translate(0,${pan.y})`}>
            {lines.map(({ participant, home }) => (
              <text key={`name-${participant.id}`} x={10} y={home - 14} className="story-name" fill={participant.accent}>
                {participant.display_name}
              </text>
            ))}
          </g>
        </svg>
      </div>
    </section>
  );
}
