import { useEffect, useRef, useState, type CSSProperties } from "react";
import { client } from "@/lib/edgespark";
import type { CharacterCost, CharacterDraft, CharacterDraftControl, PlayerControl } from "@/types/live";

const accents = ["#e64b22", "#1d7874", "#b4530a", "#4a4e9c", "#a6273f"];
const DRAFT_STORAGE_KEY = "tomato-live-character-draft";

interface JoinDialogProps {
  open: boolean;
  onClose: () => void;
  onJoined: (control: PlayerControl) => void;
}

type Stage = "form" | "generating" | "ready" | "failed" | "joining";

function readDraftControl(): CharacterDraftControl | null {
  try {
    const value = localStorage.getItem(DRAFT_STORAGE_KEY);
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

export function JoinDialog({ open, onClose, onJoined }: JoinDialogProps) {
  const [name, setName] = useState("");
  const [concept, setConcept] = useState("");
  const [accent, setAccent] = useState(accents[0]);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [cost, setCost] = useState<CharacterCost | null>(null);
  const [creditApproved, setCreditApproved] = useState(false);
  const [draft, setDraft] = useState<CharacterDraft | null>(null);
  const [draftControl, setDraftControl] = useState<CharacterDraftControl | null>(null);
  const [stage, setStage] = useState<Stage>("form");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!file) return setPreview(null);
    const next = URL.createObjectURL(file);
    setPreview(next);
    return () => URL.revokeObjectURL(next);
  }, [file]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!open || draftControl) return;
    const saved = readDraftControl();
    if (saved) {
      setDraftControl(saved);
      setStage("generating");
    }
  }, [draftControl, open]);

  useEffect(() => {
    if (!open || stage !== "form") return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const response = await client.api.fetch("/api/public/character/cost");
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Could not read the character quota");
        if (!cancelled) {
          setCost(result);
          setError("");
        }
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Could not read the character quota");
      }
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, stage]);

  useEffect(() => {
    if (!open || !draftControl || stage !== "generating") return;
    const control = draftControl;
    let cancelled = false;
    let running = false;
    async function sync() {
      if (running || cancelled) return;
      running = true;
      try {
        const response = await client.api.fetch(`/api/public/character/generations/${control.publicId}/sync`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ controlToken: control.controlToken }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Could not sync the character job");
        if (cancelled) return;
        setDraft(result.draft);
        setName(result.draft.displayName);
        setAccent(result.draft.accent);
        if (result.draft.status === "ready") setStage("ready");
        if (result.draft.status === "failed") {
          setStage("failed");
          setError(result.draft.error || "Character generation failed");
        }
        if (result.draft.status === "claimed") {
          localStorage.removeItem(DRAFT_STORAGE_KEY);
          setDraftControl(null);
          setStage("form");
        }
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Could not sync the character job");
      } finally {
        running = false;
      }
    }
    void sync();
    const timer = window.setInterval(() => void sync(), 4000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [draftControl, open, stage]);

  if (!open) return null;

  async function generateCharacter(event: React.FormEvent) {
    event.preventDefault();
    if (!file || !cost || !creditApproved) return;
    if (file.size > 8 * 1024 * 1024) {
      setError("Your photo must be under 8MB");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const presignResponse = await client.api.fetch("/api/public/avatar/presign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: file.name, contentType: file.type }),
      });
      const presign = await presignResponse.json();
      if (!presignResponse.ok) throw new Error(presign.error || "Could not prepare the photo upload");
      const upload = await fetch(presign.uploadUrl, {
        method: "PUT",
        headers: { ...presign.requiredHeaders, "Content-Type": file.type },
        body: file,
      });
      if (!upload.ok) throw new Error("Photo upload failed");

      const response = await client.api.fetch("/api/public/character/generations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName: name,
          concept,
          accent,
          avatarPath: presign.path,
          creditApproved: true,
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Character sheet generation failed");
      const control = { publicId: result.draft.publicId, controlToken: result.controlToken };
      localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(control));
      setDraft(result.draft);
      setDraftControl(control);
      setStage("generating");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Character creation failed — try again shortly");
    } finally {
      setBusy(false);
    }
  }

  async function joinMatch() {
    if (!draftControl || !draft || draft.status !== "ready") return;
    setStage("joining");
    setError("");
    try {
      const response = await client.api.fetch("/api/public/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          characterPublicId: draftControl.publicId,
          characterToken: draftControl.controlToken,
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not enter");
      const control = { participantId: result.participantId, controlToken: result.controlToken };
      localStorage.removeItem(DRAFT_STORAGE_KEY);
      // App owns the control list; writing here used to overwrite the previous character's token.
      onJoined(control);
      onClose();
    } catch (cause) {
      setStage("ready");
      setError(cause instanceof Error ? cause.message : "Could not enter — try again shortly");
    }
  }

  function startOver() {
    localStorage.removeItem(DRAFT_STORAGE_KEY);
    setDraftControl(null);
    setDraft(null);
    setFile(null);
    setCreditApproved(false);
    setError("");
    setStage("form");
  }

  const title = stage === "form" ? "Create your contestant" : stage === "ready" || stage === "joining" ? "Confirm your character sheet" : "Your contestant is taking shape";

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="join-dialog" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="join-title">
        <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
        <div className="dialog-index">IDENTITY FORGE / 01</div>
        <h2 id="join-title">{title}</h2>

        {stage === "form" ? (
          <>
            <p className="dialog-intro">Upload a photo of yourself as the identity reference. MiniMax generates a character sheet in the show\u2019s world; only the sheet you confirm enters the roster and the broadcast.</p>
            <form onSubmit={generateCharacter}>
              <div className="identity-flow" aria-label="Character creation steps">
                <span className="active"><b>01</b>Your photo</span><i>→</i><span><b>02</b>Character sheet</span><i>→</i><span><b>03</b>Confirm</span>
              </div>

              <label className="upload-zone">
                {preview ? <img src={preview} alt="Photo preview" /> : <span><b>+</b> Upload your photo<small>Clear, front-facing · JPG / PNG / WEBP · 8MB max</small></span>}
                <input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => { setFile(event.target.files?.[0] || null); setCreditApproved(false); }} />
              </label>

              <label className="field-label">
                <span>Contestant name</span>
                <input value={name} onChange={(event) => setName(event.target.value)} maxLength={20} placeholder="e.g. North Shore" required />
              </label>

              <label className="field-label">
                <span>What kind of contestant do you want to be</span>
                <textarea
                  value={concept}
                  onChange={(event) => { setConcept(event.target.value); setCreditApproved(false); }}
                  maxLength={300}
                  rows={3}
                  placeholder="Anything: who you are, your temper, what you carry, what makes you unmistakable at a glance…"
                  required
                />
                <small>The director expands this into a full brief and gives you one unmistakable signature feature.</small>
              </label>

              <fieldset>
                <legend>Accent colour</legend>
                <div className="accent-row">
                  {accents.map((item) => (
                    <button type="button" aria-label={`Choose ${item}`} className={item === accent ? "selected" : ""} style={{ background: item }} onClick={() => { setAccent(item); setCreditApproved(false); }} key={item} />
                  ))}
                </div>
              </fieldset>

              <label className="credit-consent">
                <input type="checkbox" checked={creditApproved} onChange={(event) => setCreditApproved(event.target.checked)} />
                <span>I agree the director may expand my description and generate one character sheet with {cost?.displayName || "the MiniMax image model"}. One contestant per account.</span>
              </label>

              {cost?.notice && <p className="channel-notice">{cost.notice}</p>}
              {error && <p className="form-error">{error}</p>}
              <button className="primary-action" disabled={busy || name.trim().length < 2 || concept.trim().length < 4 || !file || !cost?.available || !cost.sufficient || !creditApproved}>
                {busy ? "Submitting…" : "Create my contestant"}
              </button>
              <p className="consent-copy">Your photo is used only as an identity reference and its stored copy is deleted once the sheet is made. Upload only a photo you have the right to use.</p>
            </form>
          </>
        ) : stage === "generating" ? (
          <section className="character-progress" aria-live="polite">
            <div className="forge-visual"><i /><span>{draft?.displayName?.slice(0, 1) || "?"}</span><b /></div>
            <p>MiniMax is keeping your face and rebuilding the wardrobe, pose and background as <strong>{draft?.archetype || "a survival contestant"}</strong>.</p>
            <div className="progress-steps"><span className="done">Photo uploaded</span><span className="active">Making the sheet</span><span>Your confirmation</span></div>
            {error && <p className="form-error">{error}</p>}
            <small>You can close this window; coming back picks up the same job without paying twice.</small>
          </section>
        ) : stage === "failed" ? (
          <section className="character-failed">
            <span>GENERATION INTERRUPTED</span>
            <p>{error || draft?.error || "Character generation failed"}</p>
            <button className="primary-action" onClick={startOver}>Start over</button>
          </section>
        ) : (
          <section className="character-ready">
            <div className="character-card" style={{ "--character-accent": draft?.accent } as CSSProperties}>
              {draft?.characterUrl && <img src={draft.characterUrl} alt={`Character sheet for ${draft.displayName}`} />}
              <div><span>CONTESTANT READY</span><strong>{draft?.displayName}</strong><b>{draft?.archetype}</b></div>
            </div>
            <p>This sheet replaces your photo on the roster and anchors your identity in every shot that follows.</p>
            {error && <p className="form-error">{error}</p>}
            <div className="ready-actions">
              <button className="secondary-action" onClick={startOver} disabled={stage === "joining"}>Discard</button>
              <button className="primary-action" onClick={joinMatch} disabled={stage === "joining"}>{stage === "joining" ? "Entering…" : "Confirm and enter"}</button>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
