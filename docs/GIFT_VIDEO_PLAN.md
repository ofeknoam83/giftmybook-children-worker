# Gift Video — the 10-second animated story film (plan, gv-1)

> **Status:** plan only — nothing on this branch ships code. **Revision 3 (2026-09-02):**
> Replicate is the default host for Kling 3.0 — the existing `REPLICATE_API_TOKEN`, no new
> credential (owner decision). **Revision 2 (2026-09-02):** the
> product is a FULLY ANIMATED film — every frame is generated motion; there is no stills / Ken
> Burns mode and no silent degrade to one. Revision 1's stills reel was rejected by the owner.
> Google's documentation hosts and every video vendor's docs were unreachable from the planning
> sandbox; vendor facts below come from the vendors' hosted-API pages as summarized by search
> results and from the Google AI forum, current to 2026-09, and are marked **verify** where they
> change a decision. Phase 0 is the bake-off that turns them into measured facts.
> **Scope:** `giftmybook-children-worker` (this plan) + `giftmybook-standalone`
> (`docs/GIFT_VIDEO_APP_WIRING.md` — the app-side companion, same branch).
> **Branch:** `claude/childrens-book-video-gen-2zm58y`.
> **Siblings:** `docs/AI_ILLUSTRATION_FEEDBACK_LOOP_PLAN.md` (the Art Bench this plugs into),
> `docs/ILLUSTRATION_CONSISTENCY_REFACTOR_PLAN.md` (the Book Bible this reuses — the film is the
> ce-9 selection gate applied to motion).

**Trigger.** After a children's book has its illustrations — on the main flow once
`/generate-book` completed, or on an Art Bench round once `/v13/render-spreads` returned — an
admin clicks **Generate video** and gets a ~10-second, text-free, fully animated film built from
the identity kit and the illustrations: the child's own book coming alive, a visual summary of
the story, a cute after-sale gift we send the customer. No text anywhere in the frame.

**The one-paragraph diagnosis.** The worker already owns every input an animated film needs and
verifies each one against pinned data: the exact shipped pixels at content-hashed render keys,
the identity kit (character sheet + approved cover + outfit spec + prop and companion sheets)
elected per anchor, and per spread a fixed beat, an assigned shot type and a planned emotion.
What it does not own is motion: no video-model client, no long-running-job poller, no ffmpeg, no
clip cache, no cost rate for a second of video, and no verifier that reads a clip. The design is
therefore the ce-9 pattern applied to motion — **pinned inputs in, N candidates out, verified
against the character sheet, best one selected, bounded repair, fail closed** — on top of a
provider layer, because the choice of video model is governed by one fact: the subject is a
child, and vendors differ sharply in whether they will animate one (§2.1).

---

## 1. Goal

1. **One click, one animated film.** `POST /v13/generate-video` takes the exact render keys the
   app already holds and returns, by callback, one MP4 (`video.mp4`, 10.000 s, 1920×1080,
   30 fps, H.264 + AAC), a poster frame and a manifest. Every segment is a generated clip —
   the child moves, looks, laughs, walks; the companion moves; the world breathes.
2. **A summary of the story.** Four segments: the approved cover coming alive (meet the hero),
   the opening spread, the emotional peak, the resolution — selected deterministically from the
   beat structure the catalog fixes (§4.1). Each clip STARTS on the book's own illustration (the
   image-to-video start frame), so parents recognize the pages, and the model animates exactly
   the beat's action under a camera move assigned from the shot plan (§4.2).
3. **The identity kit does the work.** The character sheet's front / three-quarter / back views
   are the model's character reference on every clip (Kling "Elements", Veo reference images),
   the companion and carried-prop sheets ride the clips whose beats need them, and every
   candidate clip is verified frame-by-frame against the SAME sheet with the book's own blocking
   vocabulary (§4.5). Consistency comes from references and verification, never from
   "keep it consistent" prompt lines.
4. **No text, no speech.** Not in the start frames (embedded renders are re-rendered text-free
   through the production path), not in the clips (verified by transcription on sampled frames
   and by a video-level judge), not by ffmpeg (no `drawtext`, no end card, no logo). Native
   model audio is never generated (`audio: off`), so nothing is ever spoken.
5. **Fail closed, never degrade silently.** A segment whose candidates all fail verification
   after the bounded repair budget fails the film `video_unresolved` with the scored candidates
   attached — the `consistency_unresolved` shape — and the admin can promote a candidate with
   `/v13/pick-clip`. There is no Ken Burns fallback.
6. **Both admin surfaces**, same worker call, same callback shape (a bench round's film is built
   from that round's renders and anchor).

## 2. The four honest constraints (read before the design)

### 2.1 Which model will animate a child — the provider question

The subject of every clip is an illustrated child. Vendors differ on exactly this, and the
difference decides the default provider:

| model | animates an illustrated child? | identity references | clip length | notes |
|---|---|---|---|---|
| **Kling 3.0** (Kuaishou; on Replicate as `kwaivgi/kling-v3-video` — the account we already hold — and on fal.ai / Segmind; official API too) | No published restriction on non-sexual depictions of minors; general moderation only — **verify empirically in Phase 0** | **Elements**: up to 3 elements, up to 3 reference images each, referenced in the prompt (`@Element1`); image-to-video only on 3.0 | 3–15 s, start frame + optional end frame, multi-shot up to 5 segments in one clip | `negative_prompt`, `cfg_scale`, 720p/1080p, native audio optional (off is cheaper) |
| **Runway Gen-4 Turbo** (official API) | Semantic moderation; child-safety policy targets sexualization / romantic context; no allowlisting possible — **verify** | none (single start image) | 5 or 10 s, 720p 24 fps | $0.05/s; cheapest credible option, weakest identity control |
| **Google Veo 3.1 / 3.1 Fast** (Gemini API / Vertex AI) | Only with `personGeneration: allow_all`, which is **allowlist-only** (per-project requests on the Google AI forum name Vertex AI + `us-central1`); the Gemini API in EU/UK/CH/MENA locations allows `allow_adult` only, and the worker runs in `europe-west1` | up to 3 reference images (`referenceType: asset`), first + last frame | 4 / 6 / 8 s (8 s with references), extension +7 s at 720p | ≈ $0.15/s Fast … $0.40/s; **the allowlist request is filed in Phase 0 regardless** |
| OpenAI Sora 2 API | **No** — input reference images containing a human face (real or drawn) are rejected outright | — | — | excluded |
| MiniMax Hailuo 2.3, Wan 2.x, Seedance | hosted on the same aggregators; comparable moderation posture to Kling — bake-off candidates only if Kling fails Phase 0 | subject reference (Hailuo) | 5–10 s | ≈ $0.05–0.10/s |

Decision: **Kling 3.0 is the default provider** — it is the only one that takes the identity
kit as an explicit reference (Elements = the character sheet's three views, the companion sheet,
the carried-prop sheet), it supports the exact clip lengths the plan needs (3 s) and an end
frame, and it carries no minors allowlist. It is reached through **Replicate with the
existing `REPLICATE_API_TOKEN`** — no new credential; the token only needs promoting to a
worker env var (§5.3). fal.ai is the alternative host, at about half the per-second price
(§8), if Replicate's Kling 3.0 endpoint turns out not to expose Elements (open decision 1).
**Veo is the second provider**, enabled per project
once Google grants `allow_all` on Vertex AI (a `us-central1` Vertex endpoint is the region the
allowlist requests cite; using it is a Vertex deployment choice the business confirms against
its Google Cloud terms — the plan does not proxy anything through a region to dodge a policy).
**Runway is the bake-off control** (cheap, no references). The provider layer (§5.1) makes the
choice a config value, and the verifier (§4.5) is provider-agnostic, so a vendor policy change
or outage swaps the model without touching the pipeline.

### 2.2 "No text" is a hard requirement, and `embedded` books have text painted INTO the pixels

Since `ce-2` the embedded layout paints the story text into the art; `half` and `caption` art
is text-free by contract (painted text is a blocking QA defect there — `illustrator/index.js`
L171, L247-248) and the approved cover's key art never carries the title (D5). A spike on the
real embedded renders in `docs/spread-{3,5,7}.png` showed that cropping away the ce-3 "35% text
side" still leaks lines. So an embedded book's start frames are **re-rendered text-free through
the exact production `renderStorySpreads` path** under `textLayout: 'half'` (the `wide-plain`
cache key, `illustrator/index.js` L894-895 — a later layout flip replays them for free), every
start frame passes a vision text gate, and every candidate clip is checked for text that the
model painted in (models love signage). The ffmpeg graph never draws text.

### 2.3 Cost and time are dominated by the clips, and the clips are non-deterministic

Four segments × N candidates × 3 s ≈ 24 generated seconds per film at N = 2 — about $4 on
Replicate's Kling 3.0 endpoint (`kwaivgi/kling-v3-video`, ≈ $0.168/s audio-off — **verify**;
fal.ai lists Kling 3.0 Standard at ≈ $0.084/s, so the existing-account choice costs roughly
twice per film), $1.20 at Runway Turbo, $3.60 at Veo Fast — plus repairs (§4.5) and ≈ $0.15
of verification. Identity drifts over a clip's duration (the model
interpolates away from the start frame), so clips are SHORT (3 s), motion is explicitly
"subtle", references are attached, and verification samples the worst frame, not the first.
Wall clock is 2–5 minutes per clip at the vendor; with eight clips in flight a film takes
5–8 minutes — longer than the worker's 10-minute global idle exit, which the endpoint must
register against (§5.2).

### 2.4 The render cache is the source of truth for "the illustrations"

The customer's book is whatever sat at the canonical render keys (`renderCachePath`,
`illustrator/index.js` L94-97) when the PDFs were assembled; a probe round's renders sit at
identity-salted keys (L940-973). The film's start frames come from the EXACT storage keys the
app already holds — `storyContent.entries[].spreadIllustrationStorageKey` (`pipeline.js`
L360-393) for a book, `renders[].storageKey` (`server.js` L674-690) for a round — never from
"the current render for that spread". The worker verifies each exists, hashes its bytes
(`renderContentHash`, L64-66) and folds every hash into the clip and film keys.

## 3. What exists today (grounding)

### Worker

- **No video code of any kind** — no vendor client, no poller, no ffmpeg (`Dockerfile`
  installs `libvips-dev fonts-liberation imagemagick` only), no clip cache. `services/retry.js`
  retries a thunk; nothing polls. Everything in §5 is new.
- **The 202 + callback chassis** (`server.js` L564-743, `/v13/render-spreads`): validate
  everything synchronously, `res.status(202)`, a bare async IIFE, `postWithRetry` (L1071-1092)
  delivering ONE stable-shaped payload with every key present on failure (L723-739).
- **The watchdog hazard.** `activeBooks` + `createBookContext` (L131, L164-193) feed a 30 s
  watchdog (L210-225) that aborts a book idle 20 min AND `process.exit(0)`s the instance when no
  book is registered and nothing touched `global.__lastGlobalActivity` for 10 min. The v13
  probe handlers never register a context. A film job polling vendors for 5–8 minutes on an
  otherwise idle instance is exactly the job that gets killed. §5.2 registers one.
- **Text-free start frames for embedded books already exist as a path:**
  `renderStorySpreads({... textLayout: 'half', spreads, identityKeyed, seed, probeNonce, tuning})`
  (`illustrator/index.js` L879-1109) renders any subset through the full bible + candidates + QA
  path onto `wide-plain` keys.
- **Pinned per-spread inputs for motion prompts:** the shot plan `{shotType, staging,
  placement, textSide}` (`shotPlan.js` L117-169), the emotion plan `{emotion, intensity}`
  (`emotionPlan.js`, GCS-elected via `bible/index.js` L83-108), the beat text (`catalog.json`,
  twelve `{spread, beat}` pairs), the refrain spreads, the world card
  (`worldCards.js` `renderWorldCardBlock`), `inertPropValue` (`scenes.js`) for sanitizing any
  profile string, and the age band (`1-3` gets the gentler motion menu, mirroring
  `SHOT_TYPES_YOUNG`).
- **The identity kit — now the model's references:** `children-jobs/{bookId}/bible.json`
  (`bible/index.js` L211-235) names the elected character sheet
  (`catalog-assets/character-sheets/{STYLE_VERSION}/{anchorHash}.png`, `characterSheet.js`
  L124-136 — ONE 16:9 sheet with the child full-body front / three-quarter / back + two head
  insets on flat grey, which is precisely the reference set Kling Elements and Veo reference
  images want), the outfit spec, the prop and companion sheets and the world plate.
- **The verifier exists and is image-based:** `checkSpreadRenderV2` (`spreadQa.js`) attaches
  the sheets beside a render and returns the structured verdict (identity vs sheet, outfit
  garment by garment, props, companion, action, emotion, child bbox, anatomy, painted text)
  that `classifyDefects` splits into BLOCKING and ADVISORY; `select.js` scores candidates;
  `repairNoteV2` builds steering notes from pinned data. A clip is verified by running it on
  sampled frames (§4.5) — new orchestration, the same judge.
- **Strict-JSON Gemini calls** follow one template (`spreadQa.js` L158-180: key pool,
  `fetchWithTimeout`, `jsonQaGenerationConfig`, fail-open with a named `qaUnavailable`).
  Gemini also accepts a short MP4 as inline input, which the video-level judge (§4.5) uses.
- **Vendor credentials:** Replicate is an existing vendor — the app injects
  `REPLICATE_API_TOKEN` into worker calls (`cloudrun.js` L300) and drives the Replicate
  predictions API itself (`adminFunctions.js` L2003, L2039); `costTracker.js` L17-18 still
  carries `replicate-faceid` / `replicate-flux` rates. fal.ai is tracked as a call type in the
  app but has no live code. Neither Kling's official API nor Runway is wired anywhere. The
  worker's Cloud Run revision does NOT carry the Replicate token as an env var (`deploy.yml`
  L85 lists Gemini / OpenAI / DeepSeek only) — §5.3 promotes it; until then the body-injected
  copy is the fallback the adapter accepts.
- **Storage:** `uploadBuffer` (30-day signed URL), `uploadBufferIfAbsent` (election,
  `gcsStorage.js` L39-50), `downloadBuffer`, `getSignedUrl(source, ms)`, `saveJson` /
  `loadJson`. Vendors take start frames and references BY URL — a 1-hour signed URL of the
  cached render, never base64.
- **Costs:** `CostTracker.addTextUsage` / `addImageGeneration` (`costTracker.js` L5-42); no
  per-second rate yet (§8). **Flags:** zero-arg functions over `envOff` / `envOn` / `envInt`
  (`flags.js` L97-111); every new env also goes on `deploy.yml`'s `--update-env-vars` line.

### App — where the button lives and what it already knows

- A book stores the shipped keys (`storyContent.entries[].spreadIllustrationStorageKey`), the
  approved cover (`coverImageUrl` → `approvedCoverUrl`), the identity kit summary
  (`storyContent.bookBible`) and `textLayout`; a bench round stores `renders[]` + `params`
  (story pair, anchor URL and kind, text layout, probe salts) — `IllustrationTuningIteration`,
  `schema.prisma` L1890-1910. Dispatch discipline (reserve a `dispatchId` first, ignore
  `stale_dispatch` / `duplicate`) and the `consistency_unresolved` → `pick-candidate` remedy UI
  (`ConsistencyGatePanel`) are live; the film's `video_unresolved` → `pick-clip` mirrors them.
  Detail in the companion doc.

## 4. Core design — the animated film

### 4.1 The film plan: which moments, deterministically (`video/plan.js`)

`buildFilmPlan({available, coverKind, emotionPlan, shotPlan, textLayout, ageBand})` is pure.

- **Segment 0 — meet the hero:** the approved cover as start frame, present only when the
  anchor is a cover (`coverKind: 'cover'`). A raw child photo is NEVER a start frame and never
  leaves the worker toward a video vendor. A cover that fails the text gate is dropped with an
  advisory (`cover_text_visible`).
- **Opening:** the lowest available spread in 1..4. **Peak:** the available spread in 5..10
  with the highest planned emotion intensity (`big` > `clear` > `soft`), ties by the fixed order
  `[8, 9, 7, 10, 6, 5]`. **Resolution:** the highest available spread in 11..12.
- **Subsets** (bench rounds) compress: `[cover?, min, max]`, then `[cover?, only]`; none →
  `video_no_sources` before the 202.

Durations (after 0.4 s crossfades the total is exactly **10.000 s**):

| segments | seconds per segment | sum − overlaps |
|---|---|---|
| 4 | 2.4 · 3.0 · 3.0 · 2.8 | 11.2 − 1.2 = 10.0 |
| 3 | 2.6 · 4.2 · 4.0 | 10.8 − 0.8 = 10.0 |
| 2 | 4.2 · 6.2 | 10.4 − 0.4 = 10.0 |
| 1 | 10.0 | 10.0 |

Each segment requests a clip of `ceil(seconds) + 1` whole seconds from the provider (Kling
takes integer seconds from 3) and uses `[0, seconds]` — the clip starts ON the illustration and
the identity is strongest early; the tail is discarded. Fade-in from white 0.5 s, fade-out 0.5 s.

### 4.2 The motion brief: what each clip animates (`video/brief.js`)

`buildClipBrief(segment, {book, theme, spread, emotion, shot, ageBand, evidence})` is pure and
built from pinned data only; its hash is part of the clip key. It yields the provider-neutral
brief the provider adapters render into their own request shape:

- **Action** — the beat's own sentence ("Child gets ready to visit Sunnybrook Farm") rewritten
  by a fixed template into a motion sentence: "{name} {beat action in present tense}; the
  companion {companion action when the beat names them}". No LLM rewrite in v1 — the beat is
  already an action line; an optional one-call classifier (like the emotion classifier) is open
  decision 4.
- **Camera** — the segment's move from the closed vocabulary `push-in | pull-out | pan-left |
  pan-right | rise | hold`, keyed by shot type exactly as the stills design did (`wide` →
  push-in, `close-up` → pull-out, `medium` → pan toward the child's placement third, `overhead`
  → rise, `low-angle` → push-in, cover → push-in), no adjacent repeats. Band `1-3` is limited
  to `push-in | hold` (calm, slow).
- **Performance** — the emotion plan's cue ("a big, joyful grin", "quiet wonder") and
  intensity as a motion-scale word (`soft` → "barely moving", `clear` → "gentle natural
  motion", `big` → "lively but grounded motion").
- **Lock** — fixed lines: the child's face, hair, skin, outfit and proportions stay exactly as
  in the references; every object stays; the art style stays; nobody new enters; no speech, no
  mouth flapping, no dialogue; no text, captions, subtitles, letters, words, signs, logos.
- **Negative** — `text, captions, subtitles, letters, words, logo, watermark, speech, talking,
  new character, extra people, extra limbs, morphing, distorted face, outfit change, style
  change`.
- **References** — `character` (the sheet, split into its front / three-quarter / back crops
  as three reference images of ONE element), `companion` (when the beat names the companion and
  a sheet exists), `prop` (the carried comfort object after its evidence spread — the ce-6
  carry-through rule, now a reference image), in that order, with labels.

The brief is rendered per provider: Kling gets `image` (start frame URL), `prompt` with
`@Element1…` mentions, `elements[]` with the reference URLs, `negative_prompt`, `cfg_scale`
(0.5 default, raised on repair for identity defects), `duration`, `aspect_ratio: '16:9'`,
`audio: false`; Veo gets `image`, `referenceImages[]`, `negativePrompt`, `personGeneration`
(from `videoPersonGeneration()`), `durationSeconds: 8`, `generateAudio: false`; Runway gets
`promptImage` + `promptText` only (its lack of references is why it is the control, not the
default).

### 4.3 Start frames and the text gate (`video/stills.js`)

Unchanged from revision 1 and still load-bearing: canonical-key validation before the 202
(`^children-jobs/{bookId}/ce-renders/[^/]+/[^/]+/spread-(\d{1,2})\.(square|wide|wide-plain)\.png$`,
candidate keys rejected, spread must match), `downloadBuffer` + `renderContentHash`, `wide`
(embedded) keys → text-free re-render via `renderStorySpreads(... textLayout: 'half')` with the
probe salts passed through (a book with embedded keys and no anchor fails
`missing_identity_reference` before the 202; a re-render ending `consistency_unresolved` fails
the film with that code and payload), `square` (caption) art letterboxed by the blur-fill at
stitch time when the provider returns it at 1:1 — or, better, sent to the provider at 16:9 with
the blur-fill already applied so the model animates a 16:9 frame (default; open decision 5).
Every start frame passes the strict-JSON transcription gate (`{text_present, transcript}`):
text on a spread → blocking `video_text_visible`; text on the cover → segment dropped +
advisory; checker outage → advisory and proceed (sources are text-free by contract).

### 4.4 Generation: candidates, concurrency, the provider layer (`video/providers/`)

For every segment the worker submits **N candidates concurrently** (`CATALOG_VIDEO_CLIP_CANDIDATES`,
default 2, clamped 1–3) — different seeds where the provider supports one — through the
provider interface:

```js
// video/providers/<name>.js
submit(brief, { startFrameUrl, referenceUrls, seconds, seed })  -> { jobId }
poll(jobId)   -> { status: 'queued'|'running'|'done'|'failed'|'filtered', videoUrl?, error?, reasons? }
download(url) -> Buffer
rate(seconds, opts) -> USD
```

`video/generate.js` owns the loop: submit → poll every 10 s with a per-clip deadline
(`CATALOG_VIDEO_CLIP_TIMEOUT_SECONDS`, default 480) → download → `uploadBuffer` at once (Veo
keeps outputs two days; other vendors' URLs expire in hours) → the clip lands at
`children-jobs/{bookId}/gift-video/{VIDEO_VERSION}/clips/{clipHash}.cK.mp4` (`clipHash =
fnv1a(provider | model | briefHash | startFrameHash | referenceHashes | seconds)`, `K` the
candidate index, `.rPcK` for repair pass P — every scored candidate keeps its own bytes, the
ce-9 rule). `filtered` (a vendor moderation refusal) is recorded per candidate with the
vendor's reason and counts as a failed candidate; `CATALOG_VIDEO_PROVIDER_FALLBACK` (default
none) names a second provider tried ONLY for a `filtered` candidate, through the same brief and
the same verification. Every poll tick touches the book context (§5.2) and the 30 s heartbeat
reports "animating (k/n)". Adapters: `replicate.js` (DEFAULT — `POST /v1/models/kwaivgi/kling-v3-video/predictions`,
`GET /v1/predictions/{id}`, `Authorization: Bearer` with the token the app already holds;
Replicate also hosts Veo, Hailuo and Wan under the same call shape, so a model swap is a
config change), `fal.js` (queue API: submit → `request_id`, status and result endpoints,
`Authorization: Key` — the alternative host, new key), `veo.js` (Vertex `predictLongRunning`
+ `fetchPredictOperation`, ADC on Cloud Run), `runway.js` (`/v1/image_to_video`, task polling
— bake-off control, new key). No adapter for Kling's official API: it needs two new
credentials for no capability the hosts lack. Exact request fields are **verify-at-build** items; the
loop, the cache and the verifier do not depend on them. Phase 0 decides which adapters ship
first (open decision 1).

### 4.5 Verification, selection, repair — the ce-9 gate on motion (`video/verify.js`)

A clip is judged three ways, all against pinned data:

1. **Sampled frames.** Five frames (0 / 25 / 50 / 75 / 100 %) extracted by ffmpeg go through
   `checkSpreadRenderV2` with the character sheet, the segment's prop sheets and the companion
   sheet attached — the book's own structured verdict: identity vs the sheet, outfit garment by
   garment, props, companion, the beat's action, the planned emotion, child bbox, anatomy,
   painted text. `classifyDefects` splits BLOCKING (missing / duplicated child, identity, hair,
   skin, any visible outfit slot, declared props, companion, extra limbs, painted text, style
   break) from ADVISORY (action, emotion, hands, shot type). The clip's frame score is the
   **worst frame's** score — the last frame is where drift lives.
2. **Transcription** on the same frames (the §4.3 gate) — any legible text is BLOCKING
   (`clip_text_visible`).
3. **A video-level judge** — one strict-JSON call with the MP4 itself as inline input (clips are
   2–4 MB) asking a closed vocabulary: `morphing` (face or body deforms mid-clip), `identity_drift`
   (reads as a different child by the end), `outfit_change`, `new_character`, `text_appears`,
   `speech` (mouth flapping as dialogue), `frozen` (no motion at all — the model returned a
   near-still), `camera_mismatch` (advisory). All but `camera_mismatch` are BLOCKING. Fail-open
   on outage with an advisory, but an UNCHECKED clip never outranks a checked one (`select.js`
   ranks unchecked below checked).

`select.js` scores candidates exactly as it scores renders (blocking sinks below zero,
advisories and metrics shade the rest); the best candidate is promoted to the segment's
canonical key `clips/{clipHash}.mp4` with a `.qa.json` marker (`qaVersion`, verdicts, frame
scores, `unresolved` flag). While the best candidate still carries a BLOCKING defect, the
**repair loop** runs (`CATALOG_VIDEO_CLIP_MAX_REPAIRS`, default 2, clamped 0–4): N fresh
candidates steered by a `repairNoteV2`-style note built from the defects (identity → raise
`cfg_scale`, lower motion scale, restate the element mention; outfit slot → the slot's spec
line; text → "no signage"; morphing → "subtle motion only"; frozen → "visible movement of the
child's head and arms"), adopting a higher score only. Exhausted → the segment is
**unresolved**, and the film FAILS `video_unresolved` with `unresolved: [{segment, spread,
defects, candidates: [{storageKey, url, score}]}]` + `bookBible` on the failure callback. No
stills fallback, no ship-on-exhaustion default (`CATALOG_VIDEO_SHIP_ON_EXHAUSTION=1` is the
same opt-in the renders have, with the same stage advisory). Admin remedy: `POST /v13/pick-clip`
`{bookId, storageKey}` promotes a scored candidate to the canonical clip key with an
admin-vouched marker; a re-dispatch (no `forceNew`) then replays it into the film.

### 4.6 Stitch and encode (`video/ffmpeg.js`)

`buildStitchCommand(plan, clips, {width, height, fps, music})` is pure and snapshot-tested.
Per segment: `-ss 0 -t {seconds}` on the clip, `scale` to 1920×1080 (Kling 1080p and Veo 720p
both 16:9; a 1:1 clip gets the blur-fill), `fps=30`, `format=yuv420p`; then the `xfade=fade`
chain with the duration table's offsets, white fades in and out, `-an` on every clip input,
an `anullsrc` silent AAC track (or the licensed music bed, open decision 2), `libx264 -crf 20
-profile:v high -pix_fmt yuv420p -movflags +faststart -t 10.000`, plus `poster.jpg` at 1.2 s.
The xfade / fade / encode tail of this graph is the part of revision 1's Appendix A that was
validated at exactly 10.000 s; without zoompan the encode is a few seconds. No `drawtext`,
asserted by a test.

### 4.7 Storage, the film key, replay

```
children-jobs/{bookId}/gift-video/{VIDEO_VERSION}/clips/{clipHash}.mp4            ← promoted clip (+ .qa.json)
children-jobs/{bookId}/gift-video/{VIDEO_VERSION}/clips/{clipHash}.cK.mp4         ← scored candidates (+ .rPcK)
children-jobs/{bookId}/gift-video/{VIDEO_VERSION}/{filmHash}/video.mp4 | poster.jpg | video.json
```

`filmHash = fnv1a(VIDEO_VERSION | aspect | music | segments[kind, spread, startFrameHash,
briefHash, seconds] | promoted clip hashes)`. A film whose manifest and MP4 exist replays by
callback with `cached: true`; a promoted clip with a valid marker replays without re-generation
(so a `pick-clip` re-dispatch only re-stitches); `forceNew` re-generates every clip. A replay
under a newer `QA_VERSION`, or of an `unresolved` clip, re-verifies instead of trusting the
marker — the render cache's rule, verbatim. `VIDEO_VERSION` (`gv-1`) owns the namespace; a
change to the plan rules, the brief template, the duration table or the stitch graph bumps it
("gv-(N-1) films must never replay as gv-N"). Provider and model are inside `clipHash`, so
switching models is a new clip, not an invalidation. The manifest records every input hash,
the brief per segment, provider job ids, per-candidate verdicts and scores, repairs, costs,
advisories.

## 5. Worker changes (one-time deploy)

### 5.1 New module — `services/catalogEngine/video/`

| file | owns |
|---|---|
| `plan.js` | `buildFilmPlan`, duration table, motion table, enums |
| `brief.js` | `buildClipBrief` (pure), `renderRepairNote`, `briefHash` |
| `stills.js` | key regex, start-frame resolution, embedded re-render, text gate |
| `providers/{replicate,fal,veo,runway}.js` + `providers/index.js` | the adapter interface (§4.4), `providerFor(flags)`; `replicate` ships first |
| `generate.js` | candidates, polling, deadlines, clip cache, filtered handling, fallback provider |
| `verify.js` | frame sampling, `checkSpreadRenderV2` orchestration, transcription, the video judge, scoring |
| `ffmpeg.js` | `buildStitchCommand` (pure), `extractFrames`, `runFfmpeg`, `probeOutput` |
| `clips.js` | `pickClip` (the admin remedy; mirrors `illustrator/candidates.js`) |
| `index.js` | `generateGiftVideo(params)` — plan → stills → generate → verify → repair → stitch → upload → manifest |

### 5.2 Endpoint — `POST /v13/generate-video` (202 + callback)

Request (identity fields are `/v13/render-spreads`'s, so the app reuses `buildWorkerPayload`):

```json
{
  "bookId": "…", "dispatchId": "gv_…", "callbackUrl": "…/api/children/video-callback",
  "progressCallbackUrl": "…/api/children/progress",
  "renders": [{ "spread": 1, "storageKey": "children-jobs/…/spread-1.wide-plain.png" }, …],
  "story": { "request": {…}, "response": {…} },
  "profile": { "name": "…", "age": 4 },
  "approvedCoverUrl": "https://…", "childPhotoUrls": ["…"], "characterDescription": "…",
  "textLayout": "half", "illustrationTuning": {…}, "identityKeyed": true, "seed": 7, "probeNonce": "…",
  "provider": "replicate", "model": "kwaivgi/kling-v3-video",
  "aspect": "16:9", "music": "none", "forceNew": false
}
```

Validation before the 202, in the `/v13/render-spreads` order (`server.js` L564-640):
`BOOK_ID_RE`; `callbackUrl`; `renders` 1–12 entries, unique spreads, every key passing the
§4.3 regex for THIS `bookId`; `story` → `resolveStory` (`pipeline.js` L43-131) → `getBookForTag`
(`missing_book_definition`); `normalizeProfile`; `validateArtTuningInput`; `provider` / `model`
∈ the configured allowlist (`videoProviders()`, default `[replicate]`; omitted → the default);
`aspect` ∈ `16:9|9:16`; `music`; **anchor required always** (`missing_identity_reference`) —
the character sheet is the identity reference of every clip, so `prepareIdentity` must have
run or `buildBookBible` runs first, and `identity_kit_failed` is inherited; `seed` integer.
Then `res.status(202).json({success:true, bookId, dispatchId, engine:'catalog-v13',
videoVersion, provider, model, accepted:{spreads}})`. The IIFE registers
`createBookContext(bookId, {mapKey: 'video:' + bookId, …})`, touches activity on every poll and
heartbeat, and deletes it in `finally`.

Callback — one stable shape, every key present on failure:

```json
{
  "success": true, "bookId": "…", "dispatchId": "gv_…", "engine": "catalog-v13", "videoVersion": "gv-1",
  "provider": "replicate", "model": "kwaivgi/kling-v3-video",
  "video": { "url": "…", "storageKey": "…/video.mp4", "posterUrl": "…", "posterKey": "…", "hash": "…",
             "durationSeconds": 10, "width": 1920, "height": 1080, "fps": 30, "bytes": 0, "music": "none", "cached": false },
  "plan": [{ "index": 0, "kind": "cover", "spread": null, "seconds": 2.4, "motion": "push-in",
             "startFrame": { "storageKey": null, "renderHash": "…" },
             "clip": { "storageKey": "…/clips/….mp4", "hash": "…", "score": 0.82, "candidates": 2, "repairs": 0 } }, …],
  "textGate": [{ "segment": 0, "pass": true }, …],
  "bookBible": {…}, "unresolved": [],
  "advisories": [{ "stage": "video", "spread": 8, "note": "action not clearly performed" }],
  "warnings": [], "costs": { "totalCost": 2.31, "breakdown": {…} },
  "failureCode": null, "error": null
}
```

Failure codes: `video_no_sources`, `video_source_missing`, `video_text_visible`,
`video_unresolved` (with `unresolved[]`), `video_provider_unavailable` (every candidate of a
segment failed at the vendor without a verdict — outage, not quality), `video_encode_failed`,
plus the inherited `missing_book_definition`, `missing_identity_reference`,
`identity_kit_failed`, `invalid_story`, `consistency_unresolved`. Progress on
`progressCallbackUrl`, stage `video`: resolving sources → text gate → rendering text-free start
frames (n/m) → animating (k/n clips, candidates in flight) → verifying → repairing (pass p) →
stitching → uploading.

`POST /v13/pick-clip` `{bookId, storageKey}` (sync, mirrors `/v13/pick-candidate`, `server.js`
L805-822): validates the key against the candidate regex, promotes it, writes the admin-vouched
marker, returns `{success, bookId, segment, storageKey, clipHash}`.

### 5.3 Dockerfile, envs, versions, cost rates

- `Dockerfile`: `apt-get install … ffmpeg` (the Debian release behind `node:20-slim` ships
  5.1 on bookworm or 7.1 on trixie, both with libx264 + AAC; the spike pins the version it
  measured). No `fluent-ffmpeg` — `execFile` with an argv array.
- `versions.js`: `VIDEO_VERSION = 'gv-1'` with the bump-comment convention.
- `flags.js` (zero-arg): `giftVideoEnabled()` (`CATALOG_GIFT_VIDEO`, kill — the endpoint
  answers 503 `gift_video_disabled`), `videoProviders()` (`CATALOG_VIDEO_PROVIDERS`, default
  `replicate`), `videoModel()` (`CATALOG_VIDEO_MODEL`, default `kwaivgi/kling-v3-video`), `videoProviderFallback()` (`CATALOG_VIDEO_PROVIDER_FALLBACK`, default
  none), `videoPersonGeneration()` (`CATALOG_VIDEO_PERSON_GENERATION`, Veo only, default
  `allow_all` — Veo is not selectable until the allowlist exists, so the default is the value the
  allowlist grants), `videoClipCandidates()` (2, 1–3), `videoClipMaxRepairs()` (2, 0–4),
  `videoClipTimeoutSeconds()` (480), `videoMaxClipSeconds()` (`CATALOG_VIDEO_MAX_CLIP_SECONDS`,
  default 60 — the per-film spend cap counting every candidate and repair; reaching it fails the
  film `video_unresolved` rather than starting another pass), `videoShipOnExhaustion()` (opt-in),
  `videoMusic()` (`none`), `FFMPEG_PATH`. Credentials: **no new key on the default path** —
  `REPLICATE_API_TOKEN` already exists in the app's environment and is promoted to the worker
  revision (a GitHub secret + one entry on `deploy.yml`'s `--update-env-vars` line; the adapter
  also accepts the copy the app injects into request bodies, `cloudrun.js` L300, so the feature
  works before that deploy). Optional, only when their provider is configured: `FAL_KEY`,
  `RUNWAYML_API_SECRET`; Veo uses ADC, no key. Only the configured providers' credentials are
  required at boot (`/healthz` reports which). All on
  `deploy.yml`'s `--update-env-vars`.
- `costTracker.js`: `addVideoSeconds(model, seconds)` with `perSecond` rates per model id
  (`kwaivgi/kling-v3-video` on Replicate ≈ 0.168 audio-off / 0.252 with audio, Kling 3.0
  Standard on fal.ai ≈ 0.084, Runway Gen-4 Turbo 0.05, Veo 3.1 Fast ≈ 0.15, Veo 3.1 ≈ 0.40 —
  **verify**; billed for every generated candidate, filtered ones too where
  the vendor bills them); frames and the video judge through `addTextUsage` like the OCR
  verify (`illustrationGenerator.js` L412).

## 6. The Veo route (second provider)

Kept as a first-class adapter because Google is the rest of the stack's vendor and Veo's
reference images fit the identity kit as well as Kling's Elements do. It is gated by one
external fact: `personGeneration: allow_all` on the project. Phase 0 files the allowlist
request (Vertex AI, project id + number, billing, region, use case: illustrated children in a
personalized children's-book product); until it is granted the adapter refuses to submit
(`video_provider_unavailable: veo_not_allowlisted`) rather than sending a request that the
filter will reject. Transport: Vertex `predictLongRunning` → `fetchPredictOperation` polling,
ADC on Cloud Run, `storageUri` pointing at our bucket so the clip never leaves GCP. The region
of the Vertex endpoint is a deployment choice the business confirms against its Google Cloud
terms; the plan does not proxy calls through a region to dodge a policy.

## 7. Cross-repo contract (what the app must do — detail in the companion doc)

1. Send the EXACT keys (never URLs) and the identity inputs it already builds for a spread
   re-render (`buildWorkerPayload` + `identityKeyed` / `seed` / `probeNonce` for a round).
2. Reserve `dispatchId` before the call; ignore `stale_dispatch` / `duplicate` on callback.
3. Store the callback's `video`, `plan`, `unresolved`, `provider`, `model` under the surface's
   own JSON (`storyContent.giftVideo` for a book, the iteration's `video` column for a round),
   normalized like `bookBible`, bound to `sourceKeys`.
4. Surface `video_unresolved` exactly like `consistency_unresolved`: the scored candidates per
   segment with a **Pick clip** action → `POST /v13/pick-clip` → re-dispatch.
5. Re-sign `storageKey` at read time; the callback's URL is a convenience.

## 8. Mechanics, versioning, cost, time

- **Versioning:** `VIDEO_VERSION` (`gv-1`) owns the film and clip namespace; `STYLE_VERSION` /
  `QA_VERSION` untouched except that clip markers carry `qaVersion` and re-verify under a newer
  checker like renders do.
- **Cache-key folds:** provider, model, brief hash, start-frame hash, reference hashes and
  seconds are inside `clipHash`; aspect, music and the promoted clip hashes inside `filmHash`.
  `CATALOG_SHOT_PLAN=0` changes the brief and therefore the hash — no separate fold.
- **New env:** `CATALOG_GIFT_VIDEO`, `CATALOG_VIDEO_PROVIDERS`, `CATALOG_VIDEO_MODEL`,
  `CATALOG_VIDEO_PROVIDER_FALLBACK`, `CATALOG_VIDEO_PERSON_GENERATION`,
  `CATALOG_VIDEO_CLIP_CANDIDATES` (2, 1–3), `CATALOG_VIDEO_CLIP_MAX_REPAIRS` (2, 0–4),
  `CATALOG_VIDEO_CLIP_TIMEOUT_SECONDS` (480), `CATALOG_VIDEO_MAX_CLIP_SECONDS` (60),
  `CATALOG_VIDEO_SHIP_ON_EXHAUSTION` (opt-in), `CATALOG_VIDEO_MUSIC`, `FFMPEG_PATH`, and, on
  the default path, no new credential — `REPLICATE_API_TOKEN` promoted to the worker revision;
  `FAL_KEY` / `RUNWAYML_API_SECRET` only if those providers are configured.
- **Cost per film** (4 segments, 3 s clips, N = 2, no repairs; rates **verify**):

  | item | Kling 3.0 on Replicate (DEFAULT, existing token) | Kling 3.0 Std on fal.ai (new key) | Runway Gen-4 Turbo (new key) | Veo 3.1 Fast (allowlist) |
  |---|---|---|---|---|
  | clips (24 s; Veo 32 s at 4 s minimum) | ≈ $4.03 | ≈ $2.02 | ≈ $1.20 | ≈ $4.80 |
  | one repair pass on one segment (+6 s) | +$1.01 | +$0.50 | +$0.30 | +$1.20 |
  | text gate + frames + video judge (≈ 50 Gemini calls) | ≈ $0.15 | ≈ $0.15 | ≈ $0.15 | ≈ $0.15 |
  | embedded re-render (only `embedded` books; `costTracker.js` L5-31) | ≈ $0.15 | ≈ $0.15 | ≈ $0.15 | ≈ $0.15 |
  | stitch | ≈ $0.01 | ≈ $0.01 | ≈ $0.01 | ≈ $0.01 |
  | **typical** | **≈ $4.3–5.5** | **≈ $2.3–3.5** | **≈ $1.5–2.5** | **≈ $5–7.5** |

  `CATALOG_VIDEO_MAX_CLIP_SECONDS` (60) bounds the worst case at ≈ $10 on the default path
  (≈ $5 on fal.ai). The existing-account choice costs about $2 more per film than fal.ai at
  N = 2; revisit when volume makes that matter (open decision 1).
- **Time:** 5–8 minutes per film (vendor latency 2–5 min per clip, eight candidates in flight,
  verification ≈ 30 s, repairs add one vendor round each, stitch seconds). Concurrency 1 per
  instance; `min-instances=1` already covers post-202 work; the registered book context keeps
  the watchdog off the job.
- **Storage:** ≈ 4 MB per film + ≈ 3 MB per candidate clip (eight to sixteen per film) + poster
  + manifest. Candidates older than 30 days are a lifecycle-rule candidate once the feature
  is stable; promoted clips and films are kept.

## 9. What this plan deliberately does NOT do

- **No stills, no Ken Burns, no silent degrade.** A segment that cannot be animated to the
  book's standard fails the film with its candidates attached; the admin picks or retries.
- **No raw child photo** as a start frame or reference, and none sent to any video vendor.
- **No prompt-only consistency.** References + verification + selection, or nothing.
- **No text, no speech.** Native audio is never generated; music is a licensed bed or silence.
- **No region games** for Veo; the allowlist is the gate.
- **No Sora** (rejects any face) and no bespoke vendor SDKs — plain REST adapters on the key
  conventions the worker already has.
- **No auto-generation on completion** (open decision 8) and no customer-triggered generation.
- **No new render aspect** — embedded re-renders reuse the `half` path (open decision 6).

## 10. Order & tests

0. **Bake-off spike (2 days, no product change).** Add `ffmpeg` to the Dockerfile and build.
   Take three real finished books (one per `caption` / `half` / `embedded`, different age
   bands) and, by hand, run each provider on the same four start frames with the same brief:
   Kling 3.0 via Replicate (`kwaivgi/kling-v3-video`, the existing token — confirm the
   endpoint exposes Elements; if not, fal.ai's Kling 3.0 Standard on a trial key, which also
   gives the price comparison), Runway Gen-4 Turbo only if a key is worth creating for the
   control, and Veo 3.1 Fast only if the allowlist has landed. Run every clip through the
   §4.5 verifier and a human review. Record per provider: refusal / filtered rate on child
   frames, worst-frame identity score, outfit hold, text leakage, `frozen` rate, latency, cost.
   **File the Veo `allow_all` allowlist request on day 1** regardless. Output:
   `docs/audits/gift-video-bakeoff.md` and the provider default for open decision 1. If NO
   provider animates the child acceptably, stop and report — the plan does not fall back to
   stills on its own.
1. **`plan.js` + `brief.js` + `ffmpeg.js` (pure).** Tests (`__tests__/services/catalogEngine/video/`):
   full-12 picks `{1, peak, 12}`; subsets compress; photo anchor → no cover segment; duration
   tables sum to 10.000; no adjacent motion repeats; band `1-3` motion menu; brief is
   byte-stable for the same inputs and changes hash when the shot plan or emotion changes; the
   Kling / Veo / Runway renderings of one brief; stitch argv snapshot, xfade offsets, `-an` on
   every clip input, `-t 10.000`, no `drawtext`.
2. **`stills.js`** — unchanged tests from revision 1 (regex, missing object, embedded re-render
   with salts, text gate verdicts).
3. **Providers + `generate.js`.** Tests with mocked `fetch`: submit → poll (queued → running →
   done) → download → GCS; `filtered` recorded with the vendor reason and the fallback provider
   tried once; deadline → failed candidate; clip cache hit skips the vendor; the seconds cap
   stops new passes; every poll tick touches the book context.
4. **`verify.js` + selection + repair + `pick-clip`.** Tests: worst-frame scoring; a blocking
   verdict on the last frame sinks a candidate whose first frame is perfect; transcription
   blocking; video-judge vocabulary mapped to blocking / advisory; unchecked never outranks
   checked; repair note content per defect class; exhaustion → `video_unresolved` payload
   shape with candidates; `pick-clip` promotes with an admin-vouched marker and a re-dispatch
   replays without a vendor call.
5. **`index.js` + `POST /v13/generate-video` + envs + rates.** Tests (`server.test.js`
   L398-570 pattern): every validation before the 202; anchor required; provider not in the
   allowlist → 400; callback shape on success, `video_unresolved`, `video_provider_unavailable`;
   `cached: true` replay; book context registered and removed. *Deploy the worker once.*
6. **App wiring** — companion doc changes 1–6. *Deploy the app once.*
7. **Veo adapter** — when the allowlist is granted: Vertex transport, `storageUri`, the
   `veo_not_allowlisted` refusal, reference images from the sheet crops.
8. **Delivery** — companion doc §6.
9. **Validation recipe.** The three bake-off books plus one bench round with a photo anchor
   and one with three spreads; assert on each callback: `durationSeconds === 10`, 1920×1080,
   every segment's clip score above the ship threshold with `repairs ≤ 2`, `textGate` all pass,
   plan spreads `{1, peak, 12}` for the full books, `unresolved` empty, cost under the cap;
   watch every film on a phone. Canary: ship with `CATALOG_GIFT_VIDEO=0`, flip on for admins.

## 11. Open decisions (defaults chosen — flag if you disagree)

1. **Provider host for Kling 3.0: Replicate or fal.ai?** Default **Replicate** — decided by
   the owner (2026-09-02): use the credentials we already hold, no new key. The cost of that
   choice is price: Replicate lists `kwaivgi/kling-v3-video` at ≈ $0.168/s audio-off against
   fal.ai's ≈ $0.084/s for Kling 3.0 Standard (**verify** both), roughly $2 more per film at
   N = 2. fal.ai stays as the alternative adapter behind `CATALOG_VIDEO_PROVIDERS` for two
   reasons only: if Replicate's endpoint does not expose Elements (the bake-off checks), or if
   volume makes the price delta matter. The official Kling API is dropped: two new credentials
   for no capability the hosts lack.
2. **Music?** Default `none` (silent AAC track) until a licensed instrumental bed is committed
   under `data/video/music/` with its license file; never the model's native audio.
3. **Open on the animated cover?** Yes when the anchor is an approved cover; never on a photo.
4. **LLM-written motion sentences?** Default no — the beat IS an action line and the template
   is deterministic; an optional one-call classifier (like the emotion classifier) can be added
   behind `CATALOG_VIDEO_BRIEF_CLASSIFIER=1` if bake-off clips look stiff.
5. **1:1 (caption) start frames: blur-fill before the vendor or after?** Default before — the
   model animates a 16:9 frame and the fill can move with the scene; after would freeze it.
6. **Embedded books: re-render via `half` or a new text-free `wide` namespace?** Default `half`.
7. **Clip length?** 3 s requested, 2.4–3.0 s used. Longer clips drift; more segments would
   rush a 10 s summary. Revisit only with bake-off evidence.
8. **Auto-generate on completion?** Default no (admin click, as asked); the hook is
   `children.js` L808-828 behind `CHILDREN_GIFT_VIDEO_AUTO=1`.
9. **Ship on exhaustion?** Default no (fail `video_unresolved`); `CATALOG_VIDEO_SHIP_ON_EXHAUSTION=1`
   mirrors the renders' opt-in.
10. **Keep candidates forever?** Default 30-day lifecycle on `.cK` candidates once the feature is
    stable; promoted clips and films are kept.

---

## Appendix A — evidence index

- Kling 3.0: image-to-video 3–15 s, start + end frame, Elements (≤ 3 elements, ≤ 3 reference
  images each, prompt mentions), multi-shot ≤ 5 segments, `negative_prompt`, `cfg_scale`,
  optional native audio; fal.ai per-second pricing (Standard ≈ $0.084 audio-off, Pro ≈ $0.112,
  Turbo 1080p ≈ $0.14, 4K ≈ $0.42), official API 6–8 credits/s audio-off — hosted-API pages
  (fal.ai, Segmind, Kie, PiAPI) as summarized by search, 2026-09 — **verify**.
- Replicate: `kwaivgi/kling-v3-video` at ≈ $0.168/s without audio, ≈ $0.252/s with audio;
  the app's existing token and predictions-API usage (`cloudrun.js` L300, `adminFunctions.js`
  L2003-2039) — Replicate model page as summarized by search, 2026-09 — **verify**.
- Runway Gen-4 Turbo: image-to-video only, 5 or 10 s, 720p 24 fps, 5 credits/s ($0.05/s);
  moderation is semantic, cannot be allowlisted, child-safety policy — Runway API docs and
  usage policy as summarized by search — **verify**.
- Veo 3.1: `personGeneration` values, image-to-video default `allow_adult`, EU/UK/CH/MENA
  restriction, allowlist-only `allow_all` (Vertex AI, requests cite `us-central1`), 4/6/8 s,
  reference images ≤ 3, extension +7 s at 720p, two-day retention, ≈ $0.15–0.40/s — Google AI
  forum threads and third-party summaries — **verify**.
- Sora 2 API: input reference images with a human face (real or drawn) rejected — OpenAI docs
  and system card as summarized by search.
- Worker facts: `server.js` L131-225, L564-743, L805-822, L1071-1092; `illustrator/index.js`
  L64-66, L94-97, L171, L247-248, L325-377, L879-1109, L940-973, L1011; `pipeline.js` L43-131,
  L360-393; `bible/index.js` L83-108, L211-235; `characterSheet.js` L124-136; `worldPlate.js`
  L103; `shotPlan.js` L117-169; `emotionPlan.js` L240; `spreadQa.js` L158-180; `select.js`;
  `illustrator/candidates.js`; `gcsStorage.js` L39-50; `costTracker.js` L5-42; `flags.js`
  L97-111; `Dockerfile`; `cloudbuild.yaml`; app `cloudrun.js` L300, `adminFunctions.js`
  L2003-2039 (Replicate).
