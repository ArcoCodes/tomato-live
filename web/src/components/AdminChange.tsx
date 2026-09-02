import { useCallback, useEffect, useState } from "react";
import { LoginDialog } from "@/components/LoginDialog";
import { useAuth } from "@/hooks/useAuth";
import { client } from "@/lib/edgespark";

interface Tier {
  key: string;
  label: string;
  detail: string;
  concurrent: number;
  gapSeconds: number;
}

interface QueueLine {
  id: number;
  display_name: string;
  body: string;
  mentions: string[];
  generation_id: number | null;
  stage: string | null;
  created_at: string;
  consumed_at: string | null;
}

interface SelfDriven {
  id: number;
  stage: string;
  channel: string;
  cast: string[];
}

interface TierState {
  current: string;
  tiers: Tier[];
  running: number;
  houseUsed: number;
  houseLimit: number;
  queue: {
    waiting: QueueLine[];
    filming: QueueLine[];
    aired: QueueLine[];
    selfDriven: SelfDriven[];
  };
}

const STAGE_LABEL: Record<string, string> = {
  queued: "排队中",
  keyframe: "写分镜",
  video: "渲染中",
  completed: "已上镜",
};

function pace(tier: Tier) {
  if (tier.gapSeconds >= 3600) return `每 ${Math.round(tier.gapSeconds / 3600)} 小时一段`;
  if (tier.gapSeconds >= 60) return `每 ${Math.round(tier.gapSeconds / 60)} 分钟一段`;
  return `每 ${tier.gapSeconds} 秒一段`;
}

export function AdminChange() {
  const { user, isAuthenticated, signOut } = useAuth();
  const [state, setState] = useState<TierState | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState("");
  const [loginOpen, setLoginOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await client.api.fetch("/api/admin/generation-tier");
      const result = await response.json();
      // The framework answers an anonymous caller with its own code; that is not a message.
      if (response.status === 401 || result.error === "UNAUTHENTICATED") {
        throw new Error("请先用管理员账号登录");
      }
      if (!response.ok) throw new Error(result.error || "读取生成档位失败");
      setState(result);
      setError("");
    } catch (cause) {
      setState(null);
      setError(cause instanceof Error ? cause.message : "读取生成档位失败");
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 6000);
    return () => window.clearInterval(timer);
  }, [load, isAuthenticated]);

  async function pick(key: string) {
    if (busy || state?.current === key) return;
    setBusy(key);
    setNote("");
    try {
      const response = await client.api.fetch("/api/admin/generation-tier", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tier: key }),
      });
      const result = await response.json();
      if (response.status === 401 || result.error === "UNAUTHENTICATED") {
        throw new Error("登录已失效，请重新登录");
      }
      if (!response.ok) throw new Error(result.error || "切换失败");
      setNote(result.message ?? "已切换");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "切换失败");
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="admin-shell">
      <header className="admin-head">
        <div>
          <span className="eyebrow">RENOISE LIVE / ADMIN</span>
          <h1>生成档位</h1>
          <p>渲染是这个项目几乎全部的成本。没人看的时候把档位调低，直播不会中断，只是出片变慢。</p>
        </div>
        {isAuthenticated
          ? <button className="admin-signout" onClick={() => void signOut()}>{user?.email} · 退出</button>
          : <button className="admin-signin" onClick={() => setLoginOpen(true)}>登录</button>}
      </header>

      {error ? (
        <div className="admin-error">
          <strong>{error}</strong>
          {!isAuthenticated ? <button onClick={() => setLoginOpen(true)}>用管理员账号登录</button> : null}
        </div>
      ) : null}

      {state ? (
        <>
          <div className="admin-stats">
            <div><span>当前档位</span><strong>{state.tiers.find((item) => item.key === state.current)?.label ?? state.current}</strong></div>
            <div><span>正在渲染</span><strong>{state.running} 段</strong></div>
            <div><span>角色线累计</span><strong>{state.houseUsed} / {state.houseLimit}</strong></div>
          </div>

          <div className="admin-tiers">
            {state.tiers.map((tier) => (
              <button
                type="button"
                key={tier.key}
                className={tier.key === state.current ? "admin-tier is-current" : "admin-tier"}
                disabled={Boolean(busy)}
                onClick={() => void pick(tier.key)}
              >
                <span className="admin-tier-top">
                  <strong>{tier.label}</strong>
                  {tier.key === state.current ? <em>使用中</em> : null}
                </span>
                <p>{tier.detail}</p>
                <span className="admin-tier-meta">同时 {tier.concurrent} 段 · {pace(tier)}</span>
              </button>
            ))}
          </div>

          <section className="admin-queue">
            <h2>发言队列</h2>

            <div className="admin-queue-group">
              <span className="admin-queue-head">待拍 <b>{state.queue.waiting.length}</b></span>
              {state.queue.waiting.length === 0
                ? <p className="admin-queue-empty">队列是空的，导演会用默认剧本继续推进。</p>
                : state.queue.waiting.map((line) => (
                  <div className="admin-queue-line" key={line.id}>
                    <span>{line.display_name}</span>
                    <p>{line.body}</p>
                    {line.mentions.length ? <em>点名 {line.mentions.join("、")}</em> : null}
                  </div>
                ))}
            </div>

            {state.queue.filming.length ? (
              <div className="admin-queue-group">
                <span className="admin-queue-head">正在拍 <b>{state.queue.filming.length}</b></span>
                {state.queue.filming.map((line) => (
                  <div className="admin-queue-line is-filming" key={line.id}>
                    <span>{line.display_name}</span>
                    <p>{line.body}</p>
                    <em>{STAGE_LABEL[line.stage ?? ""] ?? line.stage} · 片段 #{line.generation_id}</em>
                  </div>
                ))}
              </div>
            ) : null}

            {state.queue.selfDriven.length ? (
              <div className="admin-queue-group">
                <span className="admin-queue-head">自动推进 <b>{state.queue.selfDriven.length}</b></span>
                {state.queue.selfDriven.map((item) => (
                  <div className="admin-queue-line is-auto" key={item.id}>
                    <p>{item.channel === "director" ? "导播镜头" : `${item.cast.join("、")} 的视角`}</p>
                    <em>{STAGE_LABEL[item.stage] ?? item.stage} · 片段 #{item.id}</em>
                  </div>
                ))}
              </div>
            ) : null}

            {state.queue.aired.length ? (
              <div className="admin-queue-group">
                <span className="admin-queue-head">最近上镜</span>
                {state.queue.aired.map((line) => (
                  <div className="admin-queue-line is-aired" key={line.id}>
                    <span>{line.display_name}</span>
                    <p>{line.body}</p>
                    <em>片段 #{line.generation_id}</em>
                  </div>
                ))}
              </div>
            ) : null}
          </section>

          {note ? <p className="admin-note">{note}</p> : null}
          {state.houseUsed >= state.houseLimit ? (
            <p className="admin-warn">角色线已达累计上限，无论哪个档位都不会再出新片段。要继续直播需要调高服务端的 HOUSE_CAST_MAX_CLIPS。</p>
          ) : null}
        </>
      ) : null}

      <LoginDialog open={loginOpen} onClose={() => { setLoginOpen(false); void load(); }} />
    </div>
  );
}
