/**
 * Storage Schema
 *
 * Define your storage buckets here for compile-time type safety.
 * This file is the source of truth for bucket metadata.
 * Bucket names are first-level path prefixes in the environment's R2 bucket.
 *
 * After editing this file, run:
 *   edgespark storage apply
 *
 * Usage in code:
 *   import { storage } from "edgespark";
 *   import { buckets } from "@defs";
 *   await storage.from(buckets.uploads).put("file.jpg", buffer);
 */

import type { BucketDef } from "@sdk/server-types";

export const characterAvatars: BucketDef<"character-avatars"> = {
  bucket_name: "character-avatars",
  description: "Private source portraits and generated survival challenge character art",
};

export const broadcastClips: BucketDef<"broadcast-clips"> = {
  bucket_name: "broadcast-clips",
  description: "Stable copies of completed AI survival broadcast clips",
};
