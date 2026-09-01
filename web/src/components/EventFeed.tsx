import type { MatchEvent } from "@/types/live";

function relativeTime(value: string) {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return `${seconds || 1}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

export function EventFeed({ events }: { events: MatchEvent[] }) {
  return (
    <aside className="events-panel" aria-label="实时事件">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">WORLD FEED</span>
          <h2>实时事件</h2>
        </div>
        <span className="signal">SIGNAL 98%</span>
      </div>
      <div className="event-list">
        {events.map((event, index) => (
          <article className={`event-item event-${event.kind}`} key={event.id} style={{ animationDelay: `${Math.min(index, 6) * 70}ms` }}>
            <div className="event-meta">
              <span>R{String(event.round).padStart(2, "0")}</span>
              <time>{relativeTime(event.created_at)}</time>
            </div>
            <h3>{event.title}</h3>
            <p>{event.detail}</p>
          </article>
        ))}
      </div>
    </aside>
  );
}
