import { and, desc, eq, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { db, secret, storage, vars } from "edgespark";
import { auth } from "edgespark/http";
import { buckets, characterDrafts, chatMessages, generations, matchEvents, matches, participants, viewerPerks } from "@defs";

const LIVE_SLUG = "island-zero";
const RENOISE_DEFAULT_BASE_URL = "https://www.renoise.ai/api/public/v1";
const MINIMAX_DEFAULT_BASE_URL = "https://api.minimax.io";
const CHARACTER_MODEL = "image-01";
// The character sheet doubles as the opening frame of that contestant's channel, and MiniMax takes
// the video ratio from the input image (`ratio` is ignored for image-to-video), so the sheet's
// aspect ratio IS the broadcast's aspect ratio. Portrait, because most of the audience is on a phone.
const CHARACTER_RATIO = "9:16";
const CHARACTER_RESOLUTION = "768x1366";
const LIVE_VIDEO_MODEL = "MiniMax-H3-Max";
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
const SUMMARY_MODEL = "MiniMax-M2";
const VISION_MODEL = "MiniMax-M3";
const FIELD_AUDIO_PROMPT = "Audio: on-location sound only — wind, rain hitting fabric and rock, footsteps in mud, the contestant's breathing and effort. No music, no narration, no voice-over.";
const DIRECTOR_AUDIO_PROMPT = "Audio: a calm English-speaking off-screen commentator narrates the situation in one or two short sentences, mixed over storm ambience. Broadcast commentary tone, spoken in English, no music, no other language.";
const PACING_PROMPT = [
  "Pacing: one continuous take, but never a static one.",
  `Break the ${LIVE_VIDEO_DURATION_SECONDS} seconds into three escalating beats — a new physical action or a new complication roughly every ${Math.round(LIVE_VIDEO_DURATION_SECONDS / 3)} seconds. Never hold one pose or one framing for the whole clip.`,
  "Camera: moving throughout — push in, track alongside, drop low, rise, swing to a new angle, rack focus. Change the framing at least twice.",
].join("\n");
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

async function ensureLiveMatch() {
  await db.insert(matches).values({
    slug: LIVE_SLUG,
    title: "ISLAND / 00",
    subtitle: "Island Survival Open · Season 01",
    status: "live",
    current_round: 7,
    zone: "North shore rainforest",
    viewers: 12847,
  }).onConflictDoNothing({ target: matches.slug });

  const [match] = await db.select().from(matches).where(eq(matches.slug, LIVE_SLUG)).limit(1);
  if (!match) throw new Error("Unable to initialize live match");

  return match;
}

async function avatarUrl(s3Uri: string | null) {
  if (!s3Uri) return null;
  const parsed = storage.tryParseS3Uri(s3Uri);
  if (!parsed) return s3Uri.startsWith("https://") ? s3Uri : null;
  const signed = await storage.from(parsed.bucket).createPresignedGetUrl(parsed.path, 3600);
  return signed.downloadUrl;
}

async function clipUrl(value: string | null) {
  if (!value) return null;
  const parsed = storage.tryParseS3Uri(value);
  if (!parsed) return value.startsWith("https://") ? value : null;
  const signed = await storage.from(parsed.bucket).createPresignedGetUrl(parsed.path, 3600);
  return signed.downloadUrl;
}

function requireMiniMax() {
  const apiKey = secret.get("MINIMAX_API_KEY");
  if (!apiKey) throw new Error("MINIMAX_API_KEY is not configured");
  return {
    apiKey,
    baseUrl: (vars.get("MINIMAX_API_BASE_URL") || MINIMAX_DEFAULT_BASE_URL).replace(/\/$/, ""),
  };
}

function miniMaxErrorMessage(payload: unknown, status: number) {
  const root = asObject(payload);
  const error = asObject(root.error);
  const baseResp = asObject(root.base_resp);
  return (
    cleanText(error.message, 500)
    || cleanText(error.type, 200)
    || cleanText(baseResp.status_msg, 500)
    || `MiniMax request failed (${status})`
  );
}

async function miniMaxFetch(path: string, init: RequestInit = {}) {
  const { apiKey, baseUrl } = requireMiniMax();
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  headers.set("Authorization", `Bearer ${apiKey}`);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
  const responseText = await response.text();
  let payload: unknown = {};
  try {
    payload = responseText ? JSON.parse(responseText) : {};
  } catch {
    const contentType = response.headers.get("content-type") || "unknown";
    const htmlHint = /<html|<!doctype/i.test(responseText) ? ", looks like an HTML page" : "";
    throw new Error(`MiniMax ${path} returned an unparseable response (${response.status}, ${contentType}${htmlHint})`);
  }
  const baseResp = asObject(asObject(payload).base_resp);
  const baseStatus = Number(baseResp.status_code);
  if (!response.ok || (Number.isFinite(baseStatus) && baseStatus !== 0)) {
    throw new Error(miniMaxErrorMessage(payload, response.status));
  }
  return payload;
}

async function miniMaxProbeRequest(path: string, init: RequestInit = {}) {
  const { apiKey, baseUrl } = requireMiniMax();
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  headers.set("Authorization", `Bearer ${apiKey}`);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
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

async function createMiniMaxCharacterImage(prompt: string, imageUrl: string) {
  const payload = asObject(await miniMaxFetch("/v1/image_generation", {
    method: "POST",
    body: JSON.stringify({
      model: CHARACTER_MODEL,
      prompt: cleanText(prompt, 1500),
      aspect_ratio: CHARACTER_RATIO,
      subject_reference: [{ type: "character", image_file: imageUrl }],
      response_format: "url",
      prompt_optimizer: false,
      n: 1,
    }),
  }));
  const imageUrls = asObject(payload.data).image_urls;
  const imageUrlResult = Array.isArray(imageUrls)
    ? imageUrls.find((value): value is string => typeof value === "string" && value.startsWith("http"))
    : null;
  if (!imageUrlResult) throw new Error("MiniMax finished the character sheet but returned no image URL");
  return {
    id: cleanText(payload.id, 120) || crypto.randomUUID(),
    url: imageUrlResult,
  };
}

async function createMiniMaxVideoTask(prompt: string, firstFrameUrl: string, duration: number) {
  const payload = asObject(await miniMaxFetch("/v2/video_generation", {
    method: "POST",
    body: JSON.stringify({
      model: LIVE_VIDEO_MODEL,
      content: [
        { type: "text", text: cleanText(prompt, 6500) },
        { type: "image_url", image_url: { url: firstFrameUrl }, role: "first_frame" },
      ],
      resolution: LIVE_VIDEO_RESOLUTION,
      duration,
      ratio: "adaptive",
    }),
  }));
  const taskIdValue = payload.task_id;
  if (typeof taskIdValue !== "string" && typeof taskIdValue !== "number") {
    throw new Error("MiniMax video generation returned no task_id");
  }
  return { id: String(taskIdValue), raw: payload };
}

async function getMiniMaxVideoTask(id: string) {
  return miniMaxFetch(`/v2/query/video_generation/${encodeURIComponent(id)}`);
}

function miniMaxVideoStatus(payload: unknown) {
  return cleanText(asObject(asObject(payload).task).status, 32).toLowerCase();
}

function miniMaxVideoResultUrl(payload: unknown) {
  const content = asObject(asObject(asObject(payload).task).content);
  const url = content.url;
  return typeof url === "string" && url.startsWith("http") ? url : null;
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
      900,
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
  latestClip: typeof generations.$inferSelect | null,
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
async function miniMaxChat(system: string, user: string, maxTokens: number) {
  const payload = asObject(await miniMaxFetch("/v1/text/chatcompletion_v2", {
    method: "POST",
    body: JSON.stringify({
      model: SUMMARY_MODEL,
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
  return cleanText(message.content, 800);
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
        `- It is ONE continuous take with no cuts, but it must never be static. Break it into three escalating beats, roughly ${beatSeconds} seconds each, and write them as "0-${beatSeconds}s: ...".`,
        "- Every beat is a NEW physical action or a NEW complication — something gives way, slips, tears, floods, catches. Never the same pose held throughout.",
        "- Keep the camera moving the whole time and change the framing at least twice.",
        "- Write concrete physical detail: what the hands grip, what slips, what splashes, what the wind and rain do.",
        `- The people in this shot are: ${cast}. Call them by these exact names throughout — never "the contestant" or "a survivor".`,
        guests.length
          ? `- ${guests.join(" and ")} appear alongside ${lead}; give them their own physical actions, do not leave them standing idle. No one outside this list appears.`
          : `- ${lead} is the only person in frame. No new people.`,
        "- Keep every named person's identity, wardrobe and location unchanged.",
        "- End with one line starting 'Audio:' describing on-location sound only — no music, no narration.",
        "- No on-screen text, subtitles, captions or graphics anywhere.",
        "- Write the entire prompt in English, including any spoken line, even when the viewer wrote in Chinese or another language. No Chinese characters anywhere in your output.",
        "Output only the prompt itself, no preamble and no headings.",
      ].join("\n"),
      [
        previousStory ? `Previous clip ended with: ${previousStory}` : `This opens ${lead}'s storyline.`,
        `Condition: ${condition}`,
        guests.length ? `Also in this shot: ${guests.join(", ")}` : "",
        `Viewer instruction (the "@name" marks are mentions of other contestants): ${viewerPrompt}`,
      ].filter(Boolean).join("\n"),
      900,
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
}: {
  viewerPrompt: string;
  participant: typeof participants.$inferSelect;
  guests: Array<typeof participants.$inferSelect>;
  latestClip: typeof generations.$inferSelect | null;
}) {
  const previousStory = storyTextFromGeneration(latestClip);
  const condition = contestantCondition(participant);
  const guestNames = guests.map((item) => item.display_name);
  const expanded = await expandViewerPrompt(viewerPrompt, condition, previousStory, participant.display_name, guestNames);
  const cue = viewerPrompt;
  const sharedContinuity = [
    previousStory ? `Continue from this clean visual memory: ${previousStory}.` : "Opening situation: a lone survival contestant is on a rain-soaked remote coast as a storm approaches.",
    `Branch action: ${cue}.`,
    `Physical condition: ${condition}.`,
  ].join("\n");
  // storyTextFromGeneration feeds this straight into the next clip's English prompt, so it must be
  // the expanded English text — never the viewer's raw line.
  const memorySource = expanded
    ? cleanText(expanded, 600)
    : `${participant.display_name} — ${cue}`;
  return {
    cue,
    visualMemory: `${memorySource}; ${condition}; stormy remote coast; documentary handheld realism; no on-screen graphics`,
    keyframePrompt: [
      "Create a cinematic 16:9 opening frame for a survival challenge using the supplied contestant reference image.",
      sharedContinuity,
      `Frame: the supplied contestant is visibly starting this branch: ${cue}.`,
      "Composition: documentary survival camera, grounded realism, wet fabric, muddy skin, readable face, tense body language, tropical storm atmosphere, no duplicate person.",
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
      "Continuity: preserve the first frame, contestant identity, wardrobe, location, weather, color grade and camera style.",
      NO_SCREEN_TEXT_PROMPT,
      "Avoid new people, face morphing, fantasy effects, sudden costume changes, or jumping to a different location.",
    ].join("\n"),
  };
}

// The director channel stitches the contestant channels together, so its prompt leans on the rolling
// timeline rather than on any single viewer's instruction.
// The opening frame is the END of a contestant's shot. Without saying so, the model just replays
// the beat that already aired — the cutaway has to be told that time moves on.
async function expandDirectorCut(sourceStory: string, timeline: string[], lead: string, condition: string) {
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
        "- End with one line starting 'Audio:' describing a calm English-speaking commentator narrating the situation over storm ambience.",
        "- No on-screen text, subtitles, captions or graphics. Write everything in English.",
        "Output only the prompt itself, no preamble.",
      ].join("\n"),
      [
        sourceStory ? `The frame we open on is the end of: ${sourceStory}` : "The frame we open on is a contestant on a storm-lit coast.",
        timeline.length ? `Story so far: ${timeline.join(" ")}` : "This is early in the match.",
        `Contestant visible in the frame: ${lead} — ${condition}`,
      ].join("\n"),
      900,
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
}: {
  participant: typeof participants.$inferSelect;
  sourceStory: string;
  timeline: string[];
}) {
  const recap = timeline.length ? `Story so far: ${timeline.join(" ")}` : "Story so far: the storm is closing in on the island and the contestants are still scattered.";
  const condition = contestantCondition(participant);
  const expanded = await expandDirectorCut(sourceStory, timeline, participant.display_name, condition);
  const sharedContinuity = [
    sourceStory
      ? `The opening frame is where ${participant.display_name}'s last shot ended: ${sourceStory}. That beat is over — this cutaway takes place after it.`
      : "Opening situation: a lone survival contestant is on a rain-soaked remote coast as a storm approaches.",
    recap,
    `Physical condition: ${condition}.`,
  ].join("\n");
  return {
    visualMemory: cleanText(expanded || `${sourceStory || recap}; stormy remote coast; documentary handheld realism; no on-screen graphics`, 600),
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
    if (previous?.thumbnail_url) {
      const url = await clipUrl(previous.thumbnail_url);
      if (url) return { url, s3Uri: previous.thumbnail_url, source: "channel_tail_frame" as const };
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
// expanding the viewer's line into a shot design, writing the identity lock, submitting to MiniMax —
// happens in startQueuedGeneration, so the viewer sees a live stage instead of waiting inside the
// POST with nothing on screen. Video generation itself only takes ~20s and already has feedback.
async function queueLiveGeneration(request: GenerationRequest, createdBy: string) {
  requireMiniMax();
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

  const active = await activeGenerations(match.id);
  const slotError = generationSlotError(active, request.channel, request.channelParticipantId, tierOf(match));
  if (slotError) {
    const error = new Error(slotError.error);
    error.name = slotError.status === 409 ? "ConflictError" : "RateLimitError";
    throw Object.assign(error, { generation: slotError.generation });
  }

  const [generation] = await db.insert(generations).values({
    match_id: match.id,
    round: match.current_round,
    stage: "queued",
    model: LIVE_VIDEO_MODEL,
    channel: request.channel,
    channel_participant_id: request.channelParticipantId,
    viewer_prompt: cleanText(request.viewerPrompt, VIEWER_PROMPT_MAX_CHARS) || null,
    source_generation_id: request.sourceGenerationId ?? null,
    prompt: JSON.stringify({
      promptVersion: LIVE_PROMPT_VERSION,
      awaitingPrompt: true,
      // The director dialog supplies its own prompts; keep them so startQueuedGeneration
      // does not overwrite them with the template.
      ...(cleanText(request.keyframePrompt, 3500) ? { keyframePrompt: cleanText(request.keyframePrompt, 3500) } : {}),
      ...(cleanText(request.videoPrompt, 3500) ? { videoPrompt: cleanText(request.videoPrompt, 3500) } : {}),
      ...(cleanText(request.visualMemory, 1000) ? { visualMemory: cleanText(request.visualMemory, 1000) } : {}),
    }),
    participant_ids: JSON.stringify(participantIds),
    duration_seconds: clamp(request.duration || LIVE_VIDEO_DURATION_SECONDS, LIVE_VIDEO_DURATION_SECONDS, 15),
    created_by: createdBy,
  }).returning();
  return generation;
}

// Turns a queued row into a submitted MiniMax task. Runs from the sync endpoint, so its cost lands
// on a poll the browser is making anyway rather than on the viewer's submit.
async function startQueuedGeneration(generation: typeof generations.$inferSelect) {
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
    })
    : await promptsForViewerInput({
      viewerPrompt: generation.viewer_prompt ?? "",
      participant: lead,
      guests,
      latestClip,
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
    "Avoid any hard cut to a different scene, any reset, new location, new people, face morphing, or sudden costume changes.",
  ].filter(Boolean).join("\n");

  const videoTask = await createMiniMaxVideoTask(taskPrompt, opening.url, generation.duration_seconds);
  // The prompt actually sent to MiniMax is persisted too, so a finished clip can be reproduced later.
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
  const payload = asObject(await miniMaxFetch("/v1/text/chatcompletion_v2", {
    method: "POST",
    body: JSON.stringify({
      model: VISION_MODEL,
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
      400,
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
async function pickDirectorSource(matchId: number) {
  const clips = await db.select().from(generations)
    .where(and(
      eq(generations.match_id, matchId),
      eq(generations.channel, "participant"),
      eq(generations.stage, "completed"),
      isNotNull(generations.thumbnail_url),
    ))
    .orderBy(desc(generations.id));
  const newestByParticipant = new Map<number, typeof generations.$inferSelect>();
  for (const clip of clips) {
    const pid = clip.channel_participant_id;
    if (pid != null && !newestByParticipant.has(pid)) newestByParticipant.set(pid, clip);
  }
  if (newestByParticipant.size === 0) return null;

  const directorClips = await db.select().from(generations)
    .where(and(eq(generations.match_id, matchId), eq(generations.channel, "director"), isNotNull(generations.source_generation_id)))
    .orderBy(desc(generations.id));
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
type GenerationTierKey = "live" | "idle" | "hourly";
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
async function autoQueuedWithin(matchId: number, seconds: number, housOnly: boolean) {
  const [row] = await db.select({ n: sql<number>`count(*)` }).from(generations)
    .where(and(
      eq(generations.match_id, matchId),
      housOnly ? sql`${generations.created_by} like 'house:%'` : sql`(${generations.created_by} like 'house:%' or ${generations.created_by} like 'director:%')`,
      sql`${generations.created_at} >= datetime('now', ${`-${seconds} seconds`})`,
    ));
  return Number(row?.n ?? 0);
}
// The room's chat is the queue the show films from. A message is claimed atomically so two pickers
// running at once cannot shoot the same line twice, and a message that named a contestant is
// preferred for that contestant's channel — being mentioned is how a viewer aims their idea.
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

async function claimChatCue(matchId: number, availableIds: number[]) {
  const waiting = await db.select().from(chatMessages)
    .where(and(eq(chatMessages.match_id, matchId), isNull(chatMessages.consumed_at)))
    .orderBy(chatMessages.id)
    .limit(30);
  if (!waiting.length) return null;

  // Naming someone is how a viewer casts their idea, so a message whose target is free to film
  // outranks one that would have to be handed to whoever happens to be idle.
  const aimed = waiting.filter((item) => parseParticipantIds(item.mentions).some((id) => availableIds.includes(id)));
  const unaimed = waiting.filter((item) => parseParticipantIds(item.mentions).length === 0);
  const pool = aimed.length ? aimed : unaimed.length ? unaimed : waiting;
  const pick = pool[Math.floor(Math.random() * pool.length)];

  const [claimed] = await db.update(chatMessages)
    .set({ consumed_at: new Date().toISOString() })
    .where(and(eq(chatMessages.id, pick.id), isNull(chatMessages.consumed_at)))
    .returning();
  return claimed ?? null;
}

const HOUSE_CAST_CUE = "Take the next concrete step in your own plan on this island, and run into a new complication while doing it.";

async function maybeAdvanceHouseCast(match: typeof matches.$inferSelect) {
  const matchId = match.id;
  const tier = tierOf(match);
  try {
    requireMiniMax();
    const active = await activeGenerations(matchId);
    if (active.length >= tier.concurrent) return null;
    // Count the house line against its own ceiling, so the director does not squeeze it out.
    const houseActive = active.filter((item) => item.created_by.startsWith("house:")).length;
    if (houseActive >= tier.houseSlots) return null;

    const [tally] = await db.select({ total: sql<number>`count(*)` }).from(generations)
      .where(and(eq(generations.match_id, matchId), sql`${generations.created_by} like 'house:%'`));
    if (Number(tally?.total ?? 0) >= HOUSE_CAST_MAX_CLIPS) return null;
    if (await autoQueuedWithin(matchId, tier.gapSeconds, !tier.gapCoversDirector) > 0) return null;

    const cast = await db.select().from(participants)
      .where(and(eq(participants.match_id, matchId), eq(participants.is_system, true)));
    if (!cast.length) return null;
    const busy = new Set(active.map((item) => item.channel_participant_id));

    const clipRows = await db.select({ pid: generations.channel_participant_id, id: generations.id })
      .from(generations)
      .where(and(eq(generations.match_id, matchId), eq(generations.channel, "participant")))
      .orderBy(desc(generations.id));
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
    const generation = await queueLiveGeneration({
      channel: "participant",
      channelParticipantId: next.id,
      participantIds: [next.id, ...guestIds].slice(0, 3),
      keyframePrompt: "",
      videoPrompt: "",
      visualMemory: "",
      duration: LIVE_VIDEO_DURATION_SECONDS,
      viewerPrompt: cue ? cue.body : HOUSE_CAST_CUE,
    }, cue ? "house:chat" : "house:auto");
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
    requireMiniMax();
    const active = await activeGenerations(matchId);
    if (generationSlotError(active, "director", null, tier)) return null;
    if (tier.gapCoversDirector && await autoQueuedWithin(matchId, tier.gapSeconds, false) > 0) return null;
    const source = await pickDirectorSource(matchId);
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
        const videoTask = await getMiniMaxVideoTask(generation.video_task_id);
        const status = miniMaxVideoStatus(videoTask);
        if (status === "failed" || status === "cancelled") throw new Error("MiniMax H3 Max video generation failed");
        if (status !== "succeeded") return { generation, providerStatus: status || "pending" };
        const remoteUrl = miniMaxVideoResultUrl(videoTask);
        if (!remoteUrl) throw new Error("MiniMax finished the video but returned no result URL");
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
      // two MiniMax tasks. "keyframe" is the claimed-and-writing state.
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
    return { error: message, generation: { ...generation, stage: "failed" }, failed: true };
  }
}

function liveGenerationErrorStatus(error: unknown) {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : "";
  if (name === "BadRequestError" || message.startsWith("Pick ")) return 400;
  if (name === "ConflictError") return 409;
  if (name === "NotFoundError") return 404;
  if (message.includes("MINIMAX_API_KEY")) return 503;
  if (message.includes("not currently offer") || message.includes("must be enabled")) return 503;
  return 502;
}

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

    const [recent] = await db.select({ n: sql<number>`count(*)` }).from(chatMessages).where(and(
      eq(chatMessages.match_id, match.id),
      eq(chatMessages.device_id, deviceId),
      sql`${chatMessages.created_at} >= datetime('now', ${`-${CHAT_COOLDOWN_SECONDS} seconds`})`,
    ));
    if (Number(recent?.n ?? 0) > 0) return c.json({ error: "Slow down a moment" }, 429);

    const allowance = await chatAllowanceState(match.id, deviceId);
    if (allowance && !allowance.unlimited && allowance.remaining <= 0) {
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
    }).returning();
    return c.json({ message: chatPayload(row), mentions, allowance: await chatAllowanceState(match.id, deviceId) }, 201);
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
      .where(and(eq(chatMessages.match_id, match.id), isNull(chatMessages.consumed_at)))
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
    const match = await ensureLiveMatch();
    // There is no scheduler here, so the house cast advances on the back of the viewer heartbeat.
    await maybeAdvanceHouseCast(match);
    const [roster, allEvents, clips, pendingGenerations] = await Promise.all([
      db.select().from(participants)
        .where(and(
          eq(participants.match_id, match.id),
          or(isNotNull(participants.character_draft_id), eq(participants.is_system, true)),
        ))
        .orderBy(desc(participants.score)),
      db.select().from(matchEvents).where(eq(matchEvents.match_id, match.id)).orderBy(desc(matchEvents.id)).limit(50),
      db.select().from(generations).where(and(eq(generations.match_id, match.id), eq(generations.stage, "completed"))).orderBy(desc(generations.id)).limit(60),
      db.select().from(generations)
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
      ? await db.select().from(generations).where(and(
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
    // Contestant clips whose tail frame nobody has captured yet. The browser harvests these, and a
    // landed frame is what advances the director line — EdgeSpark has no scheduler to do it.
    const tailFrameWanted = clips
      .filter((clip) => clip.result_url && !clip.thumbnail_url)
      .map((clip) => clip.id);
    const pendingList = pendingGenerations.map((item) => ({
      id: item.id,
      stage: item.stage,
      channel: item.channel,
      channel_participant_id: item.channel_participant_id,
      duration_seconds: item.duration_seconds,
      created_at: item.created_at,
    }));
    const pendingGeneration = pendingList[0] ?? null;
    return c.json({
      match,
      // Oldest first: the room reads top to bottom.
      chat: chat.reverse().map(chatPayload),
      chat_allowance: await chatAllowanceState(match.id, deviceIdOf(c)),
      chat_waiting: chat.filter((item) => !item.consumed_at).length,
      participants: rosterWithUrls,
      events,
      clips: clipList,
      story_choices: storyChoices,
      pending_generation: pendingGeneration,
      pending_generations: pendingList,
      tail_frame_wanted: tailFrameWanted,
      generated_at: new Date().toISOString(),
    });
  })
  .get("/api/public/clips/:id/video", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: "Invalid clip id" }, 400);
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
    return new Response(upstream.body, { status: upstream.status, headers });
  })
  .get("/api/public/clips/:id/thumbnail", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: "Invalid clip id" }, 400);
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
    return new Response(upstream.body, { status: 200, headers });
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
      displayName: "MiniMax image-01",
      resolution: CHARACTER_RESOLUTION,
      estimatedCredit: null,
      sufficient: true,
      available: CHARACTER_CREATION_OPEN && Boolean(secret.get("MINIMAX_API_KEY")),
      notice: !CHARACTER_CREATION_OPEN
        ? CHARACTER_CREATION_CLOSED_NOTICE
        : secret.get("MINIMAX_API_KEY")
          ? "One character sheet will be generated through the MiniMax API."
          : "The MiniMax API key is not configured, so characters cannot be generated.",
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
    if (data.creditApproved !== true) return c.json({ error: "Confirm that this will call the MiniMax API" }, 400);
    try {
      requireMiniMax();
    } catch {
      return c.json({ error: "The MiniMax API key is not configured, so characters cannot be created" }, 503);
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
      const imageTask = await createMiniMaxCharacterImage(prompt, sourceUrl);
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
    return c.json({ ready: Boolean(secret.get("MINIMAX_API_KEY")), model: LIVE_VIDEO_MODEL, provider: "minimax" });
  })
  .get("/api/director/minimax/probe", async (c) => {
    await requireDirector();
    try {
      const results = await Promise.all([
        miniMaxProbeRequest("/v1/models"),
      ]);
      return c.json({ ok: true, provider: "minimax", results });
    } catch (error) {
      const message = error instanceof Error ? error.message : "MiniMax probe failed";
      return c.json({ ok: false, provider: "minimax", error: message }, 500);
    }
  })
  .get("/api/director/renoise/probe", async (c) => {
    await requireDirector();
    try {
      const results = await Promise.all([
        miniMaxProbeRequest("/v1/models"),
      ]);
      return c.json({ ok: true, provider: "minimax", legacyAlias: true, results });
    } catch (error) {
      const message = error instanceof Error ? error.message : "MiniMax probe failed";
      return c.json({ ok: false, provider: "minimax", legacyAlias: true, error: message }, 500);
    }
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
