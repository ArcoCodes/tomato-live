import { useEffect, useMemo, useState } from "react";

const FACES_SHOWN = 4;
const ROTATE_MS = 3400;

/** Every signed-out viewer is "guest-xxxx", so the prefix would give the whole row the same letter. */
function initialOf(handle: string) {
  const stripped = handle.replace(/^guest[-_]?/i, "");
  return (stripped || handle).slice(0, 1).toUpperCase();
}

/** Stable colour per handle, so the same person keeps the same chip between rotations. */
function hueOf(handle: string) {
  let hash = 0;
  for (let i = 0; i < handle.length; i += 1) hash = (hash * 31 + handle.charCodeAt(i)) % 360;
  return hash;
}

/**
 * The headcount, with the room's own handles cycling beside it. The faces are the people whose
 * lines are in chat — the same population the number counts, not a decorative stock facepile.
 */
export function ViewerCount({ count, handles }: { count: number; handles: string[] }) {
  const rosterKey = handles.join("\u0000");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const roster = useMemo(() => [...new Set(handles)].filter(Boolean), [rosterKey]);
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    if (roster.length <= FACES_SHOWN) return;
    const timer = window.setInterval(() => setOffset((at) => (at + 1) % roster.length), ROTATE_MS);
    return () => window.clearInterval(timer);
  }, [roster.length]);

  const shown = roster.length
    ? Array.from({ length: Math.min(FACES_SHOWN, roster.length) }, (_, i) => roster[(offset + i) % roster.length])
    : [];

  return (
    <span className="viewer-count">
      <i aria-hidden="true" />
      {shown.length ? (
        <span className="viewer-faces" aria-hidden="true">
          {shown.map((handle, index) => (
            // Keyed by slot, not by handle: the chip stays put and its occupant fades over.
            <b key={index} style={{ "--hue": hueOf(handle), zIndex: FACES_SHOWN - index } as React.CSSProperties}>
              <em key={handle}>{initialOf(handle)}</em>
            </b>
          ))}
        </span>
      ) : null}
      {count.toLocaleString()} WATCHING
    </span>
  );
}
