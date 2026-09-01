import type { CSSProperties } from "react";
import type { Participant } from "@/types/live";

const statusLabel = {
  ready: "候场",
  alive: "存活",
  danger: "危险",
  eliminated: "离场",
};

export function Roster({ participants, selectedId }: { participants: Participant[]; selectedId?: number }) {
  const alive = participants.filter((item) => item.status !== "eliminated").length;

  return (
    <aside className="roster-panel" aria-label="当前参赛者">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">CONTESTANTS</span>
          <h2>参赛者</h2>
        </div>
        <span className="alive-count">{alive} ALIVE</span>
      </div>

      <div className="roster-list">
        {participants.map((participant, index) => (
          <article
            className={`roster-item status-${participant.status}${selectedId === participant.id ? " is-you" : ""}`}
            key={participant.id}
          >
            <span className="rank">{String(index + 1).padStart(2, "0")}</span>
            <div className="avatar" style={{ "--avatar-accent": participant.accent } as CSSProperties}>
              {participant.avatar_url
                ? <img src={participant.avatar_url} alt="" />
                : <span>{participant.display_name.slice(0, 2).toUpperCase()}</span>}
            </div>
            <div className="roster-copy">
              <div className="name-row">
                <strong>{participant.display_name}</strong>
                {selectedId === participant.id && <span className="you-tag">YOU</span>}
              </div>
              <span>{participant.archetype}</span>
              <div className="health-track" aria-label={`生命值 ${participant.health}`}>
                <i style={{ width: `${participant.health}%`, background: participant.accent }} />
              </div>
            </div>
            <div className="roster-state">
              <span>{statusLabel[participant.status]}</span>
              <b>{participant.score}</b>
            </div>
          </article>
        ))}
      </div>
    </aside>
  );
}
