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
        theme: AUTH_UI_THEME.LIGHT,
        variables: {
          [AUTH_UI_APPEARANCE_VARIABLE.PRIMARY]: "#e64b22",
        },
      },
    });
    return () => mounted.destroy();
  }, [open]);

  if (!open) return null;
  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="auth-dialog" role="dialog" aria-modal="true" aria-label="Sign in">
        <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
        <div className="dialog-index">ACCOUNT</div>
        <h2>Sign in to join</h2>
        <p>Contestants belong to your account, so a new device or a cleared browser never costs you control of yours.</p>
        <div ref={mountRef} />
      </div>
    </div>
  );
}
