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

interface TierState {
  current: string;
  tiers: Tier[];
  running: number;
  houseUsed: number;
  houseLimit: number;
}

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
