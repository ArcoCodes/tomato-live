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

      {/* Faces only: the cast keeps growing, and names would set the panel's floor width. */}
      <div className="roster-list">
        {participants.map((participant) => (
          <div
            className={`roster-face status-${participant.status}${selectedId === participant.id ? " is-you" : ""}`}
            key={participant.id}
            style={{ "--avatar-accent": participant.accent } as CSSProperties}
            title={`${participant.display_name} · ${participant.archetype} · ${statusLabel[participant.status]}`}
          >
            {participant.portrait_url
              ? <img src={participant.portrait_url} alt={participant.display_name} loading="lazy" />
              : <span>{participant.display_name.slice(0, 2).toUpperCase()}</span>}
          </div>
        ))}
      </div>
    </aside>
  );
}
