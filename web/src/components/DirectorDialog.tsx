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
  const [stage, setStage] = useState("等待生成");
  const [error, setError] = useState("");

  // No polling here — App runs one heartbeat for every channel. This just reads the result of it.
  useEffect(() => {
    if (!generationId) return;
    if (pendingGeneration?.id === generationId) {
      setStage(pendingGeneration.stage === "video" ? `H3 Max 正在生成 ${CLIP_SECONDS} 秒片段` : "正在提交生成任务");
      return;
    }
    setStage("片段已进入直播队列");
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
    setStage("正在准备首帧并提交 MiniMax 官方任务");
    try {
      const response = await client.api.fetch("/api/public/generations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ participantIds: selected, keyframePrompt, videoPrompt, duration: CLIP_SECONDS }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "生成任务提交失败");
      setGenerationId(result.generation.id);
      setStage(result.generation.stage === "video" ? `MiniMax H3 Max 正在生成 ${CLIP_SECONDS} 秒片段` : "正在准备首帧");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "生成任务提交失败");
      setBusy(false);
      setStage("等待生成");
    }
  }

  return (
    <div className="modal-backdrop director-backdrop">
      <div className="director-dialog" role="dialog" aria-modal="true" aria-labelledby="director-title">
        <button className="modal-close" onClick={onClose} aria-label="关闭">×</button>
        <div className="dialog-index">LIVE PIPELINE / H3 MAX</div>
        <h2 id="director-title">生成下一段</h2>
        <p className="dialog-intro">手动向总导播通道插入一段。系统优先用最近一段角色视角的尾帧作为首帧，没有素材时回退到参赛角色图。</p>

        <section className="director-section">
          <span className="step-label">01 / 角色</span>
          <div className="director-roster">
            {eligible.length ? eligible.map((participant) => (
              <button className={selected.includes(participant.id) ? "selected" : ""} onClick={() => toggleParticipant(participant.id)} key={participant.id}>
                <img src={participant.avatar_url!} alt="" />
                <span>{participant.display_name}<small>{participant.archetype}</small></span>
              </button>
            )) : <p>还没有上传角色照片的存活参赛者。</p>}
          </div>
        </section>

        <section className="director-section prompt-section">
          <label><span className="step-label">02 / 首段关键帧提示词</span><textarea value={keyframePrompt} onChange={(event) => setKeyframePrompt(event.target.value)} /></label>
          <label><span className="step-label">03 / {CLIP_SECONDS} 秒续接提示词</span><textarea value={videoPrompt} onChange={(event) => setVideoPrompt(event.target.value)} /></label>
        </section>

        {busy && <div className="pipeline-status"><i /><span>{stage}</span></div>}
        {error && <p className="form-error">{error}</p>}
        <button className="primary-action" disabled={selected.length === 0 || busy} onClick={submit}>
          {busy ? "生成进行中" : `直接生成 ${CLIP_SECONDS} 秒片段`}
        </button>
      </div>
    </div>
  );
}
