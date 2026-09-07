# Audiobook V2 — the performed read-aloud with a score and sound design (plan, ab-1)

> **Status:** IMPLEMENTED (2026-09-07, `ab-1` / `aq-1`) — `services/catalogEngine/audio/` +
> `data/audio/` + the `/v13/generate-audiobook`, `/v13/audiobook-audition`, `/v13/pick-take`,
> `/v13/cancel-audiobook` and `GET /v13/audiobook-cast` endpoints, 13 test suites. This
> document is the design record; `CLAUDE.md` (the `audio/` section + the `CATALOG_AUDIO_*`
> switches) is the running summary. §10 was the build order.
> **Scope:** `giftmybook-children-worker` (this plan — the engine) + `giftmybook-standalone`
> (`docs/AUDIOBOOK_V2_APP_WIRING.md` — the app half: dispatch, record, admin Audio Bench,
> the read-along player, delivery). The V1 engine that this REPLACES for children's books
> lives in a third repo, `giftmybook-worker/services/audiobookGenerator.js`; §2 reviews it
> with file:line evidence and §9 says what stays there (adult chat books).
> **Branch:** `claude/childrens-audiobook-plan-f0enjt` (both repos).
> **Siblings:** `docs/GIFT_VIDEO_PLAN.md` (the provider-layer + candidates/verify/select
> shape this plan copies for sound), `docs/COLORING_BOOK_V2_PLAN.md` (the closed-grammar
> plan + per-theme elected assets + set gates this plan copies for the score and the sound
> library), `docs/ILLUSTRATION_CONSISTENCY_REFACTOR_PLAN.md` (the Book Bible: pinned inputs,
> verified against — the emotion plan this plan reuses as the narrator's direction).
> **Vendor facts** below (voice, music and sound-effect models, prices, language lists) come
> from the vendors' pages as summarized by web search on 2026-09-07 and are marked
> **verify** where they change a decision; Phase 0 (§10) is the bake-off that turns them into
> measured facts, exactly as the video plan did for video models.

**Trigger.** A children's book is complete (a V1.3 story chosen, illustrated, printed or
about to be). An admin — later the customer, at checkout or from the delivery email — asks
for the audiobook and, a few minutes later, gets a read-aloud of THEIR book: a narrator who
performs the story (not reads it), the child's name said right, the companion given a
voice, a score composed for the book's world that follows the story's emotional arc, the
sounds of that world under the words, a musical motif every time the refrain comes around,
and a read-along player that turns the book's own illustrated pages as the narrator reads.

**The one-paragraph diagnosis.** Everything that makes a read-aloud good is DIRECTION —
which sentence is hushed and which is bright, where the pauses fall, when the music swells,
which word gets the splash — and the engine that owns every input a director needs is this
worker: the fixed beat per spread, the emotion plan (10 emotions × 3 intensities, already
pinned per spread for the illustrator), the companion's name and kind, the refrain text and
its exact spreads, the world-law card, the age band, the personalization evidence. V1 lives
in the OTHER worker and receives none of it: it gets a flat list of `{title, text}` segments
and one voice key, reads them with one Google voice, loops one 60-second CC0 clip under the
whole book at a constant volume, and checks nothing but the file's duration. It also cannot
read a Catalog Engine book at all (§2.1). The design below is therefore the house pattern
applied to sound: **pinned inputs in (a schema-validated AUDIO SCRIPT derived from the Book
Bible), N candidate takes out, every take VERIFIED by transcription against the manuscript,
the best selected, bounded repair, a score and a sound library elected ONCE per theme and
pinned, a deterministic timeline and mix graph, broadcast-grade loudness measured, fail
closed** — with the narrator, music and effects behind a provider layer so the bake-off
decides the vendors, not the code.

---

## 1. Goal

1. **A performed read.** Every sentence carries a delivery direction from a CLOSED vocabulary
   derived from the spread's pinned emotion (`illustrator/emotionPlan.js`), the beat, the
   punctuation and the age band; dialogue is attributed and — from band 4-5 up — the
   companion speaks in its own cast voice; the refrain is delivered the same warm way every
   time it returns, announced by a short musical motif the child learns to expect; the pace
   fits the age (band 1-3 slow with long breaths, 8-10 brisk). No sentence is ever read
   flat, and "Title page." / "Dedication." / "Spread 7" are never spoken.
2. **Every word is the manuscript's, and the name is right.** The engine never rewrites
   prose (the catalog invariant: the AI does not invent). Every take is TRANSCRIBED and
   compared with the text it was given — a dropped, doubled or invented word, a direction
   tag read aloud, a truncated first or last word is BLOCKING. The child's and the
   companion's names are checked in isolation once per (name, language, voice) and a
   pronunciation alias is elected and pinned when the voice gets them wrong.
3. **A score composed for the world.** One SUITE of cues per theme (intro signature, calm,
   playful, wonder, tender, gentle tension, triumph, lullaby ending, refrain motif),
   generated ONCE from the world-law card + a per-theme instrument palette, judged, elected
   create-if-absent under `catalog-assets/` like the world plate. Per book a deterministic
   MUSIC PLAN maps the emotion arc onto those cues (a cue holds ≥ 2 spreads, ≤ 5 changes, the
   intro under spread 1, the ending under spread 12, the motif at every refrain), ducked
   under speech by sidechain compression and breathing up in the gaps — never a constant
   volume, never a loop seam.
4. **A world you can hear.** One ambience bed per theme (birdsong and breeze on the farm,
   soft bubbles on the reef) far under everything, plus SPOT effects from a CLOSED,
   age-gated library placed at declared moments (the beat's action, the personalization
   evidence, whole-word keywords in the spread) — after the sentence, never over a word,
   never inside the refrain, capped per band, never startling. A soft page-turn between
   spreads is the read-along's affordance.
5. **A broadcast-grade mix, measured.** −16 LUFS integrated, ≤ −1 dBTP, speech at least 12
   LU above the music inside every speech window, no dead air > 2.5 s, nothing clipped —
   deterministic checks on the rendered stems, corrected by re-mixing (never by
   re-synthesis). Stereo 48 kHz MP3 192 kbps plus a TIMELINE (spread / sentence / effect /
   cue timestamps) that the app's read-along player drives page turns from.
6. **Deterministic, cached, versioned, fail-closed.** The audio script is a pure function
   of pinned inputs; takes are keyed by content hash and replay; suites and sound cues are
   elected once; `AUDIO_VERSION` owns the namespace; a segment that exhausts its budget fails
   the book `audiobook_unresolved` with its scored candidates attached and
   `POST /v13/pick-take` is the admin remedy — the `consistency_unresolved` /
   `coloring_unresolved` shape.

---

## 2. The review — what V1 does today, and why it cannot become "amazing" (grounding)

V1 is three pieces in three repos. Evidence is file:line on the branches as of 2026-09-07.

### 2.1 It cannot read a Catalog Engine book at all

- The app flattens a `ChildrenBook` into segments with
  `giftmybook-standalone/server/utils/childrenAudiobookChapters.js` — `textFromStoryEntry`
  (line 15) reads `bodyText | body | text | left.text | right.text` and nothing else.
- This worker's pipeline persists every spread's text as `captionText`
  (`services/catalogEngine/pipeline.js:425-431`), and the `/generate-book` completion
  callback carries no legacy `spreads` array (the app's `children.js:697` fallback stays
  empty). The app's own production judge reads `captionText` (`productionJudge.js:54`); the
  audiobook builder never learned to.
- Result: for every post-cutover book `buildChildrenAudiobookChapters` returns zero
  segments, `POST /api/admin/audiobooks/generate` answers 400 "No story text found"
  (`routes/admin/audiobooks.js:257`) and the entitlement queue's `buildGenerationPayload`
  throws (`services/audiobookEntitlements.js:152`). Every audiobook V1 ever produced was a
  pre-cutover book (the last commit touching the engine is 2026-07-15, #128 in
  `giftmybook-worker`; the app side's is 2026-08-06, #445 — both before the 2026-08 cutover).

### 2.2 The narrator is a voice, not a performance

- One voice per book, chosen by a theme REGEX (`resolveChildrenAudiobookVoice.js`:
  `/(bedtime|sleep|lullab|dream)/` ⇒ gentle female, `/(birthday|party|adventure…)/` ⇒ upbeat
  male, else gentle male) — the V1.3 theme ids (`farm`, `under_the_sea`, `dinosaur`…) match
  none of these, so every catalog book would get the default.
- The Chirp3-HD voices the children profile prefers "do NOT accept SSML or pitch
  adjustments — they infer emotion from punctuation" (`audiobookGenerator.js:17-20`), so the
  engine hands them plain text (`buildChildrenStoryPlainText`, line 601) — there is no way to
  direct them. The Studio/Neural2 voices get a hand-rolled SSML: `+2st` pitch on every
  sentence ending in `!`, a 140 ms break after every comma (`buildChildrenStorySsml`,
  lines 560-598) — the same treatment on a lullaby and a chase.
- No dialogue attribution, no character voices, no per-sentence emotion, no age-band pacing
  beyond one `speakingRate` per voice, no refrain awareness (the refrain is the one line the
  catalog fixes on exact spreads — V1 does not know it exists).
- The intro is `Let's read ${title}.` (line 1012); spreads whose entry type is
  `title_page` / `dedication_page` are narrated as the literal words "Title page." and
  "Dedication." (lines 825-831). Nothing checks that the child's name was pronounced
  correctly; `pronunciationHints` (line 323) is a literal find-and-replace on the text.

### 2.3 The music is one loop at one volume

- Nine 60-second CC0 excerpts from freepd.com (`audio/music/CREDITS.md`), one per mood.
- ONE file per book (`pickBookMusicPath`, line 380), chosen by keyword regex over the story
  text (`childrenAudiobookMoods.js` `nudgeMoodFromKeywords`: `\b(dark|scary|…)\b` ⇒
  suspense) — the per-segment moods it also computes are never used by the children path
  (`audiobookGenerator.js:1118`: "No per-spread music mix").
- `mixWithMusicBed` (line 840) is `amix` at a constant `volume=0.26` — no sidechain ducking
  (the ducking mixer, `mixWithMusic`, is the ADULT path), no arc, no transitions; the
  60-second excerpt loops with an audible seam every minute of a 5-8-minute book.
- The optional "attachment" (`applyMusicAttachment`, line 272) prepends/appends FIVE
  MINUTES of the same excerpt looped (`attachments/manifest.json`: `durationSeconds: 300`,
  `file: "../ambient-tender.mp3"`) — the admin picker offers it as "Soft Classical intro
  (5 min)".

### 2.4 There are no sound effects

Nothing in either repo produces, places or mixes a sound effect. The word does not occur.

### 2.5 Nothing is verified

- `runAudioQc` (line 334) is `ffprobe` duration + `silencedetect` (8 s) — the ONLY checks.
  No transcription (a dropped sentence, a doubled word, a mispronounced name, a TTS glitch
  all pass), no loudness measurement (the attachment path runs `loudnorm`, the narration mix
  does not), no true-peak check, no speech-to-music ratio, no per-segment verdict, no
  candidates, no selection, no repair. The admin approve/reject step
  (`audiobookEntitlements.js` `approveGeneration`) is the entire quality gate — a human
  listens to the whole file.

### 2.6 Nothing is deterministic, cached or versioned

- The output key is `audiobooks/${bookId}/audiobook_${Date.now()}.mp3` (line 1238). No
  content hash, no version namespace, no per-segment artifacts; a retry re-synthesizes
  everything; the app's `AudiobookGeneration.idempotencyKey` hashes the INPUTS but the
  worker cannot replay a finished segment.
- Every ffmpeg call is `execSync` with a shell-interpolated string (lines 259, 285, 373,
  871, 926) — the house rule since gv-1 is argv arrays through `execFile`
  (`services/catalogEngine/video/ffmpeg.js`).

### 2.7 The product is a `<audio>` tag

`client/src/pages/AudiobookPlayer.jsx` is an admin-only page with `<audio controls>` and a
"Download MP3" link; no cover, no page sync, no chapters, no customer access (every
entitlement is created with `deliverySuppressedReason: 'admin_only'`,
`audiobookEntitlements.js:17`); the cart hides audiobook rows from non-admins
(`cartItemTypes.js` `visibleCartItemsForRole`). The price is set (`AUDIOBOOK_CENTS` 1490)
and the entitlement/generation/job tables, the token player URL and the approve/reject flow
all exist and are worth KEEPING (§9).

### 2.8 Cost was never the constraint

Google Studio voices bill $160 per million characters (line 34); a V1.3 book is 100-720
words (`ageEngines.json` totals) ≈ 600-4,000 characters ≈ $0.10-0.65 per read. The budget
headroom under a $14.90 add-on is enormous; quality, direction and verification are what
were missing.

### 2.9 Two things V1 got right (kept)

- The Spanish/Hebrew ADAPTATION (`childrenAudiobookAdaptation.js`): glossary-locked
  names, batched, verse-aware, page-number stripping — a sound literary approach. It is
  reused in Phase 5 with verification added (§4.10).
- The entitlement model (paid / comped, token-hashed player URL, approve → publish,
  supersede older generations) — the commerce half is fine; the engine behind it is what
  changes.

---

## 3. The five honest constraints (read before the design)

### 3.1 The words are the book; the direction is metadata

The narration text is the validated manuscript, verbatim — the writer engine's invariants
(no invented plot, no invented names, the refrain exact) hold in the audiobook too. So every
provider adapter receives TEXT + DIRECTION and renders the direction in the provider's own
control channel (ElevenLabs v3 inline audio tags, Gemini TTS style prompts, OpenAI
`instructions`, Google SSML). Where the channel is INLINE (v3 tags such as `[softly]`), the
tag vocabulary is CLOSED, tags are stripped before the transcript comparison, and a tag the
model READS ALOUD is a blocking defect the transcript gate catches (§4.4). The one place the
engine adds words is the fixed intro/outro/dedication templates (§4.1), which are its own.

### 3.2 TTS is non-deterministic and sometimes wrong

Every expressive TTS model occasionally drops or doubles a word, mispronounces a name, reads a
control tag, or emits a glitch; a seed parameter reduces but does not remove this. So a take is
a CANDIDATE: N per segment, each transcribed and measured, the best selected, a bounded repair
loop while blocking defects remain, fail closed — the ce-9 gate, applied to audio. The
transcript check is itself a model (speech-to-text), so its normalization is deterministic and
its thresholds are tuned in Phase 0 on ground-truth pairs; a NAME the STT cannot hear is an
advisory that shades selection, never a blocker on its own (§4.4).

### 3.3 A generated score is only coherent if it is generated ONCE and pinned

Generating music per BOOK would give twelve different composers per theme and no way to make
cue A crossfade into cue B. So the unit of generation is the per-theme SUITE: nine cues from
ONE fixed suite prompt (tempo, key, instrument palette, "no vocals, no heavy percussion, ends
naturally") generated in one session, judged, and elected create-if-absent under
`catalog-assets/music-suites/{AUDIO_VERSION}/{themeId}-{hash8}/` — the world-plate pattern.
Per book only the PLAN varies. The CC0 library V1 shipped is the fail-open floor (a cue that
cannot be elected falls back to the mood-mapped freepd file, with an advisory), never the
product.

### 3.4 Children's ears

Band 1-3 gets one voice (the narrator reads everyone — the board-book convention), fewer
music changes, no tension cue, no startling effect, longer gaps. Every sound cue in the
library carries `bands` and `startle` flags; a `startle: true` cue never plays under 4-5 and
always sits 6 dB lower. The startle gate (§4.8) measures the effect and music stems for any
100 ms window above −8 dBTP and attenuates it. Nothing here is a prompt line; it is a
property of the library and the mix.

### 3.5 The read-along needs a timeline, not a file

Page turns, sentence highlighting and "tap to turn the page" all need per-spread and
per-sentence timestamps. So the TIMELINE is a first-class artifact computed BEFORE the mix
(from the selected takes' measured durations and, where the provider returns them, word
alignments) and the mix graph is generated FROM it — the file can never disagree with the
timeline because the timeline made the file.

---

## 4. Core design

### 4.1 The audio script — a schema-validated performance plan (`audio/script.js`)

Inputs (all pinned): the validated story (`story.response.spreads[].text`, `title`), the
book definition from `getBookForTag` (beats, `refrain.text` + `refrain.spreads`,
`companion.name/type`, `worldName`), the theme's world-law card, `ageBand` + exact age, the
emotion plan (`buildEmotionPlan` from `illustrator/emotionPlan.js` — the same object the
illustrator pins; kill-switch shared), the normalized profile (child name), the story's
`personalization_evidence` (object / food / place / interest moments with their spreads), the
request's `dedication` (`heartfeltNote` + `bookFrom`, already on `/generate-book`), the
language, the resolved cast (§4.2).

Output (ajv-validated, `data/audio/schemas/audioScript.schema.json`):

```
{
  version: 'ab-1', language, band, castHash,
  segments: [
    { index, kind: 'intro'|'dedication'|'spread'|'outro', spread|null,
      lines: [
        { index, text,                       // manuscript text, verbatim
          speaker: 'narrator'|'companion',   // §4.1 dialogue rule
          direction: { emotion, intensity, pace: 'slow'|'even'|'brisk', shape: 'statement'|'question'|'exclaim'|'trail' },
          isRefrain: bool,
          pauseAfterMs }                     // deterministic from shape + band
      ],
      expectedWords, expectedSeconds: { min, max },   // words ÷ band wpm ± 40 %
      music: { cue, entryAt: 'start'|'gap', gainDb },  // §4.5 plan
      ambience: { bed, gainDb } | null,               // §4.6
      sfx: [ { cueId, anchorLine, placement: 'after'|'under', gainDb } ] }
  ],
  musicPlan: [...], sfxPlan: [...], hash
}
```

Rules, all deterministic and unit-tested over every catalog book × every band:

- **Sentence segmentation** is a pure function (`splitLines`): sentence-final punctuation,
  verse lines kept whole, and the VERBATIM-REQUIRED strings masked first (the child name,
  companion and world names, the refrain, evidence values — the `storyValidation.js` 5c mask)
  so "Jo Jo" and "choo choo" never split.
- **Direction** = `DIRECTION_TABLE[emotion][intensity]` (a fixed table of delivery words per
  provider-neutral cue: `joy/big` → bright, smiling, energetic; `wonder/soft` → hushed, slow,
  awed; `tenderness/*` → warm, close, gentle; `worry/clear` → careful, quieter, a little
  breathless — band 1-3 never sees `worry`, the emotion plan already substitutes `calm`)
  refined per line by `shape` (a `?` lifts, a `!` brightens, `…` trails) and per band by
  `pace` (1-3 slow ≈ 110 wpm, 4-5 even ≈ 125, 6-7 even ≈ 140, 8-10 brisk ≈ 150 — the numbers
  drive `expectedSeconds`, the duration gate's bounds).
- **The refrain**: every line equal to `refrain.text` on a `refrain.spreads` spread is
  `isRefrain: true`, direction pinned to ONE fixed refrain delivery for the book (warm,
  sing-song, slightly slower, `pauseAfterMs` longer), and the music plan places the
  `refrain_motif` cue 1.5 s before it. Its text is never a sound-cue anchor.
- **Dialogue**: a quoted span whose attribution clause names the companion (`said Farmer
  Bea`, `Bea laughed`) — the companion's name as a whole word, masked against the world and
  display names exactly as `companionOnSpread` does (ce-19) — is `speaker: 'companion'`;
  everything else, the child's own lines included, is the narrator (a synthetic child voice
  is out of scope, §10). Band 1-3 is narrator-only regardless. An ambiguous attribution
  stays narrator: the rule never invents a speaker.
- **Intro / dedication / outro** are fixed per-language templates, never model text: intro
  "{title}. A story for {name}." (1-3: "{title}." then "{name}'s story."); dedication reads
  the `heartfeltNote` as "{from} wrote: …" in the tender direction when present; outro "The
  end." + one fixed closing line per band. `Title page` / `Dedication` / spread numbers are
  never spoken.
- **Sound cues and the music plan** are §4.5-4.6; the script is the one object that carries
  them, hashed as `script.hash`.

**The optional director** (`CATALOG_AUDIO_DIRECTOR`, default ON, fail-open): ONE strict-JSON
Gemini call per story (the `emotionPlan.js` classifier pattern — `jsonQaGenerationConfig`,
thinking off) that returns, per line, a direction from the SAME enums, a speaker from the
same two values, and sound-cue ids from the spread's ALLOWED list only. Every field is
validated against the enums and merged OVER the table; anything else is dropped. It is a
classifier over a closed set: no free text ever reaches a provider from it.

### 4.2 The cast — pinned voices (`audio/cast.js`, `data/audio/cast.json`)

A house cast per language: three narrators (`storyteller_warm_f`, `storyteller_warm_m`,
`storyteller_bright`) and companion voices keyed by companion KIND
(`shared/illustration/companionKind.js` decides PERSON vs creature; the cast adds
`creature_small` / `creature_large` / `guide_adult_f` / `guide_adult_m` / `magical`), each
`{provider, voiceId, model, settings}` with a content hash. The default narrator per book is
deterministic — theme + band, seeded tie-break by the story fingerprint (`fnv1a`) — and the
request may override it (`cast.narrator`). The file is versioned: editing it changes the
cast hash, which folds into every take key (§4.9). Two rules: never a cloned customer voice
(§10), and a companion voice only from band 4-5 when `CATALOG_AUDIO_CHARACTER_VOICES` is on.

### 4.3 Takes — candidates behind a provider layer (`audio/narrate.js`, `audio/providers/`)

- Unit of synthesis: ONE request per segment (a whole spread, so prosody flows across
  sentences; split at sentence boundaries only when over the provider's limit). Companion
  lines are separate requests in the companion voice; the segment's audio is the ordered
  concatenation with fixed 250 ms joins, recorded in the timeline. (ElevenLabs' multi-speaker
  "text to dialogue" endpoint is the alternative — **verify** at bake-off whether it keeps
  the narrator's continuity better than stitching.)
- `CATALOG_AUDIO_TAKE_CANDIDATES` (default 2, clamped 1-3) candidates per segment,
  `CATALOG_AUDIO_CONCURRENCY` (default 4) segments in flight, every candidate stored at its
  OWN key (`takes/{takeHash}/c{K}.wav`, repair pass P at `r{P}c{K}.wav`) — a rejected repair
  never overwrites better audio (the #295 rule). Provider seed when supported.
- The provider adapter contract (`providers/index.js`): `synthesize({text, lines, direction,
  voice, language, seed}) → {wav, alignment?: [{word, start, end}], usage}`,
  `renderDirection(direction) → provider control` (v3 tags from a CLOSED map; a Gemini style
  prompt sentence; an OpenAI `instructions` string), `pronunciationAlias(name, alias)`
  (ElevenLabs pronunciation dictionaries; a respelling substitution elsewhere), `limits`.
  Adapters: `elevenlabs.js` (default — `eleven_v3`, audio tags, 70+ languages including
  Hebrew per the vendor's model page, timestamps endpoint, pronunciation dictionaries;
  **verify** tag reliability and Hebrew quality), `gemini.js` (`gemini-2.5-pro-preview-tts`:
  style prompts, two speakers, 24 languages — **verify** Hebrew is among them; billed on the
  existing Google account), `openai.js` (`gpt-4o-mini-tts`: `instructions`, cheapest), and
  `google.js` (Chirp 3 HD — the V1 control, plain text only). The registry refuses an adapter
  that is not built, the gv-1 rule. Secrets: `ELEVENLABS_API_KEY` on the revision, with the
  app's body-injected copy as the fallback (the `REPLICATE_API_TOKEN` pattern).
- **Name pronunciation** (`audio/pronounce.js`): once per (name, language, voice hash) the
  name is synthesized ALONE, transcribed, and compared after normalization (case, diacritics,
  NFD). On mismatch up to three respellings from ONE Gemini call ("respell for a {language}
  reader", strict JSON, closed shape) are each synthesized and transcribed; the first that
  passes is pinned as the alias in `catalog-assets/pronunciations/{lang}/{nameHash}.json`
  (create-if-absent) and applied through the adapter's dictionary channel. None passing ⇒
  advisory `name_pronunciation_unverified`; the take gate still prefers the candidate whose
  transcript contains the name. The alias file is the "outfit lock" of the voice: derived
  once, verified, pinned.

### 4.4 Verification per take — the aq-1 verdict (`audio/takeQa.js`, `audio/metrics.js`, `audio/select.js`)

Every candidate is checked; the verdict is written beside it as `.qa.json` with
`qaVersion` (`AUDIO_QA_VERSION`), so a replay under a newer checker re-checks.

1. **Transcript (BLOCKING class).** ONE Gemini audio call (`CATALOG_AUDIO_STT_MODEL`, default
   `gemini-2.5-flash` — the worker's QA family, keys in place; `jsonQaGenerationConfig`)
   returns `{transcript, spokenControlWords: bool, glitch: bool, mispronounced: [...]}`.
   Deterministic comparison (`shared/text/compareSpoken.js`, the `compareTexts` lineage:
   curly/straight quotes, NFD accents, numbers spelled out, direction tags stripped from the
   expected text): word-bag match ≥ 0.92, first AND last word present (the qa-6 edge rule),
   no run of ≥ 3 expected words missing, no expected word tripled, and no tag word
   (`whispers`, `excited`…) in the transcript that is absent from the text. Failing any ⇒
   `narration text mismatch` / `direction tag spoken aloud` (fixed strings). The child's
   name absent from the transcript when present in the text ⇒ ADVISORY `name not heard`.
2. **Duration (BLOCKING).** Measured seconds outside `expectedSeconds` ⇒ `narration
   duration off` — a 3× overrun is a hallucinated ramble, a 0.4× is dropped text; both are
   caught before the transcript is even consulted.
3. **Measured signal (BLOCKING).** `metrics.js` on the native WAV: leading/trailing silence
   trimmed (recorded as offsets, never re-encoded), internal silence > 2.0 s ⇒ `dead air`,
   any sample at 0 dBFS ⇒ `clipped`, RMS more than 4 dB from the book's running median ⇒
   ADVISORY `level outlier` (the ink-set-gate idea applied to level).
4. **Judged performance (ADVISORY).** The same audio call's closed fields: `reads_as ∈
   EMOTIONS`, `monotone`, `robotic_artifacts`, `too_fast`, `too_slow` — every one advisory
   and selection-shading, except `robotic_artifacts` which is BLOCKING `synthesis artifact`.

`classifyTakeDefects` splits BLOCKING / ADVISORY with FIXED strings; `select.js` scores
(blocking sinks below zero, advisories and the level/duration/name signals shade, unchecked
ranks below checked, the closer-to-expected-duration candidate wins ties), the best is
promoted to the segment's canonical key, and the repair loop runs ONLY while blocking defects
remain: `CATALOG_AUDIO_MAX_REPAIRS` (default 2) passes of N fresh candidates, each steered by
a fixed `repairNote` (restate the direction; drop the tag that was spoken; apply the elected
name alias; a new seed) down a ladder whose last rung is NO direction at all (the renderer's
`generic-safe` idea — a plainly read sentence beats a wrongly read one). Every candidate —
base, repair, gate re-take — draws on `CATALOG_AUDIO_BUDGET_PER_SEGMENT` (default 5). A
segment that exhausts it fails the book `audiobook_unresolved` (`CATALOG_AUDIO_SHIP_ON_EXHAUSTION=1`
is the OPT-IN to ship the best candidate with its findings — the default is the opposite of
the illustrator's, because a wrong word in a child's book is worse than a delay; §11).

### 4.5 The soundtrack — per-theme suites, per-book plan (`audio/music/`)

**Suites (`music/suites.js`).** Nine cues from a closed vocabulary — `theme_intro` (12 s,
the book's signature), `calm`, `playful`, `wonder`, `tender`, `gentle_tension`, `triumph`,
`lullaby_outro` (a real ending, ritardando), `refrain_motif` (a 3-4 s sting) — each
generated from a FIXED prompt: the theme's palette from `data/audio/musicPalettes.json`
(farm: warm acoustic guitar, fiddle, soft piano — never ukulele; under_the_sea: harp, glass
marimba, slow pads; space: soft synth pads, celesta, a hum; dinosaur: marimba, low woodwinds,
gentle drums; jungle: kalimba, hand percussion, flute; safari: kora, warm strings;
enchanted_forest: celesta, harp, strings; pirate: accordion, tin whistle, a soft drum;
construction: bright xylophone, brushed kit; dream: music box, pads; christmas: sleigh bells,
piano, strings; thanksgiving: acoustic guitar, warm piano), the world card's palette/era
words, one tempo and key per suite, "instrumental, no vocals, gentle, children's storybook,
loopable body, natural ending", the cue's fixed mood line. Provider layer
(`music/providers/`): `lyria.js` (Vertex AI on the existing GCP credentials — Lyria 3 Clip
30 s ≈ $0.04 / Lyria 3 Pro up to 184 s ≈ $0.08 per piece, Lyria 3.5 ≈ $0.006/s per the
vendor's page; SynthID watermark, artist-imitation guardrails — **verify** current model ids
and whether Vertex terms clear commercial redistribution, they do for generative media
generally), `elevenlabs.js` (Eleven Music ≈ $0.15/min, commercially cleared on paid plans —
**verify**), `library.js` (the nine CC0 freepd files, moved into
`data/audio/fallback/` — the floor). Per cue N=2 candidates, judged by ONE Gemini audio call
(closed: `has_vocals`, `heavy_percussion`, `mood_match`, `abrupt_ending`, `quality` 1-5) and
measured (LUFS, peak, duration, leading silence), elected create-if-absent
(`uploadBufferIfAbsent`) under `catalog-assets/music-suites/{AUDIO_VERSION}/{themeId}-{promptHash}/{cue}.wav`
+ `suite.json` (hashes, loudness, durations); a Catalog Studio overlay that renames a world
changes the prompt hash and elects a new suite, the world-plate rule. Fail-open per cue to
the library file with a `stage: 'music'` advisory.

**The plan (`music/plan.js`, pure).** Segment → cue by a CLOSED mapping from the pinned
(emotion, intensity): `joy`/`silly` → `playful`; `wonder`/`curiosity`/`surprise` → `wonder`;
`calm`/`tenderness` → `tender` or `calm` (alternating by position so the two never repeat
back-to-back); `determination`/`pride` → `triumph` on spreads ≥ 9, else `wonder`; `worry` →
`gentle_tension` (band ≥ 4-5; 1-3 never has `worry`). Invariants (unit-tested over every
catalog book × band): `theme_intro` under the intro and spread 1; `lullaby_outro` under
spread 12 and the outro; a cue holds ≥ 2 spreads; ≤ 5 cue changes per book (1-3: ≤ 3); the
`refrain_motif` fires 1.5 s before every refrain line; every change lands INSIDE an
inter-spread gap on a 3 s `acrossfade`, never mid-sentence. Gain automation is part of the
plan: −22 dB under speech (sidechain, §4.7), rising to −14 dB in any gap ≥ 1.5 s (the
"breathing" a good radio mix does), −18 dB ceiling, band 1-3 a further −3 dB.

### 4.6 Sound design — a closed, age-gated library (`audio/sfx/`)

**The library (`data/audio/sfxCues.json`).** About eighty cue ids in two layers: one
AMBIENCE BED per theme (`amb_farm_day`, `amb_reef`, `amb_space_hum`, `amb_jungle`,
`amb_savanna`, `amb_forest_magic`, `amb_ship_deck`, `amb_site_daytime`, `amb_dreamcloud`,
`amb_snow_night`, `amb_autumn_home`, `amb_dino_valley`) and SPOT cues, each
`{cueId, category: 'animal'|'water'|'weather'|'vehicle'|'magic'|'action'|'transition',
keywords: [...], themes: [...], evidenceTypes: [...], bands: [...], maxGainDb, maxSeconds,
startle: bool, prompt}`. The audio for each cue is generated ONCE from its FIXED `prompt`
(ElevenLabs Sound Effects, ≈ $0.12/min per the vendor's API page — **verify**; or a CC0
file for `library`), N=2 candidates judged (closed: `matches_description`,
`contains_voice_or_music`, `harsh_or_startling`, `quality`) and measured (peak, duration,
leading silence trimmed), elected create-if-absent under
`catalog-assets/sfx/{AUDIO_VERSION}/{cueId}-{promptHash}.wav`. A cue that cannot be
elected is SKIPPED with an advisory — the words never wait for a sound.

**Placement (`sfx/plan.js`, pure).** Per spread the candidate set is the union of: the
personalization evidence declared on that spread (an `object` evidence → the prop's cue if
one exists, e.g. a rubber-duck squeak — highest priority), the beat's whole-word keyword hits
(second), the spread text's whole-word keyword hits with the name masks applied (third); the
pick is bounded by the band quota (1-3: 1 spot per spread, 4-5: 2, 6-7 and 8-10: 3), priority
first, the seeded shuffle for ties only. Rules: a spot is anchored AFTER the sentence that
triggered it and the timeline widens that gap to `max(natural gap, 0.6 × cue seconds)`;
`under` placement is allowed only for the ambience bed and the `transition` category; never
inside a refrain line or the 1.5 s before it (the motif owns that); ≥ 4 s between spots; a
`startle: true` cue never in band 1-3 and always −6 dB; the same cue at most twice per book.
A fixed `transition_page` cue (a soft page turn, −20 dB) sits in every inter-spread gap —
the read-along's affordance (`CATALOG_AUDIO_PAGE_TURN=0`). The director (§4.1) may choose
among a spread's ALLOWED ids only; it can never add a cue the table did not offer.

### 4.7 The timeline and the mix (`audio/timeline.js`, `audio/mix.js`)

**Timeline (pure).** From the selected takes' measured, trimmed durations (and the provider's
word alignment when it returns one): intro → 1.2 s → dedication → 1.0 s → spread 1 … gaps
0.9 s (1-3: 1.3 s) widened for sound cues, `pauseAfterMs` inside segments honoured by the
provider's own pauses (verified by the duration gate, not inserted) → outro → 2.5 s tail
under the ending cue. Output `timeline.json`:
`{totalSeconds, spreads: [{spread, start, end, lines: [{index, start, end, text, speaker}],
sfx: [{cueId, at, gainDb}], music: {cue, from, gainDb}}], chapters: [...]}` — sentence times
are exact when the provider aligned words, otherwise interpolated by word share (the app's
player highlights sentences, never words; §10).

**Mix (argv builders, snapshot-tested, `execFile` — never a shell string).** One
`filter_complex`, generated FROM the timeline:

- narration stem: each take `atrim` to its trimmed bounds, `adelay` to its timeline start,
  `amix` (normalize=0) → `loudnorm` two-pass (measure, then linear) to −18 LUFS for the
  voice stem → `[voice]` and a `[sc]` split for the sidechain;
- music stem: each planned cue `atrim`/`aloop` to its span, `afade` in/out, cues joined with
  `acrossfade=d=3` at the planned gap, the plan's gain envelope as `volume` steps, then
  `sidechaincompress` keyed by `[sc]` (ratio 4, attack 250 ms, release 1200 ms, threshold
  tuned in Phase 0 to yield ≥ 12 LU below speech), band 1-3's extra −3 dB;
- ambience stem: `aloop` the bed, `highpass=120`, `lowpass=8000`, `volume=-30dB`;
- effects stem: each cue `adelay` + `volume` (its planned gain, capped at `maxGainDb`);
- master: `amix` of the four, `loudnorm` two-pass I=−16 TP=−1 LRA=9 (`CATALOG_AUDIO_TARGET_LUFS`),
  `alimiter`, MP3 192 kbps 48 kHz stereo `libmp3lame` (+ ID3 chapters per spread).

The music, ambience and effects stems are ALSO rendered alone (same automation) so the gates
can measure them inside the timeline's speech windows.

### 4.8 Book-level gates (`audio/gates.js`) — deterministic, corrected by re-mix

- **Loudness**: integrated within ±1 LU of target, true peak ≤ −1 dBTP — else one corrective
  master pass with the measured offset (a deterministic fix, never a re-synthesis).
- **Speech-to-music ratio**: for every spread, LUFS of the voice stem minus LUFS of the
  music stem inside that spread's speech windows ≥ 12 LU — else that cue's gain drops 3 dB
  and the mix re-runs (≤ 2 passes), then advisory.
- **Dead air**: no window > 2.5 s under −50 dBFS on the master — a violation means the
  timeline is wrong ⇒ `audiobook_mix_failed` (a bug, never shipped).
- **Startle**: no 100 ms window in the effects or music stems above −8 dBTP — else that cue
  is attenuated 6 dB and re-mixed, then dropped with an advisory.
- **The listen-through** (`CATALOG_AUDIO_LISTEN_QA`, ADVISORY): ONE Gemini audio call on the
  final mix (an excerpt of three spreads when the book runs over eight minutes) with closed
  fields — `intelligible`, `music_too_loud`, `sfx_distracting`, `pace ∈ enum`,
  `abrupt_transitions`, `overall` 1-5 — every finding a `stage: 'listenQa'` advisory and the
  verdict echoed on the callback as `gates.listen`. It never blocks; it is the bench's ear.

### 4.9 Storage, keys, replay

- `takeHash` = sha256 over {segment script (lines, directions, speakers), cast hash for the
  voices used, language, provider + model + settings, pronunciation alias hash,
  `AUDIO_VERSION`} → `children-jobs/{bookId}/audiobook/{AUDIO_VERSION}/takes/{takeHash}/`
  (`c{K}.wav`, `r{P}c{K}.wav`, `take.wav` the promoted canonical, `.qa.json`). A music-only
  change never re-synthesizes a take.
- `scriptHash` = sha256 over {story fingerprint (`illustrator.storyFingerprint`), every
  takeHash, suite hash, sfx library hash + elected cue hashes, mix rules hash,
  `AUDIO_VERSION`} → `children-jobs/{bookId}/audiobook/{AUDIO_VERSION}/{scriptHash}/`
  (`audiobook.mp3`, `timeline.json`, `stems/*.wav` kept 7 days, `manifest.json`).
- A re-dispatch without `forceNew` replays every finished take (a `.qa.json` at the current
  `qaVersion` and no blocking list) and rebuilds only what changed; `forceRetake` re-takes
  listed segments (the `rerenderSpreads` operation); `segments: [subset]` renders takes only,
  no mix — the admin's iteration loop. Signed URLs 30 days; the app re-signs from the keys.
- Elected assets live under `catalog-assets/` and are pinned per `AUDIO_VERSION` + prompt
  hash: delete the object to re-elect (the companion-sheet rule).

### 4.10 Languages

English at launch. Spanish and Hebrew in Phase 5 reuse the app's glossary-locked adaptation
(§2.9) — with verification added: the transcript gate runs in the target language, the
glossary's name forms are the masked verbatim strings, the cast carries per-language voices,
and a per-language intro/outro template replaces `uiPhrases`. Direction tables are
language-neutral (they describe delivery, not words). **Verify** at bake-off: Hebrew on
`eleven_v3` versus Gemini TTS (whose 24-language list may not include it) versus Google
`he-IL` Chirp 3 HD.

---

## 5. Worker changes

### 5.1 New module — `services/catalogEngine/audio/`

```
audio/
  index.js          generateAudiobook — the run (§5.2 order of work), AudiobookError
  script.js         buildAudioScript (+ splitLines, attributeSpeakers, direction tables), scriptHash
  cast.js           resolveCast, castHash; data/audio/cast.json
  director.js       the optional strict-JSON refinement over closed enums (fail-open)
  narrate.js        take candidates, concurrency, the repair ladder, budget
  pronounce.js      name checks + elected aliases (catalog-assets/pronunciations/)
  takeQa.js         the aq-1 verdict, classifyTakeDefects, repairNote (fixed strings)
  metrics.js        wav probes: trim offsets, silence, peak, RMS, LUFS (ebur128), ratio
  select.js         scoreTake, pickBest, residualBlocking
  timeline.js       buildTimeline (pure), chapters
  mix.js            buildMixCommand (pure argv) + runners; stems; ID3 chapters
  gates.js          loudness / ratio / dead air / startle / listen-through
  music/            suites.js (election), plan.js (pure), palettes → data/audio/musicPalettes.json,
                    providers/{index,lyria,elevenlabs,library}.js
  sfx/              library.js (election), plan.js (pure), data/audio/sfxCues.json,
                    providers/{index,elevenlabs,library}.js
  providers/        index.js (registry), elevenlabs.js, gemini.js, openai.js, google.js
data/audio/         cast.json, musicPalettes.json, sfxCues.json, fallback/*.mp3 (the CC0 nine), schemas/
```

Order of work in `generateAudiobook`: resolve story + book definition (`getBookForTag`,
`missing_book_definition` on a stale tag) → cast → emotion plan → audio script (+ director)
→ pronunciation checks → replay check per take → takes: candidates → QA → select → repair →
suite + sound library election (concurrent with the takes; fail-open) → timeline → mix →
gates → ship policy → upload → manifest → callback. 30 s progress heartbeats through the
book context (`createBookContext` / `touchActivity`) so the idle watchdog never kills a run
that is polling a music provider; `CATALOG_AUDIO_TIMEOUT_MINUTES` (default 20).

### 5.2 Endpoints

- `POST /v13/generate-audiobook` → 202 `{audioVersion, cast, accepted: {segments}}`; body
  `{bookId, dispatchId?, story: {request, response}, profile, language?: 'en'|'es'|'he',
  cast?: {narrator?, companion?: key|'none'}, dedication?: {text, from},
  audioTuning?: {versionLabel, hash, text}, segments?: [1..12 subset], forceNew?,
  forceRetake?: [subset], callbackUrl, progressCallbackUrl?}`. Validation before the 202
  exactly like `/v13/generate-coloring-book` (`BOOK_ID_RE`, `normalizeProfile`,
  `resolveStory` with the pair, a unique subset, http URLs); 409 `in_flight` while a run is
  live; 503 `audiobook_disabled`. `audioTuning` is the app-owned tuning layer for the
  narrator (direction lines only — it can add delivery notes, never words; capped 1500 B,
  echoed `audioTuningUsed` as `<label>.<hash8>` or `none`, killed by
  `CATALOG_AUDIO_TUNING_LAYER=0`; folded into the take hash).
- Callback (every key present on failure): `{audioVersion, qaVersion, scriptHash, cached,
  audiobookUrl, storageKey, timelineUrl, timeline, durationSeconds, bytes, loudness:
  {integratedLufs, truePeakDbtp, lra}, cast: {narrator: {key, provider, voiceId, model,
  hash}, companion: {...}|null}, script: {hash, director: 'table'|'llm', lines,
  companionLines}, audioTuningUsed, segments: [{index, kind, spread, storageKey, url,
  seconds, qa: {pass, blocking, advisory, wordMatch, transcript}, candidates, repairs,
  cached}], music: {provider, suite: {themeId, hash, fallbackCues}, plan: [{spread, cue,
  from, gainDb}]}, sfx: {libraryHash, placed: [{spread, cueId, at, gainDb}], skipped:
  [{cueId, reason}]}, ambience, gates: {loudness, speechMusicRatio, deadAir, startle,
  listen}, pronunciations: [{name, status, alias}], unresolved: [{segment, spread, defects,
  candidates: [{storageKey, url, score}]}], advisories, warnings, costs, failureCode,
  error}`. Failure codes: `audiobook_disabled` (503), `invalid_story`,
  `missing_book_definition`, `audiobook_provider_unavailable`,
  `audiobook_provider_input_rejected`, `audiobook_unresolved`, `audiobook_mix_failed`,
  `cancelled`.
- `POST /v13/audiobook-audition` (sync, ≤ 60 s): `{story, profile, language, cast,
  spread?: 1, withMusic?: true}` → one spread through the full take path with the suite's
  cue under it → `{url, wordMatch, seconds, cast}` — the Audio Bench's voice picker, later
  the customer's.
- `POST /v13/pick-take` `{bookId, storageKey}` (a `…/takes/{hash}/c{K}.wav` from an
  `audiobook_unresolved` payload) → promotes it with an admin-vouched marker; a re-dispatch
  replays it into the mix. `POST /v13/cancel-audiobook` `{bookId}`.

### 5.3 Dockerfile, envs, versions, cost rates

- `ffmpeg` is already in the image (gv-1); the mix needs `loudnorm`, `sidechaincompress`,
  `acrossfade`, `ebur128`, `libmp3lame` — all in Debian's build (a boot smoke check like
  `ebook-convert --version` in the main worker: `ffmpeg -filters | grep sidechaincompress`).
- `ELEVENLABS_API_KEY` (optional at boot; the app injects its copy per request), Vertex via
  the existing GCP credentials, `OPENAI_API_KEY` already present.
- `versions.js`: `AUDIO_VERSION = 'ab-1'` (owns `children-jobs/{bookId}/audiobook/{v}/…` and
  the `catalog-assets/{music-suites,sfx,pronunciations}/{v}/` election paths — bump on any
  change to the script rules, the direction tables, the cast file, a suite or cue prompt, the
  sound library, the music-plan or placement invariants, or the mix graph),
  `AUDIO_QA_VERSION = 'aq-1'` (the take verdict fields, thresholds and defect vocabulary).
- `flags.js`: `audiobookEnabled` (`CATALOG_AUDIOBOOK`), `audioNarratorProvider`
  (`CATALOG_AUDIO_NARRATOR_PROVIDER`, default `elevenlabs`), `audioNarratorModel`
  (`eleven_v3`), `audioTakeCandidates` (2, 1-3), `audioMaxRepairs` (2, 0-4),
  `audioBudgetPerSegment` (5, 1-10), `audioConcurrency` (4, 1-8),
  `audioCharacterVoicesEnabled`, `audioDirectorEnabled`, `audioTranscriptQaEnabled`,
  `audioSttModel`, `audioMusicEnabled`, `audioMusicProvider` (`lyria`|`elevenlabs`|`library`),
  `audioSfxEnabled`, `audioSfxProvider` (`elevenlabs`|`library`), `audioAmbienceEnabled`,
  `audioPageTurnEnabled`, `audioListenQaEnabled`, `audioTargetLufs` (−16),
  `audioShipOnExhaustion` (OPT-IN), `audioTimeoutMinutes` (20), `audioTuningLayerEnabled`.
- `costTracker.js`: `addAudioCharacters(model, chars)` and `addAudioSeconds(model, seconds)`
  with RATES `eleven_v3` (≈ $0.10-0.18 per 1k characters depending on plan — **verify**
  against the account's tier), `gemini-2.5-pro-preview-tts` ($0.08 per 1k characters),
  `gpt-4o-mini-tts` (≈ $0.015 per minute), `eleven_sfx` ($0.12/min), `eleven_music`
  ($0.15/min), `lyria-3-pro` ($0.08/piece), `lyria-3.5` ($0.006/s), and the Gemini audio
  input for STT/judging (audio tokens ≈ 32 per second at the flash input rate).

---

## 6. Cross-repo contract (what the app must do — detail in the companion doc)

1. Children books dispatch to THIS worker's `/v13/generate-audiobook` with the chosen story
   pair (`chosenStoryPair`), the normalized profile, the dedication, the language and cast
   from the request; adult chat books keep the main worker's `/generate-audiobook` (§9).
2. The completion callback lands on `POST /api/children/audiobook-callback` and is
   normalized into ONE sanitized record (`utils/audiobook.js`, the `giftVideo.js` shape:
   capped, control-char stripped, keys not URLs are the durable truth) stored as
   `storyContent.audiobook` and mirrored onto the existing `AudiobookGeneration` row
   (`audiobookUrl`, `durationSeconds`, `qcResults` ← `gates`, `workerMetadata` ← script/cast/
   costs, `finalMp3Hash`) so the entitlement flow (approve → publish, supersede) is unchanged.
3. The admin Audiobook card becomes the **Audio Bench**: cast picker with per-voice audition,
   language, the tuning textarea, Generate, a per-spread strip (seconds, word match, chips,
   play), the gates panel, `unresolved` → Pick take, Re-take a spread, approve / reject.
4. The player becomes the **read-along**: cover, the book's own spread illustrations turned
   by the timeline, sentence highlight, scrub by spread, speed, sleep timer, download; the
   customer token URL and the delivery email once approval un-suppresses it (Phase 4).
5. The V1 chapter builder is fixed to read `captionText` regardless (so the adult/legacy
   path and its tests stay honest) and the children branch of `/api/admin/audiobooks/generate`
   is retired once V2 ships.

---

## 7. Mechanics, cost, time

- **Per book (band 6-7, ~500 words ≈ 2,800 characters, 12 spreads):** takes 2 × 2,800 =
  5,600 characters ≈ $0.55-1.00 on `eleven_v3` (≈ $0.45 on Gemini TTS, ≈ $0.10 on OpenAI),
  repairs typically +20 %; STT + judging ≈ 30 Gemini audio calls ≈ $0.05; the director
  $0.01; music, effects and ambience are replays of elected assets (≈ $0); mix is CPU. **≈
  $0.8-1.5 per book, worst case ≈ $3**, against a $14.90 add-on. Wall clock: takes ≈ 2 min
  (4 concurrent), verification ≈ 1 min, mix + gates < 1 min — **4-6 minutes**, a first run on
  a theme +2-4 min while its suite elects (concurrent with the takes).
- **One-time:** 12 suites × 9 cues × 2 candidates ≈ 216 pieces ≈ $17 (Lyria 3 Pro) or
  ≈ $30 (Eleven Music by the minute); ~80 sound cues × 2 × ~6 s ≈ 16 min ≈ $2; casts and
  pronunciation aliases are per (name, voice) and pennies.
- **Replay:** a re-dispatch of an unchanged book is free; a cast change re-takes only the
  segments that voice spoke; a suite re-election re-mixes only.

---

## 8. What this plan deliberately does NOT do

- **No cloned parent voice.** Consent, verification and abuse-prevention for voice cloning
  are a product of their own; ab-1 ships a house cast only.
- **No synthetic child voice.** The narrator reads the child's lines.
- **No per-book generated music.** The suite is per theme (§3.3); per-book composition is a
  later experiment on top of the same plan.
- **No word-level karaoke** when the provider returns no alignment — sentence-level
  highlighting only; the timeline carries word times when they exist.
- **No manuscript rewriting for audio.** The words are the book.
- **No singing** of the refrain; it gets a motif and a fixed delivery.
- **No adult chat-book audiobooks** on this engine (§9).
- **No animated read-along / video.** The gift video is its own plan.

---

## 9. What stays in `giftmybook-worker`

`services/audiobookGenerator.js` keeps serving ADULT chat books (`/generate-audiobook` with
`audiobookProfile: 'adult'`) and the admin preview endpoint until a separate decision retires
them. Once V2 ships for children's books the `children` profile branches in that file
(`childrenPerformance`, `synthesizeSegmentIntro`'s spread/scene/title-page cases,
`mixWithMusicBed`, `pickBookMusicPath`, `MOOD_MUSIC`, `TTS_LOCALE_OVERRIDES`) are dead code
and go in a follow-up there; the nine CC0 files move into this worker as the fail-open
library (§4.5). Nothing on this branch touches that repo.

---

## 10. Order & tests

### Phase 0 — the bake-off (one week, no product code)

Six books (one per band, two extra themes) × narrators {`eleven_v3`,
`gemini-2.5-pro-preview-tts`, `gpt-4o-mini-tts`, Chirp 3 HD as the V1 control}, English,
each spread rendered with the same direction; scored blind by the owner (performance,
warmth, naturalness) and by the machine (word match, tags-spoken rate, name accuracy over 40
names, duration accuracy, artifact rate, latency, cost). Music: Lyria 3 Pro vs Eleven Music
vs the CC0 library on three suites, judged for mood match, loopability and the
`no vocals / no heavy percussion` compliance. Effects: Eleven SFX vs CC0 on twenty cues.
Outputs: the provider defaults, the STT thresholds (§4.4 on ground-truth pairs), every
**verify** above resolved, the cast file's first voices. A `scripts/audioBakeoff.js` runner
and its fixtures are the only code.

### Phase 1 — the narration (the biggest win; ships as "V2 narration-only")

`script.js` (+ tables, schema, tests over every catalog book × band: valid schema, dialogue
never invents a speaker, `isRefrain` exactly on refrain spreads, expected durations monotone
in words, masks hold), `cast.js`, `providers/elevenlabs.js` (+ one alternative), `narrate.js`,
`pronounce.js`, `takeQa.js` + `metrics.js` + `select.js` (classification tables, scoring,
synthetic-WAV fixtures: a sine + silence → dead-air and clip detection), `timeline.js`,
`mix.js` voice-only graph at −16 LUFS (argv snapshots; an end-to-end against a real ffmpeg
when `FFMPEG_PATH` is set: synthetic takes → an MP3 measured at −16 ± 1 LUFS),
`gates.js` loudness + dead air, `index.js`, the endpoint + callback (`__tests__/serverAudiobook.test.js`:
400s, 409, 503, the 202 shape), `pick-take`, versions/flags/rates, the app dispatch + record
+ Audio Bench v1 (companion doc).

### Phase 2 — the score

`music/suites.js` + providers + election (judge fixtures), `music/plan.js` (invariant tests
over all 228 × 4), the ducked mix graph + stems, the speech-to-music and startle gates, the
`refrain_motif`.

### Phase 3 — the sound design

`sfxCues.json` (a review pass on every cue's `bands`/`startle`), `sfx/library.js` election,
`sfx/plan.js` (invariants: quota, refrain exclusion, spacing, band restrictions; a 228-book
sweep reporting keyword coverage per theme), ambience, page turns, the listen-through judge.

### Phase 4 — the product (app)

The read-along player, customer delivery (un-suppress on approval), cart re-enable with
audition samples, Slack/email lines. Detail in the companion doc.

### Phase 5 — languages

Per-language casts, the adaptation re-wired to the V2 dispatch with the transcript gate in
the target language, intro/outro templates for `es`/`he`, bake-off of Hebrew voices.

---

## 11. Open decisions (defaults chosen — flag if you disagree)

1. **Narrator default: ElevenLabs `eleven_v3`.** Inline audio tags, 70+ languages including
   Hebrew, pronunciation dictionaries, word timestamps, seeds. Gemini TTS is the second
   adapter (Google billing, style prompts, two speakers) and OpenAI the cheap third; the
   bake-off can reverse this.
2. **Music default: Lyria on Vertex** (the existing Google account, SynthID watermark is
   fine for a private gift); Eleven Music second; the CC0 library the floor.
3. **Effects default: Eleven SFX** generated per cue prompt, elected once; CC0 second.
4. **Character voices ON from band 4-5**; band 1-3 narrator-only.
5. **Ship-on-exhaustion OFF** for audio (a wrong word is worse than a delay) — the
   opposite of the illustrator's #297 default.
6. **One MP3 + one timeline** as the deliverable; the player streams with range requests;
   no per-spread files for the customer.
7. **The intro says the child's name** ("A story for Emma"); the dedication is read when
   the order carried one.
8. **Target −16 LUFS stereo** (the streaming/podcast norm — this is app playback, not an
   Audible submission; ACX's −18 to −23 dB RMS is the alternative if a retail channel ever
   needs it).
9. **The page-turn sound ON** by default; the read-along's page turns are timed to it.
10. **The director ON** (one strict-JSON call per story over closed enums; fail-open).

---

## Appendix A — evidence index

| Finding | Where |
|---|---|
| App chapter builder reads `bodyText/body/text/left/right` only | `giftmybook-standalone/server/utils/childrenAudiobookChapters.js:15-22` |
| Catalog pipeline persists `captionText` | `services/catalogEngine/pipeline.js:425-431` |
| 400 "No story text found" / entitlement throw | `giftmybook-standalone/server/routes/admin/audiobooks.js:257`, `services/audiobookEntitlements.js:152` |
| Voice by theme regex | `giftmybook-standalone/server/utils/resolveChildrenAudiobookVoice.js:12-40` |
| Chirp3-HD: no SSML, plain text only | `giftmybook-worker/services/audiobookGenerator.js:17-20, 601-627` |
| Regex SSML (+2st on `!`, 140 ms after commas) | `giftmybook-worker/services/audiobookGenerator.js:560-598` |
| "Let's read {title}.", "Title page.", "Dedication." | `giftmybook-worker/services/audiobookGenerator.js:1012, 825-831` |
| Nine 60 s CC0 loops | `giftmybook-worker/audio/music/CREDITS.md` |
| One bed per book, constant `volume=0.26`, no ducking | `giftmybook-worker/services/audiobookGenerator.js:380, 840-876, 1118` |
| Five-minute looped "attachment" | `giftmybook-worker/services/audiobookGenerator.js:272-318`, `audio/music/attachments/manifest.json` |
| QC = duration + silencedetect | `giftmybook-worker/services/audiobookGenerator.js:334-362` |
| Timestamped output key, no hash/version | `giftmybook-worker/services/audiobookGenerator.js:1238` |
| `execSync` shell strings | `giftmybook-worker/services/audiobookGenerator.js:253, 265, 339, 861, 894, 1213` |
| Admin-only `<audio>` player | `giftmybook-standalone/client/src/pages/AudiobookPlayer.jsx` |
| `admin_only` delivery suppression | `giftmybook-standalone/server/services/audiobookEntitlements.js:17, 267, 360, 399, 414` |
| Google Studio price $160/M chars | `giftmybook-worker/services/audiobookGenerator.js:31-37` |
| The emotion plan this plan reuses | `services/catalogEngine/illustrator/emotionPlan.js` |
| The companion-name masks reused for dialogue | `services/catalogEngine/illustrator/scenes.js` `companionOnSpread` (ce-11/ce-19) |
| Create-if-absent election | `services/gcsStorage.js:42-51` `uploadBufferIfAbsent`; `illustrator/worldPlate.js` |
| The argv-only ffmpeg rule | `services/catalogEngine/video/ffmpeg.js` |
| Refrain text + spreads per book | `services/catalogEngine/data/catalog.json` (`refrain: {text, spreads}`) |
| World-law cards (the palette words the suite prompts use) | `services/catalogEngine/data/worldCards.json` |
