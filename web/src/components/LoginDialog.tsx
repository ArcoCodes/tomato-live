import { useEffect, useRef } from "react";
import { AUTH_UI_APPEARANCE_VARIABLE, AUTH_UI_THEME } from "@edgespark/web";
import { client } from "@/lib/edgespark";

export function LoginDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open || !mountRef.current) return;
    const mounted = client.authUI.mount(mountRef.current, {
      onSuccess: () => onCloseRef.current(),
      appearance: {
        theme: AUTH_UI_THEME.DARK,
        variables: {
          [AUTH_UI_APPEARANCE_VARIABLE.PRIMARY]: "#d8ff4f",
        },
      },
    });
    return () => mounted.destroy();
  }, [open]);

  if (!open) return null;
  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="auth-dialog" role="dialog" aria-modal="true" aria-label="导演登录">
        <button className="modal-close" onClick={onClose} aria-label="关闭">×</button>
        <div className="dialog-index">DIRECTOR ACCESS</div>
        <h2>进入导演台</h2>
        <p>生成操作会调用 MiniMax 官方 API，仅活动导演账号可以执行。</p>
        <div ref={mountRef} />
      </div>
    </div>
  );
}
