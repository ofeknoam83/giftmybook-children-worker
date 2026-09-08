# Children’s illustration and film verification recovery

## Behavior

Story objects have a reference contract (`single`, `group`, `assembly`, or `scene`) in addition to their frozen design and manuscript-grounded occurrences. Living groups, nesting-box assemblies and contextual clues no longer inherit the single-subject/two-view rule. The generator, reference judge, spread judge and object contact sheets share that contract. Counts and scene changes come from the manuscript; a reflection is not an extra physical instance. Character and companion identity references remain separate.

Existing elected identities remain readable. Missing references receive a typed contract before image generation. Typed reference candidates and their complete verdicts are retained before a verified reference is elected. Group and contextual consistency checks use full scenes where a small object crop would remove the relationship being checked.

`visualJudge` classifies provider blocks before JSON parsing. It distinguishes configuration failures, transient transport failures, truncated/malformed responses and complete verdicts. An unavailable check neither approves a page nor triggers replacement artwork. Required checks remain blocking, including when the legacy ship-on-exhaustion switch is enabled. Books waiting on these checks return `visual_recovery_pending` with saved evidence; the paired app stores `needs_review` and a recovery record instead of a customer-facing generation failure.

## Durable limits and reuse

- A verification fingerprint covers the full original instructions, image bytes, model and verifier version. Requests, claims and results are private GCS objects. At most two verifier attempts are reserved per fingerprint; a provider block stops immediately. A transient error waits for the app’s bounded retry dispatcher. A malformed result gets one complete recheck with validation feedback. Interrupted reservations consume their attempt.
- Each typed reference has up to three saved candidate slots: initial, corrective and simpler contextual composition. No failed reference is silently elected. Image-provider transport retries remain bounded by the existing renderer.
- Scene candidate reservations share `CATALOG_RENDER_BUDGET_PER_SPREAD` (default 3) across repairs and worker restarts. A changed repair prompt does not reset that budget. Explicit new artwork uses its own dependency namespace. Interrupted/exhausted attempts are not labelled confirmed visual defects.
- Spread dependencies include the fixed child kit, style, outfit, world, companion and the objects/state relevant to that spread. Updating one story-object reference rekeys its dependent spreads. Compatible legacy render paths and QA markers are still read. A manuscript, identity or global styling change can legitimately invalidate more work.
- Existing full-scene checks and candidate scoring continue to enforce identity, object state, anatomy, text, composition and aesthetics. Deliberately wrong or incompletely checked images do not become passing images through recovery.

These are operation/attempt limits, not a promise of a fixed dollar price. Provider retries, existing text repair and other legacy stages retain their own limits. Costs record newly charged work separately from available reuse counters.

## Character-sheet recovery

Character sheets now use the same typed verification and review state. The old ten-minute in-memory failure cooldown is removed. `CATALOG_SHEET_CANDIDATES` is a durable TOTAL image limit (default 3, bounded 1–4): one initial sheet, then targeted repairs of verified defects, stopping at the first sheet that passes every required check. Retries, process restarts and changed repair feedback do not reset that budget. A known completed render failure can advance to the next slot immediately. An active or ambiguous render reservation still prevents duplicate purchases until the request deadline plus 30 seconds has elapsed; this is not a failure cooldown.

Candidate PNGs, complete verification requests/results and per-candidate verdict summaries are saved under a content-scoped `.recovery-v1` directory before election. A checker outage keeps the same image for its bounded recheck; a provider block stops and uses the existing exact-evidence admin review rules. Exhausted repairs retain the original findings in `needs_review`; they never elect an unchecked sheet. The admin evidence panel shows every saved sheet and its concrete clothing findings.

Generation and QA explicitly separate visible cover clothing from consistent completion of cropped hems/legs/shoes, held story props, and lighting. A cover-outfit rejection must include a visible garment, attribute, expected detail and observed difference. Missing/contradictory evidence is an unavailable judgment, not permission to redraw or approve. A repair carries the approved cover as authority and the previous sheet solely as a repair source, preserving correct identity and inferred clothing. Photo likeness remains advisory; cover identity, outfit, anatomy, layout, text and minimum cover likeness remain required.

The elected sheet paths/style version are unchanged, so previously verified character sheets and downstream artwork remain usable. Only previously missing sheets get this new recovery namespace. Historical rejected images were not retained and cannot be recovered retroactively. After deploying both changes, resume Karina book `7d27b971-c2c4-4ed9-bbf3-4d3ba7863780` for a controlled visual check; implementation tests use mocked providers and do not establish generated artwork quality.

## Film preparation

The full film prepares and checks its text-free scenes before recording missing speech or buying motion clips. It retains exact-text narration checks. Blocked scene checks preserve approved audio and clean scenes. A private screenplay-scoped `.resume.json` records frames, references, approved takes and outstanding work; the existing media and verdict caches remain the authoritative resume mechanism. Shot cache keys depend on their audio/frame/direction/references instead of the whole film’s frame set.

Previously completed film manifests remain readable. Approved partial clips under the legacy whole-film key are migrated when that exact film hash still matches and the clip bytes match their passing marker. Old unverified or incompatible clips cannot supply approval. Narration and still cache keys are preserved.

## Reviewed secondary verifier

The only secondary destination is Google `gemini-2.5-pro`. It is **disabled unless both** `CATALOG_QA_SECONDARY_MODEL=gemini-2.5-pro` and a separate `VISUAL_REVIEW_SECRET` of at least 32 characters are configured on the worker and app. Use the same secret on both; never reuse the generic worker API key. No secret is included here.

An active admin must inspect the saved evidence and approve the exact blocked fingerprint in the paired app. The app signs a short-lived attestation binding the admin, book, evidence key, fingerprint and destination. `/v13/review-visual-check` requires both worker authentication and that attestation. The worker recomputes the saved request hash and requires a recorded provider block before accepting the review. Caller-supplied reviewer names or a worker API key alone cannot authorize it.

Only then can a later resume submit the **same complete original request**, including any child/reference images and story instructions, to Gemini 2.5 Pro. The same full verdict validator applies. Safety settings are unchanged; a secondary block stops further routing. Accepted attestations are durable, but disabling configuration or rotating the secret invalidates their use. No model is called by the approval endpoint itself.

Model and block semantics: [Gemini 2.5 Pro](https://ai.google.dev/gemini-api/docs/models/gemini-2.5-pro), [Google safety feedback](https://ai.google.dev/gemini-api/docs/safety-settings).

## Coordinated rollout

Deploy with the standalone app’s children visual recovery change. No database migration is needed. Configure the fallback only after the admin review flow is available. Unset its model or secret to disable secondary routing. `CATALOG_VISUAL_RECOVERY=0` disables the production book’s new strict recovery/render path; typed reference handling remains compatible and does not elect rejected sheets. The app’s automatic dispatcher can independently be stopped with `CHILDREN_VISUAL_RECOVERY=0`.

No production configuration, deployment, private evidence transfer or paid generation was performed for this implementation. Existing failures acquire new durable records when explicitly resumed under the new worker; historical unsaved requests must not be represented as exact reproductions.

Before broad rollout, run a controlled visual pilot on firefly book `31f8bad7-e559-4a7e-8e45-9d936d020390`, marker book `6979a16e-d8c9-42af-a09e-f8874c3f7e97`, and representative singles/groups/assemblies/reflections across ages and languages. Review identity, story comprehension, anatomy and visual appeal; compare completion, review rate, cost and time. Structural catalog tests cover 228 definitions across 12 themes, but cannot establish the beauty or correctness of newly generated images. Unresolved checks remain review tasks and are not counted as successful completion.

## Scene presence and negated mentions

The shared children's illustration pipeline now checks occurrence visibility against the complete final manuscript, independently of the elected design plan. It distinguishes `visible`, `absent`, `off_screen`, and `optional`. Explicit absence is a scene requirement: “No meerkat group” must not trigger a missing-group repair, while an empty nesting box can still be a required visible box. Heard, recalled, imagined and concealed subjects are interpreted in context; partial visibility, viewpoint and mixed instance states remain part of the scene contract. A named companion stays distinct from a family of the same species.

This text-only check uses the existing Gemini QA model and durable verifier. It runs for new plans and cached plans, including reviewed-art rebuilds and text-free film scene preparation. A successful result is reused; malformed or interrupted responses have a saved two-attempt budget. A provider block or unavailable check retains the manuscript/artwork through typed recovery rather than becoming a visual defect or buying new images. No child/reference image is sent by this new planning check.

Original definitions, reference sheets and render namespaces remain fixed. The corrected plan retains `renderObjects` for existing image locations; each spread's `storyPresenceHash` in its QA marker records the independently checked scene contract. Missing or changed hashes trigger a check of existing pixels before any image repair. Prompts, spread QA, final critical-object checks and contact sheets all use the corrected occurrence states. Absent/off-screen families are not inserted from reference sheets; unexpectedly visible families require removal. Unrelated personal-prop and other quality findings remain blocking during an object-only recheck.

The correction is worker-only, requires no database migration or new configuration, and is not an automatic regeneration of existing books. After deployment, resume saved work on `671aec39-cb8d-4d5c-9b7d-66067750ef11` to validate the existing spread 5 illustration against its absence requirement. Keep the other artwork and inspect the resulting book as the visual pilot. Unit/regression providers are mocked, so passing tests establish state handling and reuse, not a guarantee of model judgment or artwork quality.

## Local validation

Run the catalog regression suite, cost tracker and worker video route tests with mocked providers:

```sh
npx jest --runInBand --coverage=false __tests__/services/catalogEngine __tests__/services/costTracker.test.js __tests__/serverGiftVideo.test.js
```

The audiobook `audio/index.test.js` is CPU intensive (about three minutes in this environment) on both unchanged main and this branch. It can be run separately. Recovery tests exercise provider blocks, malformed results, transient outages, storage failures, interrupted reservations, durable budgets, changed dependencies and signed secondary approval. Existing grounding, nesting-box occurrence and catalog contract tests continue to run.
