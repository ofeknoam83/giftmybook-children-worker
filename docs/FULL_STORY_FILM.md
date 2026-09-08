# Full-story film (gfs-1)

The book admin can request `mode: "full-story"` on `/v13/generate-video`.
It speaks the full, pinned manuscript in order: narration for descriptions and
attribution clauses, distinct voices for the child, companion and other speakers.
All 12 shipped illustrations are required. Duration follows measured speech;
it is not capped to the former 10-second trailer. Legacy requests without `mode`
continue to use the trailer, including short Art Bench motion previews.

## Pipeline

1. Partition the manuscript into exact source slices. A strict JSON director
   assigns a stable cast from the existing house voices and expressive delivery.
   The model cannot rewrite spoken text. Reject missing, reordered or uncertain
   assignments and duplicate voices. Persist the screenplay before recording.
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
5. Animate with Kling Omni, 1080p, references, and native audio disabled. Drive
   each dialogue shot with the exact recorded WAV through pinned Sync Lipsync 2.
   Verify identity, props, motion, painted text, actor and lip sync; fail closed
   on unavailable checks or remaining defects. Save approved shots and pending
   vendor prediction IDs. Retrying resumes them. Two visual attempts per run,
   six total per failed shot; a fresh regeneration resets the attempt budget.
6. Assemble uniform video with cuts, avoiding overlaps that shorten dialogue.
   Build a separately timed soundtrack with leveled speech and licensed bundled
   scene music ducked under the voices. Keep floating-point mix headroom until
   limiting. Check final duration against the complete soundtrack before delivery.

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
story-object criticality keeps its reference. More than seven remaining references
still stops the run before scene checks, narration or animation; essential props
are never silently truncated. Changed reference sets invalidate affected film/shot
caches while preserving existing speech, artwork and unchanged reference sets.

Deploy the worker before the app. `POST /v13/video-capabilities` advertises
`full-story`; the app checks it before requesting a paid render, so an old worker
cannot silently return a trailer. No database migration is required.

Required services: existing GCS and Gemini configuration, Replicate credit, and
the configured speech provider's credentials. ElevenLabs is the existing default;
the app now includes `ELEVENLABS_API_KEY` in injected worker keys. Optional request
fields: `voiceProvider` (`elevenlabs`, `gemini`, `openai`), `language` (`en`, `es`,
`he`), and `music` (`story-score`, default, or `none`). This is a fictional house
cast, not a clone of the child's voice.

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

Spend is tracked by generated video seconds and synthesized characters. Current
CostTracker rates are estimates, not a provider invoice; new models use its
unknown-model estimate until account-specific rates are configured. Full films
cost substantially more than the old trailer. No paid generation was used for
implementation tests. A real book must undergo visual/listening acceptance before
customer delivery, especially stylized animal lip sync and supporting actors.

## Verified model contracts

- [Kling Omni input schema](https://replicate.com/kwaivgi/kling-v3-omni-video/api/schema),
  checked 2026-09-07: `reference_images` (up to 7), `<<<image_N>>>` mentions,
  `start_image`, `duration` (3–15), `mode: pro`, `generate_audio: false`.
  The hosted prompt limit is 2500 characters. Unsupported guessed element fields
  from the legacy trailer are not used by this profile.
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
