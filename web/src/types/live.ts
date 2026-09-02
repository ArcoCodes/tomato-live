export type ParticipantStatus = "ready" | "alive" | "danger" | "eliminated";

export interface MatchInfo {
  id: number;
  title: string;
  subtitle: string;
  status: "waiting" | "live" | "finished";
  current_round: number;
  zone: string;
  viewers: number;
  started_at: string;
}

export interface Participant {
  id: number;
  display_name: string;
  archetype: string;
  accent: string;
  avatar_url: string | null;
  status: ParticipantStatus;
  health: number;
  stamina: number;
  hunger: number;
  score: number;
  last_action: string;
}

export interface MatchEvent {
  id: number;
  round: number;
  kind: "world" | "player" | "system" | "danger";
  title: string;
  detail: string;
  created_at: string;
}

export type ClipChannel = "director" | "participant";

export interface BroadcastClip {
  id: number;
  round: number;
  duration_seconds: number;
  channel: ClipChannel;
  channel_participant_id: number | null;
  /** Everyone written into this clip, including guests pulled in with @mentions. */
  participant_ids: number[];
  /** The clip this one took its opening frame from, if any. */
  source_generation_id: number | null;
  summary: string | null;
  result_url: string | null;
  /** Stable address for this clip's tail frame, usable as a poster. */
  thumbnail_url: string | null;
  has_tail_frame: boolean;
  created_at: string;
}

export interface StoryChoice {
  id: string;
  title: string;
  detail: string;
  participantHint: string;
  round: number;
  recentEvent: string | null;
}

export interface PendingGeneration {
  id: number;
  stage: "queued" | "keyframe" | "video";
  channel: ClipChannel;
  channel_participant_id: number | null;
  duration_seconds: number;
  created_at: string;
}

export interface LiveData {
  match: MatchInfo;
  participants: Participant[];
  events: MatchEvent[];
  clips: BroadcastClip[];
  story_choices: StoryChoice[];
  pending_generation: PendingGeneration | null;
  pending_generations: PendingGeneration[];
  /** Contestant clips whose tail frame nobody has captured yet; the browser harvests these. */
  tail_frame_wanted: number[];
  generated_at: string;
}

/** A clip someone else made that wrote you in, offered as an opening frame for your next one. */
export interface LinkOffer {
  id: number;
  fromName: string;
  summary: string | null;
}

export interface PlayerControl {
  participantId: number;
  controlToken: string;
}

export interface CharacterDraft {
  publicId: string;
  displayName: string;
  archetype: string;
  accent: string;
  model: string;
  status: "generating" | "ready" | "failed" | "claimed";
  estimatedCredit: number | null;
  characterUrl: string | null;
  error: string | null;
}

export interface CharacterDraftControl {
  publicId: string;
  controlToken: string;
}

export interface CharacterCost {
  model: string;
  displayName: string;
  resolution: string;
  estimatedCredit: number | null;
  sufficient: boolean;
  available: boolean;
  notice?: string;
  prompt: string;
}
