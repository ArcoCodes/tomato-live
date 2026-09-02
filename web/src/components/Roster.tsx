import type { CSSProperties } from "react";
import type { Participant } from "@/types/live";

const statusLabel = {
  ready: "Standby",
  alive: "Alive",
  danger: "In danger",
  eliminated: "Out",
};

export function Roster({ participants, selectedId }: { participants: Participant[]; selectedId?: number }) {
  const alive = participants.filter((item) => item.status !== "eliminated").length;

  return (
    <aside className="roster-panel" aria-label="Contestants">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">CONTESTANTS</span>
          <h2>Contestants</h2>
        </div>
        <span className="alive-count">{alive} ALIVE</span>
      </div>

      <div className="roster-list">
        {participants.map((participant) => (
          <article
            className={`hero-card status-${participant.status}${selectedId === participant.id ? " is-you" : ""}`}
            key={participant.id}
            style={{ "--accent": participant.accent } as CSSProperties}
          >
            <div className="hero-portrait">
              {participant.portrait_url
                ? <img src={participant.portrait_url} alt={participant.display_name} loading="lazy" />
                : <i>{participant.display_name.slice(0, 2).toUpperCase()}</i>}
              <span className="hero-status">{statusLabel[participant.status]}</span>
              {selectedId === participant.id ? <span className="hero-you">YOU</span> : null}
            </div>
            <div className="hero-meta">
              <strong>{participant.display_name}</strong>
              <span>{participant.archetype}</span>
            </div>
          </article>
        ))}
      </div>
    </aside>
  );
}
