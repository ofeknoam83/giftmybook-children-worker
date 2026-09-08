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

These are operation/attempt limits, not a promise of a fixed dollar price. Provider retries, character-sheet creation, existing text repair and other legacy stages retain their own limits. Costs record newly charged work separately from available reuse counters.

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

## Local validation

Run the catalog regression suite, cost tracker and worker video route tests with mocked providers:

```sh
npx jest --runInBand --coverage=false __tests__/services/catalogEngine __tests__/services/costTracker.test.js __tests__/serverGiftVideo.test.js
```

The audiobook `audio/index.test.js` is CPU intensive (about three minutes in this environment) on both unchanged main and this branch. It can be run separately. Recovery tests exercise provider blocks, malformed results, transient outages, storage failures, interrupted reservations, durable budgets, changed dependencies and signed secondary approval. Existing grounding, nesting-box occurrence and catalog contract tests continue to run.
