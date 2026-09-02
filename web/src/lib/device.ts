const DEVICE_KEY = "renoise-live-device";

/**
 * A per-browser id. Chatting needs no account, so this is what carries a viewer's message
 * allowance. Clearing site data resets it — that is the trade for not gating speech behind sign-in.
 */
export function deviceId(): string {
  try {
    const stored = localStorage.getItem(DEVICE_KEY);
    if (stored && /^[A-Za-z0-9_-]{8,64}$/.test(stored)) return stored;
    const next = crypto.randomUUID().replace(/-/g, "");
    localStorage.setItem(DEVICE_KEY, next);
    return next;
  } catch {
    // Private windows can refuse storage; the id then lasts only as long as the page does.
    return crypto.randomUUID().replace(/-/g, "");
  }
}

export const deviceHeaders = { "X-Device-Id": deviceId() };
