import { useEffect, useMemo, useState } from "react";
import { client } from "@/lib/edgespark";
import type { Participant, PendingGeneration } from "@/types/live";

const CLIP_SECONDS = 10;

const defaultKeyframePrompt = `Create a cinematic 16:9 opening frame for a survival challenge. Preserve the identities of every supplied participant reference. They stand in a rain-soaked tropical forest beside a damaged emergency beacon at blue hour. Practical expedition clothing, wet fabric, muddy skin, urgent but physically plausible body language. Documentary camera, 35mm lens, grounded realism, deep olive shadows and warm amber utility lights. No visible text anywhere, no subtitles, no captions, no labels, no HUD, no UI overlay, no scoreboard, no status bars, no logos, no watermark, no duplicate people, no costume changes, no deformed hands, no glossy game-CG.`;

const defaultVideoPrompt = `Continue the survival challenge for 10 seconds. The contestants work together to restart the damaged emergency beacon while heavy wind pushes through the trees. One contestant braces the antenna, another connects the battery, and the beacon suddenly flashes amber. Slow handheld push-in, medium camera movement, natural physical motion, wind, rain and distant thunder. Maintain the current identities, clothing, positions, documentary realism and color grade. Single unbroken shot, no cuts, no dialogue. No visible text anywhere, no subtitles, no captions, no labels, no HUD, no UI overlay, no scoreboard, no status bars, no logos, no watermark, no new people, no face morphing.`;

export function DirectorDialog({ open, onClose, participants, pendingGeneration, onCompleted }: {
  open: boolean;
  onClose: () => void;
  participants: Participant[];
  /** The director channel's in-flight task, if any. App owns the sync polling for every channel. */
  pendingGeneration: PendingGeneration | null;
  onCompleted: () => void;
}) {
  const eligible = useMemo(() => participants.filter((item) => item.avatar_url && item.status !== "eliminated"), [participants]);
  const [selected, setSelected] = useState<number[]>([]);
  const [keyframePrompt, setKeyframePrompt] = useState(defaultKeyframePrompt);
  const [videoPrompt, setVideoPrompt] = useState(defaultVideoPrompt);
  const [busy, setBusy] = useState(false);
  const [generationId, setGenerationId] = useState<number | null>(null);
  const [stage, setStage] = useState("Idle");
  const [error, setError] = useState("");

  // No polling here — App runs one heartbeat for every channel. This just reads the result of it.
  useEffect(() => {
    if (!generationId) return;
    if (pendingGeneration?.id === generationId) {
      setStage(pendingGeneration.stage === "video" ? `H3 Max is rendering a ${CLIP_SECONDS}s clip` : "Submitting the job");
      return;
    }
    setStage("Clip is in the broadcast queue");
    setGenerationId(null);
    setBusy(false);
    onCompleted();
  }, [generationId, onCompleted, pendingGeneration?.id, pendingGeneration?.stage]);

  if (!open) return null;

  function toggleParticipant(id: number) {
    setSelected((current) => current.includes(id)
      ? current.filter((item) => item !== id)
      : current.length < 3 ? [...current, id] : current);
  }

  async function submit() {
    setBusy(true);
    setError("");
    setStage("Preparing the opening frame and submitting to MiniMax");
    try {
      // Host-only now: the public create endpoint took an arbitrary prompt from anyone.
      const response = await client.api.fetch("/api/director/generations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ participantIds: selected, keyframePrompt, videoPrompt, duration: CLIP_SECONDS }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not submit the job");
      setGenerationId(result.generation.id);
      setStage(result.generation.stage === "video" ? `MiniMax H3 Max is rendering a ${CLIP_SECONDS}s clip` : "Preparing the opening frame");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not submit the job");
      setBusy(false);
      setStage("Idle");
    }
  }

  return (
    <div className="modal-backdrop director-backdrop">
      <div className="director-dialog" role="dialog" aria-modal="true" aria-labelledby="director-title">
        <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
        <div className="dialog-index">LIVE PIPELINE / H3 MAX</div>
        <h2 id="director-title">Cut the next clip</h2>
        <p className="dialog-intro">Insert a clip into the director channel by hand. It opens on the most recent contestant tail frame, falling back to a character sheet when there is no footage.</p>

        <section className="director-section">
          <span className="step-label">01 / CAST</span>
          <div className="director-roster">
            {eligible.length ? eligible.map((participant) => (
              <button className={selected.includes(participant.id) ? "selected" : ""} onClick={() => toggleParticipant(participant.id)} key={participant.id}>
                <img src={(participant.portrait_url ?? participant.avatar_url)!} alt="" />
                <span>{participant.display_name}<small>{participant.archetype}</small></span>
              </button>
            )) : <p>No living contestant has a character sheet yet.</p>}
          </div>
        </section>

        <section className="director-section prompt-section">
          <label><span className="step-label">02 / OPENING FRAME PROMPT</span><textarea value={keyframePrompt} onChange={(event) => setKeyframePrompt(event.target.value)} /></label>
          <label><span className="step-label">03 / {CLIP_SECONDS}s SHOT PROMPT</span><textarea value={videoPrompt} onChange={(event) => setVideoPrompt(event.target.value)} /></label>
        </section>

        {busy && <div className="pipeline-status"><i /><span>{stage}</span></div>}
        {error && <p className="form-error">{error}</p>}
        <button className="primary-action" disabled={selected.length === 0 || busy} onClick={submit}>
          {busy ? "Rendering" : `Film a ${CLIP_SECONDS}s clip`}
        </button>
      </div>
    </div>
  );
}
