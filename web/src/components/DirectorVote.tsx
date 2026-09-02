import { useEffect, useRef, useState } from "react";
import { client } from "@/lib/edgespark";
import type { DirectorVote as VoteData } from "@/types/live";

/**
 * The fork viewers steer. Both candidates are already generating while this is on screen, so the
 * winner can air as soon as the current clip ends — the vote decides which one is kept, not when
 * generation starts.
 */
export function DirectorVote({ vote, onVoted }: { vote: VoteData; onVoted: () => void }) {
  const [remaining, setRemaining] = useState(0);
  // Optimistic: the poll that confirms it is up to 2s away, and the window is only 10s.
  const [picked, setPicked] = useState<"a" | "b" | null>(vote.my_vote);
  const roundRef = useRef(vote.id);

  if (roundRef.current !== vote.id) {
    roundRef.current = vote.id;
    if (picked !== vote.my_vote) setPicked(vote.my_vote);
  }

  useEffect(() => {
    const tick = () => setRemaining(Math.max(0, Math.ceil((Date.parse(vote.closes_at) - Date.now()) / 1000)));
    tick();
    const timer = window.setInterval(tick, 250);
    return () => window.clearInterval(timer);
  }, [vote.closes_at]);

  const total = vote.options.reduce((sum, item) => sum + item.votes, 0);

  async function cast(option: "a" | "b") {
    if (picked || remaining <= 0) return;
    setPicked(option);
    try {
      await client.api.fetch("/api/public/director/vote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roundId: vote.id, option }),
      });
      onVoted();
    } catch {
      setPicked(vote.my_vote);
    }
  }

  return (
    <div className="vote-bar">
      <div className="vote-head">
        <span>下一段往哪走</span>
        <b className={remaining <= 3 ? "is-urgent" : ""}>{remaining}s</b>
      </div>
      <div className="vote-options">
        {vote.options.map((option) => {
          const share = total ? Math.round((option.votes / total) * 100) : 0;
          return (
            <button
              key={option.key}
              type="button"
              className={picked === option.key ? "vote-option is-picked" : "vote-option"}
              disabled={Boolean(picked) || remaining <= 0}
              onClick={() => void cast(option.key)}
            >
              <i style={{ width: `${share}%` }} />
              <strong>{option.label}</strong>
              <small>{option.votes} 票</small>
            </button>
          );
        })}
      </div>
    </div>
  );
}
