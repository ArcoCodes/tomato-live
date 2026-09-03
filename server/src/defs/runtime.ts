// Typed runtime input keys for app code.
// VarKey and SecretKey are string literal union types, not values or config storage.
// Add a key here before using vars.get("KEY") or secret.get("KEY") in code.
// Values still come from .env.local in local dev and remote vars/secrets in deployed envs.

export type VarKey =
  | "FAL_TEXT_MODEL"
  | "FAL_VISION_MODEL"
  | "RENOISE_API_BASE_URL"
  | "RENOISE_PROXY_TOKEN"
  | "HOST_USER_EMAIL";

export type SecretKey =
  | "FAL_KEY"
  | "RENOISE_API_KEY";
