import { useEffect, useRef } from "react";
import { client } from "@/lib/edgespark";

export interface TailFrameTarget {
  id: number;
  /** Where the clip plays from: the public bucket address, or the same-origin proxy as fallback. */
  src: string;
}

/**
 * MiniMax H3-Max can only be handed one opening image, so every channel continues by starting from
 * its own previous clip's last frame. EdgeSpark has no scheduler and cannot decode video, so the
 * frame is captured here. The clip is loaded with crossOrigin="anonymous": the public bucket answers
 * with CORS headers and the same-origin proxy needs none, so either way the canvas stays untainted
 * and `toBlob` works.
 *
 * Runs off to the side of playback — it never touches the visible player.
 */
export function useTailFrameHarvester(wanted: TailFrameTarget[], onCaptured: () => void) {
  const doneRef = useRef(new Set<number>());
  const busyRef = useRef(false);
  const onCapturedRef = useRef(onCaptured);
  onCapturedRef.current = onCaptured;

  useEffect(() => {
    const pending = wanted.filter((item) => !doneRef.current.has(item.id));
    if (pending.length === 0 || busyRef.current) return;

    let cancelled = false;
    busyRef.current = true;

    async function captureOne({ id, src }: TailFrameTarget) {
      const video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.preload = "auto";
      video.crossOrigin = "anonymous";
      video.src = src;
      try {
        await new Promise<void>((resolve, reject) => {
          const fail = () => reject(new Error(`clip ${id} failed to load`));
          video.onerror = fail;
          video.onloadedmetadata = () => resolve();
          window.setTimeout(fail, 20000);
        });
        const target = Number.isFinite(video.duration) ? Math.max(0, video.duration - 0.05) : 0;
        await new Promise<void>((resolve, reject) => {
          video.onseeked = () => resolve();
          video.onerror = () => reject(new Error(`clip ${id} failed to seek`));
          window.setTimeout(() => reject(new Error(`clip ${id} seek timed out`)), 20000);
          video.currentTime = target;
        });
        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        if (!canvas.width || !canvas.height) throw new Error(`clip ${id} has no picture`);
        const context = canvas.getContext("2d");
        if (!context) throw new Error("canvas 2d context unavailable");
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
        if (!blob) throw new Error(`clip ${id} produced no frame`);
        const response = await client.api.fetch(`/api/public/clips/${id}/tail-frame`, {
          method: "POST",
          headers: { "Content-Type": "image/jpeg" },
          body: blob,
        });
        if (!response.ok) throw new Error(`clip ${id} upload rejected (${response.status})`);
        return true;
      } finally {
        video.removeAttribute("src");
        video.load();
      }
    }

    void (async () => {
      let captured = false;
      for (const target of pending) {
        if (cancelled) break;
        // Mark first: a clip that cannot be captured must not be retried on every poll.
        doneRef.current.add(target.id);
        try {
          if (await captureOne(target)) captured = true;
        } catch {
          // A single unreadable clip must not stall the rest of the queue.
        }
      }
      busyRef.current = false;
      if (captured && !cancelled) onCapturedRef.current();
    })();

    return () => { cancelled = true; };
  }, [wanted]);
}
