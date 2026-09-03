import { useEffect, useMemo, useState } from "react";

const FACES_SHOWN = 4;
const ROTATE_MS = 3400;

/** Every signed-out viewer is "guest-xxxx", so the prefix would give the whole row the same letter. */
function initialOf(handle: string) {
  const stripped = handle.replace(/^guest[-_]?/i, "");
  return (stripped || handle).slice(0, 1).toUpperCase();
}

// Illustrated faces from a seed, so the same handle is always the same person. Fetched rather than
// bundled: the drawing library unpacks to well over 400KB, which is a poor trade for a decorative
// header element on a page that has just been through a performance pass. These are a few KB of SVG
// the browser caches for good, and a face that fails to load falls back to the lettered chip.
const FACE_STYLE = "notionists";

function faceUrl(handle: string) {
  const seed = encodeURIComponent(handle);
  return `https://api.dicebear.com/9.x/${FACE_STYLE}/svg?seed=${seed}&backgroundColor=transparent&radius=50`;
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
              {/* The initial sits underneath as the fallback: if the drawing never arrives the chip
                  still reads as a person rather than as an empty hole. */}
              <em key={handle}>{initialOf(handle)}</em>
              <img key={`${handle}-face`} src={faceUrl(handle)} alt="" loading="lazy" decoding="async" />
            </b>
          ))}
        </span>
      ) : null}
      {count.toLocaleString()} WATCHING
    </span>
  );
}
