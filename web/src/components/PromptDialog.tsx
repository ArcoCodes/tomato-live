import { useEffect, useState } from "react";

interface ClipPrompt {
  id: number;
  channel: string;
  created_at: string;
  duration_seconds: number;
  summary: string | null;
  cast: string[];
  instruction: string | null;
  asked_by: string | null;
  prompt: string | null;
}

/**
 * What made one clip. The instruction sits at the top on its own because that is the part a viewer
 * recognises — often their own line — and the full prompt below is the machinery behind it.
 */
export function PromptDialog({ clipId, onClose }: { clipId: number; onClose: () => void }) {
  const [data, setData] = useState<ClipPrompt | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    setData(null);
    setError("");
    fetch(`/api/public/clips/${clipId}/prompt`)
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error("unavailable"))))
      .then((payload: ClipPrompt) => { if (live) setData(payload); })
      .catch(() => { if (live) setError("That clip's prompt could not be loaded."); });
    return () => { live = false; };
  }, [clipId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="prompt-backdrop" onClick={onClose} role="presentation">
      <div className="prompt-dialog" onClick={(event) => event.stopPropagation()} role="dialog" aria-label="Clip prompt">
        <div className="prompt-head">
          <span className="eyebrow">SHOT #{clipId}</span>
          <button type="button" className="prompt-close" onClick={onClose} aria-label="Close">✕</button>
        </div>

        {error ? <p className="prompt-empty">{error}</p> : null}
        {!data && !error ? <p className="prompt-empty">Loading…</p> : null}

        {data ? (
          <>
            {data.instruction ? (
              <div className="prompt-block is-lead">
                <span className="eyebrow">
                  {data.asked_by ? `ASKED FOR BY ${data.asked_by.toUpperCase()}` : "THE SHOW'S OWN CUE"}
                </span>
                <p>{data.instruction}</p>
              </div>
            ) : (
              <div className="prompt-block is-lead">
                <span className="eyebrow">DIRECTOR CUT</span>
                <p>A wide view of the shot it was cut from — nobody asked for this one.</p>
              </div>
            )}

            {data.summary ? (
              <div className="prompt-block">
                <span className="eyebrow">WHAT HAPPENED</span>
                <p>{data.summary}</p>
              </div>
            ) : null}

            <div className="prompt-block">
              <span className="eyebrow">SENT TO THE MODEL</span>
              <pre>{data.prompt ?? "This clip predates prompt capture."}</pre>
            </div>

            <p className="prompt-foot">
              {data.cast.join(", ")} · {data.duration_seconds}s
            </p>
          </>
        ) : null}
      </div>
    </div>
  );
}
