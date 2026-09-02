# Gift Video — the 10-second story reel (plan, gv-1)

> **Status:** plan only — nothing on this branch ships code. The stills reel's ffmpeg graph in
> Appendix A was validated on the real embedded renders in `docs/spread-{3,5,7}.png` (2752×1536)
> with ffmpeg 7.0: exactly 10.000 s, 1920×1080, 30 fps, H.264 yuv420p `+faststart`, encoded in
> 40 s on a 4-vCPU sandbox. Google's Veo documentation hosts were unreachable from the planning
> sandbox; every Veo number below comes from the Google AI forum and third-party summaries
> current to 2026-09 and is marked **verify** where it changes a decision.
> **Scope:** `giftmybook-children-worker` (this plan) + `giftmybook-standalone`
> (`docs/GIFT_VIDEO_APP_WIRING.md` — the app-side companion, same branch).
> **Branch:** `claude/childrens-book-video-gen-2zm58y`.
> **Siblings:** `docs/AI_ILLUSTRATION_FEEDBACK_LOOP_PLAN.md` (the Art Bench this plugs into),
> `docs/ILLUSTRATION_CONSISTENCY_REFACTOR_PLAN.md` (the Book Bible this reuses).

**Trigger.** After a children's book has its illustrations — on the main flow once
`/generate-book` completed, or on an Art Bench round once `/v13/render-spreads` returned — an
admin clicks **Generate video** and gets a ~10-second, text-free video built from the identity
kit and the illustrations: a visual summary of the story, a cute after-sale gift we send the
customer. No text anywhere in the frame.

**The one-paragraph diagnosis.** The worker already owns every input a story reel needs and
verifies each one against pinned data: the exact shipped pixels sit at content-hashed render
keys, the identity kit (character sheet + approved cover + outfit spec) is elected per anchor,
and every spread carries a fixed beat, an assigned shot type and a planned emotion. What it does
not own is a single frame of motion: no ffmpeg in the image, no long-running-operation poller,
no video cache, no cost rate for a second of video. And the obvious "animate the child with
Veo" path runs into a policy wall this plan refuses to route around (§2.1). So the product is a
**deterministic stills reel** — Ken Burns motion over the book's own art, stitched by ffmpeg,
gated for text — built the way the illustrator builds everything (pinned inputs, content-hashed
cache, advisories never silent), with generative "living" segments as an opt-in layer that
always degrades to the stills segment it replaces.

---

## 1. Goal

1. **One click, one artifact.** `POST /v13/generate-video` takes the exact render keys the app
   already holds from the completion / probe callbacks and returns, by callback, one MP4
   (`video.mp4`, 10.000 s, 1920×1080, 30 fps, H.264 + AAC) plus a poster frame and a manifest.
2. **A summary of the story, not a slideshow of it.** Four segments: the approved cover (meet the
   hero), the opening spread, the emotional peak, the resolution — selected deterministically
   from the beat structure the catalog already fixes (§4.1), each with an assigned camera move
   derived from the spread's shot plan (§4.2), crossfaded, fading in from and out to white.
3. **No text. Ever.** Not in the pixels (embedded renders are re-rendered text-free through the
   production path), not by ffmpeg (no `drawtext`, no end card, no logo), and verified by a
   vision gate on every source still before a frame is encoded (§4.4).
4. **Same identity guarantees as the book.** Stills mode cannot drift by construction — every
   frame is a crop of art the Book Bible already verified. Living mode (§6) verifies every
   generative clip against the same character sheet with the same blocking vocabulary and falls
   back to the still it was animating.
5. **Both admin surfaces.** The main-flow book page and the Art Bench round card get the same
   button, the same worker call, the same callback shape; a bench round's video is built from
   that round's renders and anchor, so the bench can judge motion under a tuning version too.

## 2. The four honest constraints (read before the design)

### 2.1 Every major video model restricts animating children — and the worker runs in the EU

Google Veo's `personGeneration` parameter takes `dont_allow`, `allow_adult` (the image-to-video
default — the model "won't generate youth or children people or faces") and `allow_all`, which
is **allowlist-only**: developers file per-project requests on the Google AI forum for exactly
our use case ("Veo 3.1 person generation (image-to-video, minors)"). In **EU, UK, CH and MENA
locations the only allowed value for Veo 3 / 3.1 is `allow_adult`** — and the worker is deployed
to `europe-west1` (`cloudbuild.yaml`, `.github/workflows/deploy.yml`). Our identity anchor is an
illustrated child; Veo's responsible-AI filter classifies depictions of minors, illustrated or
not, so an image-to-video call on a spread is filtered (`raiMediaFilteredCount` /
`raiMediaFilteredReasons` in the operation response), not animated. Routing the call through
another region to dodge the policy is NOT an option this plan considers.

Consequence: **the deterministic stills reel is the product** (§4). Generative animation of the
child is a gated Phase 3 that ships only after Google grants the allowlist for this project
(§6.2), and every generative clip has a stills fallback so a video is always producible. One
generative segment needs no allowlist at all: the theme's **world plate** is an environment-only
image with no people by construction (`illustrator/worldPlate.js`), so "the world wakes up" can
be animated under `personGeneration: dont_allow` (§6.1).

### 2.2 "No text" is a hard requirement, and `embedded` books have text painted INTO the pixels

Since `ce-2` the embedded layout paints the story text into the art (Gemini `embedText` + OCR
verification); `half` and `caption` art is text-free by contract (painted text is a blocking QA
defect there — `illustrator/index.js` L171, L247-248), and the approved cover's key art never
carries the title (D5). The planning spike on the real embedded renders in `docs/spread-3.png`,
`spread-5.png`, `spread-7.png` showed that cropping away the ce-3 "35% text side" still leaks
lines — the painted block routinely spans 40–45% of the width. So embedded books get their reel
stills **re-rendered text-free through the exact production `renderStorySpreads` path** under
`textLayout: 'half'` — the `wide-plain` cache key (`illustrator/index.js` L894-895), so a later
layout flip to `half` replays them for free — and EVERY reel still passes a vision "no legible
text" gate before it is encoded. The ffmpeg graph itself never draws text.

### 2.3 Cost and time

A stills reel is CPU only: a 10 s 1080p30 encode of four Ken Burns segments took 40 s on a
4-vCPU sandbox; the Cloud Run instance is 4 vCPU / 16 Gi with no throttling and concurrency 1,
so ffmpeg owns the machine. A generative clip costs about $0.15/s (Veo 3.1 Fast) to $0.40/s
(Veo 3.1) — an 8 s clip is $1.20–$3.20 (third-party pricing summaries, 2026-09 — **verify**
against the official pricing page before budgeting). Veo clips are 4 / 6 / 8 s (8 s is mandatory
for 1080p, reference images and extension), extension adds 7 s per hop at 720p only, and
generated videos stay on Google's servers for **2 days** — the worker must copy every clip into
GCS as soon as the operation completes.

### 2.4 The render cache is the source of truth for "the illustrations"

The customer's book is whatever sat at the canonical render keys (`spread-N.<aspect>.png`,
`renderCachePath`, `illustrator/index.js` L94-97) when the PDFs were assembled; a probe round's
renders sit at identity-salted keys (`-i…`, `-s…`, nonce — L940-973). The reel must be built
from the EXACT storage keys the app already holds — `storyContent.entries[].spreadIllustrationStorageKey`
(`pipeline.js` L360-393) for a book, `renders[].storageKey` (`server.js` L674-690) for a round —
never from "the current render for that spread", which a later re-dispatch may have replaced.
The app sends the keys; the worker verifies each exists, hashes its bytes (`renderContentHash`,
L64-66), and folds every hash into the video key, so a changed source can never replay an old
video.

## 3. What exists today (grounding)

### Worker

- **No video code of any kind.** `grep -rE 'veo|predictLongRunning|ffmpeg|zoompan'` across the
  services is empty; `Dockerfile` installs `libvips-dev fonts-liberation imagemagick` only;
  `services/retry.js` retries a thunk but has no poll-until helper. Everything in §5 is new.
- **The 202 + callback chassis** (`server.js` L564-743, `/v13/render-spreads`): validate
  everything synchronously, `res.status(202)`, a bare async IIFE does the work, `postWithRetry`
  (L1071-1092: 3 attempts, 15 s each, non-2xx is a failed attempt) delivers ONE stable-shaped
  payload — every success key present on failure too (L723-739).
- **The watchdog hazard.** `activeBooks` + `createBookContext` (L131, L164-193) feed a 30 s
  watchdog (L210-225) that aborts a book idle 20 min AND `process.exit(0)`s the instance when no
  book is registered and nothing touched `global.__lastGlobalActivity` for 10 min. Only
  `/generate-book`, coloring, and `/finalize-book` register a context; the v13 probe handlers do
  not. A video job that polls Veo for minutes on an otherwise idle instance is exactly the job
  that gets killed. §5.2 registers a context.
- **Rendering a subset text-free already exists:** `renderStorySpreads({... textLayout: 'half',
  spreads: [...], identityKeyed, seed, probeNonce, tuning, forceRerender})`
  (`illustrator/index.js` L879-1109) renders any subset through the full bible + candidates +
  QA path onto `wide-plain` keys and returns `{results:[{spread, buffer, storageKey, url,
  advisories, fresh}], storyHash, bookBible, ...}`. This IS the embedded re-render (§4.3).
- **Pinned per-spread inputs for motion:** the shot plan `{shotType, staging, placement,
  textSide}` per spread (`shotPlan.js` L117-169, seeded by the raw story fingerprint), the
  emotion plan `{emotion, intensity ∈ soft|clear|big}` per spread (`emotionPlan.js`, GCS-elected
  per story via `bible/index.js` L83-108), the beat text (`catalog.json` — twelve `{spread,
  beat}` pairs, no role vocabulary), the refrain spreads, the theme's world card
  (`worldCards.js` `renderWorldCardBlock`), and `inertPropValue` (`scenes.js`) for sanitizing any
  profile string that reaches a prompt.
- **The identity kit:** `children-jobs/{bookId}/bible.json` (`bible/index.js` L211-235) names
  the elected character sheet key (`catalog-assets/character-sheets/{STYLE_VERSION}/{anchorHash}.png`,
  `characterSheet.js` L124-136), the outfit spec, prop/companion sheets and the world plate
  (`catalog-assets/world-plates/{STYLE_VERSION}/{themeId}-{promptHash}.png`, `worldPlate.js`
  L103). `summarizeBible` (L326-343) is the callback shape the app already stores.
- **Strict-JSON vision calls** follow one template (`spreadQa.js` L158-180): key pool
  `getNextApiKey`, `fetchWithTimeout`, `jsonQaGenerationConfig` (thinking off, ≥2048 output
  tokens), fail-open on HTTP errors with a named `qaUnavailable`. The text gate (§4.4) is one
  more instance of it.
- **Gemini transport is raw REST**, never the SDK (`illustrationGenerator.js` L1032, L1141);
  `GEMINI_IMAGE_SAFETY_SETTINGS` rides every image call (`shared/illustration/config.js`
  L21-26). A Veo client keeps the same transport (§6.3) — `predictLongRunning` + operation
  polling is plain REST and the key pool stays in charge.
- **Storage:** `uploadBuffer` (30-day signed URL), `uploadBufferIfAbsent` (`ifGenerationMatch:
  0` election, `gcsStorage.js` L39-50), `downloadBuffer` (path / `gs://` / signed URL),
  `saveJson` / `loadJson`; no `exists()` — existence is `downloadBuffer(...).catch(() => null)`.
- **Costs:** `CostTracker.addTextUsage` / `addImageGeneration` with a `RATES` table
  (`costTracker.js` L5-31); an unknown model bills the default and warns once (L33-42). There is
  no per-second rate — §8 adds one.
- **Flags:** zero-arg functions over `envOff` / `envOn` / `envInt` (`flags.js` L97-111);
  everything ON by default, envs are kill-switches, opt-ins use `=1`. Any new env must also be
  added to `deploy.yml`'s `--update-env-vars` line (Cloud Run replaces the set).

### App — where the button lives and what it already knows

- **A book** stores the shipped keys in `storyContent.entries[].spreadIllustrationStorageKey`,
  the approved cover in `coverImageUrl` (the worker's `approvedCoverUrl`), the identity kit in
  `storyContent.bookBible`, and `textLayout`. The completion callback (`server/routes/children.js`
  L651-835) already has a post-response side-effect block (L808-828: coloring book, audiobook
  entitlements, production judge) — the auto-generate hook of the future, deliberately NOT used
  by this plan (open decision 9).
- **A bench round** (`IllustrationTuningIteration`, `schema.prisma` L1890-1910) stores
  `renders:[{spread, url, storageKey, qa}]` and `params:{storyPair, anchorUrl, anchorKind,
  textLayout, spreads, probeNonce, ...}` — everything a video call needs — and the round card's
  header action row (`client/src/pages/AdminIllustrationTuning.jsx` L400-410, Re-judge / Golden)
  is where the button goes.
- **Dispatch discipline** is settled: reserve the row with a `dispatchId` BEFORE the worker
  call, delete the reservation on dispatch failure, the callback rejects `stale_dispatch` /
  `duplicate` (`children.js` L857-865; `illustrationTuningWorkbench.js` L364-412).
- **Delivery primitives exist:** Resend email with v2 blocks (`server/email/templates/v2/`), the
  opaque-token → 302-to-short-lived-signed-URL redeem route (`server/routes/ebookDeliveries.js`
  L131-250), and the app's own GCS signer (`server/services/storage.js` `ensureAccessibleUrl`,
  `getShortLivedSignedUrl`). Phase 4 composes them; nothing new is invented.

## 4. Core design — the stills reel

### 4.1 The video plan: which stills, deterministically (`video/plan.js`)

`buildVideoPlan({available, coverKind, emotionPlan, shotPlan, textLayout, ageBand})` is a pure
function: same inputs, same plan, forever. `available` is the set of spreads the caller sent
keys for (all twelve for a book; a subset for a round).

- **Segment 0 — meet the hero:** the approved cover, present only when the anchor is a cover
  (`coverKind: 'cover'`). A raw child photo is NEVER a segment — a bench round anchored on a
  photo simply has no cover segment. A cover that fails the text gate (§4.4) is dropped with an
  advisory (`cover_text_visible`), never failed.
- **Opening:** the lowest available spread in 1..4 (spread 1 is a wide bookend by shot-plan
  invariant — the establishing shot for free).
- **Peak:** the available spread in 5..10 with the highest planned emotion intensity
  (`big` > `clear` > `soft`); ties break by the fixed preference order `[8, 9, 7, 10, 6, 5]`
  (the emotion plan's own `climaxFloor` sits at the same place — `emotionPlan.js` L240). Without
  an emotion plan (`CATALOG_EMOTION_PLAN=0`) the preference order alone decides.
- **Resolution:** the highest available spread in 11..12 (12 is the other wide bookend).
- **Subsets:** distinct spreads only; with fewer than three story spreads the plan compresses
  (`[cover?, min, max]`, then `[cover?, only]`); with none → `video_no_sources` before the 202.

Durations come from a fixed table keyed by segment count so the total is exactly **10.000 s**
after the 0.4 s crossfades:

| segments | seconds per segment | sum − overlaps |
|---|---|---|
| 4 | 2.4 · 3.0 · 3.0 · 2.8 | 11.2 − 1.2 = 10.0 |
| 3 | 2.6 · 4.2 · 4.0 | 10.8 − 0.8 = 10.0 |
| 2 | 4.2 · 6.2 | 10.4 − 0.4 = 10.0 |
| 1 | 10.0 | 10.0 |

Fade-in from white 0.5 s at 0.0, fade-out to white 0.5 s at 9.5. A 9:16 variant (Phase 4) uses
the same plan with the frame swapped; the plan never knows the frame size.

### 4.2 Motion from the shot plan, never from taste (`video/plan.js`)

Each segment gets ONE camera move from a closed vocabulary — `push-in`, `pull-out`, `pan-left`,
`pan-right`, `rise` — chosen by the spread's assigned shot type and placement (pinned data,
`shotPlan.js`): `wide` → push-in; `close-up` → pull-out; `medium` → pan toward the child's
placement third (`left-third` → pan-left, `right-third` → pan-right; `half` layout, where the
child owns the right half → pan-right); `overhead` → rise; `low-angle` → push-in; the cover →
push-in. No two adjacent segments repeat a move (the later one flips through a fixed alternate
table: push-in↔pull-out, pan-left↔pan-right, rise→push-in). Zoom span is 10% with an
ease-in-out curve; pans travel the full slack of a 6% zoom. `CATALOG_SHOT_PLAN=0` (no plan) →
every spread is treated as `wide`, and the plan records `shotPlan: 'none'` in the manifest.

### 4.3 Source stills (`video/stills.js`)

For every planned segment the worker resolves ONE PNG buffer and its content hash:

1. **Validate the key** before the 202: `^children-jobs/{bookId}/ce-renders/[^/]+/[^/]+/spread-(\d{1,2})\.(square|wide|wide-plain)\.png$`
   — canonical keys only (candidate keys `.cK` / `.rPcK` are rejected; promote one with
   `/v13/pick-candidate` first), the `bookId` segment must equal the request's, the spread in
   the key must equal `renders[].spread`. Anything else is a 400, never a callback.
2. **Fetch** via `downloadBuffer`; a missing object fails the run `video_source_missing`
   naming the spread (the app's keys are stale — say so, never substitute the current render).
3. **Aspect by key suffix:** `wide-plain` → 16:9, used as is; `square` → 1:1, letterboxed by
   the blur-fill (Appendix A: a blurred, darkened, scaled copy of the still fills the frame
   behind it — the standard portrait-in-landscape treatment); `wide` → the embedded render,
   **never used**: the selected spreads are re-rendered text-free through
   `renderStorySpreads({... textLayout: 'half', spreads: <the plan's spreads>})` with the exact
   identity inputs the app passes for a spread re-render (`approvedCoverUrl`, `childPhotoUrls`,
   `characterDescription`, `illustrationTuning`, `identityKeyed`, `seed`, `probeNonce`), so the
   new stills land at the `wide-plain` keys beside the book's (or round's) own renders under the
   same `storyHash` and bible fold. A book with embedded keys and no anchor fails
   `missing_identity_reference` BEFORE the 202 (decidable from the key suffix). A re-render that
   ends `consistency_unresolved` fails the video with the same code and payload — the video
   inherits the book's ship policy, it does not relax it.
4. **The cover:** `downloadBuffer(approvedCoverUrl)` (signed URL / `gs://` both work); portrait
   art goes through the same blur-fill.

The manifest records, per segment, `{kind, spread, storageKey, renderHash, aspect, rerendered}`.

### 4.4 The text gate — "no text" is verified, not assumed

Every source still (cover included) gets ONE strict-JSON vision call on the QA model
(`CATALOG_QA_VISION_MODEL`, default `gemini-2.5-flash`, the `spreadQa.js` L158-180 template):
"Transcribe every legible letter, word or digit painted anywhere in this illustration" →
`{text_present: boolean, transcript: string}`. Verdicts:

- `text_present` on a `square` / `wide-plain` still → **blocking** `video_text_visible`
  naming the spread and the transcript. Such a still is already a QA escape (painted text is a
  blocking defect in those layouts); the video never ships it and the callback tells the admin
  which spread to re-render.
- `text_present` on the cover → drop the cover segment, advisory `cover_text_visible`, the
  plan re-computes its duration table (a cover with a painted title is a legitimate design;
  the video just does not open on it).
- Checker outage (`qaUnavailable`) → advisory `text_gate_unavailable`, the run proceeds — every
  source is text-free by contract already; the gate is belt and braces, and a vision outage
  must not block a gift. The manifest records the gate verdict per segment either way.

### 4.5 Encode (`video/ffmpeg.js`)

`buildVideoCommand(plan, {width, height, fps, music})` is a **pure function** from the plan to
an ffmpeg argv (Appendix A is the validated graph); tests snapshot it. The runner `execFile`s
`FFMPEG_PATH || 'ffmpeg'` in a per-run temp directory (`/tmp/gift-video/{bookId}/{videoHash}/`,
removed in `finally`), with a 10-minute timeout, and produces `video.mp4` + `poster.jpg` (the
frame at 1.2 s). Per segment: pre-upscale ×2 so `zoompan` never jitters, blur-fill composite,
the assigned move, `fps=30`, `format=yuv420p`; then an `xfade=fade` chain with the table's
offsets; then white fades; `libx264 -preset medium -crf 20 -profile:v high -pix_fmt yuv420p
-movflags +faststart -t 10.000`. Audio is an `anullsrc` silent AAC track by default (players
and WhatsApp handle silent tracks better than no track); a licensed music bed is open decision 1
(`CATALOG_VIDEO_MUSIC=<name>` selects a file under `data/video/music/`, `afade` in/out,
`-shortest`). The graph contains no `drawtext`; a unit test asserts the argv never does.

Encode wall clock ≈ 40–60 s at 1080p on the instance; the run emits the illustrator's 30 s
progress heartbeat pattern (`illustrator/index.js` L1011) throughout.

### 4.6 Storage, the video key, and replay

```
children-jobs/{bookId}/gift-video/{VIDEO_VERSION}/{videoHash}/video.mp4
children-jobs/{bookId}/gift-video/{VIDEO_VERSION}/{videoHash}/poster.jpg
children-jobs/{bookId}/gift-video/{VIDEO_VERSION}/{videoHash}/video.json      ← manifest
children-jobs/{bookId}/gift-video/{VIDEO_VERSION}/clips/{clipHash}.mp4         ← §6 generative clips
catalog-assets/world-clips/{VIDEO_VERSION}/{themeId}-{plateHash}.mp4           ← §6.1, elected per theme
```

`videoHash = fnv1a(VIDEO_VERSION | mode | aspect | music | segments[kind, spread, storageKey,
renderHash, seconds, motion]).toString(36)` — the same content-hash discipline as the render
cache: a changed source still, a changed plan, a bumped version or a different mode can never
replay an earlier video. A request whose manifest AND `video.mp4` already exist returns by
callback immediately with `cached: true` and no ffmpeg run; `forceNew` skips the replay (in
stills mode the output is bit-for-bit deterministic anyway; in living mode it re-rolls clips and
bypasses the clip cache). `VIDEO_VERSION` (`versions.js`, `gv-1`) is the deploy-owned
invalidator — a graph change, a duration-table change or a plan-rule change bumps it with the
usual "gv-(N-1) videos must never replay as gv-N" comment. `STYLE_VERSION` is never touched by
this feature.

The manifest is the audit record: inputs (every key + hash), the plan, gate verdicts, ffmpeg
version + argv hash, clip ids and model per generative segment, costs, advisories, `createdAt`.

## 5. Worker changes (one-time deploy)

### 5.1 New module — `services/catalogEngine/video/`

| file | owns |
|---|---|
| `plan.js` | `buildVideoPlan`, the duration table, the motion table, `MOTIONS` / `SEGMENT_KINDS` enums |
| `stills.js` | key validation regex, source resolution, the embedded re-render call, the text gate |
| `ffmpeg.js` | `buildVideoCommand` (pure), `runFfmpeg`, `extractPoster`, `probeOutput` |
| `veo.js` | (§6) `generateClip`: `predictLongRunning` + poll + download → GCS, `buildClipPrompt` |
| `index.js` | `generateGiftVideo(params)` — resolve → gate → (animate) → encode → upload → manifest |

`generateGiftVideo({bookId, story, bookDef, profile, renders, approvedCoverUrl, childPhotoUrl,
characterDescription, textLayout, tuning, identityKeyed, seed, probeNonce, mode, aspect, music,
forceNew, costTracker, onProgress, log})` → `{video:{storageKey, posterKey, url, posterUrl,
hash, durationSeconds, width, height, fps, bytes, mode, music, cached}, plan, textGate,
advisories, warnings}`.

### 5.2 Endpoint — `POST /v13/generate-video` (202 + callback)

Request (the identity fields are exactly `/v13/render-spreads`'s, so the app reuses
`buildWorkerPayload`):

```json
{
  "bookId": "…", "dispatchId": "gv_…", "callbackUrl": "https://…/api/children/video-callback",
  "progressCallbackUrl": "https://…/api/children/progress",
  "renders": [{ "spread": 1, "storageKey": "children-jobs/…/spread-1.wide-plain.png" }, …],
  "story": { "request": {…}, "response": {…} },
  "profile": { "name": "…", "age": 4 },
  "approvedCoverUrl": "https://…", "childPhotoUrls": ["…"], "characterDescription": "…",
  "textLayout": "half", "illustrationTuning": { "versionLabel": "…", "hash": "…", "text": "…" },
  "identityKeyed": true, "seed": 7, "probeNonce": "…",
  "mode": "stills", "aspect": "16:9", "music": "none", "forceNew": false
}
```

Validation, all before the 202, in the `/v13/render-spreads` order (`server.js` L564-640):
`BOOK_ID_RE`; `callbackUrl`; `renders` 1–12 entries, spreads unique ints in 1..12, every key
passing §4.3's regex for THIS `bookId`; `story` pair required → `resolveStory` (pinned
re-validation, `pipeline.js` L43-131) → `getBookForTag` (`missing_book_definition`);
`normalizeProfile`; `validateArtTuningInput`; `mode` ∈ `stills|living` (living additionally
requires `flags.giftVideoLivingEnabled()`, else 400 `living_mode_disabled`); `aspect` ∈
`16:9|9:16`; `music` ∈ `none|<bundled name>`; anchor required (`missing_identity_reference`)
when any key ends `.wide.png` or `mode === 'living'`; `seed` integer. Then
`res.status(202).json({success:true, bookId, dispatchId, engine:'catalog-v13', videoVersion,
mode, accepted:{spreads}})`.

The IIFE registers `createBookContext(bookId, {mapKey: 'video:' + bookId, callbackUrl,
progressCallbackUrl})` so the 10-minute global exit and the per-book idle abort see the job
(§3), touches activity on every heartbeat, and deletes the context in `finally`.

Callback — one stable shape, every key present on failure:

```json
{
  "success": true, "bookId": "…", "dispatchId": "gv_…", "engine": "catalog-v13", "videoVersion": "gv-1",
  "video": { "url": "https://…signed…/video.mp4", "storageKey": "children-jobs/…/video.mp4",
             "posterUrl": "…", "posterKey": "…", "hash": "…", "durationSeconds": 10,
             "width": 1920, "height": 1080, "fps": 30, "bytes": 3928816,
             "mode": "stills", "music": "none", "cached": false },
  "plan": [{ "index": 0, "kind": "cover", "spread": null, "seconds": 2.4, "motion": "push-in",
             "generative": false, "source": { "storageKey": null, "renderHash": "…" } }, …],
  "textGate": [{ "segment": 0, "pass": true }, …],
  "advisories": [{ "stage": "video", "spread": 7, "note": "clip_fallback: identity mismatch vs sheet" }],
  "warnings": [], "costs": { "totalCost": 0.02, "breakdown": {…} },
  "failureCode": null, "error": null
}
```

Failure codes: `video_no_sources`, `video_source_missing`, `video_text_visible`,
`video_encode_failed`, plus the inherited `missing_book_definition`, `missing_identity_reference`,
`invalid_story`, `consistency_unresolved` (with `unresolved[]` + `bookBible`, exactly as
`/v13/render-spreads` ships them). Per-clip generative failures are advisories, never failures.

Progress (`progressCallbackUrl`, `progressReporter.reportProgress`, stage `video`): resolving
sources → text gate → rendering text-free stills (n/m) → animating (n/m) → encoding →
uploading. `costs` is `costTracker.getSummary()` as everywhere else.

### 5.3 Dockerfile, envs, versions

- `Dockerfile`: `apt-get install … ffmpeg` on the existing line (the Debian release behind
  `node:20-slim` ships ffmpeg 5.1 on bookworm or 7.1 on trixie, both with libx264 + AAC, about
  100 MB; the spike pins the version it measured). No `fluent-ffmpeg` — `child_process.execFile` with an argv
  array (never a shell string) is enough and keeps the builder pure.
- `versions.js`: `VIDEO_VERSION = 'gv-1'` with the bump-comment convention.
- `flags.js` (all zero-arg): `giftVideoEnabled()` (`CATALOG_GIFT_VIDEO`, kill-switch — the
  endpoint answers 503 `gift_video_disabled`), `giftVideoLivingEnabled()`
  (`CATALOG_GIFT_VIDEO_LIVING`, **opt-in `=1`**), `giftVideoWorldClipEnabled()`
  (`CATALOG_GIFT_VIDEO_WORLD_CLIP`, opt-in, §6.1), `videoModel()` (`CATALOG_VIDEO_MODEL`,
  default `veo-3.1-fast-generate-preview`), `videoPersonGeneration()`
  (`CATALOG_VIDEO_PERSON_GENERATION`, default `allow_adult`; set `allow_all` only once the
  allowlist is granted), `videoMaxClipSeconds()` (`CATALOG_VIDEO_MAX_CLIP_SECONDS`, default 12,
  clamped 0–24 — the per-video generative spend cap), `videoMusic()` (`CATALOG_VIDEO_MUSIC`,
  default `none`), `FFMPEG_PATH`. Every one of them also goes on `deploy.yml`'s
  `--update-env-vars` line.
- `costTracker.js`: `addVideoSeconds(model, seconds)` with `RATES` entries carrying
  `perSecond` (`veo-3.1-fast-generate-preview: 0.15`, `veo-3.1-generate-preview: 0.40` —
  **verify**), and the text gate billed through `addTextUsage(QA model, 500, 50)` like the OCR
  verify (`illustrationGenerator.js` L412).

## 6. Living mode — generative segments as an opt-in layer (Phase 3)

Living mode never changes the plan, the gate, the encode or the callback shape. It replaces
the zoompan source of a segment with a short clip, and every clip that cannot be produced or
verified is replaced by the stills segment it was meant to animate, with a stage `video`
advisory naming why. A living-mode video is therefore never worse than a stills video.

### 6.1 The world wakes up — policy-safe, per theme, amortized to ~zero (Phase 3a)

The theme's world plate (`worldPlate.js`; environment only, no people by construction) is
animated ONCE per theme and STYLE_VERSION: image-to-video, `personGeneration: dont_allow`,
prompt from the world card only ("gentle ambient motion — leaves sway, light shimmers, water
ripples; no people, no animals added, no text, no captions"), 8 s, elected with
`uploadBufferIfAbsent` at `catalog-assets/world-clips/{VIDEO_VERSION}/{themeId}-{plateHash}.mp4`
so racing instances adopt one clip, fail-open to no world segment. With the switch on the plan
inserts it between the cover and the opening spread (5 segments: 2.2 · 2.4 · 2.4 · 2.4 · 2.2).
Cost: one 8 s clip per theme, ever — 12 clips for the whole catalog.

### 6.2 The child moves — allowlist-gated (Phase 3b)

Each story segment (never the cover) becomes a 4 s image-to-video clip from its verified still,
trimmed to the segment length, `personGeneration: allow_all` (**requires the granted allowlist**
— file it in Phase 0; the switch stays off until then and a filtered response is an advisory,
not a retry). The prompt is built from pinned data only (`buildClipPrompt`): the beat's action,
the planned emotion cue, the assigned move as a camera sentence, then the fixed lock — "the
child's face, hair, skin, outfit, proportions and the illustration style stay exactly as drawn;
every object and character stays in place; subtle natural motion only; no speech, no dialogue,
no narration, no captions, no subtitles, no letters, no words, no logo, no watermark, no new
characters" — with a matching `negativePrompt`. Native audio is discarded at stitch time
(`-an` on clip inputs): the music bed or silence is the only track, so nothing is ever spoken.

**Verification, same vocabulary as the book:** three frames per clip (0 %, 50 %, 100 %) go
through `checkSpreadRenderV2` with the character sheet and the segment's prop sheets attached,
and `classifyDefects` decides: any BLOCKING defect (missing / duplicated child, identity, hair,
skin, any visible outfit slot, painted text, extra limbs, style break) drops the clip →
stills segment + advisory `clip_fallback:{spread, defects}`; ADVISORY defects ship as
advisories. Clips are cached at `clips/{clipHash}.mp4` (`clipHash = fnv1a(model | prompt |
renderHash | seconds | personGeneration)`) with their verdict beside them, so a re-encode never
pays twice. `videoMaxClipSeconds()` caps generative seconds per video (default 12 = three 4 s
clips); the plan marks segments beyond the cap `generative: false` up front.

### 6.3 The Veo client (`video/veo.js`)

Raw REST like every other Gemini call, on the key pool: `POST
https://generativelanguage.googleapis.com/v1beta/models/{model}:predictLongRunning` with
`{instances:[{prompt, image:{bytesBase64Encoded, mimeType}}], parameters:{aspectRatio,
durationSeconds, resolution:'720p', personGeneration, negativePrompt, sampleCount:1}}` →
`{name}`; `GET /v1beta/{name}` every 10 s until `done` (deadline 6 min per clip, three clips
concurrently under `p-limit`), then download the returned video URI with the same key and
`uploadBuffer` it at once (§2.3: two-day server retention). A `raiMediaFilteredCount > 0` or an
empty sample set is a **filtered** result → advisory, no retry, no fallback model. The input
still is JPEG-recompressed at 1920 px wide with `sharp` before upload. Field names above are
from memory of the 3.1 API — **verify against the docs at build time**; the poller and the
fallback contract do not depend on them. Every poll tick touches the book context (§5.2).

## 7. Cross-repo contract (what the app must do — detail in the companion doc)

1. Send the EXACT keys: `storyContent.entries[].spreadIllustrationStorageKey` for a book,
   `renders[].storageKey` for a round — never URLs (signed URLs expire; keys do not).
2. Send the identity inputs it already builds for a spread re-render (`buildWorkerPayload` +
   `identityKeyed` / `seed` / `probeNonce` for a round), so an embedded re-render lands beside
   the round's own renders.
3. Reserve `dispatchId` before the call; the callback matches on it; `stale_dispatch` /
   `duplicate` are ignored (the ce-9 discipline).
4. Store the callback's `video` object under the surface's own JSON (`storyContent.giftVideo`
   for a book, the iteration's `video` column for a round), normalized like `bookBible`, bound
   to `sourceKeys` so the UI can mark a video stale when the book's renders change later.
5. Re-sign `storageKey` at read time (`ensureAccessibleUrl`) — the URL in the callback is a
   30-day signed URL, a convenience, not the record.

## 8. Mechanics, versioning, cost, time

- **Versioning:** `VIDEO_VERSION` (new, `gv-1`) owns the video cache namespace; `STYLE_VERSION`
  and `QA_VERSION` are untouched. A change to the plan rules, the duration table, the motion
  table or the ffmpeg graph bumps `gv-N` ("gv-(N-1) videos must never replay as gv-N"). Mode,
  aspect and music are inside the hash, not the version — switching them is a new video, not
  an invalidation.
- **Cache-key folds:** `mode`, `aspect`, `music`, and each segment's `renderHash` are in
  `videoHash`; `CATALOG_SHOT_PLAN=0` shows up as a different motion assignment and therefore a
  different hash — no separate fold needed. Generative clips hash their own inputs.
- **New env:** `CATALOG_GIFT_VIDEO` (kill), `CATALOG_GIFT_VIDEO_LIVING=1` (opt-in),
  `CATALOG_GIFT_VIDEO_WORLD_CLIP=1` (opt-in), `CATALOG_VIDEO_MODEL`,
  `CATALOG_VIDEO_PERSON_GENERATION`, `CATALOG_VIDEO_MAX_CLIP_SECONDS` (12, 0–24),
  `CATALOG_VIDEO_MUSIC` (`none`), `FFMPEG_PATH`.
- **Cost per video:**

  | item | rate | stills | living 3a | living 3b |
  |---|---|---|---|---|
  | text gate | 4 × `gemini-2.5-flash` vision (≈500 in / 50 out) | ≈ $0.01 | ≈ $0.01 | ≈ $0.01 |
  | embedded re-render (only `embedded` books) | 3 spreads × (2 candidates × $0.02 + QA) (`costTracker.js` L5-31) | ≈ $0.15 | ≈ $0.15 | ≈ $0.15 |
  | encode | ≈ 60 s of the instance's CPU | ≈ $0.01 | ≈ $0.01 | ≈ $0.01 |
  | world clip | 8 s × $0.15, once per theme | — | ≈ $0 amortized | ≈ $0 amortized |
  | child clips | 3 × 4 s × $0.15 (Fast) … $0.40 | — | — | ≈ $1.80 … $4.80 |
  | clip verification | 9 × `gemini-2.5-flash` vision | — | — | ≈ $0.02 |

  Ship stills at ≈ $0.02–0.20 per gift; living 3b at ≈ $2–5 is a pricing decision, not an
  engineering one (open decision 6).
- **Time:** stills ≈ 1.5–2 min end to end (downloads, 4 gate calls, ~60 s encode, upload);
  an embedded book adds one render round (≈ 2–4 min); living adds the Veo operations (≈ 1–3
  min each, three concurrent). Concurrency 1 per instance means a video occupies an instance
  like a probe does; `min-instances=1` already covers post-202 work.
- **Storage:** ≈ 4 MB per video + 150 KB poster + the manifest; clips ≈ 2–3 MB each. No
  lifecycle rule in v1 (a gift should keep working); revisit with Phase 4's share tokens.

## 9. What this plan deliberately does NOT do

- **No text in any form** — no title card, no child's name, no "made with love" outro, no
  logo. The brief says no text; a branded outro is open decision 8, default no.
- **No raw child photo in the video**, ever, and no raw photo sent to a video model — only
  the illustrated cover, the illustrated spreads and the environment-only world plate leave the
  worker.
- **No prompt-only consistency.** Generative clips are verified against the character sheet
  with the book's own blocking vocabulary; a clip the checker could not verify is not shipped
  (the ce-9 "unchecked never replaces known" rule, applied to motion).
- **No region games.** Living 3b waits for the allowlist; the plan does not proxy Veo calls
  through a non-EU region.
- **No auto-generation on completion** (the brief says admin click; the side-effect hook at
  `children.js` L808-828 is the one-liner if that changes — open decision 9).
- **No second vendor.** Sora, Runway, Kling and friends carry their own minor-depiction rules
  and none of them is behind our key pool, judges or safety settings; if Google never grants
  the allowlist, the stills reel is still the product.
- **No new render aspect.** Embedded re-renders reuse the `half` path and its `wide-plain` keys
  (open decision 2) rather than adding a text-free `wide` namespace.

## 10. Order & tests

0. **Spike (½ day, no product change).** Add `ffmpeg` to the Dockerfile, build, run the
   Appendix A graph inside the container on one real book's `wide-plain` renders and one
   `square` book, record encode time; hit `veo-3.1-fast-generate-preview` once from the deployed
   region with an approved cover under `allow_adult` and record the exact filtered response
   shape; **file the `allow_all` (image-to-video, minors) allowlist request for the project**.
   Tests: none; outputs go in `docs/audits/gift-video-spike.md`.
1. **`video/plan.js` + `video/ffmpeg.js` (pure).** Tests
   (`__tests__/services/catalogEngine/video/plan.test.js`, `ffmpeg.test.js`): full-12 picks
   `{1, peak, 12}`; peak follows intensity then the preference order; subsets compress; photo
   anchor → no cover segment; every duration table sums to 10.000 after overlaps; no adjacent
   motion repeats; argv snapshot for a 4-segment plan; xfade offsets; blur-fill branch for
   `square`; `-t 10.000`; the argv never contains `drawtext`.
2. **`video/stills.js`.** Tests (`stills.test.js`, the `artProbe.test.js` mocking pattern —
   `jest.mock` `illustrationGenerator` + `gcsStorage`): key regex rejects traversal, another
   bookId, candidate keys, spread/key mismatch; missing object → `video_source_missing`;
   `.wide.png` keys trigger `renderStorySpreads` with `textLayout: 'half'` and the probe salts
   passed through; text gate blocking → `video_text_visible` with the transcript; cover text →
   dropped segment + advisory; gate outage → advisory and proceed.
3. **`video/index.js` + `POST /v13/generate-video` + Dockerfile + `VIDEO_VERSION` + flags +
   cost rate.** Tests (`server.test.js`, the L398-570 pattern with `global.fetch` captured and
   `settle()`): every validation happens BEFORE the 202 (`fetch` never called on a 400);
   `missing_identity_reference` for embedded keys without an anchor; callback payload shape on
   success, on `video_text_visible`, on encode failure (all keys present); `cached: true` replay
   with no ffmpeg call; a book context is registered and removed. *Deploy the worker once.*
4. **App wiring** — the companion doc's changes 1–6 (routes, callback, bench button, book card).
   *Deploy the app once.*
5. **Living 3a (world clip)** — `video/veo.js` poller + election. Tests (`veo.test.js`):
   mocked `fetch` pending→done; filtered result → `null` + advisory; deadline; download → GCS
   copy; election winner/loser adopt one clip; switch off → no call.
6. **Living 3b (child clips)** — only after the allowlist lands: clip prompt from pinned data,
   frame extraction, `checkSpreadRenderV2` verification, fallback, clip cache, the seconds cap.
   Tests: blocking verdict → stills segment + advisory; unchecked clip never ships; cap marks
   segments `generative: false` before any call.
7. **Delivery (Phase 4)** — companion doc: share token + public page + email + 9:16 + music.
8. **Validation recipe.** One `caption` book, one `half` book, one `embedded` book (the
   re-render path), one bench round with a photo anchor (no cover segment) and one with three
   spreads; assert on each callback: `durationSeconds === 10`, `1920×1080`, `textGate` all
   pass, plan spreads `{1, peak, 12}` for the full books, `rerendered: true` only on the
   embedded book, and the poster is not white. Play every output on an iPhone (WhatsApp) and an
   Android before enabling the button for the team. Canary: ship the worker revision with
   `CATALOG_GIFT_VIDEO=0`, flip it on for admins only.

## 11. Open decisions (defaults chosen — flag if you disagree)

1. **Music?** Default `none` — a silent AAC track — until a licensed instrumental bed is
   committed under `data/video/music/` with its license file; then `CATALOG_VIDEO_MUSIC` picks
   it (a per-theme mood table is a later, data-only step). Never Veo's native audio.
2. **Embedded books: re-render via `half` (child pushed to the right half) or a new text-free
   `wide` namespace?** Default `half` — zero new cache paths, the stills replay on a layout
   flip, and a pan-right move suits the composition. Revisit if admins dislike the right-weighted
   framing.
3. **Open on the cover?** Default yes when the anchor is an approved cover; never on a raw
   photo. Drop with an advisory when the cover fails the text gate.
4. **Exactly 10.000 s?** Yes — the duration table guarantees it; "about ten seconds" would make
   every product screenshot and QA assertion fuzzy.
5. **Resolution?** 1080p30. The encode cost difference is noise and messaging apps recompress
   anyway; 9:16 is a Phase 4 variant of the same plan.
6. **Living mode default?** Off (`CATALOG_GIFT_VIDEO_LIVING` opt-in), and per-video generative
   seconds capped at 12. Turning it on is a pricing call once the allowlist exists.
7. **Who triggers?** Admins only, on both surfaces; customers never generate — they receive.
8. **A branded outro?** Default no: the brief says no text and a logo is text. If wanted, it
   becomes a fifth segment from a bundled text-free image, still gated.
9. **Auto-generate on completion?** Default no (admin click, as asked). The hook is
   `children.js` L808-828 behind a `CHILDREN_GIFT_VIDEO_AUTO=1` flag when the team wants it.
10. **Keep videos forever?** Default yes (no lifecycle rule); a gift link that dies is worse
    than a few MB.

---

## Appendix A — the validated stills graph (ffmpeg 7.0, 4 segments, 10.000 s)

Produced by the pure builder prototype; `W=1920 H=1080 FPS=30 UP=2 XFADE=0.4 FADE=0.5
ZOOM=0.10`, ease `E = 0.5-0.5*cos(PI*on/(N-1))`, `N = seconds*FPS`.

```
ffmpeg -y -hide_banner -loglevel error
  -loop 1 -framerate 30 -t 2.400 -i cover.png
  -loop 1 -framerate 30 -t 3.000 -i spread-1.wide-plain.png
  -loop 1 -framerate 30 -t 3.000 -i spread-8.wide-plain.png
  -loop 1 -framerate 30 -t 2.800 -i spread-12.wide-plain.png
  -f lavfi -i anullsrc=r=48000:cl=stereo
  -filter_complex "
    [0:v]format=rgb24,split=2[a0][b0];
    [a0]scale=3840:2160:force_original_aspect_ratio=increase,crop=3840:2160,gblur=sigma=40,eq=brightness=-0.08[bg0];
    [b0]scale=3840:2160:force_original_aspect_ratio=decrease[fg0];
    [bg0][fg0]overlay=(W-w)/2:(H-h)/2,setsar=1,
      zoompan=z='1+0.10*(0.5-0.5*cos(PI*on/71))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1920x1080:fps=30,format=yuv420p[seg0];
    … seg1 (pan-right: z='1.06', x='(iw-iw/zoom)*E'), seg2 (rise: y='(ih-ih/zoom)*(1-E)'), seg3 (pull-out: z='1.10-0.10*E') …
    [seg0][seg1]xfade=transition=fade:duration=0.4:offset=2.000[x1];
    [x1][seg2]xfade=transition=fade:duration=0.4:offset=4.600[x2];
    [x2][seg3]xfade=transition=fade:duration=0.4:offset=7.200[x3];
    [x3]fade=t=in:st=0:d=0.5:color=white,fade=t=out:st=9.500:d=0.5:color=white,format=yuv420p[v]"
  -map "[v]" -map 4:a
  -c:v libx264 -preset medium -crf 20 -profile:v high -pix_fmt yuv420p -r 30
  -c:a aac -b:a 128k -movflags +faststart -t 10.000 video.mp4
```

Measured output: `Duration: 00:00:10.00`, `h264 (High) yuv420p 1920x1080 [SAR 1:1 DAR 16:9]
30 fps`, `aac 48000 Hz stereo`, 3.9 MB, 40 s encode on 4 vCPU. The blur-fill branch was
exercised with a 1376×768 portrait-ish source and the crop branch with a right-side text crop
— the latter is what proved §2.2 (text survived the crop), so the shipped builder has no crop
branch at all.

## Appendix B — evidence index

- Veo `personGeneration` values, the image-to-video default, the EU/UK/CH/MENA `allow_adult`
  restriction and the allowlist-only `allow_all`: Google AI forum threads "Request allowlist
  access for Veo 3.1 person generation (image-to-video, minors)" and the Gemini API Veo
  reference (unreachable from the sandbox; **verify**).
- Veo 3.1 clip lengths (4/6/8 s; 8 s mandatory for 1080p / reference images / extension),
  extension (+7 s per hop, 720p, up to 148 s), 2-day server retention, native audio, LRO
  polling: Google's Veo 3.1 launch notes and the Gemini API video reference as summarized by
  third parties, 2026-09.
- Pricing (≈ $0.15/s Fast, ≈ $0.40/s standard at 720p/1080p, higher at 4K): third-party
  pricing summaries, 2026-09 — **verify** on the official pricing page.
- Worker facts: `server.js` L131-225 (contexts + watchdog), L564-743 (`/v13/render-spreads`),
  L1071-1092 (`postWithRetry`); `illustrator/index.js` L64-66, L94-97, L171, L247-248,
  L325-377, L879-1109, L940-973, L1011; `pipeline.js` L43-131, L360-393; `bible/index.js`
  L83-108, L211-235, L326-343; `characterSheet.js` L124-136; `worldPlate.js` L103;
  `shotPlan.js` L117-169; `emotionPlan.js` L240; `spreadQa.js` L158-180; `gcsStorage.js`
  L39-50; `costTracker.js` L5-42; `flags.js` L97-111; `Dockerfile`; `cloudbuild.yaml`.
- App facts: see `giftmybook-standalone/docs/GIFT_VIDEO_APP_WIRING.md`.
