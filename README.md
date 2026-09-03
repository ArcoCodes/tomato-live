# Tomato Live

An EdgeSpark-hosted live AI survival show prototype. Viewers upload their own portrait, generate and approve a world-consistent contestant design, join the active match, choose round actions, and appear in Renoise-generated broadcast clips.

## Runtime architecture

1. The browser uploads the viewer's source portrait directly to private EdgeSpark Storage with a presigned PUT URL.
2. The viewer reviews the complete identity-preserving character prompt and a live Renoise credit estimate before approving one image task. The server prefers GPT Image 2 for identity-sensitive editing and falls back to the live default compatible Renoise image model when needed.
3. EdgeSpark records a private character draft, sends the portrait to Renoise as an identity reference, and polls the same task ID until the contestant design is ready. The source portrait is then removed from EdgeSpark Storage.
4. The generated character design is shown to the viewer for approval. Only after approval is it added to the public roster and registered as that contestant's reusable Renoise identity material.
5. EdgeSpark stores match state, contestants, events, control-token hashes, character drafts, and broadcast generation jobs in its database.
6. A signed-in director selects up to three contestants and approves the complete shared-keyframe and video prompts.
7. The server composes the selected generated character designs into one scene keyframe, then sends that keyframe to MiniMax H3 Max as its opening frame.
8. The director endpoint polls the same task IDs, copies the finished clip into EdgeSpark Storage, and adds it to the public broadcast queue.

Finished clips and tail frames live in the public `broadcast-clips` bucket behind `https://video.renoise.live`, and the live feed hands the browser those addresses directly, so video bytes never pass through the Worker. The bucket's CORS policy is what lets the browser capture tail frames cross-origin. The same-origin `/api/public/clips/:id/*` proxy remains as the fallback for clips stored anywhere else.

Public character generation is limited to three attempts per network per hour. A browser-stored draft token lets a viewer close the dialog and safely resume polling without creating or charging for a duplicate task.

Renoise model durations, resolutions, ratios, and material roles are discovered from the live `/models` response at runtime. The server does not rely on a copied capability table.

## Local development

```bash
cd server && npm install
cd ../web && npm install
cd .. && edgespark dev
```

The live feed works without a local Renoise key. Character generation and director generations require `RENOISE_API_KEY` in `server/.env.local` or the corresponding EdgeSpark project secret.

## Validation

```bash
cd server && npm run typecheck
cd ../web && npm run build && npm run lint
cd .. && edgespark deploy --dry-run
```

## Important product boundary

The match engine is authoritative. Renoise visualizes an already-decided event; generated footage never changes health, score, elimination status, or inventory by itself.
