# Full-story film (gfs-2)

The book admin can request `mode: "full-story"` on `/v13/generate-video`.
It speaks the full, pinned manuscript in order: narration for descriptions and
attribution clauses, distinct voices for the child, companion and other speakers.
All 12 shipped illustrations are required. Duration follows measured speech;
it is not capped to the former 10-second trailer. Legacy requests without `mode`
continue to use the trailer, including short Art Bench motion previews.

## gfs-2 (2026-09-09): silent characters, cheaper shots, a real soundtrack

Four findings on the first delivered films, each fixed structurally.

1. **Characters spoke the narrator's words.** Under a narrated passage a
   character's mouth moved in a talking rhythm — reading, to the viewer, as the
   character speaking the narration. Two causes. (a) The shot brief's DATA block
   carried the WHOLE spread text, quotations included: given `“Hello!” said Jo`
   the video model animated Jo saying hello, on the narrated shot and on every
   other character's dialogue shot alike. The brief now describes the scene
   with every quotation removed (`maskQuotedSpeech`) and carries only the
   shot's OWN spoken passage verbatim; a narrated shot states silent acting in
   positive terms ("nobody talks in this shot; every character's lips stay
   closed and still from the first frame to the last") without the words
   narrator / voiceover / speak that prime a talking mouth, and its negative
   prompt names talking, moving lips and open mouths (Kling Omni's input does
   not take a negative prompt — the field rides the other profile and
   `CATALOG_VIDEO_MODEL_INPUT_JSON`). (b) Nothing judged the result: the
   `checkPerformance` judge existed but was never called. Every animated shot
   is now judged before acceptance — a narrated shot by `checkNarrationSilence`
   (a clear talking rhythm is the fixed defect; a smile, gasp, laugh or yawn is
   not, and doubt is not a defect), a dialogue shot by `checkPerformance` after
   its lip sync (the named character speaks, every other mouth stays closed,
   the sync follows the words) — and a flagged shot spends a repair render in
   the existing bounded loop with the defect fed back (`Repair these observed
   defects: …`), two per run, six in total per shot, failing
   `film_scene_unresolved` with the defect named when exhausted. A judge outage
   never blocks a film: the shot ships marked `unchecked` with a `visualQa`
   advisory, is re-judged (a cheap call, no new motion) on the next resume, and
   the callback's `visualQa` carries `{status: pass|partial|not_run, checked,
   unchecked, repaired}`. Kill-switch `CATALOG_FILM_VISUAL_QA=0`.
2. **Cost.** Kling bills per generated second, so the film buys fewer seconds
   at a cheaper tier and reports what it will buy. (a) `CATALOG_FILM_VIDEO_QUALITY`
   (default `std`, 720p) is the tier every shot is bought at — about half the
   `pro` (1080p) per-second rate on Kling's price list; the film is assembled
   at 1080p either way. A request's `quality: 'std' | 'pro'` overrides it per
   film; the tier folds into every shot key, so std and pro motion never
   replay each other, and the cost table bills `kwaivgi/kling-v3-omni-video:std`
   beside the bare (pro) id and `sync/lipsync-2`. (b) `speechShots` packs a
   take into BALANCED whole-second shots of 3–15 s — a 29 s take used to buy
   14 + 14 + 3 (a stub for the last 1.3 s of speech); it buys 15 + 15 — and
   every shot is exactly as long as the second the vendor bills, so the pause
   at its end is film time already paid for (and where the sound cues live)
   instead of a discarded fraction. (c) Before the first purchase the run logs
   and reports `spend` — `{quality, shots, dialogueShots, animatedSeconds,
   lipsyncSeconds, estimatedUsd}` from the rate table — on the checkpoint and
   the callback, so the admin sees the bill before it exists. Speech takes are
   pinned by `FILM_CAST_VERSION` and survive the gfs-2 bump; the gfs-1 motion
   (talking mouths) does not replay.
3. **The music was boring.** The film scored every spread with one of nine
   CC0 ambient loops chosen by that spread's emotion — a per-spread flip-flop
   of generic beds. The score is now the audiobook's own: the per-theme music
   SUITE (Lyria / Eleven Music, elected once per theme, shared with the
   audiobook, the CC0 file only as the per-cue fallback) under the audiobook's
   cue grammar — theme_intro and lullaby_outro bookends, ≥ 2-spread holds,
   the band's change cap, no gentle_tension under 4, the refrain motif 1.5 s
   before the refrain passage — laid on the film's clock with 3 s crossfades
   centred on the cuts (`filmSoundtrack.js`: `planFilmCues` is pure over the
   screenplay, so the assets are elected while the takes record;
   `layFilmSoundtrack` is pure over the measured shots), sidechain-ducked
   under the voices by the audiobook's mixer.
4. **No sound effects.** The audiobook's CLOSED sound library now places its
   cues on the film: the theme's ambience bed under the whole film, and spot
   cues by evidence > beat > text keyword (band quota, two uses per book,
   never on the refrain), each starting 0.15 s after its anchored passage ends
   — inside the pause the whole-second shot paid for — spaced ≥ 4 s and never
   over a spoken word (`validateFilmSoundtrack`). The master is MEASURED to the
   audiobook's loudness target and limited; the effects and music stems are
   held to the startle rule. The callback's `soundtrack` carries the suite,
   the cue spans, the placed cues, the bed and the loudness; the film hash
   folds the plan and the elected assets, so a newly elected suite is a new
   mix, never a re-bought shot. `music: 'none'` drops the score and the
   motif; `CATALOG_FILM_SFX=0` drops the cues and the bed.

## Pipeline

1. Partition the manuscript into exact source slices. A strict JSON director
   assigns a stable cast from the existing house voices and expressive delivery.
   The model cannot rewrite spoken text. Assignments are matched by fragment id
   (their order is free); every SPOKEN fragment needs exactly one certain
   assignment to a cast id with an emotion from the vocabulary, while a
   whitespace/punctuation-only fragment — the splitter leaves one after every
   quoted sentence — is never spoken and needs none. Mechanical slips are
   normalized, never guessed: a cast member's name in place of its id, `certain`
   as the string "true", an emotion in the wrong case. Duplicate voices and an
   unknown cast are rejected. A screenplay that still fails goes back to the
   director ONCE (`CATALOG_FILM_DIRECTOR_REPAIRS`, default 1) with the exact
   failing fragments — id, spread, text, reason — for a complete corrected
   screenplay; a fragment it still cannot resolve fails `film_script_ambiguous`
   naming the fragment's text (before 2026-09-08 one blank fragment marked
   uncertain, or one emotion outside the list, failed the whole film with no
   second ask and a message that named only the fragment number). Persist the
   screenplay before recording.
2. Use the existing narration adapters, take QA and bounded repair ladder.
   Full-film takes require the complete normalized transcript, including on
   cache replay. Character voices are enabled for every age band.
   Exact-text replay also requires a checked verdict with no blocking defects;
   an admin pick or matching transcript alone cannot approve an unchecked take.
   A failed passage retry keeps the canonical key but gets fresh synthesis seeds
   and distinct candidate paths, preserving earlier attempts. Temporary verifier
   failures get one additional check on the same recording within each candidate;
   disabled or persistently unavailable checks still stop delivery.
3. Partition measured PCM audio into frame-aligned shots, each 3–14 seconds,
   preserving every source sample. Use quiet boundaries for long passages.
4. Keep all 12 scenes; re-render embedded-text illustrations through the
   text-free production path. Pin character/companion/prop sheets. Render
   separate scenes concurrently (three), but shots within one scene sequentially:
   each continues from the preceding shot's actual last used frame.
5. Animate with Kling Omni at the run's tier (`std` by default, gfs-2),
   references, and native audio disabled. Drive each dialogue shot with the
   exact recorded WAV through Sync Lipsync 2. Judge every shot before accepting
   it (a narrated shot: no talking mouths; a dialogue shot: the named actor,
   other mouths closed, the sync) and re-animate with the defect fed back; a
   judge outage ships the shot flagged, never silently. Save approved shots and
   pending vendor prediction IDs. Retrying resumes them. Two animation attempts
   per run, six total per failed shot; a fresh regeneration resets the budget.
6. Assemble uniform video with cuts, avoiding overlaps that shorten dialogue.
   Build a separately timed soundtrack: leveled speech, the theme's music suite
   under the cue grammar (crossfaded, sidechain-ducked), the ambience bed, the
   placed sound cues and the refrain motif; measure the master to the loudness
   target, then limit. Keep floating-point mix headroom until limiting. Check
   final duration against the complete soundtrack before delivery.

## Deployment and operation

Scene recovery makes one bounded corrective pass when the final cross-spread
check finds a confirmed critical-object design mismatch, then verifies the whole
selected set again. It repairs only flagged, verified scenes, retains the original
artwork and writes repair candidates in a separate `ocr-1` namespace. Existing
per-spread and contact-repair budgets still apply. Unavailable checks never trigger
this repair pass, and an unchecked repair cannot replace a checked original.

Completed image-generation failures record a durable failure marker. Their slot
still counts against the budget, but a later retry can use the next slot without
mistaking the failed call for a live 15-minute reservation. Live and ambiguous
reservations remain protected; saved provider refusals retain their review hold.
Video errors report a missing scene verdict once instead of repeating an
unverified-object error for every object. Provider blocks explicitly direct the
admin to inspect saved evidence; repeatedly resuming unchanged requests cannot
clear them or approve the artwork.

Video reference images retain the child, companion and plot-critical story props.
Decorative personalization props and story objects explicitly marked noncritical
are omitted from the video request, using the pinned story-object plan. The book's
artwork, illustration references and quality checks remain unchanged. Omitted props
are recorded in the film checkpoint, worker log and result warnings. Unknown
story-object criticality keeps its reference. Kling counts PICTURES per request —
the start frame and every reference image together, seven at most (vendor error
1201, 2026-09-08: a shot that sent one start frame + seven sheets was refused) —
so each shot attaches at most six references, selected for ITS scene: the child's
sheet always, the companion next, then the essential props with a required
story-object occurrence on that spread, then props merely mentioned there, then
the rest in kit order (`shotReferenceSheets`). A kit that fits is sent exactly
as before, so its cache keys hold; a kit that does not is split by scene rather
than refused, and every omission is loud — the worker log, the film checkpoint
(`shotReferences`) and the result warnings name the spread and the props. Nothing
is lost from the picture: the start frame is the scene's own verified illustration
and already shows the prop; the reference only guards its design during motion.
`CATALOG_VIDEO_MAX_IMAGES` overrides the vendor limit when it changes. Changed
reference sets invalidate affected film/shot caches while preserving existing
speech, artwork and unchanged reference sets.

Deploy the worker before the app. `POST /v13/video-capabilities` advertises
`full-story`; the app checks it before requesting a paid render, so an old worker
cannot silently return a trailer. No database migration is required.

Required services: existing GCS and Gemini configuration, Replicate credit, and
the configured speech provider's credentials. ElevenLabs is the existing default;
the app now includes `ELEVENLABS_API_KEY` in injected worker keys. Optional request
fields: `voiceProvider` (`elevenlabs`, `gemini`, `openai`), `language` (`en`, `es`,
`he`), `music` (`story-score`, default, or `none`) and `quality` (`std`, the
worker's default, or `pro`). This is a fictional house cast, not a clone of the
child's voice. The score and the sound cues need the audiobook's providers
(Lyria on Vertex via `GOOGLE_CLOUD_PROJECT`, or Eleven Music; ElevenLabs sound
generation) — without them the music falls open to the CC0 library per cue and
the cues are skipped, each with an advisory.

The full-film budget is 256 shots / 30 minutes of output and a three-hour run
deadline; exceeding it fails explicitly without shortening the manuscript.
Progress heartbeats keep the app's 20-minute *inactivity* watchdog informed.
Finished shots can be resumed after failure. Vendor work may continue after
cancellation; persisted prediction IDs allow the next attempt to collect it.

Audio failures report their actual blocking defects (such as clipping, duration,
or text mismatch). `film_audio_verification_unavailable` distinguishes an absent
verdict from defective speech. The failure callback's `unresolved` entries retain
the passage/spread, expected text, observed transcript, measurements, take key,
candidate keys and verifier error for diagnosis. They never include API keys.
Retry video preserves verified passages; no complete-story regeneration is needed
to retry a failed recording. The exact normalized-transcript requirement remains.

Text-free still preparation reuses clean, current QA markers. Missing, malformed,
or failed scene verdicts are rechecked on the saved image; a malformed or transiently
unavailable checker gets one additional attempt with field-specific feedback and
more output room, using the exact same pixels and references. No missing verdict
field is inferred as a pass. Only a usable verdict with actual blocking defects
enters the existing bounded image-repair loop, including when the book's automatic
completion policy previously retained that image. Set repairs preserve an image
while its per-scene checker is unavailable. These options apply to full-film still
preparation; the ordinary book completion policy is unchanged.

`film_scene_unresolved` includes each affected spread, its actual defects or
unavailable-check reason, storage key and available candidate evidence. An unusable
scene verdict blocks animation even without a critical story-object requirement.
Retry video keeps approved audio and clean scene images; a checker format error
alone does not require buying replacement illustrations.

Spend is tracked by generated video seconds (per tier), lip-synced seconds and
synthesized characters, and estimated BEFORE the first purchase (`spend` on the
callback). Current CostTracker rates are estimates, not a provider invoice — the
std tier is entered at half of pro, the lip-sync rate as summarized in 2026-09;
verify both on the hosts' pricing pages before invoicing. Full films cost
substantially more than the old trailer; at the std tier about half of what
gfs-1 films cost. No paid generation was used for
implementation tests. A real book must undergo visual/listening acceptance before
customer delivery, especially stylized animal lip sync and supporting actors.

## Verified model contracts

- [Kling Omni input schema](https://replicate.com/kwaivgi/kling-v3-omni-video/api/schema),
  checked 2026-09-07: `reference_images`, `<<<image_N>>>` mentions,
  `start_image`, `duration` (3–15), `mode` and `generate_audio: false`.
  `mode` is `standard | pro | 4k` — corrected 2026-09-09 from the vendor's
  own 422 (`input.mode: mode must be one of the following: "standard",
  "pro", "4k"`), which had failed every full-story film after its stills,
  sheets, screenplay and voice takes were already paid for: our internal
  tier vocabulary is `std | pro`, and `klingMode` in
  `video/providers/models.js` maps it (`std` → `standard`) so an internal
  label never reaches the vendor unmapped. gfs-2 buys `standard` by
  default. Any 422 that still names a field is now CORRECTED and
  resubmitted rather than failing the run (`video/providers/inputRepair.js`:
  the value is mapped onto the vendor's listed values, else the field is
  dropped so the model applies its own default — never `prompt` or
  `start_image`, and the end frame stays the last resort); each correction
  rides the run as a stage `video` advisory, and a repair that touched the
  tier field bills the shot at the default tier instead of `:std`. Whether the Omni schema accepts
  `negative_prompt` was not verified (the host was unreachable on 2026-09-09),
  so the film's negative prompt is NOT sent to Omni; add it through
  `CATALOG_VIDEO_MODEL_INPUT_JSON` once verified.
  The hosted prompt limit is 2500 characters. Unsupported guessed element fields
  from the legacy trailer are not used by this profile. The vendor's picture
  limit is SEVEN per request counting `start_image`, `end_image` and every
  `reference_images` entry together (Kling error 1201 on 2026-09-08, "The
  number of images and elements exceeds the limit, max number is 7"); the
  profile's `imageLimit` and `imageBudget` (providers/models.js) hold every
  request to it, and the input guard is the last line.
- [Sync input schema](https://replicate.com/sync/lipsync-2/api/schema), checked
  2026-09-07: `video`, `audio`, `sync_mode`, `active_speaker`, `temperature`.
  Version is pinned in `filmPerformance.js`; `silence` avoids looping or cutting
  off supplied dialogue when the vendor video has a longer tail.

## Validation

Video, speech-take, API and app integration tests cover all-scene delivery,
exact transcript handling, distinct cast below age three, sample-preserving long
audio splitting, wrong-speaker failure, saved prediction resume, heartbeat guards,
long plan persistence, and worker capability negotiation. No live vendors or DB
are contacted by these tests.

The real FFmpeg smoke test uses synthetic motion and sound and confirms a film
over 30 seconds preserves its last audio segment and expected total duration:

```sh
FFMPEG_PATH=/path/to/ffmpeg npm test -- --runInBand --no-coverage \
  __tests__/services/catalogEngine/video/filmMedia.integration.test.js
```
## Spoken spelling ambiguity

The complete-text gate compares every word in order. A bounded, same-recording
audio check can resolve up to four spelling substitutions when the word counts
match and the sequence was not reordered. The checker must confirm that each
substitution has the same pronunciation in context and that the complete passage
is audible. Missing/extra words, other audio defects, uncertainty, and failed
checks remain blocked. There is no edit-distance allowance or transcript rewrite.

The saved spelling verdict includes hashes of the manuscript, raw transcript,
recording bytes, language, and the checker version. Resume can verify an existing
text-only failure before requesting new synthesis, and reuse a valid saved
verdict. Fresh regeneration still requests new takes.
