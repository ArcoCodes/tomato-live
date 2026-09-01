import { useEffect, useRef, useState, type CSSProperties } from "react";
import { client } from "@/lib/edgespark";
import type { CharacterCost, CharacterDraft, CharacterDraftControl, PlayerControl } from "@/types/live";

const archetypes = ["野外医生", "机械师", "侦察兵", "植物学家", "攀登者", "厨师"];
const accents = ["#d8ff4f", "#ff7448", "#7ec8ff", "#f4c06a", "#c7a7ff"];
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
  const [archetype, setArchetype] = useState(archetypes[0]);
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
        const query = new URLSearchParams({ archetype, accent });
        const response = await client.api.fetch(`/api/public/character/cost?${query.toString()}`);
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "无法读取角色生成额度");
        if (!cancelled) {
          setCost(result);
          setError("");
        }
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "无法读取角色生成额度");
      }
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [accent, archetype, open, stage]);

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
        if (!response.ok) throw new Error(result.error || "角色生成状态同步失败");
        if (cancelled) return;
        setDraft(result.draft);
        setName(result.draft.displayName);
        setArchetype(result.draft.archetype);
        setAccent(result.draft.accent);
        if (result.draft.status === "ready") setStage("ready");
        if (result.draft.status === "failed") {
          setStage("failed");
          setError(result.draft.error || "角色生成失败");
        }
        if (result.draft.status === "claimed") {
          localStorage.removeItem(DRAFT_STORAGE_KEY);
          setDraftControl(null);
          setStage("form");
        }
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "角色生成状态同步失败");
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
      setError("本人照片不能超过 8MB");
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
      if (!presignResponse.ok) throw new Error(presign.error || "无法准备本人照片上传");
      const upload = await fetch(presign.uploadUrl, {
        method: "PUT",
        headers: { ...presign.requiredHeaders, "Content-Type": file.type },
        body: file,
      });
      if (!upload.ok) throw new Error("本人照片上传失败");

      const response = await client.api.fetch("/api/public/character/generations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName: name,
          archetype,
          accent,
          avatarPath: presign.path,
          creditApproved: true,
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "角色定妆图生成失败");
      const control = { publicId: result.draft.publicId, controlToken: result.controlToken };
      localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(control));
      setDraft(result.draft);
      setDraftControl(control);
      setStage("generating");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "角色创建失败，请稍后重试");
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
      if (!response.ok) throw new Error(result.error || "报名失败");
      const control = { participantId: result.participantId, controlToken: result.controlToken };
      localStorage.removeItem(DRAFT_STORAGE_KEY);
      localStorage.setItem("tomato-live-control", JSON.stringify(control));
      onJoined(control);
      onClose();
    } catch (cause) {
      setStage("ready");
      setError(cause instanceof Error ? cause.message : "报名失败，请稍后重试");
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

  const title = stage === "form" ? "先生成你的参赛角色" : stage === "ready" || stage === "joining" ? "确认角色定妆" : "角色正在成形";

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="join-dialog" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="join-title">
        <button className="modal-close" onClick={onClose} aria-label="关闭">×</button>
        <div className="dialog-index">IDENTITY FORGE / 01</div>
        <h2 id="join-title">{title}</h2>

        {stage === "form" ? (
          <>
            <p className="dialog-intro">上传本人照片作为身份参考。MiniMax 官方 API 会先生成统一世界观的角色定妆图；只有你确认后的角色图会进入名单和 H3 Max 直播。</p>
            <form onSubmit={generateCharacter}>
              <div className="identity-flow" aria-label="角色创建流程">
                <span className="active"><b>01</b>本人照片</span><i>→</i><span><b>02</b>角色定妆</span><i>→</i><span><b>03</b>确认参赛</span>
              </div>

              <label className="upload-zone">
                {preview ? <img src={preview} alt="本人照片预览" /> : <span><b>+</b> 上传本人照片<small>清晰正面照 · JPG / PNG / WEBP · 最大 8MB</small></span>}
                <input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => { setFile(event.target.files?.[0] || null); setCreditApproved(false); }} />
              </label>

              <label className="field-label">
                <span>参赛名</span>
                <input value={name} onChange={(event) => setName(event.target.value)} maxLength={20} placeholder="例如：北岸来客" required />
              </label>

              <fieldset>
                <legend>生存专长</legend>
                <div className="choice-grid">
                  {archetypes.map((item) => (
                    <button type="button" className={item === archetype ? "selected" : ""} onClick={() => { setArchetype(item); setCreditApproved(false); }} key={item}>{item}</button>
                  ))}
                </div>
              </fieldset>

              <fieldset>
                <legend>识别色</legend>
                <div className="accent-row">
                  {accents.map((item) => (
                    <button type="button" aria-label={`选择 ${item}`} className={item === accent ? "selected" : ""} style={{ background: item }} onClick={() => { setAccent(item); setCreditApproved(false); }} key={item} />
                  ))}
                </div>
              </fieldset>

              <details className="prompt-disclosure">
                <summary>查看完整角色生成提示词</summary>
                <pre>{cost?.prompt || "正在读取生成配置…"}</pre>
              </details>

              <label className="credit-consent">
                <input type="checkbox" checked={creditApproved} onChange={(event) => setCreditApproved(event.target.checked)} />
                <span>我已查看完整提示词，并确认由 {cost?.displayName || "MiniMax 图片模型"} 生成 1 张角色定妆图。</span>
              </label>

              {cost?.notice && <p className="channel-notice">{cost.notice}</p>}
              {error && <p className="form-error">{error}</p>}
              <button className="primary-action" disabled={busy || name.trim().length < 2 || !file || !cost?.available || !cost.sufficient || !creditApproved}>
                {busy ? "正在提交角色生成…" : "生成我的参赛角色"}
              </button>
              <p className="consent-copy">原照片仅作为角色身份参考；定妆图完成后，本站会删除原照片存储副本。请仅上传你有权使用的照片。</p>
            </form>
          </>
        ) : stage === "generating" ? (
          <section className="character-progress" aria-live="polite">
            <div className="forge-visual"><i /><span>{draft?.displayName?.slice(0, 1) || "?"}</span><b /></div>
            <p>MiniMax 正在保留你的面部身份，并将服装、姿态与背景重塑为 <strong>{draft?.archetype || "生存挑战者"}</strong>。</p>
            <div className="progress-steps"><span className="done">照片已加密上传</span><span className="active">角色定妆生成中</span><span>等待你的确认</span></div>
            {error && <p className="form-error">{error}</p>}
            <small>可以关闭窗口，稍后回来会继续读取同一个任务，不会重复扣费。</small>
          </section>
        ) : stage === "failed" ? (
          <section className="character-failed">
            <span>GENERATION INTERRUPTED</span>
            <p>{error || draft?.error || "角色生成失败"}</p>
            <button className="primary-action" onClick={startOver}>重新开始</button>
          </section>
        ) : (
          <section className="character-ready">
            <div className="character-card" style={{ "--character-accent": draft?.accent } as CSSProperties}>
              {draft?.characterUrl && <img src={draft.characterUrl} alt={`${draft.displayName} 的角色定妆图`} />}
              <div><span>CONTESTANT READY</span><strong>{draft?.displayName}</strong><b>{draft?.archetype}</b></div>
            </div>
            <p>这张定妆图将代替原照片出现在参赛名单中，并作为后续比赛镜头的角色身份锚点。</p>
            {error && <p className="form-error">{error}</p>}
            <div className="ready-actions">
              <button className="secondary-action" onClick={startOver} disabled={stage === "joining"}>放弃此角色</button>
              <button className="primary-action" onClick={joinMatch} disabled={stage === "joining"}>{stage === "joining" ? "正在进入候场区…" : "确认角色并参赛"}</button>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
