import { and, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, ne, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { ctx, db, secret, storage, vars } from "edgespark";
import { auth } from "edgespark/http";
import { buckets, characterDrafts, chatMessages, generations, matchEvents, matches, participants, runtimeLeases, viewerPerks, viewerPresence } from "@defs";

const LIVE_SLUG = "island-zero";
const RENOISE_DEFAULT_BASE_URL = "https://www.renoise.ai/api/public/v1";
const CHARACTER_MODEL = "image-01";
// The character sheet doubles as the opening frame of that contestant's channel, and the model takes
// the video ratio from the input image (`ratio` is ignored for image-to-video), so the sheet's
// aspect ratio IS the broadcast's aspect ratio. Portrait, because most of the audience is on a phone.
const CHARACTER_RATIO = "9:16";
const CHARACTER_RESOLUTION = "768x1366";
const LIVE_VIDEO_MODEL = "minimax/h3-max-turbo";
const LEGACY_LIVE_VIDEO_MODEL = "hailuo-h3-max";
const LIVE_VIDEO_RESOLUTION = "480P";
const LIVE_VIDEO_DURATION_SECONDS = 10;
const CHARACTER_RATE_LIMIT_PER_HOUR = 3;
// Everyone gets one contestant; the host account runs the show and needs several.
const CHARACTER_LIMIT_PER_USER = 1;
// Character creation is closed while the house cast carries the show. Flip to true to reopen it.
const CHARACTER_CREATION_OPEN = false;
const CHARACTER_CREATION_CLOSED_NOTICE = "Character creation opens soon — hang tight.";
const CHARACTER_LIMIT_HOST = 12;
// Mid-dark hues: they sit on white with enough contrast to carry white text in the avatar tile.
const ACCENTS = ["#e64b22", "#1d7874", "#b4530a", "#4a4e9c", "#a6273f"];
const LIVE_PROMPT_VERSION = "channel-v3";
// Older clips still carry usable visual memory, so they stay readable as continuity sources.
const CONTINUABLE_PROMPT_VERSIONS = new Set(["textless-v2", LIVE_PROMPT_VERSION]);
const VIEWER_PROMPT_MAX_CHARS = 300;
const TAIL_FRAME_MAX_BYTES = 4 * 1024 * 1024;
const FIELD_AUDIO_PROMPT = "Audio: on-location sound only — wind, rain hitting fabric and rock, footsteps in mud, the contestant's breathing and effort. No music, no narration, no voice-over.";
const DIRECTOR_AUDIO_PROMPT = "Audio: a calm English-speaking off-screen commentator narrates the situation in one or two short sentences, mixed over storm ambience. Broadcast commentary tone, spoken in English, no music, no other language.";
const PACING_PROMPT = [
  "Pacing: one continuous take, but never a static one.",
  `Break the ${LIVE_VIDEO_DURATION_SECONDS} seconds into three escalating beats — a new physical action or a new complication roughly every ${Math.round(LIVE_VIDEO_DURATION_SECONDS / 3)} seconds. Never hold one pose or one framing for the whole clip.`,
  "Camera: moving throughout — push in, track alongside, drop low, rise, swing to a new angle, rack focus. Change the framing at least twice.",
].join("\n");
// Peril is the show; injury detail is what gets a clip refused. The shot designer escalates hard
// by design — every beat has to be a worse complication than the last — and left alone it walks
// straight into blood and open wounds, which the video model rejects outright. One contestant was
// losing nearly half its clips this way, and a refused clip leaves no tail frame, so the channel
// then reopens on the same rejected frame and refuses again.
const SAFE_PERIL_PROMPT = "Keep it broadcastable: strain, exhaustion, cold, fear and near-misses carry the danger. No blood, no wounds, no injury detail, no gore, no bodies.";

const NO_SCREEN_TEXT_PROMPT = [
  "ABSOLUTE VISUAL RULE: raw camera footage only.",
  "No visible text anywhere in the image or video.",
  "No subtitles, captions, labels, written language, HUD, UI overlay, scoreboard, stat panel, status bars, lower-third graphics, logos, watermarks, numbers or letters.",
  "Do not imitate a TV broadcast graphic package or a game interface.",
].join(" ");
const STORY_CHOICE_BLUEPRINTS = [
  {
    id: "signal",
    title: "Chase the signal",
    detail: "Follow the broken transmission deeper in — it could be supplies, or the leading edge of the storm.",
    action: "Head for the weather station",
    cue: "the contestant follows a flickering emergency signal through wet jungle under rising wind",
  },
  {
    id: "beacon",
    title: "Force the beacon",
    detail: "Crack the old casing in the rain and spend the last of the charge on one visible fix.",
    action: "Repair the beacon",
    cue: "the contestant repairs a damaged rescue beacon as amber light pulses through heavy rain",
  },
  {
    id: "shelter",
    title: "Throw up shelter",
    detail: "Tarp and deadfall against the wind — trading mobility for a window to survive in.",
    action: "Find cover",
    cue: "the contestant builds a low storm shelter from a tarp, branches and salvaged cord",
  },
  {
    id: "supplies",
    title: "Strip the wreck",
    detail: "Run the rocks while the tide is out and haul back a medkit, rope, or whatever is in that crate.",
    action: "Search for supplies",
    cue: "the contestant searches a half-submerged wreck crate on sharp black rocks",
  },
  {
    id: "team",
    title: "Go back for someone",
    detail: "Abandon the solo route to reach a contestant pinned below the mud slope.",
    action: "Help a contestant",
    cue: "the contestant helps another survivor climb out of a collapsing muddy ravine",
  },
  {
    id: "recover",
    title: "Hold and watch",
    detail: "Get low behind the roots, get some strength back, and read the next safe window.",
    action: "Rest here",
    cue: "the contestant rests under tangled tree roots while scanning the storm-lit shoreline",
  },
] as const;

const VERIFIED_MODEL_FALLBACKS: Record<string, JsonObject> = {
  "gpt-image-2": {
    name: "gpt-image-2",
    displayName: "GPT Image 2",
    kind: "image",
    resolutions: ["1k", "2k", "4k"],
    defaultResolution: "1k",
    aspectRatios: ["1:1", "3:2", "2:3", "3:4", "4:3", "16:9", "9:16", "21:9"],
    defaultAspectRatio: "1:1",
    materialRoles: ["reference_image"],
  },
  "hailuo-h3-max": {
    name: "hailuo-h3-max",
    displayName: "MiniMax H3 Max",
    kind: "video",
    resolutions: ["480p", "768p"],
    defaultResolution: "768p",
    aspectRatios: ["16:9", "21:9", "4:3", "1:1", "3:4", "9:16"],
    defaultAspectRatio: "16:9",
    durations: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    defaultDuration: 5,
    materialRoles: ["first_frame", "last_frame"],
  },
};

type JsonObject = Record<string, unknown>;

const MD5_SHIFTS = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

const MD5_CONSTANTS = Array.from({ length: 64 }, (_, index) => (
  Math.floor(Math.abs(Math.sin(index + 1)) * 2 ** 32) >>> 0
));

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" ? value as JsonObject : {};
}

function clamp(value: number, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function cleanText(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function leftRotate32(value: number, shift: number) {
  return ((value << shift) | (value >>> (32 - shift))) >>> 0;
}

function md5Hex(buffer: ArrayBuffer) {
  const input = new Uint8Array(buffer);
  const paddedLength = (input.length + 9 + 63) & ~63;
  const bytes = new Uint8Array(paddedLength);
  bytes.set(input);
  bytes[input.length] = 0x80;

  const bitLength = input.length * 8;
  for (let index = 0; index < 8; index += 1) {
    bytes[paddedLength - 8 + index] = Math.floor(bitLength / 2 ** (8 * index)) & 0xff;
  }

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  for (let offset = 0; offset < paddedLength; offset += 64) {
    const words = Array.from({ length: 16 }, (_, index) => {
      const start = offset + index * 4;
      return (
        bytes[start]
        | (bytes[start + 1] << 8)
        | (bytes[start + 2] << 16)
        | (bytes[start + 3] << 24)
      ) >>> 0;
    });
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let index = 0; index < 64; index += 1) {
      let f: number;
      let g: number;
      if (index < 16) {
        f = (b & c) | (~b & d);
        g = index;
      } else if (index < 32) {
        f = (d & b) | (~d & c);
        g = (5 * index + 1) % 16;
      } else if (index < 48) {
        f = b ^ c ^ d;
        g = (3 * index + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * index) % 16;
      }
      const nextD = d;
      d = c;
      c = b;
      b = (b + leftRotate32((a + f + MD5_CONSTANTS[index] + words[g]) >>> 0, MD5_SHIFTS[index])) >>> 0;
      a = nextD;
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  return [a0, b0, c0, d0].map((word) => (
    [0, 8, 16, 24].map((shift) => ((word >>> shift) & 0xff).toString(16).padStart(2, "0")).join("")
  )).join("");
}

// How often the show is allowed to advance itself, fleet-wide. Short enough that the broadcast
// still feels immediate, long enough that a hundred watching browsers cost about what one does.
const ADVANCE_MIN_INTERVAL_MS = 4000;
// The in-memory half of the gate. It cannot bound the interval — every isolate has its own copy —
// so it exists only to keep most heartbeats from spending a D1 round trip on the lease query.
// Shorter than the lease so an isolate is still awake when the window actually reopens.
const ADVANCE_SOFT_INTERVAL_MS = 2000;
let lastAdvanceAt = 0;

// Global mutual exclusion on D1: at most one request holds `key` at a time, fleet-wide. Both
// statements decide the winner inside the database — a read-then-write would hand the lease to
// every viewer whose heartbeat landed in the same moment, which is the problem it exists to solve.
// The holder may retake its own lease, so a viewer keeps work it has already started.
async function claimLease(key: string, ttlMs: number, holder: string): Promise<boolean> {
  const now = Date.now();
  try {
    const taken = await db.update(runtimeLeases)
      .set({ holder, until_ms: now + ttlMs })
      .where(and(
        eq(runtimeLeases.key, key),
        or(lt(runtimeLeases.until_ms, now), eq(runtimeLeases.holder, holder)),
      ))
      .returning({ key: runtimeLeases.key });
    if (taken.length > 0) return true;
    const created = await db.insert(runtimeLeases)
      .values({ key, holder, until_ms: now + ttlMs })
      .onConflictDoNothing({ target: runtimeLeases.key })
      .returning({ key: runtimeLeases.key });
    return created.length > 0;
  } catch {
    // A lease that cannot be read is not a lease anyone holds: skip the work, never break the page.
    return false;
  }
}

async function ensureLiveMatch() {
  await db.insert(matches).values({
    slug: LIVE_SLUG,
    title: "ISLAND / 00",
    subtitle: "Island Survival Open · Season 01",
    status: "live",
    current_round: 7,
    zone: "North shore rainforest",
  }).onConflictDoNothing({ target: matches.slug });

  const [match] = await db.select().from(matches).where(eq(matches.slug, LIVE_SLUG)).limit(1);
  if (!match) throw new Error("Unable to initialize live match");

  return match;
}

// Signing is a round trip, and the roster alone needs eight of them. Each signature is good for an
// hour, yet every heartbeat from every browser was asking for a fresh set. Holding them for ten
// minutes on the isolate keeps a wide margin under the hour and takes the round trips out of the
// hot path; a cold isolate just signs again.
const PRESIGN_TTL_MS = 10 * 60 * 1000;
const PRESIGN_CACHE_MAX = 400;
const presignCache = new Map<string, { url: string; until: number }>();

async function presignedUrl(s3Uri: string) {
  const now = Date.now();
  const hit = presignCache.get(s3Uri);
  if (hit && hit.until > now) return hit.url;
  const parsed = storage.tryParseS3Uri(s3Uri);
  if (!parsed) return null;
  const signed = await storage.from(parsed.bucket).createPresignedGetUrl(parsed.path, 3600);
  // Insertion order is eviction order, and the archive only grows, so drop the oldest entries
  // rather than letting the isolate hold every clip it has ever served.
  if (presignCache.size >= PRESIGN_CACHE_MAX) {
    for (const key of presignCache.keys()) {
      presignCache.delete(key);
      if (presignCache.size < PRESIGN_CACHE_MAX * 0.8) break;
    }
  }
  presignCache.set(s3Uri, { url: signed.downloadUrl, until: now + PRESIGN_TTL_MS });
  return signed.downloadUrl;
}

async function avatarUrl(s3Uri: string | null) {
  if (!s3Uri) return null;
  if (!storage.tryParseS3Uri(s3Uri)) return s3Uri.startsWith("https://") ? s3Uri : null;
  return await presignedUrl(s3Uri);
}

async function clipUrl(value: string | null) {
  if (!value) return null;
  if (!storage.tryParseS3Uri(value)) return value.startsWith("https://") ? value : null;
  return await presignedUrl(value);
}

// ── fal ──────────────────────────────────────────────────────────────────────
// One key for everything the show generates. Video runs on fal's queue; the writing runs on their
// OpenAI-compatible router, so the chat calls keep the shape they already had.
const FAL_QUEUE_BASE = "https://queue.fal.run";
const FAL_SYNC_BASE = "https://fal.run";
const FAL_VIDEO_MODEL = "minimax/h3-max-turbo/image-to-video";
const FAL_CHAT_PATH = "/openrouter/router/openai/v1/chat/completions";
// Held as vars so the host can change model without a deploy — useful precisely because these are
// the two decisions most likely to want tuning once real footage is coming back.
const FAL_TEXT_MODEL_DEFAULT = "openai/gpt-4o-mini";
const FAL_VISION_MODEL_DEFAULT = "openai/gpt-4o-mini";

function requireFal() {
  const apiKey = secret.get("FAL_KEY");
  if (!apiKey) throw new Error("FAL_KEY is not configured");
  return apiKey;
}

function falErrorMessage(payload: unknown, status: number, raw: string) {
  const root = asObject(payload);
  // fal reports schema problems as a list of {loc, msg}; those are the ones worth reading in full.
  const detail = Array.isArray(root.detail)
    ? root.detail.map((item) => {
      const entry = asObject(item);
      const where = Array.isArray(entry.loc) ? entry.loc.join(".") : "";
      return `${where}: ${cleanText(entry.msg, 200)}`;
    }).join("; ")
    : cleanText(root.detail, 400);
  return cleanText(detail || root.message || raw, 500) || `fal request failed (${status})`;
}

async function falFetch(url: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Key ${requireFal()}`);
  headers.set("Accept", "application/json");
  if (init.body) headers.set("Content-Type", "application/json");
  const response = await fetch(url, { ...init, headers });
  const raw = await response.text();
  let payload: unknown = null;
  try {
    payload = raw ? JSON.parse(raw) : null;
  } catch {
    payload = null;
  }
  if (!response.ok) throw new Error(falErrorMessage(payload, response.status, raw));
  return payload;
}

// The queue hands back the URLs to poll, so they are kept rather than rebuilt: a model whose id has
// a sub-path ("…/image-to-video") does not poll at the path it was submitted to.
function falTaskRef(id: string, statusUrl: string, responseUrl: string) {
  return JSON.stringify({ id, status: statusUrl, response: responseUrl });
}

function parseFalTaskRef(value: string) {
  try {
    const parsed = asObject(JSON.parse(value));
    const id = cleanText(parsed.id, 200);
    if (!id) return null;
    return {
      id,
      status: cleanText(parsed.status, 500),
      response: cleanText(parsed.response, 500),
    };
  } catch {
    return null;
  }
}

async function createFalVideoTask(prompt: string, firstFrameUrl: string, duration: number) {
  const payload = asObject(await falFetch(`${FAL_QUEUE_BASE}/${FAL_VIDEO_MODEL}`, {
    method: "POST",
    body: JSON.stringify({
      prompt: cleanText(prompt, 6500),
      image_url: firstFrameUrl,
      duration: String(duration),
      // fal wants the capital P it is already written with; lowercasing it fails validation.
      resolution: LIVE_VIDEO_RESOLUTION,
    }),
  }));
  const id = cleanText(payload.request_id, 200);
  if (!id) throw new Error("fal returned no request_id");
  const statusUrl = cleanText(payload.status_url, 500)
    || `${FAL_QUEUE_BASE}/${FAL_VIDEO_MODEL}/requests/${encodeURIComponent(id)}/status`;
  const responseUrl = cleanText(payload.response_url, 500)
    || `${FAL_QUEUE_BASE}/${FAL_VIDEO_MODEL}/requests/${encodeURIComponent(id)}`;
  return { id: falTaskRef(id, statusUrl, responseUrl), raw: payload };
}

// One poll answers both questions: still running, or done and here is the file.
async function getFalVideoTask(stored: string) {
  const ref = parseFalTaskRef(stored);
  if (!ref) throw new Error("This clip was queued on the old provider and cannot be polled");
  const status = asObject(await falFetch(ref.status));
  const state = cleanText(status.status, 40).toUpperCase();
  if (state !== "COMPLETED") return { state, payload: status };
  return { state, payload: asObject(await falFetch(ref.response)) };
}

function falVideoStatus(state: string) {
  if (state === "COMPLETED") return "completed";
  if (state === "IN_PROGRESS" || state === "IN_QUEUE") return "processing";
  return state ? state.toLowerCase() : "pending";
}

function falVideoResultUrl(payload: unknown) {
  const root = asObject(payload);
  const video = asObject(root.video);
  const direct = cleanText(video.url, 800);
  if (direct.startsWith("http")) return direct;
  // Some fal models return the file under a differently named key; take the first URL that looks
  // like one rather than failing on a naming difference.
  for (const value of Object.values(root)) {
    const nested = asObject(value);
    const url = cleanText(nested.url, 800);
    if (url.startsWith("http")) return url;
  }
  return null;
}

function requireRenoise() {
  const apiKey = secret.get("RENOISE_API_KEY");
  if (!apiKey) throw new Error("RENOISE_API_KEY is not configured");
  return {
    apiKey,
    baseUrl: (vars.get("RENOISE_API_BASE_URL") || RENOISE_DEFAULT_BASE_URL).replace(/\/$/, ""),
  };
}

async function renoiseFetch(path: string, init: RequestInit = {}) {
  const { apiKey, baseUrl } = requireRenoise();
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  headers.set("X-API-Key", apiKey);
  headers.set("X-Client-Name", "tomato-live");
  headers.set("X-Client-Version", "1.0.0");
  const proxyToken = vars.get("RENOISE_PROXY_TOKEN");
  if (proxyToken) headers.set("X-Tomato-Proxy-Token", proxyToken);
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
  const responseText = await response.text();
  let payload: unknown = {};
  try {
    payload = responseText ? JSON.parse(responseText) : {};
  } catch {
    const contentType = response.headers.get("content-type") || "unknown";
    const htmlHint = /<html|<!doctype/i.test(responseText) ? ", looks like an HTML page" : "";
    throw new Error(`Renoise ${path} returned an unparseable response (${response.status}, ${contentType}${htmlHint})`);
  }
  if (!response.ok) {
    const message = cleanText(asObject(payload).message, 500) || `Renoise request failed (${response.status})`;
    throw new Error(message);
  }
  return payload;
}

async function renoiseProbeRequest(path: string, init: RequestInit = {}) {
  const { apiKey, baseUrl } = requireRenoise();
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  headers.set("X-API-Key", apiKey);
  headers.set("X-Client-Name", "tomato-live-probe");
  headers.set("X-Client-Version", "1.0.0");
  const proxyToken = vars.get("RENOISE_PROXY_TOKEN");
  if (proxyToken) headers.set("X-Tomato-Proxy-Token", proxyToken);
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
  const text = await response.text();
  let json = false;
  let keys: string[] = [];
  try {
    const parsed = JSON.parse(text);
    json = true;
    keys = Object.keys(asObject(parsed));
  } catch {
    json = false;
  }
  return {
    path,
    status: response.status,
    contentType: response.headers.get("content-type"),
    json,
    keys,
    looksLikeHtml: /<html|<!doctype/i.test(text),
    preview: json ? null : text.slice(0, 80),
  };
}

function findModelList(raw: unknown) {
  const queue: Array<{ value: unknown; depth: number }> = [{ value: raw, depth: 0 }];
  while (queue.length) {
    const current = queue.shift();
    if (!current) break;
    if (typeof current.value === "string" && current.depth < 4 && /^[\s]*[\[{]/.test(current.value)) {
      try {
        queue.push({ value: JSON.parse(current.value), depth: current.depth + 1 });
      } catch {
        // Ignore non-JSON strings inside provider metadata.
      }
      continue;
    }
    if (Array.isArray(current.value)) {
      const candidates = current.value.map(asObject);
      if (candidates.some((candidate) => typeof (candidate.name ?? candidate.model ?? candidate.id) === "string")) {
        return candidates;
      }
      if (current.depth < 4) current.value.forEach((value) => queue.push({ value, depth: current.depth + 1 }));
      continue;
    }
    if (current.value && typeof current.value === "object" && current.depth < 4) {
      Object.values(current.value).forEach((value) => queue.push({ value, depth: current.depth + 1 }));
    }
  }
  return [];
}

function modelName(model: JsonObject) {
  return cleanText(model.name ?? model.model ?? model.id, 120);
}

async function getRenoiseModels() {
  const raw = await renoiseFetch("/models");
  return findModelList(raw);
}

async function getRenoiseModel(name: string) {
  try {
    const models = await getRenoiseModels();
    const model = models.find((candidate) => modelName(candidate) === name);
    if (model) return model;
  } catch {
    // Some edge-to-edge routes return the Renoise HTML shell for /models.
  }
  const fallback = VERIFIED_MODEL_FALLBACKS[name];
  if (fallback) return fallback;
  throw new Error(`Renoise does not currently offer the model ${name}`);
}

async function getCharacterImageModel() {
  let models: JsonObject[] = [];
  try {
    models = await getRenoiseModels();
  } catch {
    models = [];
  }
  const compatible = models.filter((candidate) => (
    candidate.kind === "image"
    && Array.isArray(candidate.materialRoles)
    && candidate.materialRoles.includes("reference_image")
  ));
  const preferred = compatible.find((candidate) => modelName(candidate) === CHARACTER_MODEL);
  const fallback = compatible.find((candidate) => candidate.isDefault === true) ?? compatible[0];
  const selected = preferred ?? fallback;
  return selected ?? VERIFIED_MODEL_FALLBACKS[CHARACTER_MODEL];
}

function pickAdvertised(values: unknown, preferred: string, fallback: unknown) {
  const advertised = Array.isArray(values) ? values.filter((value): value is string => typeof value === "string") : [];
  if (advertised.includes(preferred)) return preferred;
  if (typeof fallback === "string" && advertised.includes(fallback)) return fallback;
  return advertised[0];
}

function unwrapTask(payload: unknown) {
  const root = asObject(payload);
  const data = asObject(root.data);
  if (root.task) return asObject(root.task);
  if (data.task) return asObject(data.task);
  return Object.keys(data).length ? data : root;
}

function taskId(payload: unknown) {
  const task = unwrapTask(payload);
  const id = task.id;
  if (typeof id !== "number" && typeof id !== "string") throw new Error("Renoise response did not include a task id");
  return String(id);
}

function taskStatus(payload: unknown) {
  return cleanText(unwrapTask(payload).status, 32).toLowerCase();
}

function taskResultUrl(payload: unknown) {
  const task = unwrapTask(payload);
  const artifacts = asObject(task.artifacts);
  const candidates = [task.resultUrl, task.result_url, task.url, artifacts.resultUrl, artifacts.videoUrl, artifacts.imageUrl];
  return candidates.find((value): value is string => typeof value === "string" && value.startsWith("http")) ?? null;
}

// The viewer writes a free-form idea; the agent turns it into a production brief. The sheet and the
// identity-lock paragraph are both cut from this same brief, which is what keeps the text half and the
// image half describing one person.
type CharacterBrief = {
  archetype: string;
  role: string;
  signature: string;
  wardrobe: string;
  appearance: string;
};

function fallbackBrief(concept: string): CharacterBrief {
  const trimmed = cleanText(concept, 60) || "survivor";
  return {
    archetype: trimmed.slice(0, 12),
    role: "survival-show contestant",
    signature: "a single hand-made object they never put down",
    wardrobe: "practical weathered expedition gear, layered fabric, utility straps",
    appearance: "",
  };
}

function extractJsonObject(raw: string): JsonObject | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return asObject(JSON.parse(raw.slice(start, end + 1)));
  } catch {
    return null;
  }
}

async function expandCharacterConcept(displayName: string, concept: string): Promise<CharacterBrief> {
  const fallback = fallbackBrief(concept);
  try {
    const raw = await miniMaxChat(
      [
        "You are the character designer on a gritty documentary-style survival reality show.",
        "A viewer has described the contestant they want to play. Expand it into a production brief.",
        "Rules:",
        "- Give the contestant ONE very distinctive visual signature: a single unmistakable physical feature a viewer could pick out of a crowd in one frame. An object always carried, a scar or marking, an unusual garment, hair, a prosthetic, a tool lashed to the body. Make it specific and strange, never generic.",
        "- Enrich what the viewer asked for. Never replace their idea with your own.",
        "- Stay grounded in documentary realism: no fantasy armour, no superpowers, no glowing technology, no mask covering the face.",
        "- Output strict JSON and nothing else. No markdown fence, no commentary.",
        "JSON shape:",
        '{"archetype": "a 1-3 word English identity label", "role": "the same identity as a short English noun phrase", "signature": "one English sentence naming the single distinctive feature", "wardrobe": "one English sentence: the outfit layer by layer with exact colours and materials", "appearance": "ONE dense English paragraph under 110 words covering face shape and features, skin tone, hair, build, then the outfit layer by layer, then the distinctive signature. Plain concrete words. No name, no story, no camera or lighting talk."}',
      ].join("\n"),
      `Contestant name: ${displayName}\nViewer description: ${concept}`,
      chatBudget(900),
    );
    const parsed = extractJsonObject(raw);
    if (!parsed) return fallback;
    return {
      archetype: cleanText(parsed.archetype, 12) || fallback.archetype,
      role: cleanText(parsed.role, 80) || fallback.role,
      signature: cleanText(parsed.signature, 240) || fallback.signature,
      wardrobe: cleanText(parsed.wardrobe, 240) || fallback.wardrobe,
      appearance: cleanText(parsed.appearance, 700),
    };
  } catch {
    // A brief we wrote ourselves still produces a sheet; it just will not be as distinctive.
    return fallback;
  }
}

function characterPrompt(brief: CharacterBrief, accent: string) {
  return [
    "USE: identity-preserving cinematic survival-contestant character portrait.",
    "SOURCE: the attached photo is the contestant identity reference.",
    `SUBJECT: transform the same person into a ${brief.role} prepared for a near-future tropical island survival broadcast.`,
    `SIGNATURE — must be clearly visible and unmistakable in the frame: ${brief.signature}`,
    `WARDROBE: ${brief.wardrobe}. Add a restrained ${accent} identification accent. No helmet, no mask.`,
    "COMPOSITION: vertical 9:16 portrait frame, the contestant full body from head to boots, centred, hands visible, readable silhouette, headroom above and ground below.",
    "SCENE/BACKGROUND: a rain-soaked tropical coast at dusk — wet rock, wind-bent palms, low storm cloud filling the rest of the frame; cinematic but the contestant stays the unmistakable subject.",
    "LIGHTING/MATERIALS: documentary realism, overcast key light, warm field-lamp rim, tactile wet fabric and natural skin texture.",
    "PRESERVE: facial identity, age, skin tone, ethnicity, hairstyle, distinctive facial features, and natural body proportions from the source photo.",
    "CHANGE ONLY: wardrobe, pose, framing, and background needed for the survival-contestant design.",
    NO_SCREEN_TEXT_PROMPT,
    "AVOID: text, logos, UI, watermark, extra people, props covering the face, fantasy armor, exaggerated muscles, beauty-filter skin, face drift, cropped head, cropped feet.",
  ].join("\n");
}

function requestFingerprint(c: { req: { header(name: string): string | undefined } }) {
  return [
    c.req.header("CF-Connecting-IP") || "local",
    c.req.header("User-Agent") || "unknown",
  ].join("|");
}

async function estimateRenoiseCredit(model: string, resolution: string) {
  const query = new URLSearchParams({ model, duration: "5", resolution });
  const payload = asObject(await renoiseFetch(`/credit/estimate?${query.toString()}`));
  const data = asObject(payload.data);
  const value = Number(payload.estimatedCredit ?? data.estimatedCredit);
  if (!Number.isFinite(value)) throw new Error("Renoise cannot estimate the character generation credit right now");
  return {
    estimatedCredit: value,
    sufficient: Boolean(payload.sufficient ?? data.sufficient),
  };
}

async function createRenoiseTask(body: JsonObject) {
  const response = await renoiseFetch("/tasks", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Idempotency-Key": crypto.randomUUID(),
    },
    body: JSON.stringify(body),
  });
  return { id: taskId(response), raw: response };
}

async function getRenoiseTask(id: string) {
  const detail = await renoiseFetch(`/tasks/${encodeURIComponent(id)}`);
  if (taskResultUrl(detail) || taskStatus(detail) !== "completed") return detail;
  return renoiseFetch(`/tasks/${encodeURIComponent(id)}/result`);
}

function renoiseMaterialType(contentType: string) {
  if (contentType.startsWith("video/")) return "video";
  if (contentType.startsWith("audio/")) return "audio";
  return "image";
}

async function uploadRenoiseMaterial(bytes: ArrayBuffer, filename: string, contentType = "image/jpeg") {
  const type = renoiseMaterialType(contentType);
  const uploadPayload = asObject(await renoiseFetch("/materials/upload-url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contentType, filename, type }),
  }));
  const uploadUrl = cleanText(uploadPayload.uploadUrl, 5000);
  const storagePath = cleanText(uploadPayload.path, 5000);
  if (!uploadUrl || !storagePath) throw new Error("Renoise material upload-url response is incomplete");

  const uploadResponse = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: bytes,
  });
  if (!uploadResponse.ok) throw new Error(`Renoise material file upload failed (${uploadResponse.status})`);

  const payload = await renoiseFetch("/materials", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      storagePath,
      contentType,
      name: filename,
      md5: md5Hex(bytes),
      type,
    }),
  });
  const root = asObject(payload);
  const material = asObject(root.material ?? asObject(root.data).material ?? root.data);
  const id = material.id ?? root.id;
  const numericId = Number(id);
  if (!Number.isInteger(numericId)) throw new Error("Renoise material upload did not return an id");
  return numericId;
}

async function characterDraftPayload(draft: typeof characterDrafts.$inferSelect) {
  return {
    publicId: draft.public_id,
    displayName: draft.display_name,
    archetype: draft.archetype,
    accent: draft.accent,
    model: draft.model,
    status: draft.status,
    estimatedCredit: draft.estimated_credit ? Number(draft.estimated_credit) : null,
    characterUrl: await avatarUrl(draft.generated_s3_uri),
    error: draft.error_message,
  };
}

async function getOwnedCharacterDraft(publicId: string, controlToken: string) {
  const [draft] = await db.select().from(characterDrafts)
    .where(eq(characterDrafts.public_id, publicId))
    .limit(1);
  if (!draft || !controlToken || draft.control_token_hash !== await sha256(controlToken)) return null;
  return draft;
}

async function removeStoredSource(s3Uri: string | null) {
  if (!s3Uri) return;
  const parsed = storage.tryParseS3Uri(s3Uri);
  if (!parsed) return;
  await storage.from(parsed.bucket).delete([parsed.path]);
}

async function syncParticipantMaterial(participant: typeof participants.$inferSelect) {
  if (participant.renoise_material_id) return participant.renoise_material_id;
  if (!participant.avatar_s3_uri) throw new Error(`${participant.display_name} has no character sheet yet`);
  const parsed = storage.tryParseS3Uri(participant.avatar_s3_uri);
  if (!parsed) throw new Error(`${participant.display_name} has an invalid character sheet address`);
  const object = await storage.from(parsed.bucket).get(parsed.path);
  if (!object) throw new Error(`${participant.display_name} character sheet is missing`);
  const materialId = await uploadRenoiseMaterial(
    object.body,
    `participant-${participant.id}.jpg`,
    object.metadata.contentType || "image/jpeg",
  );
  await db.update(participants).set({ renoise_material_id: materialId }).where(eq(participants.id, participant.id));
  return materialId;
}

// The next clip opens on this one's final frame, so the only part of a shot design worth handing
// forward is how it ended. Carrying the first 600 characters instead gave the next shot the beats
// that had already aired, and truncated the ending — the one part it actually needed. One memory
// ended mid-word on "sam surfaces gasping, blo".
function finalBeatOf(shot: string) {
  const beats = shot.split(/(?=\d{1,2}\s*-\s*\d{1,2}\s*s\s*:)/i).map((part) => part.trim()).filter(Boolean);
  const last = beats.length ? beats[beats.length - 1] : shot;
  // The audio line describes sound, not the moment the next shot opens on.
  return last.split(/\n\s*Audio\s*:/i)[0].trim();
}

function storyTextFromGeneration(generation: typeof generations.$inferSelect | null) {
  if (!generation?.prompt) return "";
  try {
    const promptSet = asObject(JSON.parse(generation.prompt));
    if (!CONTINUABLE_PROMPT_VERSIONS.has(String(promptSet.promptVersion))) return "";
    return cleanText(promptSet.visualMemory ?? promptSet.videoPrompt ?? promptSet.keyframePrompt, 800);
  } catch {
    return "";
  }
}

// One contestant channel per participant; the director channel carries channel_participant_id = null.
function channelFilter(matchId: number, channel: "director" | "participant", participantId: number | null) {
  return and(
    eq(generations.match_id, matchId),
    eq(generations.channel, channel),
    participantId == null
      ? isNull(generations.channel_participant_id)
      : eq(generations.channel_participant_id, participantId),
  );
}

async function latestChannelClip(matchId: number, channel: "director" | "participant", participantId: number | null) {
  const [clip] = await db.select().from(generations)
    .where(and(channelFilter(matchId, channel, participantId), eq(generations.stage, "completed")))
    .orderBy(desc(generations.id))
    .limit(1);
  return clip ?? null;
}

// A tail frame the video model refuses is a dead end with no way out: the channel always reopens on
// its last completed clip, so the same rejected frame goes back every time and nothing new ever
// completes to replace it. One contestant sat on a frame of bloodied hands for six hours and 81
// straight failures. After this many refusals the channel gives up on the frame and re-establishes
// from the character sheet instead.
const TAIL_FRAME_GIVE_UP = 3;

async function failuresSince(matchId: number, participantId: number, clipId: number) {
  const [row] = await db.select({ n: sql<number>`count(*)` }).from(generations)
    .where(and(
      channelFilter(matchId, "participant", participantId),
      eq(generations.stage, "failed"),
      gt(generations.id, clipId),
    ));
  return Number(row?.n ?? 0);
}

// A render that never comes back holds its contestant's channel shut for good, because a channel is
// single-file by design: nothing else can film for that person until this row leaves the active
// stages. One contestant went sixteen minutes with a single clip wedged in `video`. Of 1326 clips
// filmed in three hours exactly one took longer than a minute, so five is far past generous.
const STALE_GENERATION_SECONDS = 300;

async function reapStalledGenerations(matchId: number) {
  const reaped = await db.update(generations)
    .set({ stage: "failed", error_message: "The render never came back; the channel was freed so the show could go on" })
    .where(and(
      eq(generations.match_id, matchId),
      inArray(generations.stage, ["queued", "keyframe", "video"]),
      sql`created_at < datetime('now', ${`-${STALE_GENERATION_SECONDS} seconds`})`,
    ))
    .returning({ id: generations.id });
  // Whatever a viewer asked for in those clips goes back in the queue rather than dying with them.
  for (const row of reaped) await requeueFailedCue(row.id);
  if (reaped.length) console.log(`[reaper] freed ${reaped.length} wedged clip(s)`);
  return reaped.length;
}

async function activeGenerations(matchId: number) {
  return db.select().from(generations)
    .where(and(eq(generations.match_id, matchId), inArray(generations.stage, ["queued", "keyframe", "video"])))
    .orderBy(desc(generations.id));
}

// A busy channel blocks only itself; the global cap is what keeps concurrent spend bounded.
function generationSlotError(
  active: Array<typeof generations.$inferSelect>,
  channel: "director" | "participant",
  participantId: number | null,
  tier: GenerationTier,
) {
  if (channel === "director") {
    // Director cuts have nothing to serialise on: each one opens on a different contestant's tail
    // frame. Only the tier's ceiling limits them.
    const running = active.filter((item) => item.channel === "director");
    if (running.length >= tier.directorSlots) {
      return { status: 409 as const, error: "The director line is already at its concurrent limit", generation: running[0] };
    }
  } else {
    const sameChannel = active.find((item) =>
      item.channel === channel && (item.channel_participant_id ?? null) === participantId);
    if (sameChannel) {
      return { status: 409 as const, error: "This channel is still filming its last clip; it opens up once that lands", generation: sameChannel };
    }
  }
  if (active.length >= tier.concurrent) {
    return { status: 429 as const, error: "Too many clips rendering at once — try again shortly", generation: null };
  }
  return null;
}

function contestantCondition(participant: typeof participants.$inferSelect) {
  const who = participant.display_name;
  if (participant.hunger >= 65) return `${who} is hungry and urgent, taking riskier movements`;
  if (participant.stamina <= 35) return `${who} is tired, moving carefully and conserving energy`;
  if (participant.health <= 45) return `${who} is injured but still determined, favoring cautious physical action`;
  return `${who} is alert, mobile and ready to push the survival objective forward`;
}

function parseParticipantIds(value: string | null) {
  if (!value) return [] as number[];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(Number).filter(Number.isInteger) : [];
  } catch {
    return [];
  }
}

function escapeForRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Viewers pull other contestants into their shot by writing @name. H3-Max takes only one opening
// frame, so a guest can only enter through their identity-lock text — which is exactly what we have.
// In the order they were named, not the order of the roster. The first person mentioned is the one
// the viewer is writing about, and downstream that decides whose shot it is.
function mentionedParticipants(viewerPrompt: string, roster: Array<typeof participants.$inferSelect>, selfId: number) {
  return roster
    .filter((item) => item.id !== selfId && item.status !== "eliminated")
    .map((item) => ({
      item,
      at: viewerPrompt.search(new RegExp(`@\\s*${escapeForRegExp(item.display_name)}`, "i")),
    }))
    .filter((hit) => hit.at >= 0)
    .sort((a, b) => a.at - b.at)
    .map((hit) => hit.item);
}

function buildStoryChoices(
  match: typeof matches.$inferSelect,
  roster: Array<typeof participants.$inferSelect>,
  events: Array<typeof matchEvents.$inferSelect>,
  // Only the summary is read, so this takes the trimmed clip row the live payload builds from.
  latestClip: { summary: string | null } | null,
) {
  if (roster.length === 0) return [];
  const latestStory = cleanText(latestClip?.summary, 200);
  const recentEvent = events.find((event) => event.kind === "player") ?? events[0];
  return STORY_CHOICE_BLUEPRINTS.map((choice, index) => {
    const lead = roster[index % roster.length];
    const pressure = lead.hunger > 65
      ? "Hunger is high, so the choices turn riskier"
      : lead.stamina < 35 ? "Stamina is low, so the moves stay careful" : "Still in shape to push on";
    return {
      id: choice.id,
      title: choice.title,
      detail: latestStory
        ? `${choice.detail} Right now: ${latestStory.slice(0, 60)}…`
        : choice.detail,
      participantHint: `${lead.display_name} · ${pressure}`,
      round: match.current_round,
      recentEvent: recentEvent?.title ?? null,
    };
  });
}

function storyChoiceById(choiceId: string) {
  return STORY_CHOICE_BLUEPRINTS.find((choice) => choice.id === choiceId) ?? null;
}

// Shared text-model helper. Every caller must treat failure as non-fatal: a missing summary or an
// un-translated viewer line is never a reason to block video generation.
// maxChars caps what comes back. The default suits a one-line answer; a structured reply needs far
// more room, and truncating one costs it its closing brace.
async function miniMaxChat(system: string, user: string, maxTokens: number, maxChars = 800) {
  const payload = asObject(await falFetch(`${FAL_SYNC_BASE}${FAL_CHAT_PATH}`, {
    method: "POST",
    body: JSON.stringify({
      model: vars.get("FAL_TEXT_MODEL") || FAL_TEXT_MODEL_DEFAULT,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_tokens: maxTokens,
      temperature: 0.7,
    }),
  }));
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const message = asObject(asObject(choices[0]).message);
  return cleanText(message.content, maxChars);
}

const REASONING_HEADROOM = 1400;

function chatBudget(forOutput: number) {
  return forOutput + REASONING_HEADROOM;
}

// The viewer writes in whatever language they like; the video prompt reads better as one English
// action line. If the model is unavailable we pass the original text straight through.
// Viewers type one short line. That alone yields a flat clip, so the model expands it into a real
// shot design with beats before it ever reaches the video model.
async function expandViewerPrompt(
  viewerPrompt: string,
  condition: string,
  previousStory: string,
  lead: string,
  guests: string[],
  story: StoryState,
  moving: boolean,
) {
  const beatSeconds = Math.round(LIVE_VIDEO_DURATION_SECONDS / 3);
  const cast = guests.length
    ? `${lead} plus ${guests.join(" and ")}`
    : lead;
  try {
    const shot = await miniMaxChat(
      [
        "You are the shot designer on a gritty documentary-style survival reality show.",
        `Turn the viewer's instruction into a rich English video-generation prompt for one ${LIVE_VIDEO_DURATION_SECONDS}-second clip.`,
        "Rules:",
        // Without this the instruction reads as one more note among a dozen, and the model writes
        // another beat of whatever the last clip was doing instead.
        "- THE INSTRUCTION IS THE CLIP. Dramatise the thing the viewer actually asked for, and have it start happening in the first beat. Everything else below shapes how it looks, never whether it happens.",
        `- It is ONE continuous take with no cuts, but it must never be static. Break it into three escalating beats, roughly ${beatSeconds} seconds each, and write them as "0-${beatSeconds}s: ...".`,
        "- Every beat is a NEW physical action or a NEW complication — something gives way, slips, tears, floods, catches. Never the same pose held throughout.",
        "- Keep the camera moving the whole time and change the framing at least twice.",
        "- Write concrete physical detail: what the hands grip, what slips, what splashes, what the wind and rain do.",
        `- ${SAFE_PERIL_PROMPT}`,
        `- The people in this shot are: ${cast}. Call them by these exact names throughout — never "the contestant" or "a survivor".`,
        guests.length
          ? `- ${guests.join(" and ")} appear alongside ${lead}; give them their own physical actions, do not leave them standing idle. No one outside this list appears.`
          : `- ${lead} is the only person in frame. No new people.`,
        moving
          ? "- This shot is the journey itself: they physically leave where they are and arrive somewhere new. End the clip in the new place, not the old one."
          // Flatly forbidding a location change vetoed every instruction that asked for one: a
          // viewer said to reach the forest and camp, and the shot came back as another squeeze
          // through the same tunnel wall.
          : "- Keep every named person's identity and wardrobe unchanged. Stay where they are UNLESS the instruction takes them somewhere else — if it does, film the move and end the clip in the new place.",
        "- End with one line starting 'Audio:' describing on-location sound only — no music, no narration.",
        "- No on-screen text, subtitles, captions or graphics anywhere.",
        "- Write the entire prompt in English, including any spoken line, even when the viewer wrote in Chinese or another language. No Chinese characters anywhere in your output.",
        "Output only the prompt itself, no preamble and no headings.",
      ].join("\n"),
      [
        `INSTRUCTION TO FILM (the "@name" marks are mentions of other contestants): ${viewerPrompt}`,
        "",
        "Context for how it should look:",
        previousStory ? `- The previous clip ended with: ${previousStory}` : `- This opens ${lead}'s storyline.`,
        moving
          ? `- They are leaving that place. By the end of this clip they are in: ${story.setting} (${story.clock}).`
          : `- Where they are as this starts: ${story.setting} (${story.clock}).`,
        `- What everyone is trying to do right now: ${story.goal}`,
        `- Condition: ${condition}`,
        guests.length ? `- Also in this shot: ${guests.join(", ")}` : "",
      ].filter(Boolean).join("\n"),
      chatBudget(900),
    );
    return shot || "";
  } catch {
    return "";
  }
}

async function promptsForViewerInput({
  viewerPrompt,
  participant,
  guests,
  latestClip,
  story,
  moving,
}: {
  viewerPrompt: string;
  participant: typeof participants.$inferSelect;
  guests: Array<typeof participants.$inferSelect>;
  latestClip: typeof generations.$inferSelect | null;
  story: StoryState;
  moving: boolean;
}) {
  const previousStory = storyTextFromGeneration(latestClip);
  const condition = contestantCondition(participant);
  const guestNames = guests.map((item) => item.display_name);
  const expanded = await expandViewerPrompt(viewerPrompt, condition, previousStory, participant.display_name, guestNames, story, moving);
  const cue = viewerPrompt;
  const sharedContinuity = [
    previousStory
      ? `Continue from this clean visual memory: ${previousStory}.`
      : `Opening situation: ${participant.display_name} is at ${story.setting}, ${story.clock}.`,
    moving
      ? `This shot is the move: they leave where they are and end it at ${story.setting}.`
      : `Where the show is now: ${story.setting}, ${story.clock}.`,
    `Chapter: ${story.phase}. What they are trying to do: ${story.goal}.`,
    `Branch action: ${cue}.`,
    `Physical condition: ${condition}.`,
  ].join("\n");
  // storyTextFromGeneration feeds this straight into the next clip's English prompt, so it must be
  // the expanded English text — never the viewer's raw line.
  const memorySource = expanded
    ? cleanText(finalBeatOf(expanded), 600)
    : `${participant.display_name} — ${cue}`;
  return {
    cue,
    // The suffix here is chained straight into the next clip as previousStory, so it has to carry
    // the CURRENT place. A hardcoded one re-injects itself forever and pins the show to it.
    visualMemory: `${memorySource}; ${condition}; ${storyBackdrop(story)}; documentary handheld realism; no on-screen graphics`,
    keyframePrompt: [
      "Create a cinematic 16:9 opening frame for a survival challenge using the supplied contestant reference image.",
      sharedContinuity,
      `Frame: the supplied contestant is visibly starting this branch: ${cue}.`,
      `Composition: documentary survival camera, grounded realism, readable face, tense body language, the light and weather of ${story.setting}, no duplicate person.`,
      "Preserve the contestant identity, age, face, hairstyle, ethnicity, body proportions and outfit continuity from the reference.",
      NO_SCREEN_TEXT_PROMPT,
    ].join("\n"),
    videoPrompt: [
      `Continue the survival challenge for exactly ${LIVE_VIDEO_DURATION_SECONDS} seconds.`,
      sharedContinuity,
      // The expanded shot design already carries beats, camera moves and audio; the template is only
      // the fallback for when the text model is unavailable.
      expanded || [
        `Action for ${participant.display_name} (the viewer's own words, possibly not in English): ${cue}. Perform exactly that; keep it physically plausible and readable within the clip.`,
        guestNames.length ? `${guestNames.join(" and ")} are in shot alongside ${participant.display_name} and act too.` : "",
        PACING_PROMPT,
        FIELD_AUDIO_PROMPT,
      ].filter(Boolean).join("\n"),
      moving
        ? "Continuity: preserve the first frame, contestant identity, wardrobe and camera style. The location is meant to change across this clip — travel to it on camera, do not cut to it."
        : "Continuity: preserve the first frame, contestant identity, wardrobe, location, weather, color grade and camera style.",
      NO_SCREEN_TEXT_PROMPT,
      moving
        ? "Avoid new people, face morphing, fantasy effects, sudden costume changes, or any hard cut."
        : "Avoid new people, face morphing, fantasy effects, sudden costume changes, or jumping to a different location.",
    ].join("\n"),
  };
}

// The director channel stitches the contestant channels together, so its prompt leans on the rolling
// timeline rather than on any single viewer's instruction.
// The opening frame is the END of a contestant's shot. Without saying so, the model just replays
// the beat that already aired — the cutaway has to be told that time moves on.
async function expandDirectorCut(sourceStory: string, timeline: string[], lead: string, condition: string, story: StoryState) {
  const beatSeconds = Math.round(LIVE_VIDEO_DURATION_SECONDS / 3);
  try {
    const shot = await miniMaxChat(
      [
        "You are the shot designer for the broadcast cutaway of a gritty survival reality show.",
        `Write an English video-generation prompt for one ${LIVE_VIDEO_DURATION_SECONDS}-second cutaway.`,
        "Critical: the opening frame is the LAST frame of a contestant's own shot. That beat has already aired.",
        "Rules:",
        "- Do NOT repeat, re-stage or continue the action that just ended. Time moves forward from it.",
        "- Open on that frame and immediately pull back into a wide establishing broadcast shot, then keep the camera drifting — crane up, arc around, settle on the widest view.",
        "- Show the wider situation instead of the contestant's hands: the terrain, the weather closing in, distance still to cover, what is about to become a problem.",
        `- Three escalating beats of about ${beatSeconds} seconds each, written as "0-${beatSeconds}s: ...".`,
        "- Keep the location, weather, wardrobe and colour grade continuous with the opening frame.",
        "- This is the show's wide view, so use it: reveal how far the situation has moved on, what the place has become, and what is closing in next.",
        `- ${SAFE_PERIL_PROMPT}`,
        "- End with one line starting 'Audio:' describing a calm English-speaking commentator narrating the situation over storm ambience.",
        "- No on-screen text, subtitles, captions or graphics. Write everything in English.",
        "Output only the prompt itself, no preamble.",
      ].join("\n"),
      [
        sourceStory ? `The frame we open on is the end of: ${sourceStory}` : `The frame we open on is a contestant at ${story.setting}.`,
        `Where the show is now: ${story.setting}, ${story.clock}.`,
        `Chapter: ${story.phase}. What they are trying to do: ${story.goal}. Tension: ${story.tension}/100.`,
        timeline.length ? `Story so far: ${timeline.join(" ")}` : "This is early in the match.",
        `Contestant visible in the frame: ${lead} — ${condition}`,
      ].join("\n"),
      chatBudget(900),
    );
    return shot || "";
  } catch {
    return "";
  }
}

async function promptsForDirectorCut({
  participant,
  sourceStory,
  timeline,
  story,
}: {
  participant: typeof participants.$inferSelect;
  sourceStory: string;
  timeline: string[];
  story: StoryState;
}) {
  const recap = timeline.length ? `Story so far: ${timeline.join(" ")}` : `Story so far: ${story.goal}, and the contestants are still scattered.`;
  const condition = contestantCondition(participant);
  const expanded = await expandDirectorCut(sourceStory, timeline, participant.display_name, condition, story);
  const sharedContinuity = [
    sourceStory
      ? `The opening frame is where ${participant.display_name}'s last shot ended: ${sourceStory}. That beat is over — this cutaway takes place after it.`
      : `Opening situation: ${participant.display_name} is at ${story.setting}, ${story.clock}.`,
    `Where the show is now: ${story.setting}, ${story.clock}. Chapter: ${story.phase}. Objective: ${story.goal}.`,
    recap,
    `Physical condition: ${condition}.`,
  ].join("\n");
  return {
    visualMemory: cleanText(expanded || `${sourceStory || recap}; ${storyBackdrop(story)}; documentary handheld realism; no on-screen graphics`, 600),
    keyframePrompt: [
      "Create a cinematic 16:9 broadcast frame for a survival challenge using the supplied opening frame.",
      sharedContinuity,
      NO_SCREEN_TEXT_PROMPT,
    ].join("\n"),
    videoPrompt: [
      `Continue the survival challenge broadcast for exactly ${LIVE_VIDEO_DURATION_SECONDS} seconds.`,
      sharedContinuity,
      "The action in the opening frame has already finished. Do not repeat or re-stage it; move time forward from it.",
      expanded || [
        "Action: show what the situation looks like now — the terrain, the weather closing in, what is about to become a problem. Not a rerun of the beat that just ended.",
        // The director line is the show's god's-eye cut, so it opens out of the contestant's own framing.
        "Camera: start on the supplied frame and pull back into a wide establishing broadcast shot that reveals the whole location and where the contestant sits in it, then keep drifting — crane up, arc around, settle on the widest view.",
        PACING_PROMPT,
        DIRECTOR_AUDIO_PROMPT,
      ].join("\n"),
      "Continuity: preserve the contestant identity, wardrobe, location, weather, color grade and camera style from the first frame.",
      NO_SCREEN_TEXT_PROMPT,
      "Avoid new people, face morphing, fantasy effects, sudden costume changes, or jumping to a different location.",
    ].join("\n"),
  };
}

function isHostAccount() {
  const configuredEmail = vars.get("HOST_USER_EMAIL")?.toLowerCase();
  const currentEmail = auth.user?.email?.toLowerCase();
  return Boolean(currentEmail && configuredEmail && currentEmail === configuredEmail);
}

async function requireDirector() {
  if (!isHostAccount()) throw new Error("This account has no host permission");
}

async function characterQuota(matchId: number) {
  const limit = isHostAccount() ? CHARACTER_LIMIT_HOST : CHARACTER_LIMIT_PER_USER;
  if (!auth.user) return { used: 0, limit, remaining: 0 };
  const mine = await db.select({ id: participants.id }).from(participants).where(and(
    eq(participants.match_id, matchId),
    eq(participants.user_id, auth.user.id),
  ));
  return { used: mine.length, limit, remaining: Math.max(0, limit - mine.length) };
}

async function persistVideoResult(generationId: number, remoteUrl: string) {
  // Falling back to the provider's temporary URL means the clip 404s in a few hours, so the reason
  // is recorded rather than swallowed.
  let lastReason = "unknown";
  // Several clips finish at once at the higher tiers and R2 answers the burst with "reduce your
  // concurrent request rate". That is transient and worth waiting out: losing the upload costs the
  // whole clip, which is already paid for.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 400 * 2 ** (attempt - 1)));
      const response = await fetch(remoteUrl);
      if (!response.ok) throw new Error(`download failed (${response.status})`);
      const bytes = await response.arrayBuffer();
      const path = `matches/${LIVE_SLUG}/generation-${generationId}.mp4`;
      await storage.from(buckets.broadcastClips).put(path, bytes, {
        contentType: response.headers.get("content-type") || "video/mp4",
        cacheControl: "public, max-age=31536000, immutable",
      });
      return storage.createS3Uri(buckets.broadcastClips, path);
    } catch (error) {
      lastReason = error instanceof Error ? error.message : "unknown";
    }
  }
  await db.update(generations)
    .set({ error_message: `Clip upload failed, still on the provider temporary link: ${lastReason}` })
    .where(eq(generations.id, generationId))
    .catch(() => undefined);
  return remoteUrl;
}

async function persistTailFrame(generationId: number, frame: { bytes: ArrayBuffer; contentType: string }) {
  const path = `matches/${LIVE_SLUG}/tail-frames/generation-${generationId}.jpg`;
  await storage.from(buckets.broadcastClips).put(path, frame.bytes, {
    contentType: frame.contentType || "image/jpeg",
    cacheControl: "public, max-age=3600",
  });
  return storage.createS3Uri(buckets.broadcastClips, path);
}

async function submitH3VideoFromFrame(materialId: number, prompt: string, duration: number) {
  const videoModel = await getRenoiseModel(LEGACY_LIVE_VIDEO_MODEL);
  const materialRoles = Array.isArray(videoModel.materialRoles) ? videoModel.materialRoles : [];
  if (!materialRoles.includes("first_frame")) throw new Error(`${LEGACY_LIVE_VIDEO_MODEL} does not accept a first frame`);
  const videoResolution = pickAdvertised(videoModel.resolutions, "768p", videoModel.defaultResolution);
  return createRenoiseTask({
    model: LEGACY_LIVE_VIDEO_MODEL,
    prompt: `@material:${materialId}\n${prompt}`,
    duration,
    ...(videoResolution ? { resolution: videoResolution } : {}),
    materials: [{ id: materialId, role: "first_frame", index: 0 }],
  });
}

function pickH3Duration(videoModel: JsonObject, requested: number) {
  const advertisedDurations = Array.isArray(videoModel.durations)
    ? videoModel.durations.map(Number).filter(Number.isFinite)
    : [];
  const requestedDuration = clamp(requested || LIVE_VIDEO_DURATION_SECONDS, LIVE_VIDEO_DURATION_SECONDS, 15);
  const defaultDuration = Number(videoModel.defaultDuration);
  return advertisedDurations.includes(requestedDuration)
    ? requestedDuration
    : advertisedDurations.includes(LIVE_VIDEO_DURATION_SECONDS)
      ? LIVE_VIDEO_DURATION_SECONDS
      : advertisedDurations.includes(defaultDuration) ? defaultDuration : advertisedDurations[0];
}

interface GenerationRequest {
  channel: "director" | "participant";
  channelParticipantId: number | null;
  participantIds: number[];
  keyframePrompt: string;
  videoPrompt: string;
  visualMemory: string;
  duration: number;
  viewerPrompt?: string | null;
  sourceGenerationId?: number | null;
  openingFrameS3Uri?: string | null;
}

// The one place that decides which image opens a clip. A contestant channel is anchored by that
// contestant's own material — their previous tail frame, or their character sheet when the channel
// is new — which is the only way identity survives on a model with no reference-image input.
async function openingFrameFor(request: GenerationRequest, selected: Array<typeof participants.$inferSelect>, matchId: number) {
  if (request.openingFrameS3Uri) {
    const url = await clipUrl(request.openingFrameS3Uri);
    if (url) return { url, s3Uri: request.openingFrameS3Uri, source: "supplied" as const };
  }
  if (request.channel === "participant" && request.channelParticipantId != null) {
    const previous = await latestChannelClip(matchId, "participant", request.channelParticipantId);
    // Everything queued after that clip failed, so the frame it left behind is the one thing every
    // attempt had in common. Stop feeding it back.
    const refusals = previous ? await failuresSince(matchId, request.channelParticipantId, previous.id) : 0;
    if (previous?.thumbnail_url && refusals < TAIL_FRAME_GIVE_UP) {
      const url = await clipUrl(previous.thumbnail_url);
      if (url) return { url, s3Uri: previous.thumbnail_url, source: "channel_tail_frame" as const };
    }
    if (refusals >= TAIL_FRAME_GIVE_UP) {
      console.log(`[frame] contestant ${request.channelParticipantId} reopening on its sheet after ${refusals} refusals`);
    }
  }
  const anchor = selected.find((item) => item.id === request.channelParticipantId) ?? selected[0];
  const url = await avatarUrl(anchor?.avatar_s3_uri ?? null);
  if (!url) throw new Error("No character sheet available, cannot submit the video job");
  return { url, s3Uri: anchor?.avatar_s3_uri ?? null, source: "character_sheet" as const };
}

// Manual director submissions come from the dialog as loose JSON; they always target the director
// channel, never a contestant's own perspective line.
function directorRequestFrom(data: JsonObject): GenerationRequest {
  return {
    channel: "director",
    channelParticipantId: null,
    participantIds: Array.isArray(data.participantIds)
      ? data.participantIds.map(Number).filter(Number.isInteger).slice(0, 3)
      : [],
    keyframePrompt: cleanText(data.keyframePrompt, 3500),
    videoPrompt: cleanText(data.videoPrompt, 3500),
    visualMemory: cleanText(data.visualMemory, 1000),
    duration: Number(data.duration) || LIVE_VIDEO_DURATION_SECONDS,
  };
}

// Queueing is deliberately cheap: validate, write a `queued` row, return. All the slow work —
// expanding the viewer's line into a shot design, writing the identity lock, submitting to fal —
// happens in startQueuedGeneration, so the viewer sees a live stage instead of waiting inside the
// POST with nothing on screen. Video generation itself only takes ~20s and already has feedback.
async function queueLiveGeneration(request: GenerationRequest, createdBy: string) {
  requireFal();
  const participantIds = request.participantIds.filter(Number.isInteger).slice(0, 3);
  if (participantIds.length === 0) throw new Error("Pick 1-3 contestants");
  const match = await ensureLiveMatch();
  const selected = await db.select({ id: participants.id }).from(participants).where(and(
    eq(participants.match_id, match.id),
    or(isNotNull(participants.character_draft_id), eq(participants.is_system, true)),
    inArray(participants.id, participantIds),
  ));
  if (selected.length !== participantIds.length) {
    const error = new Error("The roster changed — refresh and try again");
    error.name = "ConflictError";
    throw error;
  }

  const tier = tierOf(match);
  // Advisory only — it exists to give an API caller a precise error, not to hold the limit. The
  // statement below is what actually holds it.
  const slotError = generationSlotError(
    await activeGenerations(match.id), request.channel, request.channelParticipantId, tier);
  if (slotError) {
    const error = new Error(slotError.error);
    error.name = slotError.status === 409 ? "ConflictError" : "RateLimitError";
    throw Object.assign(error, { generation: slotError.generation });
  }

  const queuedPrompt = JSON.stringify({
    promptVersion: LIVE_PROMPT_VERSION,
    awaitingPrompt: true,
    // The director dialog supplies its own prompts; keep them so startQueuedGeneration
    // does not overwrite them with the template.
    ...(cleanText(request.keyframePrompt, 3500) ? { keyframePrompt: cleanText(request.keyframePrompt, 3500) } : {}),
    ...(cleanText(request.videoPrompt, 3500) ? { videoPrompt: cleanText(request.videoPrompt, 3500) } : {}),
    ...(cleanText(request.visualMemory, 1000) ? { visualMemory: cleanText(request.visualMemory, 1000) } : {}),
  });

  // Every watching browser ticks the house cast and the director, so reading the slot counts and
  // then inserting let a dozen heartbeats all see the same free slot and all take it. That is how
  // one contestant channel ended up with three clips in flight in the same second, and how the
  // house line ate the headroom the director needs. Re-checking inside the INSERT is what actually
  // serialises a channel: the losers write nothing.
  const busy = sql`match_id = ${match.id} and stage in ('queued','keyframe','video')`;
  const channelGuard = request.channel === "director"
    ? sql`(select count(*) from generations where ${busy} and channel = 'director') < ${tier.directorSlots}`
    // A contestant channel is single-file whatever the tier says: its clips chain tail frame to tail
    // frame, and two at once fork the chain.
    : sql`not exists (select 1 from generations where ${busy} and channel = 'participant' and channel_participant_id = ${request.channelParticipantId})`;
  // The house ceiling is what leaves the director room it cannot be crowded out of.
  const houseGuard = createdBy.startsWith("house:")
    ? sql` and (select count(*) from generations where ${busy} and created_by like 'house:%') < ${tier.houseSlots}`
    : sql``;

  const inserted = await db.all<{ id: number }>(sql`
    insert into generations (
      match_id, round, stage, model, channel, channel_participant_id,
      viewer_prompt, source_generation_id, prompt, participant_ids, duration_seconds, created_by
    )
    select ${match.id}, ${match.current_round}, 'queued', ${LIVE_VIDEO_MODEL}, ${request.channel},
      ${request.channelParticipantId}, ${cleanText(request.viewerPrompt, VIEWER_PROMPT_MAX_CHARS) || null},
      ${request.sourceGenerationId ?? null}, ${queuedPrompt}, ${JSON.stringify(participantIds)},
      ${clamp(request.duration || LIVE_VIDEO_DURATION_SECONDS, LIVE_VIDEO_DURATION_SECONDS, 15)}, ${createdBy}
    where (select count(*) from generations where ${busy}) < ${tier.concurrent}
      and ${channelGuard}${houseGuard}
    returning id
  `);
  if (!inserted.length) {
    const lost = generationSlotError(
      await activeGenerations(match.id), request.channel, request.channelParticipantId, tier)
      ?? { status: 429 as const, error: "Too many clips rendering at once — try again shortly", generation: null };
    const error = new Error(lost.error);
    error.name = lost.status === 409 ? "ConflictError" : "RateLimitError";
    throw Object.assign(error, { generation: lost.generation });
  }
  const [generation] = await db.select().from(generations)
    .where(eq(generations.id, inserted[0].id)).limit(1);
  return generation;
}

// Turns a queued row into a submitted fal task. Runs from the sync endpoint, so its cost lands
// on a poll the browser is making anyway rather than on the viewer's submit.
async function startQueuedGeneration(generation: typeof generations.$inferSelect) {
  const [ownerMatch] = await db.select().from(matches).where(eq(matches.id, generation.match_id)).limit(1);
  if (!ownerMatch) throw new Error("That match is gone");
  const story = storyStateOf(ownerMatch);
  const participantIds = parseParticipantIds(generation.participant_ids);
  const selected = await db.select().from(participants)
    .where(and(eq(participants.match_id, generation.match_id), inArray(participants.id, participantIds)));
  if (selected.length === 0) throw new Error("The roster changed — refresh and try again");

  // A link continues from a clip this contestant was written into; its tail frame holds both people.
  let sourceClip: typeof generations.$inferSelect | null = null;
  if (generation.source_generation_id != null) {
    const [row] = await db.select().from(generations)
      .where(eq(generations.id, generation.source_generation_id)).limit(1);
    sourceClip = row ?? null;
  }
  const openingFrameS3Uri = sourceClip?.thumbnail_url ?? null;

  // A director cut has no channel owner of its own, so its lead is whoever owned the clip that
  // supplied the frame.
  const leadId = generation.channel === "director"
    ? sourceClip?.channel_participant_id ?? null
    : generation.channel_participant_id;
  const lead = selected.find((item) => item.id === leadId) ?? selected[0];
  const guests = selected.filter((item) => item.id !== lead.id);

  const latestClip = await latestChannelClip(
    generation.match_id,
    generation.channel,
    generation.channel_participant_id,
  );
  const moving = generation.channel === "participant" && owesTransition(ownerMatch, latestClip?.id ?? null);
  const queuedPrompt = (() => {
    try {
      return asObject(JSON.parse(generation.prompt || "{}"));
    } catch {
      return {} as JsonObject;
    }
  })();
  const suppliedVideoPrompt = cleanText(queuedPrompt.videoPrompt, 3500);
  const prompts = suppliedVideoPrompt
    ? {
      keyframePrompt: cleanText(queuedPrompt.keyframePrompt, 3500),
      videoPrompt: suppliedVideoPrompt,
      visualMemory: cleanText(queuedPrompt.visualMemory, 1000),
    }
    : generation.channel === "director"
    ? await promptsForDirectorCut({
      participant: lead,
      // The frame comes from sourceClip, so the written memory has to come from there too —
      // reading the director channel's own previous clip described a different shot entirely.
      sourceStory: storyTextFromGeneration(sourceClip),
      timeline: await recentVisualMemories(generation.match_id, 3),
      story,
    })
    : await promptsForViewerInput({
      viewerPrompt: generation.viewer_prompt ?? "",
      participant: lead,
      guests,
      latestClip,
      story,
      // The story moved on without this channel, so its next shot is the walk to the new place.
      // Breaking the frame chain instead would reopen on the character sheet, whose background is
      // the beach we are trying to leave.
      moving,
    });

  const keyframePrompt = cleanText(prompts.keyframePrompt, 3500);
  const videoPrompt = cleanText(prompts.videoPrompt, 3500);
  const visualMemory = cleanText(prompts.visualMemory, 1000) || cleanText(videoPrompt, 1000);

  const opening = await openingFrameFor({
    channel: generation.channel,
    channelParticipantId: generation.channel_participant_id,
    participantIds,
    keyframePrompt,
    videoPrompt,
    visualMemory,
    duration: generation.duration_seconds,
    openingFrameS3Uri,
  }, selected, generation.match_id);
  const identityLock = await identityLockLines(selected);

  const taskPrompt = [
    opening.source === "character_sheet"
      ? "Starting from the supplied first frame, animate this survival challenge moment as one continuous take."
      : "Starting from the supplied first frame, continue the exact same survival challenge moment as one continuous take.",
    "The take is continuous but never static: the action escalates and the camera keeps moving and reframing throughout.",
    opening.source === "character_sheet"
      ? "The supplied frame is this contestant's official character sheet: keep the face, hair, body type and outfit identical to it."
      : "Treat the supplied frame as the previous clip's final frame; preserve scene geometry, contestant positions, wardrobe, lighting, weather, camera style and color grade.",
    opening.source === "character_sheet" ? cleanText(keyframePrompt, 800) : "",
    identityLock,
    cleanText(videoPrompt, 3500),
    generation.channel === "director" ? DIRECTOR_AUDIO_PROMPT : FIELD_AUDIO_PROMPT,
    NO_SCREEN_TEXT_PROMPT,
    SAFE_PERIL_PROMPT,
    moving
      ? "The location changes across this take, on camera and without a cut. Avoid any hard cut, reset, new people, face morphing, or sudden costume changes."
      : "Avoid any hard cut to a different scene, any reset, new location, new people, face morphing, or sudden costume changes.",
  ].filter(Boolean).join("\n");

  const videoTask = await createFalVideoTask(taskPrompt, opening.url, generation.duration_seconds);
  // The prompt actually sent to fal is persisted too, so a finished clip can be reproduced later.
  const storedPrompt = JSON.stringify({
    promptVersion: LIVE_PROMPT_VERSION,
    keyframePrompt,
    videoPrompt,
    visualMemory,
    taskPrompt,
    openingFrameSource: opening.source,
    previousGenerationId: latestClip?.id ?? null,
  });
  await db.update(generations)
    .set({ stage: "video", prompt: storedPrompt, video_task_id: videoTask.id })
    .where(eq(generations.id, generation.id));
  return { ...generation, stage: "video" as const, prompt: storedPrompt, video_task_id: videoTask.id };
}

async function miniMaxVisionChat(system: string, text: string, imageUrl: string, maxTokens: number) {
  const payload = asObject(await falFetch(`${FAL_SYNC_BASE}${FAL_CHAT_PATH}`, {
    method: "POST",
    body: JSON.stringify({
      model: vars.get("FAL_VISION_MODEL") || FAL_VISION_MODEL_DEFAULT,
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: [
            { type: "text", text },
            { type: "image_url", image_url: { url: imageUrl } },
          ],
        },
      ],
      max_tokens: maxTokens,
      temperature: 0.3,
    }),
  }));
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  return cleanText(asObject(asObject(choices[0]).message).content, 1200);
}

// H3-Max only ever sees one opening frame, so across a long tail-frame chain the wardrobe, hair and
// build drift. A written description of the character sheet, carried in every prompt, is the anchor.
// Written once per contestant and cached on the row.
async function ensureAppearance(participant: typeof participants.$inferSelect) {
  if (participant.appearance) return participant.appearance;
  const sheetUrl = await avatarUrl(participant.avatar_s3_uri);
  if (!sheetUrl) return "";
  try {
    const written = await miniMaxVisionChat(
      "You write identity-lock sheets for a video-generation pipeline, so that the same person can be "
      + "reproduced frame after frame. Write ONE dense English paragraph covering, in this order: face shape "
      + "and distinctive facial features, skin tone, hair length/colour/texture and how it sits, build and "
      + "height impression, then the outfit layer by layer with exact colours and materials, then any "
      + "identifying accent colour or accessory. Plain concrete words. No name, no story, no camera or "
      + "lighting talk, no speculation about mood. Under 120 words. Output only the paragraph.",
      "Describe this survival-show contestant so they can be redrawn identically in later shots.",
      sheetUrl,
      500,
    );
    const appearance = cleanText(written, 600);
    if (!appearance) return "";
    await db.update(participants).set({ appearance }).where(eq(participants.id, participant.id));
    return appearance;
  } catch {
    // Without the anchor the clip still generates; it just drifts more over a long chain.
    return "";
  }
}

async function identityLockLines(selected: Array<typeof participants.$inferSelect>) {
  const lines = await Promise.all(selected.map(async (participant) => {
    const appearance = await ensureAppearance(participant);
    return appearance ? `IDENTITY LOCK — ${participant.display_name} must look exactly like this in every frame: ${appearance}` : "";
  }));
  return lines.filter(Boolean).join("\n");
}

// The Chinese summaries are for viewers. Director prompts continue from the English memory chain.
async function recentVisualMemories(matchId: number, limit: number) {
  const rows = await db.select().from(generations)
    .where(and(eq(generations.match_id, matchId), eq(generations.stage, "completed")))
    .orderBy(desc(generations.id))
    .limit(limit);
  return rows.map((row) => storyTextFromGeneration(row)).filter(Boolean).reverse();
}

async function recentSummaries(matchId: number, limit: number) {
  const rows = await db.select({ summary: generations.summary }).from(generations)
    .where(and(eq(generations.match_id, matchId), isNotNull(generations.summary)))
    .orderBy(desc(generations.id))
    .limit(limit);
  return rows.map((row) => row.summary!).reverse();
}

// Every finished clip leaves one timeline line: it feeds the next director prompt and, as a world
// event, it is what viewers read in the feed. Never fatal — a clip stands on its own without it.
// Used when the writer fails or comes back unusable. Rotating them keeps a bad stretch from
// reading as the same sentence repeated down the whole timeline.
const HOLDING_LINES = [
  "{who} is still holding out in the storm.",
  "{who} pushes on through the rain, no ground gained yet.",
  "The weather has {who} pinned where they are.",
  "{who} is still on their feet, and that is all the island is giving.",
];

async function summarizeClip(generation: typeof generations.$inferSelect) {
  const [participant] = generation.channel_participant_id != null
    ? await db.select().from(participants).where(eq(participants.id, generation.channel_participant_id)).limit(1)
    : [];
  const who = participant?.display_name ?? "a contestant";

  // A director cut is a wide view of the situation, so it narrates from the clip it was cut from.
  let sourceSummary = "";
  if (generation.channel === "director" && generation.source_generation_id != null) {
    const [source] = await db.select({ summary: generations.summary }).from(generations)
      .where(eq(generations.id, generation.source_generation_id)).limit(1);
    sourceSummary = source?.summary ?? "";
  }

  // The house cast is driven by an internal English cue, not by a viewer. Never let that cue surface
  // as the story line when the writer falls through.
  const authored = generation.created_by.startsWith("house:") ? "" : generation.viewer_prompt;
  const fallback = authored
    ? `${who}：${authored}`
    : sourceSummary || HOLDING_LINES[generation.id % HOLDING_LINES.length].replace("{who}", who);
  let summary = fallback;
  const timeline = await recentSummaries(generation.match_id, 8).catch(() => [] as string[]);
  const writeSummary = () => miniMaxChat(
      [
        "You are the commentator on a desert-island survival reality show, tying scattered clips into one continuous story.",
        "From the timeline below and what happens in this clip, write ONE English sentence under 25 words that moves the story on: what someone is doing, what state they are in, or what just turned.",
        "Never describe the filming. No \"shot\", \"camera\", \"frame\", \"cut\", \"close-up\", \"pan\", \"zoom\", \"the director\" — nothing about editing or broadcasting.",
        "Only the people and events inside the story, as if telling a viewer what is happening. Do not repeat what the timeline already said.",
        "Output that one sentence only — no quotes, no prefix.",
      ].join("\n"),
      [
        timeline.length ? `Story so far, in order:\n${timeline.map((line, index) => `${index + 1}. ${line}`).join("\n")}` : "This is the opening of the story.",
        generation.channel === "director"
          ? [
            "This clip is the wide view of the game, establishing where things stand overall.",
            sourceSummary ? `What just aired: ${sourceSummary} (do not restate it)` : `${who} is on screen.`,
            "Write that sentence from the outside view: where the situation is heading, the pressure of the weather, or what someone is about to face. Do not repeat what just aired.",
          ].join("\n")
          : [
            `This clip is ${who}'s point of view.`,
            authored
              ? `What ${who} is doing here: ${authored}`
              : `${who} is pushing their own survival plan forward and running into new trouble.`,
            "Write that sentence, giving the situation or the outcome of it.",
          ].join("\n"),
      ].join("\n\n"),
      chatBudget(200),
    );
  try {
    // The writer fails intermittently under load, and a dropped line leaves a hole in the timeline
    // that every later summary reads from. One retry is worth it.
    const written = await writeSummary().catch(() => writeSummary());
    const line = cleanText(written, 260);
    // A reply cut off mid-phrase reads as a glitch to the viewer; the template line is better.
    if (line && (line.length > 24 || /[.!?]$/.test(line))) summary = line;
  } catch {
    // Keep the template line.
  }
  await db.update(generations).set({ summary }).where(eq(generations.id, generation.id));
  await db.update(matches).set({ story_beat: sql`story_beat + 1` })
    .where(eq(matches.id, generation.match_id)).catch(() => undefined);
  await db.insert(matchEvents).values({
    match_id: generation.match_id,
    participant_id: generation.channel_participant_id,
    round: generation.round,
    kind: "world",
    title: generation.channel === "director" ? "Standings" : `${who} POV`,
    detail: summary,
  });
  return summary;
}

// Round-robin across contestant channels: whoever has fresh footage and has waited longest since the
// director last cut to them goes next.
// How far back the director looks for footage. Candidates are only ever the newest clip per
// contestant, and a cut that used one of those is recent too, so nothing older can change the answer.
const DIRECTOR_SOURCE_WINDOW = 150;

// Exactly what the live payload reads back out. Selecting whole rows dragged the prompt column with
// every clip — several kilobytes each, sixty of them, on every heartbeat from every browser — and
// none of it is ever sent to anyone.
const CLIP_PAYLOAD_COLUMNS = {
  id: generations.id,
  round: generations.round,
  stage: generations.stage,
  duration_seconds: generations.duration_seconds,
  channel: generations.channel,
  channel_participant_id: generations.channel_participant_id,
  participant_ids: generations.participant_ids,
  source_generation_id: generations.source_generation_id,
  summary: generations.summary,
  result_url: generations.result_url,
  thumbnail_url: generations.thumbnail_url,
  created_at: generations.created_at,
} as const;

async function pickDirectorSource(match: typeof matches.$inferSelect) {
  const matchId = match.id;
  // Four columns and a bounded window, deliberately. Selecting whole rows with no limit meant every
  // heartbeat pulled every finished clip the show had ever made — prompt payloads included, tens of
  // megabytes of them — and that is what put the database over its memory limit and took the live
  // endpoint down. Only the newest clip per contestant can ever be picked, so this window is plenty.
  const clips = await db.select({
    id: generations.id,
    channel_participant_id: generations.channel_participant_id,
    thumbnail_url: generations.thumbnail_url,
    participant_ids: generations.participant_ids,
  }).from(generations)
    .where(and(
      eq(generations.match_id, matchId),
      eq(generations.channel, "participant"),
      eq(generations.stage, "completed"),
      isNotNull(generations.thumbnail_url),
      // A cut opens on this clip's tail frame, so footage from before the last relocation would put
      // the broadcast back in a place the story has left. Better to wait a beat than to cut there.
      gte(generations.id, match.story_reframe_after),
    ))
    .orderBy(desc(generations.id))
    .limit(DIRECTOR_SOURCE_WINDOW);
  const newestByParticipant = new Map<number, (typeof clips)[number]>();
  for (const clip of clips) {
    const pid = clip.channel_participant_id;
    if (pid != null && !newestByParticipant.has(pid)) newestByParticipant.set(pid, clip);
  }
  if (newestByParticipant.size === 0) return null;

  const directorClips = await db.select({
    id: generations.id,
    source_generation_id: generations.source_generation_id,
  }).from(generations)
    .where(and(eq(generations.match_id, matchId), eq(generations.channel, "director"), isNotNull(generations.source_generation_id)))
    .orderBy(desc(generations.id))
    .limit(DIRECTOR_SOURCE_WINDOW);
  const sourceIds = new Set(directorClips.map((clip) => clip.source_generation_id!));
  const lastCutAt = new Map<number, number>();
  for (const director of directorClips) {
    const source = clips.find((clip) => clip.id === director.source_generation_id);
    const pid = source?.channel_participant_id;
    if (pid != null && !lastCutAt.has(pid)) lastCutAt.set(pid, director.id);
  }

  const candidates = [...newestByParticipant.values()]
    // A clip the director already used is not fresh footage any more.
    .filter((clip) => !sourceIds.has(clip.id))
    .sort((a, b) => {
      const aCut = lastCutAt.get(a.channel_participant_id!) ?? -1;
      const bCut = lastCutAt.get(b.channel_participant_id!) ?? -1;
      return aCut - bCut;
    });
  return candidates[0] ?? null;
}

// Chained off a tail frame landing: EdgeSpark has no scheduler, so the director line advances on the
// back of the request that made new footage usable.
// Nobody submits prompts for the house cast, so the show writes their storylines itself. They run on
// ordinary contestant channels — same identity anchoring, same tail-frame chain — which is what lets
// the director cut to them exactly as it cuts to a viewer's contestant, and what keeps the broadcast
// moving when no viewer has asked for anything.
// A backstop against a runaway loop, not the cost control — that is the tier below, which the host
// can move at any time. A cumulative cap is a one-way door: once reached the show stops for good
// and only a redeploy restarts it.
const HOUSE_CAST_MAX_CLIPS = 20000;

// How hard the show films. Rendering is the whole cost of this project, so the host can throttle it
// from /admin-change when nobody is watching rather than having to take the site down.
type GenerationTierKey = "live" | "paced" | "idle" | "hourly";
interface GenerationTier {
  key: GenerationTierKey;
  label: string;
  detail: string;
  concurrent: number;
  // Per-line ceilings. A contestant channel is single-file whatever the tier says — its clips chain
  // tail frame to tail frame and two at once would fork the chain — so houseSlots is how many
  // different contestants may be filming at the same time.
  directorSlots: number;
  houseSlots: number;
  gapSeconds: number;
  // Low tiers pace the director on the same clock as the cast, so "one clip an hour" means one
  // clip an hour in total, not one per line.
  gapCoversDirector: boolean;
  // How much the show may film of its own accord inside one gapSeconds window. Absent means the
  // old behaviour: one clip, then wait out the whole gap.
  houseBurst?: number;
  directorBurst?: number;
}
const GENERATION_TIERS: Record<GenerationTierKey, GenerationTier> = {
  live: {
    key: "live",
    label: "Live",
    detail: "3 contestant clips and 2 director cuts in flight, about 10 clips a minute.",
    concurrent: 5,
    directorSlots: 2,
    houseSlots: 3,
    gapSeconds: 4,
    gapCoversDirector: false,
  },
  paced: {
    key: "paced",
    label: "Paced",
    detail: "Four contestant clips and one director cut every ten minutes. Anything a viewer asks for still films at once, on top of this.",
    // Headroom is for the room, not for the pace: a burst of viewer lines needs somewhere to go.
    concurrent: 5,
    directorSlots: 2,
    houseSlots: 4,
    gapSeconds: 600,
    gapCoversDirector: false,
    houseBurst: 4,
    directorBurst: 1,
  },
  idle: {
    key: "idle",
    label: "Low",
    detail: "One clip at a time, one a minute. Use this when hardly anyone is watching.",
    concurrent: 1,
    directorSlots: 1,
    houseSlots: 1,
    gapSeconds: 60,
    gapCoversDirector: true,
  },
  hourly: {
    key: "hourly",
    label: "Idle",
    detail: "One clip at a time, one an hour. Costs almost nothing; the broadcast barely moves.",
    concurrent: 1,
    directorSlots: 1,
    houseSlots: 1,
    gapSeconds: 3600,
    gapCoversDirector: true,
  },
};

function tierOf(match: { generation_tier: string }) {
  return GENERATION_TIERS[match.generation_tier as GenerationTierKey] ?? GENERATION_TIERS.live;
}

// Every auto-queued clip counts against the low tiers' clock, whichever line asked for it.
// Only what the show filmed of its own accord. A clip somebody asked for is not part of the pace
// being kept — counting it would let one viewer's line push the next self-driven beat back.
async function autoQueuedWithin(matchId: number, seconds: number, houseOnly: boolean) {
  const [row] = await db.select({ n: sql<number>`count(*)` }).from(generations)
    .where(and(
      eq(generations.match_id, matchId),
      houseOnly
        ? eq(generations.created_by, "house:auto")
        : sql`${generations.created_by} in ('house:auto', 'director:auto')`,
      sql`${generations.created_at} >= datetime('now', ${`-${seconds} seconds`})`,
    ));
  return Number(row?.n ?? 0);
}

async function directorCutsWithin(matchId: number, seconds: number) {
  const [row] = await db.select({ n: sql<number>`count(*)` }).from(generations)
    .where(and(
      eq(generations.match_id, matchId),
      eq(generations.created_by, "director:auto"),
      sql`${generations.created_at} >= datetime('now', ${`-${seconds} seconds`})`,
    ));
  return Number(row?.n ?? 0);
}
// The room's chat is the queue the show films from. A message is claimed atomically so two pickers
// running at once cannot shoot the same line twice, and a message that named a contestant is
// preferred for that contestant's channel — being mentioned is how a viewer aims their idea.
// A browser counts as watching for this long after its last heartbeat, which runs every 9s.
const VIEWER_PRESENCE_WINDOW_SECONDS = 45;

async function markWatching(matchId: number, deviceId: string) {
  if (!deviceId) return;
  await db.insert(viewerPresence)
    // first_seen is only written on insert, so it keeps the arrival even as last_seen moves.
    .values({ match_id: matchId, device_id: deviceId, first_seen: sql`current_timestamp` as unknown as string })
    .onConflictDoUpdate({
      target: viewerPresence.device_id,
      set: { match_id: matchId, last_seen: sql`current_timestamp` },
    })
    .catch(() => undefined);
}

// Presence is per browser, so it is the one part of the heartbeat that cannot ride the advance
// lease: a single winner marking itself watching every four seconds would leave the counter reading
// one, and nobody but that winner would ever get an arrival row. Refreshed at two thirds of the
// presence window — the widest spacing that still keeps a steadily-polling viewer inside the
// window — and remembered per isolate, so most heartbeats cost no write at all. The memo has to
// out-size the audience an isolate actually sees: once it starts evicting live entries, every
// evicted viewer's next heartbeat writes again and the cap has bought nothing.
const PRESENCE_REFRESH_MS = (VIEWER_PRESENCE_WINDOW_SECONDS * 2 / 3) * 1000;
const PRESENCE_MEMO_MAX = 20000;
const presenceMemo = new Map<string, number>();

function presenceDue(deviceId: string) {
  const now = Date.now();
  const seen = presenceMemo.get(deviceId);
  if (seen != null && now - seen < PRESENCE_REFRESH_MS) return false;
  // Insertion order is eviction order. A cold isolate rebuilds this from nothing, so it only has to
  // stay bounded — dropping a live viewer's entry just costs one extra write.
  if (presenceMemo.size >= PRESENCE_MEMO_MAX) {
    for (const key of presenceMemo.keys()) {
      presenceMemo.delete(key);
      if (presenceMemo.size < PRESENCE_MEMO_MAX * 0.8) break;
    }
  }
  presenceMemo.set(deviceId, now);
  return true;
}

// A synthetic crowd sitting under the real one, so the counter reads like a broadcast rather than
// like an empty room. Derived from the clock, not from random: every viewer sees the same figure at
// the same moment, and it drifts smoothly instead of jumping between heartbeats. Set to 0 to show
// only the people actually present.
const SYNTHETIC_AUDIENCE_CENTRE = 1600;
const SYNTHETIC_AUDIENCE_SWING = 780;

function syntheticAudience(now = Date.now()) {
  if (SYNTHETIC_AUDIENCE_CENTRE <= 0) return 0;
  // Stepped to 30-second buckets: the figure still drifts over minutes, but within a bucket every
  // heartbeat reads the same value — which is what lets an otherwise-unchanged /live payload keep
  // its ETag and answer with a 304 instead of a fresh body.
  const t = Math.floor(now / 30000) * 30;
  // Two periods that do not divide into each other, so the curve never looks like a loop: a tide
  // over ~90 minutes and a ripple over ~13.
  const tide = Math.sin((t / 5400) * Math.PI * 2);
  const ripple = Math.sin((t / 780) * Math.PI * 2 + 1.7);
  const drift = tide * SYNTHETIC_AUDIENCE_SWING + ripple * (SYNTHETIC_AUDIENCE_SWING * 0.17);
  return Math.max(120, Math.round(SYNTHETIC_AUDIENCE_CENTRE + drift));
}

// Browsers actually present. The admin page reads this one; the broadcast adds the synthetic crowd.
async function countRealWatching(matchId: number) {
  const [row] = await db.select({ n: sql<number>`count(*)` }).from(viewerPresence)
    .where(and(
      eq(viewerPresence.match_id, matchId),
      sql`${viewerPresence.last_seen} >= datetime('now', ${`-${VIEWER_PRESENCE_WINDOW_SECONDS} seconds`})`,
    ));
  return Number(row?.n ?? 0);
}

async function countWatching(matchId: number) {
  return await countRealWatching(matchId) + syntheticAudience();
}

// What the host asked to see: who arrived, who actually said something, and who took one of the
// unlock links. The click-through counts come off viewer_perks, because a rung is only granted when
// the viewer opens that link — the tier IS the click.
async function audienceBoard(matchId: number) {
  const one = async (query: Promise<Array<{ n: number }>>) => Number((await query)[0]?.n ?? 0);
  const [visitors, visitorsToday, spoke, spokeToday, messages, followedX, followedJp, registered] = await Promise.all([
    one(db.select({ n: sql<number>`count(*)` }).from(viewerPresence)),
    one(db.select({ n: sql<number>`count(*)` }).from(viewerPresence)
      .where(sql`${viewerPresence.first_seen} >= date('now')`)),
    one(db.select({ n: sql<number>`count(distinct ${chatMessages.device_id})` }).from(chatMessages)
      .where(and(eq(chatMessages.match_id, matchId), sql`${chatMessages.device_id} != '' and ${chatMessages.device_id} not like 'seed:%'`))),
    one(db.select({ n: sql<number>`count(distinct ${chatMessages.device_id})` }).from(chatMessages)
      .where(and(eq(chatMessages.match_id, matchId), sql`${chatMessages.device_id} != '' and ${chatMessages.device_id} not like 'seed:%' and ${chatMessages.created_at} >= date('now')`))),
    one(db.select({ n: sql<number>`count(*)` }).from(chatMessages)
      .where(and(eq(chatMessages.match_id, matchId), sql`${chatMessages.device_id} != '' and ${chatMessages.device_id} not like 'seed:%'`))),
    one(db.select({ n: sql<number>`count(*)` }).from(viewerPerks).where(sql`${viewerPerks.tier} >= 1`)),
    one(db.select({ n: sql<number>`count(*)` }).from(viewerPerks).where(sql`${viewerPerks.tier} >= 2`)),
    one(db.select({ n: sql<number>`count(*)` }).from(viewerPerks).where(sql`${viewerPerks.tier} >= 3`)),
  ]);
  return { visitors, visitorsToday, spoke, spokeToday, messages, followedX, followedJp, registered };
}

const CHAT_MAX_CHARS = 140;
// Speaking is what puts a clip on the meter, so it is rationed. Each step grants more, and none of
// them can be checked from here — following an account off-site leaves nothing the server can read —
// so unlocking is on the viewer's word. The host is exempt.
const CHAT_UNLOCKS = [
  { key: "base", grant: 1, title: "", detail: "", url: "", cta: "" },
  {
    key: "follow_x",
    grant: 2,
    title: "Follow Renoise on X",
    detail: "Follow with the button below and 2 more messages are yours right away.",
    url: "https://x.com/renoiseai",
    cta: "Follow",
  },
  {
    key: "follow_x_jp",
    grant: 4,
    title: "Follow Renoise Jp on X",
    detail: "The Japanese account — follow it for 4 more messages.",
    url: "https://x.com/renoiseaijp",
    cta: "Follow",
  },
  {
    key: "register",
    grant: 5,
    title: "Create a Renoise account",
    detail: "Sign up at Renoise for a final 5 messages.",
    url: "https://renoise.ai/?utm_medium=renoiselive&utm_source=tomato-renoise-live",
    cta: "Sign up",
  },
];

function chatAllowanceFor(tier: number) {
  return CHAT_UNLOCKS.slice(0, Math.min(tier, CHAT_UNLOCKS.length - 1) + 1)
    .reduce((total, step) => total + step.grant, 0);
}

function nextUnlock(tier: number) {
  const step = CHAT_UNLOCKS[tier + 1];
  if (!step) return null;
  return { key: step.key, grant: step.grant, title: step.title, detail: step.detail, url: step.url, cta: step.cta };
}

// Chatting needs no account, so the quota follows the browser. A viewer who clears their storage
// gets a fresh allowance — that is the cost of not making people sign in to speak.
function deviceIdOf(c: { req: { header(name: string): string | undefined } }) {
  const raw = cleanText(c.req.header("X-Device-Id"), 64);
  return /^[A-Za-z0-9_-]{8,64}$/.test(raw) ? raw : "";
}

function guestHandle(deviceId: string) {
  return `guest-${deviceId.replace(/[^A-Za-z0-9]/g, "").slice(-4).toLowerCase() || "0000"}`;
}

async function viewerTier(deviceId: string) {
  if (!deviceId) return 0;
  const [row] = await db.select().from(viewerPerks).where(eq(viewerPerks.device_id, deviceId)).limit(1);
  return row?.tier ?? 0;
}

async function chatAllowanceState(matchId: number, deviceId: string) {
  if (isHostAccount()) {
    return { unlimited: true, used: 0, allowance: 0, remaining: 0, tier: CHAT_UNLOCKS.length - 1, next: null };
  }
  if (!deviceId) return null;
  const [tally] = await db.select({ n: sql<number>`count(*)` }).from(chatMessages)
    .where(and(eq(chatMessages.match_id, matchId), eq(chatMessages.device_id, deviceId)));
  const tier = await viewerTier(deviceId);
  const used = Number(tally?.n ?? 0);
  const allowance = chatAllowanceFor(tier);
  return {
    unlimited: false,
    used,
    allowance,
    remaining: Math.max(0, allowance - used),
    tier,
    next: nextUnlock(tier),
  };
}

const CHAT_COOLDOWN_SECONDS = 4;

// A handle, not the address: chat is public and an email is not.
function chatHandle(email: string) {
  const name = email.split("@")[0] || "viewer";
  return name.length > 14 ? `${name.slice(0, 14)}…` : name;
}

function chatPayload(row: typeof chatMessages.$inferSelect) {
  return {
    id: row.id,
    display_name: row.display_name,
    body: row.body,
    mentions: parseParticipantIds(row.mentions),
    filmed: Boolean(row.consumed_at),
    generation_id: row.generation_id,
    created_at: row.created_at,
  };
}

// The room drives the show, so the queue is ranked before anything else is considered: the host is
// never left waiting, and a real viewer always outranks the chatter we seeded ourselves. Sampling
// one line out of a mixed pool meant a viewer's idea competed with dozens of our own.
const CHAT_PRIORITY_SEED = 0;
const CHAT_PRIORITY_VIEWER = 1;
const CHAT_PRIORITY_HOST = 2;

// Is anyone real still waiting to be filmed? Only asked when the pacing gap is about to turn the
// cast away, so the common path pays nothing for it.
// Claiming happens before the slot is secured, so a line can be taken out of the queue and then
// lose the race for the last render slot. Left there it would be marked filmed and never filmed —
// a viewer's message silently swallowed. Put it back instead.
// A render can fail after the line was taken out of the queue — the video model refuses a frame,
// a task never comes back — and until now that was the end of it: marked filmed, never filmed.
// A real viewer's line goes back instead. Bounded, because a line the model will always refuse
// would otherwise retry until it had spent real money on nothing.
const CHAT_CUE_MAX_ATTEMPTS = 3;

async function requeueFailedCue(generationId: number) {
  await db.update(chatMessages)
    .set({ consumed_at: null, generation_id: null })
    .where(and(
      eq(chatMessages.generation_id, generationId),
      gte(chatMessages.priority, CHAT_PRIORITY_VIEWER),
      lt(chatMessages.attempts, CHAT_CUE_MAX_ATTEMPTS),
    ))
    .catch(() => undefined);
}

async function releaseChatCue(id: number) {
  // The attempt is given back with the line. Losing a race for the last slot is not the cameras
  // trying and failing — nothing was ever sent — and counting it burned the retry budget on a
  // message the model had never seen. Attempts are failed renders, only.
  await db.update(chatMessages)
    .set({ consumed_at: null, attempts: sql`max(0, attempts - 1)` })
    .where(eq(chatMessages.id, id)).catch(() => undefined);
}

async function viewerLineWaiting(matchId: number) {
  const [row] = await db.select({ n: sql<number>`count(*)` }).from(chatMessages)
    .where(and(
      eq(chatMessages.match_id, matchId),
      isNull(chatMessages.consumed_at),
      gte(chatMessages.priority, CHAT_PRIORITY_VIEWER),
      lt(chatMessages.attempts, CHAT_CUE_MAX_ATTEMPTS),
    ));
  return Number(row?.n ?? 0) > 0;
}

async function claimChatCue(matchId: number, availableIds: number[]) {
  // People only. The seeded room is atmosphere — it makes the chat feel inhabited, and that is all
  // it is for. Letting it commission footage meant most of what the show filmed was its own chatter
  // talking to itself, and a real viewer's line was one voice among ours.
  const waiting = await db.select().from(chatMessages)
    .where(and(
      eq(chatMessages.match_id, matchId),
      isNull(chatMessages.consumed_at),
      gte(chatMessages.priority, CHAT_PRIORITY_VIEWER),
      lt(chatMessages.attempts, CHAT_CUE_MAX_ATTEMPTS),
    ))
    .orderBy(desc(chatMessages.priority), chatMessages.id)
    .limit(40);
  if (!waiting.length) return null;

  // Only the top rank present is in play; everything below it waits its turn.
  const rank = waiting[0].priority;
  const ranked = waiting.filter((item) => item.priority === rank);

  // Naming someone is how a viewer casts their idea, so a message whose target is free to film
  // outranks one that would have to be handed to whoever happens to be idle.
  const aimed = ranked.filter((item) => parseParticipantIds(item.mentions).some((id) => availableIds.includes(id)));
  const unaimed = ranked.filter((item) => parseParticipantIds(item.mentions).length === 0);
  // A line that names someone is a casting decision. Handing it to whoever happens to be free
  // films the opposite of what was asked, so a real viewer's line waits for the person they named
  // instead — they are only ever a clip away. Our own seeded chatter can be recast freely.
  const pool = aimed.length ? aimed
    : unaimed.length ? unaimed
    : rank >= CHAT_PRIORITY_VIEWER ? []
    : ranked;
  if (!pool.length) return null;
  // The host's lines are filmed in the order they were written; everyone else's is a draw.
  const pick = rank >= CHAT_PRIORITY_HOST ? pool[0] : pool[Math.floor(Math.random() * pool.length)];

  const [claimed] = await db.update(chatMessages)
    .set({ consumed_at: new Date().toISOString(), attempts: sql`attempts + 1` })
    .where(and(eq(chatMessages.id, pick.id), isNull(chatMessages.consumed_at)))
    .returning();
  return claimed ?? null;
}

// The room seeds itself when real viewers are quiet. These land in the same queue as everyone
// else's lines, so a seeded message is a real instruction that gets filmed, not decoration.
const CHAT_SEED_HANDLES = [
  "kaito92", "mira_", "notdave", "eelsoup", "grimjr", "pixel_hana", "th3orist", "mossy",
  "vantablack", "roachking", "sundae", "bugbear", "nine_lives", "orbital", "kettle",
];
// How talkative the room is. The floor doubles as the queue depth: seeding stops once that many
// lines are waiting, so a chatty tier fills the queue faster than a slow render tier drains it.
type ChatSeedTierKey = "busy" | "normal" | "quiet" | "off";
interface ChatSeedTier {
  key: ChatSeedTierKey;
  label: string;
  detail: string;
  floor: number;
  gapSeconds: number;
}
const CHAT_SEED_TIERS: Record<ChatSeedTierKey, ChatSeedTier> = {
  busy: {
    key: "busy",
    label: "Busy",
    detail: "Up to 5 lines waiting, a new one every 12s. The room feels packed.",
    floor: 5,
    gapSeconds: 12,
  },
  normal: {
    key: "normal",
    label: "Normal",
    detail: "Up to 2 lines waiting, a new one every 45s.",
    floor: 2,
    gapSeconds: 45,
  },
  quiet: {
    key: "quiet",
    label: "Quiet",
    detail: "One line waiting at most, and only every 3 minutes.",
    floor: 1,
    gapSeconds: 180,
  },
  off: {
    key: "off",
    label: "Off",
    detail: "Nobody is seeded. Only real viewers speak, and the show falls back to its own cues.",
    floor: 0,
    gapSeconds: 0,
  },
};

function chatSeedTierOf(match: { chat_seed_tier: string }) {
  return CHAT_SEED_TIERS[match.chat_seed_tier as ChatSeedTierKey] ?? CHAT_SEED_TIERS.normal;
}

async function maybeSeedChat(match: typeof matches.$inferSelect) {
  const matchId = match.id;
  const tier = chatSeedTierOf(match);
  if (tier.floor <= 0) return null;
  try {
    requireFal();
    const [waiting] = await db.select({ n: sql<number>`count(*)` }).from(chatMessages)
      .where(and(
        eq(chatMessages.match_id, matchId),
        isNull(chatMessages.consumed_at),
        gte(chatMessages.priority, CHAT_PRIORITY_VIEWER),
      ));
    // Only speak up when the room has gone quiet; real viewers always take priority.
    if (Number(waiting?.n ?? 0) >= tier.floor) return null;

    const [recent] = await db.select({ n: sql<number>`count(*)` }).from(chatMessages)
      .where(and(
        eq(chatMessages.match_id, matchId),
        sql`${chatMessages.device_id} like 'seed:%'`,
        sql`${chatMessages.created_at} >= datetime('now', ${`-${tier.gapSeconds} seconds`})`,
      ));
    if (Number(recent?.n ?? 0) > 0) return null;

    const roster = await db.select().from(participants).where(and(
      eq(participants.match_id, matchId),
      or(isNotNull(participants.character_draft_id), eq(participants.is_system, true)),
    ));
    if (!roster.length) return null;
    const names = roster.map((item) => item.display_name);
    const story = storyStateOf(match);
    // Written off the recap alone, the room turned into an echo of the show: every seeded line was
    // another variation of whatever the last four clips had been about, and those lines then drove
    // the next clips. The people actually watching are the way out of that loop, so they are most
    // of what a seeded viewer is made of.
    const room = await recentRoomLines(matchId, 25, 12).catch(() => [] as string[]);

    const written = await miniMaxChat(
      [
        "You are one viewer in the live chat of a survival reality show. Write ONE chat message.",
        "Rules:",
        "- Under 90 characters. One line. No quotes around it.",
        `- Tell a contestant what to do next, and name them with @. Contestants: ${names.map((n) => `@${n}`).join(", ")}.`,
        "- You may name two of them in one message if you want them in the same shot.",
        "- Sound like a person watching a stream at 1am: casual, lowercase, blunt, sometimes funny.",
        "- Never sound like a narrator, an assistant, or an announcer. No 'let us', no 'perhaps', no stage directions.",
        `- It has to be something they could physically do where they actually are: ${story.setting}.`,
        room.length
          ? "- The real people in the room are most of who you are. Take their subject, their mood and the way they type; want what they want. The recap is background you glance at, never the thing you retell — do not simply restate the last shot."
          : "- The room is quiet, so pick something the recap has not already covered rather than narrating it back.",
        // Following the room cannot mean multiplying its worst line: one viewer's insult would
        // otherwise come back as a chorus of them, and every one of those is a clip cue.
        "- Follow the room, not its worst line. Never repeat an insult, a sexual remark or abuse aimed at anyone. Take what that person seems to want to see happen and ask for that instead; if there is nothing, ignore them.",
        "Output the message only.",
      ].join("\n"),
      [
        room.length
          ? `What the real people watching are saying, newest last — this is most of what you are:\n${room.map((line) => `- ${line}`).join("\n")}`
          : "Nobody real has said anything for a while.",
        // The current chapter, not the last few clips: clips are filmed behind the story, so their
        // summaries describe a place the show has already left and the room ends up shouting about
        // a flooded tunnel while the contestants stand on a cliff.
        `\nBackground — where they are right now: ${story.setting} (${story.clock}). They are trying to ${story.goal}.`,
      ].join("\n"),
      chatBudget(120),
    );

    const body = cleanText(written, CHAT_MAX_CHARS).replace(/^["']|["']$/g, "");
    // A reply with nobody in it would film as an unaimed cue and waste the beat.
    if (body.length < 6 || !/@/.test(body)) {
      console.error("[seed] unusable reply", JSON.stringify({ written, body }));
      return null;
    }
    const mentions = mentionedParticipants(body, roster, -1).map((item) => item.id).slice(0, 3);
    if (!mentions.length) {
      console.error("[seed] no mention matched", JSON.stringify({ body, names }));
      return null;
    }

    const handle = CHAT_SEED_HANDLES[Math.floor(Math.random() * CHAT_SEED_HANDLES.length)];
    // The gap was checked before the model call, which takes seconds — long enough for a second
    // heartbeat to pass the same check and post a twin. Re-checking it inside the insert is what
    // actually holds the interval: the loser writes nothing.
    const inserted = await db.run(sql`
      insert into chat_messages (match_id, user_id, device_id, display_name, body, mentions)
      select ${matchId}, '', ${`seed:${handle}`}, ${handle}, ${body}, ${JSON.stringify(mentions)}
      where not exists (
        select 1 from chat_messages
        where match_id = ${matchId}
          and device_id like 'seed:%'
          and created_at >= datetime('now', ${`-${tier.gapSeconds} seconds`})
      )
    `);
    return inserted;
  } catch (error) {
    // A quiet room is better than a broken heartbeat.
    console.error("[seed] failed", error instanceof Error ? error.message : String(error));
    return null;
  }
}

// ── The showrunner ───────────────────────────────────────────────────────────
// The world used to be three string constants baked into the prompts, so the show filmed the same
// beach with the same instruction forever no matter what the timeline said. These read that world
// out of the match row instead, and rewrite it whenever the story has earned a turn.

// Completed clips between turns when the room is silent. Every real viewer line pulls the next turn
// two clips closer — that is what "the audience moves the plot" means mechanically.
// The room is what moves this show. Three real viewer lines turn the story, whatever the clip count
// says; the beat target is only what carries it along when nobody is talking. The floor is the one
// hard limit — a chapter that ends before its first clip has aired is a chapter nobody can follow.
const STORY_PUSH_TRIGGER = 3;
const STORY_BEAT_TARGET = 12;
const STORY_BEAT_FLOOR = 4;

type StoryState = {
  chapter: number;
  phase: string;
  setting: string;
  goal: string;
  clock: string;
  directive: string;
  tension: number;
};

function storyStateOf(match: typeof matches.$inferSelect): StoryState {
  return {
    chapter: match.story_chapter,
    phase: match.story_phase,
    setting: match.story_setting,
    goal: match.story_goal,
    clock: match.story_clock,
    directive: match.story_directive,
    tension: match.story_tension,
  };
}

// Where the show is, written for a video model. Every prompt that used to say "stormy remote coast"
// says this instead.
function storyBackdrop(story: StoryState) {
  return `${story.setting}; ${story.clock}`;
}

// The model is asked for JSON but answers like a writer, sometimes fenced, sometimes with a
// sentence in front. Take the outermost object and ignore the rest.
function parseModelJson(raw: string) {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return asObject(JSON.parse(raw.slice(start, end + 1)));
  } catch {
    return null;
  }
}

// Viewer lines since the last turn, oldest first. Seeded chatter is deliberately excluded: the point
// of this list is to let the people actually in the room steer, and the seeds are ours.
// The room as the seeded chat hears it: recent real lines only. Older ones would have the fake
// viewers still arguing about a situation the show left an hour ago.
async function recentRoomLines(matchId: number, minutes: number, limit: number) {
  const rows = await db.select({ name: chatMessages.display_name, body: chatMessages.body })
    .from(chatMessages)
    .where(and(
      eq(chatMessages.match_id, matchId),
      sql`${chatMessages.device_id} not like 'seed:%'`,
      sql`${chatMessages.created_at} >= datetime('now', ${`-${minutes} minutes`})`,
    ))
    .orderBy(desc(chatMessages.id))
    .limit(limit);
  return rows.map((row) => `${row.name}: ${row.body}`).reverse();
}

async function viewerPushSince(matchId: number, since: string | null) {
  const rows = await db.select({ name: chatMessages.display_name, body: chatMessages.body })
    .from(chatMessages)
    .where(and(
      eq(chatMessages.match_id, matchId),
      sql`${chatMessages.device_id} not like 'seed:%'`,
      since ? sql`${chatMessages.created_at} > ${since}` : sql`1 = 1`,
    ))
    .orderBy(desc(chatMessages.id))
    .limit(12);
  return rows.map((row) => `${row.name}: ${row.body}`).reverse();
}

// The chapters the show has already done. Clip summaries describe single beats, so a diet of them
// alone makes the showrunner think in beats too and hand back another inch of the same rock. The
// chapter list is the only view of the story at the size this decision is made at.
async function recentChapters(matchId: number, limit: number) {
  const rows = await db.select({ title: matchEvents.title, detail: matchEvents.detail })
    .from(matchEvents)
    .where(and(eq(matchEvents.match_id, matchId), eq(matchEvents.kind, "world")))
    .orderBy(desc(matchEvents.id))
    .limit(limit);
  return rows.reverse();
}

// The island, as places a camera can be. Handed to the showrunner when it has to move: asked in the
// abstract it writes another inch of the rock it is already on, but given ground with names it goes
// there. Nothing here implies a way off the island.
const ISLAND_TERRAIN = [
  "the surf line and the reef beyond it",
  "a mangrove swamp on brackish water",
  "a river gorge running fast after rain",
  "dense jungle interior under closed canopy",
  "a volcanic slope of loose ash and vents",
  "the high ridge above the treeline",
  "a dune field behind the beach",
  "the wreck they came ashore in",
  "tidal flats going out for a kilometre",
  "a waterfall plunge pool in the rocks",
  "burnt clearing left by an old fire",
  "sea caves that flood at high tide",
  "a rotting palm grove full of crabs",
  "the headland where the wind never stops",
];

// Which part of the day a clock line describes. Comparing the clock strings themselves does not
// work: the model rewords it every turn — "the dead calm of midnight" then "dead calm of midnight"
// — so an exact match reads two identical nights as a change and the show never sees a sunrise.
function daypartOf(clock: string) {
  const t = clock.toLowerCase();
  if (/first light|dawn|sunrise|daybreak/.test(t)) return "dawn";
  if (/morning/.test(t)) return "morning";
  if (/noon|midday/.test(t)) return "midday";
  if (/afternoon/.test(t)) return "afternoon";
  if (/dusk|sunset|evening|twilight/.test(t)) return "dusk";
  if (/night|midnight|dark|small hours/.test(t)) return "night";
  return "unplaced";
}

// A chapter's detail line is "<clock>. <setting>. <goal>", so the clock is everything up to the
// first sentence break. Reading the whole line would pick up a "night" from the scenery instead.
function clockOfDetail(detail: string) {
  return detail.split(". ")[0];
}

const STORY_TURN_RULES = [
  "You are the showrunner of a survival reality show that films around the clock. Your job is to move the story on: decide what the island does to these people next.",
  "Return ONLY a JSON object — no prose, no code fence — with exactly these keys:",
  '"phase": a 2-4 word name for the stretch of story that starts now.',
  '"setting": one clause naming where the show is now and what it physically looks like. This is fed to a video model as the location of every shot, so it must be concrete and filmable.',
  '"clock": time of day and which day, e.g. "first light on day two".',
  '"goal": the one thing the contestants are now trying to do, in one clause.',
  '"directive": one instruction under 25 words that ANY of them could act on right now. Never name a contestant and never assume where one particular person is standing — every one of them is handed this same line, so it has to be what the situation demands of whoever is on camera. A physical action with a complication in it, never a feeling.',
  '"tension": integer 0-100, how close this situation is to disaster.',
  `Content: ${SAFE_PERIL_PROMPT}`,
  '"relocated": true only when "setting" is a genuinely different place from the current one.',
  "THE ONE RULE YOU CANNOT BREAK: this is survival on a remote desert island, and it never becomes anything else.",
  "- They never get off it. No rescue, no boat away, no aircraft, no radio contact answered, no mainland, no town, no camera crew, no other people arriving. Open water is a wall, not an exit.",
  "- Nothing supernatural, no monsters, no technology the island would not have. Whatever threatens them is weather, water, terrain, cold, hunger, thirst, wildlife, or the wreckage of what they arrived with.",
  "- Everything else about where this goes is yours to decide.",
  "Beyond that, write freely:",
  "- Range across the island. It has a shore, reefs, cliffs, caves, ridges, jungle, a river, mangrove, swamp, burnt ground, a crater, dunes, wreckage — you are not confined to the corner they are standing in.",
  "- Do not continue the small moment the last clips were on. Hours can pass between turns. Come back to them somewhere else, doing something else, up against a different problem.",
  "- Vary what the island is doing to them. Consecutive stretches should not all be about the same threat — a squeeze through rock, then a flood, then thirst, then a storm, then something in the water, then having to make fire.",
  "- Change the pressure too. Not every stretch is a disaster: foraging, building, drying out, patching a raft, watching weather come in and knowing what it means are all good television.",
  "- Time only ever moves forward. Days pass, weather turns, light changes.",
  "- The viewers' lines below are the point of this show. If they asked for something, the next stretch IS that thing — not a nod to it, not a version of it you liked better. Only when the room is silent is the direction yours to choose.",
  "- Everything in English.",
].join("\n");

// Runs on the heartbeat. Returns the new state when the story turned, null when it is not time yet.
async function advanceStory(match: typeof matches.$inferSelect) {
  const state = storyStateOf(match);
  try {
    requireFal();
    // Cheap gate first. Every watching browser runs this every few seconds, and below the floor no
    // amount of chat can pull the turn forward — so do not go near the chat table to find that out.
    if (match.story_beat < STORY_BEAT_FLOOR) return null;
    const pushes = await viewerPushSince(match.id, match.story_advanced_at).catch(() => [] as string[]);
    // Either the room has spoken enough to steer, or enough has aired that the story owes a turn.
    const target = pushes.length >= STORY_PUSH_TRIGGER ? STORY_BEAT_FLOOR : STORY_BEAT_TARGET;
    if (match.story_beat < target) return null;
    // Every watching browser ticks this, so without an atomic claim a dozen heartbeats all see the
    // same due beat and all pay for a turn. Zeroing the counter IS the claim; the losers write
    // nothing and go home.
    const claimed = await db.update(matches).set({ story_beat: 0 })
      .where(and(eq(matches.id, match.id), gte(matches.story_beat, target)))
      .returning({ id: matches.id });
    if (!claimed.length) return null;
    // The claim already zeroed the counter, so a failed turn would otherwise cost the show a whole
    // stretch of silence. Hand the beats back and let the next tick try again.
    const releaseClaim = () => db.update(matches).set({ story_beat: sql`story_beat + ${target}` })
      .where(eq(matches.id, match.id)).catch(() => undefined);

    // Few enough that the last few beats orient the turn without dictating its size.
    const timeline = await recentSummaries(match.id, 4).catch(() => [] as string[]);
    const chapterRows = await recentChapters(match.id, 8).catch(() => [] as Array<{ title: string; detail: string }>);
    const chapters = chapterRows.map((row) => row.title);
    // A chapter's detail line opens with its clock, so this counts how long the show has been stuck
    // at one hour of one day. Twenty-four chapters ran without leaving the night of day one, and a
    // storm that never breaks makes every location look like the same wet rock.
    const daypart = daypartOf(state.clock);
    const stalled = chapterRows.filter((row) => daypartOf(clockOfDetail(row.detail)) === daypart).length;
    const mustAdvanceTime = stalled >= 3;
    // Chapters only advance on a real move, so several stretches carrying the same number means the
    // show has been picking at one situation. Asking nicely does not shift it — this does.
    const held = chapters.filter((title) => title.startsWith(`Chapter ${state.chapter} `)).length;
    const mustMove = held >= 2;
    const unusedGround = ISLAND_TERRAIN
      .filter((ground) => !chapters.concat(state.setting).some((seen) => seen.toLowerCase().includes(ground.split(" ")[1] ?? ground)));
    const cast = await db.select().from(participants)
      .where(and(eq(participants.match_id, match.id), eq(participants.is_system, true)));

    const answer = await miniMaxChat(
      STORY_TURN_RULES,
      [
        `Chapter ${state.chapter} — ${state.phase}`,
        `Where they are now: ${state.setting}`,
        `Time now: ${state.clock}`,
        `What they are trying to do: ${state.goal}`,
        `Tension now: ${state.tension}/100`,
        chapters.length
          ? `\nStretches the show has already done, oldest first:\n${chapters.map((line) => `- ${line}`).join("\n")}\nDo not hand back another variation of these. Whatever you choose, it has to be something this list does not already cover.`
          : "",
        timeline.length ? `\nThe last few beats on screen:\n${timeline.map((line, i) => `${i + 1}. ${line}`).join("\n")}\nThese are single ten-second shots. Do not simply continue them — decide where the story goes next, at a far larger size than one shot.` : "\nThe show has only just started.",
        cast.length ? `\nThe contestants: ${cast.map((item) => contestantCondition(item)).join("; ")}` : "",
        pushes.length
          ? `\nThe viewers watching right now have been saying:\n${pushes.map((line) => `- ${line}`).join("\n")}\nTake them seriously — they are steering this show.`
          : "\nThe room is quiet, so this turn is yours to choose.",
        mustAdvanceTime
          ? [
            "\nTIME HAS TO MOVE, and that is not optional either.",
            `It has been "${state.clock}" for several stretches now. Push the clock to the next real marker and let the weather turn with it.`,
            daypart === "night"
              ? "It has been dark for a long time. This turn brings daylight — first light, morning or full sun — not another hour of night."
              : "Move to a different part of the day: afternoon light, dusk, or into the night.",
            "Weather that never breaks makes every place look identical. If a storm has been running, this is where it blows itself out, or where the next one is still hours off.",
          ].join("\n")
          : "",
        mustMove
          ? [
            "\nTHIS TURN IS A HARD MOVE, and that is not optional.",
            "They have been picking at the same situation for several stretches now. Whatever they were trying to do there is finished or abandoned — say so and leave.",
            "Hours pass. Put them somewhere else on the island entirely, on ground the chapters above have not used.",
            (unusedGround.length ? unusedGround : ISLAND_TERRAIN).slice(0, 8).map((ground) => `- ${ground}`).join("\n"),
            'Pick one of those or somewhere just as different, write it into "setting", give them a new "goal" that belongs to that place, and set "relocated" to true.',
          ].join("\n")
          : "",
      ].filter(Boolean).join("\n"),
      chatBudget(1200),
      4000,
    );

    const next = parseModelJson(answer);
    if (!next) {
      console.error("[story] unparseable turn", answer.slice(0, 200));
      await releaseClaim();
      return null;
    }
    const setting = cleanText(next.setting, 260);
    const phase = cleanText(next.phase, 60);
    const directive = cleanText(next.directive, 240);
    // A turn without a place and an instruction is worse than no turn: the beat counter would reset
    // and the show would coast on the old constants for another full stretch.
    if (!setting || !phase || !directive) {
      console.error("[story] incomplete turn", answer.slice(0, 200));
      await releaseClaim();
      return null;
    }

    const goal = cleanText(next.goal, 220) || state.goal;
    const clock = cleanText(next.clock, 60) || state.clock;
    const rawTension = Number(next.tension);
    const tension = Number.isFinite(rawTension) ? Math.min(100, Math.max(0, Math.round(rawTension))) : state.tension;
    const relocated = next.relocated === true
      && setting.trim().toLowerCase() !== state.setting.trim().toLowerCase();
    const chapter = relocated ? state.chapter + 1 : state.chapter;

    // Channels still sitting in the old place owe the audience the walk to the new one. Marking the
    // current head of the clip list is what tells them apart from channels that already moved.
    const [head] = await db.select({ id: sql<number>`coalesce(max(id), 0)` }).from(generations)
      .where(eq(generations.match_id, match.id));

    await db.update(matches).set({
      story_chapter: chapter,
      story_phase: phase,
      story_setting: setting,
      story_goal: goal,
      story_clock: clock,
      story_directive: directive,
      story_tension: tension,
      story_beat: 0,
      story_advanced_at: sql`(current_timestamp)` as unknown as string,
      ...(relocated ? { story_reframe_after: Number(head?.id ?? 0) } : {}),
    }).where(eq(matches.id, match.id));

    // Moving costs them, but a new place is also the one chance to catch a breath. Without this the
    // cast bottoms out permanently and contestantCondition freezes again, one rung lower.
    if (relocated) {
      await db.update(participants).set({
        stamina: sql`min(100, stamina + 16)`,
        hunger: sql`min(100, hunger + 6)`,
      }).where(and(eq(participants.match_id, match.id), eq(participants.is_system, true)));
    }

    await db.insert(matchEvents).values({
      match_id: match.id,
      participant_id: null,
      round: match.current_round,
      kind: "world",
      title: `Chapter ${chapter} — ${phase}`,
      detail: `${clock}. ${setting}. ${goal}`,
    }).catch(() => undefined);

    console.log(`[story] chapter ${chapter} — ${phase}${relocated ? " (moved)" : ""}: ${setting}`);
    return { chapter, phase, setting, goal, clock, directive, tension } satisfies StoryState;
  } catch (error) {
    // A missed turn just means the story holds its current shape for another stretch.
    console.error("[story] turn failed", error instanceof Error ? error.message : String(error));
    return null;
  }
}

// A contestant channel whose newest clip predates the last relocation has not physically arrived
// yet: its next shot is the journey, not another beat in the place it already left.
function owesTransition(match: typeof matches.$inferSelect, latestClipId: number | null) {
  if (match.story_reframe_after <= 0) return false;
  return (latestClipId ?? 0) <= match.story_reframe_after;
}

async function maybeAdvanceHouseCast(match: typeof matches.$inferSelect) {
  const matchId = match.id;
  const tier = tierOf(match);
  try {
    requireFal();
    const active = await activeGenerations(matchId);
    if (active.length >= tier.concurrent) return null;
    // Count the house line against its own ceiling, so the director does not squeeze it out.
    const houseActive = active.filter((item) => item.created_by.startsWith("house:")).length;
    if (houseActive >= tier.houseSlots) return null;

    const [tally] = await db.select({ total: sql<number>`count(*)` }).from(generations)
      .where(and(eq(generations.match_id, matchId), sql`${generations.created_by} like 'house:%'`));
    if (Number(tally?.total ?? 0) >= HOUSE_CAST_MAX_CLIPS) return null;
    // The gap paces the show filming its own ideas. Somebody in the room asking for something is
    // not that, and making them wait out a tier's interval is the opposite of a live broadcast.
    const selfDriven = await autoQueuedWithin(matchId, tier.gapSeconds, !tier.gapCoversDirector);
    if (selfDriven >= (tier.houseBurst ?? 1)) {
      if (!await viewerLineWaiting(matchId)) return null;
    }

    const cast = await db.select().from(participants)
      .where(and(eq(participants.match_id, matchId), eq(participants.is_system, true)));
    if (!cast.length) return null;
    const busy = new Set(active.map((item) => item.channel_participant_id));

    // Only the newest clip per contestant is read out of this, so a window that comfortably covers
    // the whole cast is enough. Unbounded, it sorted every clip the show had ever filmed on every
    // heartbeat, and the cost grew with the archive.
    const clipRows = await db.select({ pid: generations.channel_participant_id, id: generations.id })
      .from(generations)
      .where(and(eq(generations.match_id, matchId), eq(generations.channel, "participant")))
      .orderBy(desc(generations.id))
      .limit(80);
    const lastClip = new Map<number, number>();
    for (const row of clipRows) {
      if (row.pid != null && !lastClip.has(row.pid)) lastClip.set(row.pid, row.id);
    }
    // Whoever has been off screen longest goes next, unless a waiting message names someone else.
    const idle = cast
      .filter((item) => !busy.has(item.id))
      .sort((a, b) => (lastClip.get(a.id) ?? -1) - (lastClip.get(b.id) ?? -1));
    if (!idle.length) return null;

    const cue = await claimChatCue(matchId, idle.map((item) => item.id));
    const mentioned = cue ? parseParticipantIds(cue.mentions) : [];
    // The first person named who is free to film owns the shot; the rest join it.
    const next = idle.find((item) => mentioned.includes(item.id)) ?? idle[0];
    const guestIds = mentioned.filter((id) => id !== next.id);
    let generation: Awaited<ReturnType<typeof queueLiveGeneration>> | null = null;
    try {
      generation = await queueLiveGeneration({
        channel: "participant",
        channelParticipantId: next.id,
        participantIds: [next.id, ...guestIds].slice(0, 3),
        keyframePrompt: "",
        videoPrompt: "",
        visualMemory: "",
        duration: LIVE_VIDEO_DURATION_SECONDS,
        viewerPrompt: cue ? cue.body : match.story_directive,
      }, cue ? "house:chat" : "house:auto");
    } catch (error) {
      if (cue) await releaseChatCue(cue.id);
      throw error;
    }
    if (!generation && cue) await releaseChatCue(cue.id);
    if (generation) {
      await db.update(participants).set({
        stamina: sql`max(0, stamina - 3)`,
        hunger: sql`min(100, hunger + 2)`,
      }).where(eq(participants.id, next.id)).catch(() => undefined);
    }
    if (cue && generation) {
      await db.update(chatMessages).set({ generation_id: generation.id })
        .where(eq(chatMessages.id, cue.id)).catch(() => undefined);
    }
    return generation;
  } catch {
    // The house cast stalling must never break the request that happened to tick it.
    return null;
  }
}

async function maybeStartDirectorClip(match: typeof matches.$inferSelect) {
  const matchId = match.id;
  const tier = tierOf(match);
  try {
    requireFal();
    const active = await activeGenerations(matchId);
    if (generationSlotError(active, "director", null, tier)) return null;
    if (tier.gapCoversDirector && await autoQueuedWithin(matchId, tier.gapSeconds, false) > 0) return null;
    // Cuts are chained off tail frames, so without a ceiling of their own the director would answer
    // every contestant clip — four cuts for a batch of four, not the one the tier asks for.
    if (tier.directorBurst != null && await directorCutsWithin(matchId, tier.gapSeconds) >= tier.directorBurst) {
      return null;
    }
    const source = await pickDirectorSource(match);
    if (!source?.channel_participant_id || !source.thumbnail_url) return null;
    const [participant] = await db.select({ id: participants.id }).from(participants)
      .where(eq(participants.id, source.channel_participant_id)).limit(1);
    if (!participant) return null;
    // Only queued here — the prompt work happens on a later sync, so the tail-frame upload that
    // triggered this returns immediately.
    //
    // The opening frame is that clip's tail frame, so whoever was in it is in this one. Taking only
    // the channel owner would drop a co-star who is visibly still on screen.
    const inherited = parseParticipantIds(source.participant_ids);
    return await queueLiveGeneration({
      channel: "director",
      channelParticipantId: null,
      participantIds: inherited.length ? inherited : [participant.id],
      sourceGenerationId: source.id,
      keyframePrompt: "",
      videoPrompt: "",
      visualMemory: "",
      duration: LIVE_VIDEO_DURATION_SECONDS,
    }, "director:auto");
  } catch {
    // A stalled director line must never break the request that fed it a tail frame.
    return null;
  }
}

async function syncLiveGeneration(id: number) {
  if (!Number.isInteger(id)) {
    const error = new Error("Invalid generation id");
    error.name = "BadRequestError";
    throw error;
  }
  const [generation] = await db.select().from(generations).where(eq(generations.id, id)).limit(1);
  if (!generation) {
    const error = new Error("No such generation");
    error.name = "NotFoundError";
    throw error;
  }
  try {
    if (generation.stage === "video" && generation.video_task_id) {
      if (generation.model === LIVE_VIDEO_MODEL) {
        const videoTask = await getFalVideoTask(generation.video_task_id);
        const status = falVideoStatus(videoTask.state);
        if (status === "failed" || status === "cancelled" || status === "error") {
          throw new Error(`${LIVE_VIDEO_MODEL} video generation failed`);
        }
        if (status !== "completed") return { generation, providerStatus: status || "pending" };
        const remoteUrl = falVideoResultUrl(videoTask.payload);
        if (!remoteUrl) throw new Error("fal finished the video but returned no result URL");
        const stableUrl = await persistVideoResult(generation.id, remoteUrl);
        const completed = { ...generation, stage: "completed" as const, result_url: stableUrl };
        // Several viewers poll this endpoint at once. Only the request that actually flips the row
        // may write the summary or start the director clip, or both happen twice.
        const claimed = await db.update(generations)
          .set({ stage: "completed", result_url: stableUrl, completed_at: new Date().toISOString() })
          .where(and(eq(generations.id, generation.id), ne(generations.stage, "completed")))
          .returning({ id: generations.id });
        if (claimed.length === 0) {
          return { generation: { ...completed, result_url: await clipUrl(stableUrl) }, providerStatus: "completed" };
        }
        const summary = await summarizeClip(completed).catch(() => null);
        return {
          generation: { ...completed, summary: summary ?? completed.summary, result_url: await clipUrl(stableUrl) },
          providerStatus: "completed",
        };
      }
      const videoTask = await getRenoiseTask(generation.video_task_id);
      const status = taskStatus(videoTask);
      if (status === "failed") throw new Error("H3 Max video generation failed");
      if (status !== "completed") return { generation, providerStatus: status || "pending" };
      const remoteUrl = taskResultUrl(videoTask);
      if (!remoteUrl) throw new Error("The video finished but returned no result URL");
      const stableUrl = await persistVideoResult(generation.id, remoteUrl);
      await db.update(generations).set({ stage: "completed", result_url: stableUrl, completed_at: new Date().toISOString() })
        .where(eq(generations.id, generation.id));
      return { generation: { ...generation, stage: "completed", result_url: await clipUrl(stableUrl) }, providerStatus: "completed" };
    }
    if (generation.stage === "queued") {
      // Claim the row first: two concurrent polls would otherwise both expand the prompt and submit
      // two fal tasks. "keyframe" is the claimed-and-writing state.
      const claimed = await db.update(generations)
        .set({ stage: "keyframe" })
        .where(and(eq(generations.id, generation.id), eq(generations.stage, "queued")))
        .returning({ id: generations.id });
      if (claimed.length === 0) {
        const [fresh] = await db.select().from(generations).where(eq(generations.id, id)).limit(1);
        return { generation: fresh ?? generation, providerStatus: fresh?.stage ?? "keyframe" };
      }
      const started = await startQueuedGeneration({ ...generation, stage: "keyframe" });
      return { generation: started, providerStatus: "pending" };
    }
    if (generation.stage === "keyframe") {
      // Claimed but never submitted: the request that claimed it died. Do not strand it forever.
      const createdAt = Date.parse(`${generation.created_at.replace(" ", "T")}Z`);
      if (Number.isFinite(createdAt) && Date.now() - createdAt > 180_000) {
        throw new Error("Shot writing was interrupted; the job was never submitted");
      }
    }
    return { generation, providerStatus: generation.stage };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Sync failed";
    await db.update(generations).set({ stage: "failed", error_message: message }).where(eq(generations.id, generation.id));
    // The line that asked for this shot is not spent just because the render was.
    await requeueFailedCue(generation.id);
    return { error: message, generation: { ...generation, stage: "failed" }, failed: true };
  }
}

function liveGenerationErrorStatus(error: unknown) {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : "";
  if (name === "BadRequestError" || message.startsWith("Pick ")) return 400;
  if (name === "ConflictError") return 409;
  if (name === "NotFoundError") return 404;
  if (message.includes("FAL_KEY")) return 503;
  if (message.includes("not currently offer") || message.includes("must be enabled")) return 503;
  return 502;
}

type LiveMatchRow = Awaited<ReturnType<typeof ensureLiveMatch>>;

// Everything in the live payload that is the same for every viewer. Roster presigns, the clip
// window, the chat tail and the story choices cost the same whether one browser asks or a hundred
// do, so they are built once per isolate per LIVE_SHARED_TTL_MS and handed out unchanged. Only
// chat_allowance (per device) and tail_frame_wanted (per election) are left out of it.
async function buildLiveShared(match: LiveMatchRow) {
  const [roster, allEvents, clips, pendingGenerations] = await Promise.all([
    db.select().from(participants)
      .where(and(
        eq(participants.match_id, match.id),
        or(isNotNull(participants.character_draft_id), eq(participants.is_system, true)),
      ))
      // A fixed running order, not score. Ranking them meant the cast reshuffled itself
      // mid-broadcast every time someone acted, and a viewer looking for one contestant had to
      // find them again. This is the order the channel strip shows.
      .orderBy(participants.display_order, participants.id),
    db.select().from(matchEvents).where(eq(matchEvents.match_id, match.id)).orderBy(desc(matchEvents.id)).limit(50),
    db.select(CLIP_PAYLOAD_COLUMNS).from(generations)
      .where(and(eq(generations.match_id, match.id), eq(generations.stage, "completed")))
      .orderBy(desc(generations.id)).limit(60),
    db.select(CLIP_PAYLOAD_COLUMNS).from(generations)
      .where(and(eq(generations.match_id, match.id), inArray(generations.stage, ["queued", "keyframe", "video"])))
      .orderBy(desc(generations.id)),
  ]);
  const visibleParticipantIds = new Set(roster.map((participant) => participant.id));
  const events = allEvents
    .filter((event) => event.participant_id == null || visibleParticipantIds.has(event.participant_id))
    .slice(0, 20);
  const storyChoices = buildStoryChoices(match, roster, events, clips[0] ?? null);
  const rosterWithUrls = await Promise.all(roster.map(async (participant) => ({
    ...participant,
    avatar_url: await avatarUrl(participant.avatar_s3_uri),
    // Falls back to the sheet so a viewer-made contestant, which has no separate portrait, still
    // shows a face everywhere the cast is displayed.
    portrait_url: await avatarUrl(participant.portrait_s3_uri ?? participant.avatar_s3_uri),
    control_token_hash: undefined,
  })));
  // Chat keeps a longer memory than the clip window does, so a line filmed a while back would
  // point at a clip the page no longer has and its "Watch it" button would go nowhere. Pull those back in.
  const chat = await db.select().from(chatMessages)
    .where(eq(chatMessages.match_id, match.id))
    .orderBy(desc(chatMessages.id))
    .limit(40);
  const haveClipIds = new Set(clips.map((clip) => clip.id));
  const missingClipIds = [...new Set(chat
    .map((item) => item.generation_id)
    .filter((id): id is number => id != null && !haveClipIds.has(id)))];
  const referencedClips = missingClipIds.length
    ? await db.select(CLIP_PAYLOAD_COLUMNS).from(generations).where(and(
      eq(generations.match_id, match.id),
      eq(generations.stage, "completed"),
      inArray(generations.id, missingClipIds),
    ))
    : [];
  const clipList = [...clips, ...referencedClips].map((clip) => ({
    id: clip.id,
    round: clip.round,
    duration_seconds: clip.duration_seconds,
    channel: clip.channel,
    channel_participant_id: clip.channel_participant_id,
    participant_ids: parseParticipantIds(clip.participant_ids),
    source_generation_id: clip.source_generation_id,
    summary: clip.summary,
    // One stable address per clip. A presigned URL changes on every poll, and a changed <video> src
    // makes the browser drop the decoded picture and reload — the player would black out and restart.
    result_url: clip.result_url ? `/api/public/clips/${clip.id}/video` : null,
    thumbnail_url: clip.thumbnail_url ? `/api/public/clips/${clip.id}/thumbnail` : null,
    has_tail_frame: Boolean(clip.thumbnail_url),
    created_at: clip.created_at,
  }));
  const pendingList = pendingGenerations.map((item) => ({
    id: item.id,
    stage: item.stage,
    channel: item.channel,
    channel_participant_id: item.channel_participant_id,
    duration_seconds: item.duration_seconds,
    created_at: item.created_at,
  }));
  return {
    shared: {
      match: { ...match, viewers: await countWatching(match.id) },
      // Oldest first: the room reads top to bottom.
      chat: chat.reverse().map(chatPayload),
      // What is actually queued to film, which is now people's lines only.
      chat_waiting: chat.filter((item) => !item.consumed_at && item.priority >= CHAT_PRIORITY_VIEWER).length,
      participants: rosterWithUrls,
      events,
      clips: clipList,
      story_choices: storyChoices,
      pending_generation: pendingList[0] ?? null,
      pending_generations: pendingList,
    },
    // Contestant clips whose tail frame nobody has captured yet. Only the advance winner turns
    // these into an election, so the list stops here.
    tailFrameCandidates: clips.filter((clip) => clip.result_url && !clip.thumbnail_url).map((clip) => clip.id),
  };
}

// `caches.default` is a Workers runtime global the SDK typings do not describe. Reached
// defensively: where it is missing, every request goes to R2 exactly as it did before.
type EdgeCache = { match(req: Request): Promise<Response | undefined>; put(req: Request, res: Response): Promise<void> };
const edgeCache: EdgeCache | undefined = (globalThis as { caches?: { default?: EdgeCache } }).caches?.default;
// Past this a clip is cheaper to stream from R2 than to hold a copy of at every PoP.
const EDGE_FILL_MAX_BYTES = 100 * 1024 * 1024;
// One fill per clip per isolate. Fifty viewers arriving at a cold PoP together would otherwise each
// pull the whole clip down to warm the same cache entry.
const edgeFillInFlight = new Set<number>();

// The client's own response is usually a 206, and the Cache API refuses to store one, so the entry
// is filled by a second range-less fetch. Everything here is best-effort: a clip that fails to
// cache is a clip served from R2 again next time.
async function fillEdgeCache(id: number, url: string, signed: string) {
  try {
    const cache = edgeCache;
    if (!cache) return;
    const upstream = await fetch(signed);
    if (upstream.status !== 200) return;
    const length = Number(upstream.headers.get("content-length") ?? 0);
    if (length > EDGE_FILL_MAX_BYTES) return;
    const headers = new Headers();
    headers.set("content-type", upstream.headers.get("content-type") || "video/mp4");
    if (length) headers.set("content-length", String(length));
    headers.set("accept-ranges", "bytes");
    headers.set("cache-control", "public, max-age=31536000, immutable");
    await cache.put(new Request(url), new Response(upstream.body, { status: 200, headers }));
  } catch {
    // Nothing to report: the next viewer simply reads from R2.
  } finally {
    edgeFillInFlight.delete(id);
  }
}

const LIVE_SHARED_TTL_MS = 2500;
let liveSharedCache: { at: number; match: LiveMatchRow; shared: Awaited<ReturnType<typeof buildLiveShared>>["shared"] } | null = null;

// How long an elected viewer is trusted to land a tail frame before the clip goes back up for
// election. Long enough to download and decode a ten-second clip on a phone.
const TAIL_LEASE_TTL_MS = 45_000;
// Elections cost a write each and run on one request. A healthy show has one or two clips waiting;
// a wide backlog is capped so a single heartbeat cannot spend its whole subrequest budget here.
// Harvested clips leave the list, so the cap walks through the backlog over successive ticks.
const TAIL_ELECTIONS_PER_TICK = 6;

const app = new Hono()
  .get("/api/public/health", (c) => c.json({ ok: true, service: "tomato-live" }))
  .post("/api/public/chat", async (c) => {
    // No sign-in needed to speak; the browser identifies the viewer and carries their allowance.
    const deviceId = deviceIdOf(c);
    if (!deviceId) return c.json({ error: "This browser could not be identified" }, 400);
    const data = asObject(await c.req.json().catch(() => ({})));
    const body = cleanText(data.body, CHAT_MAX_CHARS);
    if (body.length < 2) return c.json({ error: "Write something first" }, 400);
    const match = await ensureLiveMatch();
    // The host directs the show from the same box everyone else types into, so their line skips the
    // queue, the cooldown and the allowance. Everything below is the viewer path.
    const host = isHostAccount();

    const [recent] = await db.select({ n: sql<number>`count(*)` }).from(chatMessages).where(and(
      eq(chatMessages.match_id, match.id),
      eq(chatMessages.device_id, deviceId),
      sql`${chatMessages.created_at} >= datetime('now', ${`-${CHAT_COOLDOWN_SECONDS} seconds`})`,
    ));
    if (!host && Number(recent?.n ?? 0) > 0) return c.json({ error: "Slow down a moment" }, 429);

    const allowance = await chatAllowanceState(match.id, deviceId);
    if (!host && allowance && !allowance.unlimited && allowance.remaining <= 0) {
      return c.json({
        error: allowance.next ? "You are out of messages" : "You have used every message",
        allowance,
      }, 403);
    }

    const roster = await db.select().from(participants).where(and(
      eq(participants.match_id, match.id),
      or(isNotNull(participants.character_draft_id), eq(participants.is_system, true)),
    ));
    // -1 because nobody in chat is a contestant themselves, so every name is a real mention.
    const mentions = mentionedParticipants(body, roster, -1).map((item) => item.id).slice(0, 3);

    const [row] = await db.insert(chatMessages).values({
      match_id: match.id,
      user_id: auth.user?.id ?? "",
      device_id: deviceId,
      // Signing in gets you your handle; everyone else speaks as a guest.
      display_name: auth.user?.email ? chatHandle(auth.user.email) : guestHandle(deviceId),
      body,
      mentions: JSON.stringify(mentions),
      priority: host ? CHAT_PRIORITY_HOST : CHAT_PRIORITY_VIEWER,
    }).returning();
    // Film it now rather than on whichever browser happens to heartbeat next. The queue write is
    // cheap — the prompt work happens later, on the sync poll — so this costs the poster almost
    // nothing and is the difference between a live room and a suggestion box.
    const filming = await maybeAdvanceHouseCast(match).catch(() => null);
    // The sender refreshes the moment this returns and has to see their own line, so the shared
    // payload goes stale here rather than waiting out its clock.
    liveSharedCache = null;
    return c.json({
      message: chatPayload(row),
      mentions,
      filming: filming?.id ?? null,
      allowance: await chatAllowanceState(match.id, deviceId),
    }, 201);
  })
  .post("/api/public/chat/unlock", async (c) => {
    const deviceId = deviceIdOf(c);
    if (!deviceId) return c.json({ error: "This browser could not be identified" }, 400);
    const data = asObject(await c.req.json().catch(() => ({})));
    const step = cleanText(data.step, 24);
    const match = await ensureLiveMatch();
    const tier = await viewerTier(deviceId);
    const pending = nextUnlock(tier);
    // Only the step actually on offer can be claimed, so a replayed call cannot skip a rung.
    if (!pending || pending.key !== step) {
      return c.json({ error: "That unlock is already claimed", allowance: await chatAllowanceState(match.id, deviceId) }, 409);
    }
    await db.insert(viewerPerks)
      .values({ device_id: deviceId, user_id: auth.user?.id ?? `device:${deviceId}`, tier: tier + 1 })
      .onConflictDoUpdate({
        target: viewerPerks.device_id,
        set: { tier: tier + 1, updated_at: new Date().toISOString() },
      });
    return c.json({ allowance: await chatAllowanceState(match.id, deviceId) });
  })
  .get("/api/admin/generation-tier", async (c) => {
    if (!isHostAccount()) return c.json({ error: "This account has no host permission" }, 403);
    const match = await ensureLiveMatch();
    const [houseTally] = await db.select({ n: sql<number>`count(*)` }).from(generations)
      .where(and(eq(generations.match_id, match.id), sql`${generations.created_by} like 'house:%'`));
    const inFlight = await db.select().from(generations)
      .where(and(eq(generations.match_id, match.id), inArray(generations.stage, ["queued", "keyframe", "video"])))
      .orderBy(desc(generations.id));

    const roster = await db.select({ id: participants.id, display_name: participants.display_name })
      .from(participants).where(eq(participants.match_id, match.id));
    const nameOf = new Map(roster.map((item) => [item.id, item.display_name]));
    const cast = (ids: number[]) => ids.map((id) => nameOf.get(id) ?? `#${id}`);

    const waiting = await db.select().from(chatMessages)
      .where(and(
        eq(chatMessages.match_id, match.id),
        isNull(chatMessages.consumed_at),
        gte(chatMessages.priority, CHAT_PRIORITY_VIEWER),
      ))
      .orderBy(chatMessages.id)
      .limit(40);
    const claimed = await db.select().from(chatMessages)
      .where(and(eq(chatMessages.match_id, match.id), isNotNull(chatMessages.consumed_at)))
      .orderBy(desc(chatMessages.id))
      .limit(20);

    const stageOf = new Map(inFlight.map((item) => [item.id, item.stage]));
    const line = (row: typeof chatMessages.$inferSelect) => ({
      id: row.id,
      display_name: row.display_name,
      body: row.body,
      mentions: cast(parseParticipantIds(row.mentions)),
      generation_id: row.generation_id,
      stage: row.generation_id != null ? stageOf.get(row.generation_id) ?? "completed" : null,
      created_at: row.created_at,
      consumed_at: row.consumed_at,
    });

    return c.json({
      current: tierOf(match).key,
      tiers: Object.values(GENERATION_TIERS),
      chatSeed: { current: chatSeedTierOf(match).key, tiers: Object.values(CHAT_SEED_TIERS) },
      // Split out, because the number on the broadcast is not the number of people there.
      audience: (() => {
        const synthetic = syntheticAudience();
        return { synthetic, windowSeconds: VIEWER_PRESENCE_WINDOW_SECONDS };
      })(),
      realViewers: await countRealWatching(match.id),
      board: await audienceBoard(match.id),
      story: await (async () => {
        const pushes = await viewerPushSince(match.id, match.story_advanced_at).catch(() => [] as string[]);
        return {
          ...storyStateOf(match),
          beat: match.story_beat,
          // What the counter is racing to, and why. A story held up by a quiet room reads very
          // differently from one that is genuinely stuck.
          target: pushes.length >= STORY_PUSH_TRIGGER ? STORY_BEAT_FLOOR : STORY_BEAT_TARGET,
          pushes: pushes.length,
          pushTrigger: STORY_PUSH_TRIGGER,
          advancedAt: match.story_advanced_at,
        };
      })(),
      running: inFlight.length,
      houseUsed: Number(houseTally?.n ?? 0),
      houseLimit: HOUSE_CAST_MAX_CLIPS,
      queue: {
        waiting: waiting.map(line),
        // A message is "filming" only while the clip it became is still rendering.
        filming: claimed.filter((row) => row.generation_id != null && stageOf.has(row.generation_id)).map(line),
        aired: claimed.filter((row) => row.generation_id == null || !stageOf.has(row.generation_id)).slice(0, 8).map(line),
        // Everything else in flight is the show filming itself, with nobody's line behind it.
        selfDriven: inFlight.filter((item) => !claimed.some((row) => row.generation_id === item.id)).map((item) => ({
          id: item.id,
          stage: item.stage,
          channel: item.channel,
          cast: cast(parseParticipantIds(item.participant_ids)),
        })),
      },
    });
  })
  .post("/api/admin/chat-seed-tier", async (c) => {
    if (!isHostAccount()) return c.json({ error: "This account has no host permission" }, 403);
    const data = asObject(await c.req.json().catch(() => ({})));
    const key = cleanText(data.tier, 16) as ChatSeedTierKey;
    if (!CHAT_SEED_TIERS[key]) return c.json({ error: "Unknown chat tier" }, 400);
    const match = await ensureLiveMatch();
    await db.update(matches).set({ chat_seed_tier: key }).where(eq(matches.id, match.id));
    return c.json({ current: key, message: `Seeded chat set to ${CHAT_SEED_TIERS[key].label}` });
  })
  .post("/api/admin/generation-tier", async (c) => {
    if (!isHostAccount()) return c.json({ error: "This account has no host permission" }, 403);
    const data = asObject(await c.req.json().catch(() => ({})));
    const key = cleanText(data.tier, 16) as GenerationTierKey;
    if (!GENERATION_TIERS[key]) return c.json({ error: "Unknown generation tier" }, 400);
    const match = await ensureLiveMatch();
    await db.update(matches).set({ generation_tier: key }).where(eq(matches.id, match.id));
    // Clips already rendering are paid for; the new tier applies to what gets queued next.
    return c.json({ current: key, message: `Switched to ${GENERATION_TIERS[key].label}; clips already rendering will finish first` });
  })
  .get("/api/public/live", async (c) => {
    const deviceId = deviceIdOf(c);
    // There is no scheduler here, so the show advances on the back of the viewer heartbeat — but it
    // only has to advance once, not once per watching browser. Every viewer running the full seed /
    // reap / story / director / cast pass multiplied the database load by the size of the audience,
    // which is what put it over the edge. The clock below is per isolate and so bounds nothing on
    // its own — a hundred browsers spread over a dozen PoPs each got their own copy of it. It is
    // here only to keep most heartbeats off the lease query; the lease is what makes "once every
    // four seconds" true for the whole fleet.
    let winner: Awaited<ReturnType<typeof buildLiveShared>> | null = null;
    let winnerMatch: LiveMatchRow | null = null;
    if (Date.now() - lastAdvanceAt >= ADVANCE_SOFT_INTERVAL_MS) {
      lastAdvanceAt = Date.now();
      // A fresh holder per attempt: the lease's own-holder renewal clause exists for tail-frame
      // elections, where the same device must keep its claim across ticks. Reusing one holder id
      // here would let this isolate retake "advance" before it expires and beat the 4s cadence.
      if (await claimLease("advance", ADVANCE_MIN_INTERVAL_MS, crypto.randomUUID())) {
        let current = await ensureLiveMatch();
        try {
          await maybeSeedChat(current);
          // Before anything asks for a slot, give back the ones nothing is using any more.
          await reapStalledGenerations(current.id);
          const turned = await advanceStory(current);
          if (turned) current = await ensureLiveMatch();
          // The director line is normally chained off a tail frame landing. If every slot happened to be
          // busy at that exact moment the cut was simply lost, with nothing to retry it — which is how
          // it went an hour without filming. Giving it first refusal on each tick is that retry.
          await maybeStartDirectorClip(current);
          await maybeAdvanceHouseCast(current);
          // The pipeline used to move only because every viewer polled every pending clip. Now that
          // a viewer drives only what it owns, a clip whose author closed the tab would sit at
          // 'queued' with nobody to ask about it. One per tick, oldest first: the show keeps
          // rendering with nobody watching, and upstream sees a fixed rate rather than one request
          // per viewer per clip. Backgrounded, because a provider round trip and a video copy must
          // never be on the critical path of a heartbeat.
          const [stranded] = await db.select({ id: generations.id }).from(generations)
            .where(and(
              eq(generations.match_id, current.id),
              inArray(generations.stage, ["queued", "video"]),
            ))
            .orderBy(generations.id).limit(1);
          if (stranded) ctx.runInBackground(syncLiveGeneration(stranded.id).catch(() => undefined));
        } catch (error) {
          console.error("[heartbeat] advance failed", error instanceof Error ? error.message : String(error));
        }
        // The winner builds rather than reads: the pass it just ran is what changed the clips its
        // own tail elections are about to be held over.
        winner = await buildLiveShared(current);
        winnerMatch = current;
        liveSharedCache = { at: Date.now(), match: current, shared: winner.shared };
      }
    }
    let match: LiveMatchRow;
    let shared: Awaited<ReturnType<typeof buildLiveShared>>["shared"];
    let tailFrameCandidates: number[] = [];
    if (winner && winnerMatch) {
      match = winnerMatch;
      shared = winner.shared;
      tailFrameCandidates = winner.tailFrameCandidates;
    } else {
      const hit = liveSharedCache && Date.now() - liveSharedCache.at < LIVE_SHARED_TTL_MS ? liveSharedCache : null;
      if (hit) {
        // The match row rides along in the cache so a served-from-memory heartbeat skips
        // ensureLiveMatch as well — its upsert already ran on whichever request built this.
        match = hit.match;
        shared = hit.shared;
      } else {
        match = await ensureLiveMatch();
        const fresh = await buildLiveShared(match);
        shared = fresh.shared;
        liveSharedCache = { at: Date.now(), match, shared: fresh.shared };
      }
    }
    if (deviceId && presenceDue(deviceId)) ctx.runInBackground(markWatching(match.id, deviceId));
    // Reading a clip's last frame means downloading the whole clip, which is the most expensive
    // thing the page does — and it was being done by every browser for every clip so that the first
    // upload could win and the rest be thrown away. One viewer is elected per clip instead. The
    // lease expires if they close the tab, and the next advance winner re-runs the election; the
    // idempotent upload route stays the safety net for the frame that lands twice anyway.
    // No device id means no browser to do the work — a probe winning an election would just hold
    // the lease until it lapsed, so those requests stand aside.
    const tailFrameWanted: number[] = [];
    if (deviceId) {
      for (const id of tailFrameCandidates.slice(0, TAIL_ELECTIONS_PER_TICK)) {
        if (await claimLease(`tail:${id}`, TAIL_LEASE_TTL_MS, deviceId)) tailFrameWanted.push(id);
      }
    }
    const payload = {
      ...shared,
      chat_allowance: await chatAllowanceState(match.id, deviceId),
      tail_frame_wanted: tailFrameWanted,
    };
    // Versioned by content, not by clock: the browser hands the tag back and an unchanged feed
    // costs a bodiless 304 instead of ~50KB of JSON per viewer per heartbeat — which is why
    // generated_at stays out of the hash. Weak from the start, because the CDN marks recompressed
    // responses weak anyway and a mismatched marker would break the comparison.
    const etag = `W/"${(await sha256(JSON.stringify(payload))).slice(0, 32)}"`;
    if (c.req.header("if-none-match") === etag) {
      return c.body(null, 304, { ETag: etag });
    }
    return c.json({ ...payload, generated_at: new Date().toISOString() }, 200, {
      ETag: etag,
      "Cache-Control": "private, no-cache",
    });
  })
  .get("/api/public/clips/:id/video", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: "Invalid clip id" }, 400);
    // A completed clip is immutable, so the PoP can answer for it. Cloudflare slices a range out of
    // a cached 200 on its own, which is what lets a seeking player hit the edge too — and it saves
    // the row lookup and the presign as well as the bytes.
    const hit = await edgeCache?.match(c.req.raw).catch(() => undefined);
    if (hit) return hit;
    const [clip] = await db.select({ stage: generations.stage, result_url: generations.result_url })
      .from(generations).where(eq(generations.id, id)).limit(1);
    if (!clip || clip.stage !== "completed" || !clip.result_url) return c.json({ error: "No such clip" }, 404);
    const signed = await clipUrl(clip.result_url);
    if (!signed) return c.json({ error: "Clip address unavailable" }, 404);
    // Proxied rather than redirected: a presigned URL changes on every request, so a redirect would
    // hand the browser a new cache key each time and re-download the whole clip.
    const forwarded = new Headers();
    const range = c.req.header("range");
    const ifNoneMatch = c.req.header("if-none-match");
    if (range) forwarded.set("range", range);
    if (ifNoneMatch) forwarded.set("if-none-match", ifNoneMatch);
    const upstream = await fetch(signed, { headers: forwarded });
    if (upstream.status >= 400) return c.json({ error: "Could not read the clip" }, 502);
    const headers = new Headers();
    for (const key of ["content-type", "content-length", "content-range", "etag", "last-modified"]) {
      const value = upstream.headers.get(key);
      if (value) headers.set(key, value);
    }
    if (!headers.has("content-type")) headers.set("content-type", "video/mp4");
    headers.set("accept-ranges", "bytes");
    // A completed clip never changes, so the browser can replay it straight from disk cache.
    headers.set("cache-control", "public, max-age=31536000, immutable");
    // The first viewer at each PoP pays for the fill; everyone behind them is served from the edge.
    if (edgeCache && !edgeFillInFlight.has(id)) {
      edgeFillInFlight.add(id);
      ctx.runInBackground(fillEdgeCache(id, c.req.url, signed));
    }
    return new Response(upstream.body, { status: upstream.status, headers });
  })
  .get("/api/public/clips/:id/thumbnail", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: "Invalid clip id" }, 400);
    // Tail frames are the archive's wallpaper: small, immutable, and asked for by every viewer at
    // once. Served from the PoP, they cost neither a row lookup nor a presign nor an R2 read.
    const hit = await edgeCache?.match(c.req.raw).catch(() => undefined);
    if (hit) return hit;
    const [clip] = await db.select({ thumbnail_url: generations.thumbnail_url }).from(generations)
      .where(eq(generations.id, id)).limit(1);
    if (!clip?.thumbnail_url) return c.json({ error: "That clip has no thumbnail yet" }, 404);
    const signed = await clipUrl(clip.thumbnail_url);
    if (!signed) return c.json({ error: "Thumbnail address unavailable" }, 404);
    const upstream = await fetch(signed);
    if (upstream.status >= 400) return c.json({ error: "Could not read the thumbnail" }, 502);
    const headers = new Headers();
    headers.set("content-type", upstream.headers.get("content-type") || "image/jpeg");
    const length = upstream.headers.get("content-length");
    if (length) headers.set("content-length", length);
    headers.set("cache-control", "public, max-age=31536000, immutable");
    const response = new Response(upstream.body, { status: 200, headers });
    if (edgeCache) {
      ctx.runInBackground(edgeCache.put(new Request(c.req.url), response.clone()).catch(() => undefined));
    }
    return response;
  })
  .post("/api/public/clips/:id/tail-frame", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: "Invalid clip id" }, 400);
    const [clip] = await db.select().from(generations).where(eq(generations.id, id)).limit(1);
    if (!clip || clip.stage !== "completed" || !clip.result_url) return c.json({ error: "No such clip" }, 404);
    // First frame wins. Re-uploads are a no-op so a second viewer racing the first changes nothing.
    if (clip.thumbnail_url) return c.json({ ok: true, skipped: true });
    const contentType = c.req.header("content-type") || "";
    if (!contentType.startsWith("image/")) return c.json({ error: "The tail frame must be an image" }, 400);
    const bytes = await c.req.arrayBuffer();
    if (bytes.byteLength < 1024 || bytes.byteLength > TAIL_FRAME_MAX_BYTES) {
      return c.json({ error: "Invalid tail frame size" }, 400);
    }
    const s3Uri = await persistTailFrame(id, { bytes, contentType });
    const claimed = await db.update(generations)
      .set({ thumbnail_url: s3Uri })
      .where(and(eq(generations.id, id), isNull(generations.thumbnail_url)))
      .returning({ id: generations.id });
    if (claimed.length === 0) return c.json({ ok: true, skipped: true });
    // This frame is exactly what the director channel was waiting for.
    const [clipMatch] = await db.select().from(matches).where(eq(matches.id, clip.match_id)).limit(1);
    const director = clip.channel === "participant" && clipMatch ? await maybeStartDirectorClip(clipMatch) : null;
    return c.json({ ok: true, directorGenerationId: director?.id ?? null });
  })
  .post("/api/public/avatar/presign", async (c) => {
    const data = asObject(await c.req.json().catch(() => ({})));
    const filename = cleanText(data.filename, 120).replace(/[^a-zA-Z0-9._-]/g, "-");
    const contentType = cleanText(data.contentType, 80).toLowerCase();
    if (!filename || !["image/jpeg", "image/png", "image/webp"].includes(contentType)) {
      return c.json({ error: "Only JPG, PNG or WebP photos are supported" }, 400);
    }
    const path = `avatars/${crypto.randomUUID()}-${filename}`;
    const signed = await storage.from(buckets.characterAvatars).createPresignedPutUrl(path, 900, { contentType });
    return c.json({ path, uploadUrl: signed.uploadUrl, requiredHeaders: signed.requiredHeaders });
  })
  .get("/api/public/character/cost", async (c) => {
    return c.json({
      model: CHARACTER_MODEL,
      displayName: CHARACTER_MODEL,
      resolution: CHARACTER_RESOLUTION,
      estimatedCredit: null,
      sufficient: true,
      available: false,
      notice: CHARACTER_CREATION_CLOSED_NOTICE,
    });
  })
  .post("/api/public/character/generations", async (c) => {
    if (!CHARACTER_CREATION_OPEN) return c.json({ error: CHARACTER_CREATION_CLOSED_NOTICE }, 503);
    // Characters belong to accounts now: it is what makes them recoverable and what the per-user
    // limit is counted against.
    if (!auth.user) return c.json({ error: "Sign in to create a character" }, 401);
    const quotaMatch = await ensureLiveMatch();
    const quota = await characterQuota(quotaMatch.id);
    if (quota.remaining <= 0) {
      return c.json({ error: `Each account may create ${quota.limit} character(s); you have created ${quota.used}` }, 403);
    }
    const data = asObject(await c.req.json().catch(() => ({})));
    const displayName = cleanText(data.displayName, 20);
    const concept = cleanText(data.concept, 300);
    // Contestants are told apart by colour on the story map, so a duplicate accent makes two lines
    // indistinguishable. Prefer one nobody in this match is using.
    const usedAccents = new Set((await db.select({ accent: participants.accent }).from(participants)
      .where(eq(participants.match_id, quotaMatch.id))).map((row) => row.accent));
    const freeAccents = ACCENTS.filter((item) => !usedAccents.has(item));
    const requestedAccent = cleanText(data.accent, 16);
    const accent = requestedAccent && !usedAccents.has(requestedAccent)
      ? requestedAccent
      : freeAccents[0] ?? ACCENTS[Math.floor(Math.random() * ACCENTS.length)];
    const avatarPath = cleanText(data.avatarPath, 240);
    if (displayName.length < 2) return c.json({ error: "The contestant name needs at least 2 characters" }, 400);
    if (concept.length < 4) return c.json({ error: "Describe the contestant you want to be, at least 4 characters" }, 400);
    if (!avatarPath || !avatarPath.startsWith("avatars/")) return c.json({ error: "Upload a valid photo of yourself first" }, 400);
    if (data.creditApproved !== true) return c.json({ error: "Confirm that this will call the generation API" }, 400);
    try {
      requireFal();
    } catch {
      return c.json({ error: "The generation API key is not configured, so characters cannot be created" }, 503);
    }

    const meta = await storage.from(buckets.characterAvatars).head(avatarPath);
    if (!meta) return c.json({ error: "The photo upload has not finished" }, 400);
    if (meta.size > 8 * 1024 * 1024) return c.json({ error: "Your photo must be under 8MB" }, 400);

    const requesterHash = await sha256(requestFingerprint(c));
    const recent = await db.select({ id: characterDrafts.id }).from(characterDrafts).where(and(
      eq(characterDrafts.requester_hash, requesterHash),
      ne(characterDrafts.status, "failed"),
      sql`${characterDrafts.created_at} >= datetime('now', '-1 hour')`,
    ));
    if (recent.length >= CHARACTER_RATE_LIMIT_PER_HOUR) {
      return c.json({ error: "This network may create 3 characters an hour — try again later" }, 429);
    }

    const publicId = crypto.randomUUID();
    const controlToken = crypto.randomUUID();
    const brief = await expandCharacterConcept(displayName, concept);
    const prompt = characterPrompt(brief, accent);
    const [draft] = await db.insert(characterDrafts).values({
      public_id: publicId,
      control_token_hash: await sha256(controlToken),
      requester_hash: requesterHash,
      display_name: displayName,
      archetype: brief.archetype,
      concept,
      appearance: brief.appearance || null,
      accent,
      source_s3_uri: storage.createS3Uri(buckets.characterAvatars, avatarPath),
      model: CHARACTER_MODEL,
      prompt,
      status: "generating",
      estimated_credit: null,
    }).returning();

    try {
      const sourceUrl = await avatarUrl(storage.createS3Uri(buckets.characterAvatars, avatarPath));
      if (!sourceUrl) throw new Error("Could not sign a temporary URL for the photo");
      // Sheets carried a real face into the show through MiniMax's subject reference. That provider
      // is gone, and choosing a fal model with the same capability is a decision nobody has made —
      // so this says so, rather than failing somewhere further down with a confusing message.
      const imageTask: { url: string; id: string } = ((): never => {
        throw new Error("Character sheets are not wired to fal yet");
      })();
      const imageResponse = await fetch(imageTask.url);
      if (!imageResponse.ok) throw new Error("Could not download the generated character sheet");
      const imageBytes = await imageResponse.arrayBuffer();
      const contentType = imageResponse.headers.get("content-type") || "image/png";
      const outputPath = `generated/${draft.public_id}.png`;
      await storage.from(buckets.characterAvatars).put(outputPath, imageBytes, {
        contentType,
        cacheControl: "private, max-age=31536000, immutable",
      });
      const generatedS3Uri = storage.createS3Uri(buckets.characterAvatars, outputPath);
      await removeStoredSource(draft.source_s3_uri);
      const completedAt = new Date().toISOString();
      const readyDraft = {
        ...draft,
        status: "ready" as const,
        source_s3_uri: null,
        generated_s3_uri: generatedS3Uri,
        renoise_task_id: imageTask.id,
        completed_at: completedAt,
      };
      await db.update(characterDrafts).set({
        renoise_task_id: imageTask.id,
        status: "ready",
        source_s3_uri: null,
        generated_s3_uri: generatedS3Uri,
        completed_at: completedAt,
      }).where(eq(characterDrafts.id, draft.id));
      return c.json({
        draft: await characterDraftPayload(readyDraft),
        controlToken,
        message: "The character sheet was generated through the MiniMax API",
      }, 201);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not submit the character job";
      await db.update(characterDrafts).set({ status: "failed", error_message: message }).where(eq(characterDrafts.id, draft.id));
      return c.json({ error: message }, 502);
    }
  })
  .post("/api/public/character/generations/:publicId/sync", async (c) => {
    const publicId = cleanText(c.req.param("publicId"), 64);
    const data = asObject(await c.req.json().catch(() => ({})));
    const controlToken = cleanText(data.controlToken, 100);
    const draft = await getOwnedCharacterDraft(publicId, controlToken);
    if (!draft) return c.json({ error: "Cannot access this character draft" }, 403);
    if (draft.status !== "generating") return c.json({ draft: await characterDraftPayload(draft) });
    if (!draft.renoise_task_id) return c.json({ draft: await characterDraftPayload(draft), providerStatus: "pending" });

    try {
      const imageTask = await getRenoiseTask(draft.renoise_task_id);
      const status = taskStatus(imageTask);
      if (status === "failed") throw new Error("Character sheet generation failed");
      if (status !== "completed") {
        return c.json({ draft: await characterDraftPayload(draft), providerStatus: status || "pending" });
      }
      const remoteUrl = taskResultUrl(imageTask);
      if (!remoteUrl) throw new Error("The character job finished but returned no sheet");
      const imageResponse = await fetch(remoteUrl);
      if (!imageResponse.ok) throw new Error("Could not download the generated character sheet");
      const imageBytes = await imageResponse.arrayBuffer();
      const contentType = imageResponse.headers.get("content-type") || "image/png";
      const outputPath = `generated/${draft.public_id}.png`;
      await storage.from(buckets.characterAvatars).put(outputPath, imageBytes, {
        contentType,
        cacheControl: "private, max-age=31536000, immutable",
      });
      const generatedMaterialId = await uploadRenoiseMaterial(
        imageBytes,
        `character-${draft.id}.png`,
        contentType,
      );
      const generatedS3Uri = storage.createS3Uri(buckets.characterAvatars, outputPath);
      await removeStoredSource(draft.source_s3_uri);
      const completedAt = new Date().toISOString();
      const readyDraft = {
        ...draft,
        status: "ready" as const,
        source_s3_uri: null,
        generated_s3_uri: generatedS3Uri,
        renoise_generated_material_id: generatedMaterialId,
        completed_at: completedAt,
      };
      await db.update(characterDrafts).set({
        status: "ready",
        source_s3_uri: null,
        generated_s3_uri: generatedS3Uri,
        renoise_generated_material_id: generatedMaterialId,
        completed_at: completedAt,
      }).where(eq(characterDrafts.id, draft.id));
      return c.json({ draft: await characterDraftPayload(readyDraft), providerStatus: "completed" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Character sync failed";
      await db.update(characterDrafts).set({ status: "failed", error_message: message }).where(eq(characterDrafts.id, draft.id));
      return c.json({ error: message, draft: await characterDraftPayload({ ...draft, status: "failed", error_message: message }) }, 502);
    }
  })
  .post("/api/public/join", async (c) => {
    if (!auth.user) return c.json({ error: "Sign in to enter your contestant" }, 401);
    const data = asObject(await c.req.json().catch(() => ({})));
    const characterPublicId = cleanText(data.characterPublicId, 64);
    const characterToken = cleanText(data.characterToken, 100);
    const draft = await getOwnedCharacterDraft(characterPublicId, characterToken);
    if (!draft) return c.json({ error: "Cannot confirm this character draft" }, 403);
    if (draft.status === "claimed") return c.json({ error: "This contestant has already entered" }, 409);
    if (draft.status !== "ready" || !draft.generated_s3_uri) {
      return c.json({ error: "Wait for the character sheet to finish" }, 409);
    }
    const match = await ensureLiveMatch();
    const quota = await characterQuota(match.id);
    if (quota.remaining <= 0) {
      return c.json({ error: `Each account may field ${quota.limit} contestant(s); you already have ${quota.used}` }, 403);
    }
    const controlToken = crypto.randomUUID();
    const [participant] = await db.insert(participants).values({
      match_id: match.id,
      character_draft_id: draft.id,
      // Recorded so a signed-in viewer can recover a character whose token they lost.
      user_id: auth.user?.id ?? null,
      display_name: draft.display_name,
      archetype: draft.archetype,
      accent: draft.accent,
      avatar_s3_uri: draft.generated_s3_uri,
      appearance: draft.appearance,
      renoise_material_id: draft.renoise_generated_material_id,
      control_token_hash: await sha256(controlToken),
      status: "alive",
      health: 100,
      stamina: 86,
      hunger: 18,
      score: 100,
      last_action: "Heading to the entry point",
    }).returning();
    await db.update(characterDrafts).set({ status: "claimed", claimed_at: new Date().toISOString() })
      .where(eq(characterDrafts.id, draft.id));
    await db.insert(matchEvents).values({
      match_id: match.id,
      participant_id: participant.id,
      round: match.current_round,
      kind: "system",
      title: `${draft.display_name} is in the holding area`,
      detail: `${draft.archetype} joins the game in the next safe shot.`,
    });
    return c.json({ participantId: participant.id, controlToken, message: "Your contestant is in the holding area" }, 201);
  })
  .get("/api/public/my-characters", async (c) => {
    const match = await ensureLiveMatch();
    const quota = await characterQuota(match.id);
    if (!auth.user) return c.json({ characters: [], quota, isHost: false, signedIn: false });
    // Ownership now lives on the account, so a lost browser token no longer loses the character.
    const mine = await db.select().from(participants)
      .where(and(eq(participants.match_id, match.id), eq(participants.user_id, auth.user.id)))
      .orderBy(participants.id);
    return c.json({
      characters: mine.map((item) => ({ id: item.id, display_name: item.display_name, status: item.status })),
      quota,
      isHost: isHostAccount(),
      signedIn: true,
    });
  })
  .post("/api/public/action", async (c) => {
    const data = asObject(await c.req.json().catch(() => ({})));
    const participantId = Number(data.participantId);
    const controlToken = cleanText(data.controlToken, 100);
    // The viewer writes the branch themselves now; the blueprints survive only as UI shortcuts.
    const viewerPrompt = cleanText(data.viewerPrompt ?? data.prompt, VIEWER_PROMPT_MAX_CHARS);
    if (!Number.isInteger(participantId) || viewerPrompt.length < 2) {
      return c.json({ error: "Write what your contestant should do" }, 400);
    }
    const [participant] = await db.select().from(participants).where(eq(participants.id, participantId)).limit(1);
    if (!participant) return c.json({ error: "You cannot control this contestant" }, 403);
    const ownsBySession = Boolean(auth.user && participant.user_id === auth.user.id);
    // Once a character belongs to an account, the account is the only way in. The browser token
    // stays valid only for characters that predate accounts and were never claimed — otherwise
    // signing out would leave control behind in localStorage.
    const ownsByToken = !participant.user_id
      && Boolean(controlToken && participant.control_token_hash === await sha256(controlToken));
    if (!ownsBySession && !ownsByToken) return c.json({ error: "You cannot control this contestant" }, 403);
    if (!participant.character_draft_id) return c.json({ error: "Only viewer-created contestants can be controlled" }, 403);
    if (participant.status === "eliminated") return c.json({ error: "This contestant is out" }, 409);
    const match = await ensureLiveMatch();

    // Only this contestant's own channel has to be idle; other channels keep running in parallel.
    const active = await activeGenerations(match.id);
    const slotError = generationSlotError(active, "participant", participant.id, tierOf(match));
    if (slotError) return c.json({ error: slotError.error, generation: slotError.generation }, slotError.status);

    const roster = await db.select().from(participants).where(and(
      eq(participants.match_id, match.id),
      or(isNotNull(participants.character_draft_id), eq(participants.is_system, true)),
    ));

    // Opting to continue from a clip you were written into: that frame already holds both people in
    // one real composition, which no amount of identity-lock text can reproduce.
    const linkFromId = Number(data.linkFromGenerationId);
    let linkedSourceId: number | null = null;
    let linkedCast: string | null = null;
    if (Number.isInteger(linkFromId) && linkFromId > 0) {
      const [linked] = await db.select().from(generations).where(eq(generations.id, linkFromId)).limit(1);
      const linkedIds = parseParticipantIds(linked?.participant_ids ?? null);
      const usable = linked
        && linked.match_id === match.id
        && linked.stage === "completed"
        && Boolean(linked.thumbnail_url)
        && linkedIds.includes(participant.id)
        && linked.channel_participant_id !== participant.id;
      if (!usable) return c.json({ error: "That clip cannot open your shot" }, 400);
      linkedSourceId = linked!.id;
      linkedCast = linked!.participant_ids;
    }
    // MiniMax takes at most 3 people, and the channel owner always holds one of those slots.
    const guests = mentionedParticipants(viewerPrompt, roster, participant.id).slice(0, 2);
    await db.update(participants).set({
      last_action: viewerPrompt.slice(0, 40),
      stamina: clamp(participant.stamina - 9),
      hunger: clamp(participant.hunger + 4),
      score: participant.score + 20,
    }).where(eq(participants.id, participant.id));
    for (const guest of guests) {
      await db.insert(matchEvents).values({
        match_id: participant.match_id,
        participant_id: guest.id,
        round: match.current_round,
        kind: "danger",
        title: `${guest.display_name} was pulled into the shot`,
        detail: `${participant.display_name} wrote ${guest.display_name} into this clip. Once it lands, ${guest.display_name} can type / to continue from that frame.`,
      });
    }
    await db.insert(matchEvents).values({
      match_id: participant.match_id,
      participant_id: participant.id,
      round: match.current_round,
      kind: "player",
      title: `${participant.display_name} gave an order`,
      detail: guests.length
        ? `${viewerPrompt} — filming on the ${participant.display_name} channel with ${guests.map((item) => item.display_name).join(", ")}.`
        : `${viewerPrompt} — filming on the ${participant.display_name} channel.`,
    });
    try {
      // Continuing from a linked clip means opening on a frame that already holds its whole cast.
      const carriedOver = linkedSourceId ? parseParticipantIds(linkedCast) : [];
      const generation = await queueLiveGeneration({
        channel: "participant",
        channelParticipantId: participant.id,
        participantIds: [...new Set([participant.id, ...guests.map((item) => item.id), ...carriedOver])],
        sourceGenerationId: linkedSourceId,
        viewerPrompt,
        keyframePrompt: "",
        videoPrompt: "",
        visualMemory: "",
        duration: LIVE_VIDEO_DURATION_SECONDS,
      }, `participant:${participant.id}`);
      return c.json({
        ok: true,
        message: "Order received, writing the shot",
        guests: guests.map((item) => item.display_name),
        generation,
      }, 201);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not submit the job";
      return c.json({ error: message }, liveGenerationErrorStatus(error));
    }
  })
  .post("/api/public/generations/:id/sync", async (c) => {
    try {
      const result = await syncLiveGeneration(Number(c.req.param("id")));
      if (result.failed) return c.json(result, 502);
      return c.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Sync failed";
      return c.json({ error: message }, liveGenerationErrorStatus(error));
    }
  })
  .get("/api/director/status", async (c) => {
    await requireDirector();
    return c.json({ ready: Boolean(secret.get("FAL_KEY")), model: LIVE_VIDEO_MODEL, provider: "fal" });
  })
  .post("/api/director/generations", async (c) => {
    if (!isHostAccount()) return c.json({ error: "This account has no host permission" }, 403);
    try {
      const data = asObject(await c.req.json().catch(() => ({})));
      const generation = await queueLiveGeneration(directorRequestFrom(data), auth.user!.id);
      return c.json({ generation, message: "Queued, writing the shot" }, 201);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not submit the job";
      return c.json({ error: message }, liveGenerationErrorStatus(error));
    }
  })
  .post("/api/director/generations/:id/sync", async (c) => {
    await requireDirector();
    try {
      const result = await syncLiveGeneration(Number(c.req.param("id")));
      if (result.failed) return c.json(result, 502);
      return c.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Sync failed";
      return c.json({ error: message }, liveGenerationErrorStatus(error));
    }
  });

export default app;
