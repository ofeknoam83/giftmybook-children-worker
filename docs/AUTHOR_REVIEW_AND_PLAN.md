# Author + AI Review: How to make these books actually great

A review of the current pipeline from a children's-book author and an AI engineer
sitting in the same chair, with a concrete plan to fix what matters. The goal
is not "more rules"; it is **fewer, better-placed rules** and **one missing
feedback loop**.

---

## Honest verdict

The pipeline is impressively complete. It has a planner, a writer, a quality
gate, a stateful illustrator, drift QA, retry memory, repair budgets, and a
print adapter. **What's holding back quality is not missing machinery — it's
that the machinery talks in one direction.** The writer cannot see what the
illustrator failed to render; the illustrator cannot see when the writer fixed
something; the cover-composition guess is treated as ground truth; and the
"soft fail" gates have quietly become "ship anyway" gates. On top of that,
the writer's system prompt has grown into 80 lines of equally-shouting rules.
Great children's books have a **unified voice and a real arc**, not a long
checklist of don'ts. The plan below addresses both halves: voice/craft
and engineering.

---

## Part 1 — Writing the most amazing personalized children's book

### What "amazing" actually means (before any code)

A book a child asks for again has these traits, in roughly this order:

1. **One specific emotional truth.** Not "bedtime is hard," but a particular
   small feeling: *the shadow on the wall looked like a hand, until Dad turned
   on the lamp.* Personalization serves this — it doesn't replace it.
2. **A single, consistent narrator voice** across all 13 spreads. Most AI
   books read like 13 unrelated couplets stapled together.
3. **A refrain that earns its repetition** — set up in the first third,
   deepened in the middle, transformed at the end. Same words, new meaning.
4. **Sensory specificity.** "A copper kettle with a chipped lid," not "a thing
   in the kitchen." Specific nouns out-perform clever rhymes.
5. **A real (small) arc with stakes.** Even tiny: *can I finish the last bite,
   can I tell my friend I'm sorry, can I be brave for one more step.*
6. **Personalization that feels honest.** The child's name, their dog, their
   street, their fear — woven in, not pasted on. Identity-rhymes ("Sarah" /
   "terrarium") are an anti-signal of quality and the gate already bans them.
7. **An ending that feels inevitable but not predictable.** Callbacks, not
   coincidences.

The current writer enforces a lot of negative space ("don't do X"). Greatness
comes from positive space: **voice, refrain, specificity, callback**. The
plan below shifts weight in that direction.

### Concrete moves — writing

**W1. Collapse the two planning passes into one *story bible* call.**
`services/storyPlanner.js` brainstorms a story seed; then
`services/writer/themes/base.js` plans beats and location palette again. Merge
into a single `planStoryBible()` call that emits *everything downstream needs*:
beats, emotional arc, location palette, refrain candidate, prose-prop
whitelist, and a one-sentence **voice card** (see W2). Keep
`storyPlanner.js`'s richer brainstorming prompt; throw away the duplicate plan
in the writer theme. Net: ~$X/book saved, one source of truth, one place to
edit prompts.

**Format constraint — non-negotiable:** every book ships **exactly 13 spreads**
(Lulu print spec; layout pipeline assumes it). The bible must therefore assign
a *purpose* to each of the 13 slots so none coast: hook, world, want,
obstacle, attempt, setback, refrain-deepen, turn, climax, callback, resolve,
ritual-moment, closing-image. Treat 13 as a poem's meter — a fixed shape
the story fills with intent. The mid-book sag (spreads 8–10) is where AI
books die; explicit per-spread purpose is the antidote.

**W2. Add a "voice card" to the bible and pin it everywhere.**
Today the writer is told *what to write* (beats, props, rhyme rules) but not
*how the narrator sounds*. Add 4 short fields to the bible:

- `narratorPOV` — third-person warm, second-person intimate, first-person
  brave-child, etc.
- `tonalRegister` — e.g. "gentle, slightly wry, never cute."
- `signatureMove` — one *positive* trick the narrator uses (a sound word,
  a tiny aside to the reader, a sensory zoom).
- `refrainSeed` — a 4-to-7-word phrase that will recur; not its rhyme, just
  its core.

Pin the voice card at the top of the writer system prompt **above** the rule
list, and include it in the per-spread prompt. This single change does more
for "amazing" than any new constraint.

**W3. Triage the writer's system prompt into three tiers.**
`services/bookPipeline/writer/draftBookText.js` is 80 lines of rules at equal
volume. Split into:

- **Hard fails** (gate blocks): identity rhyme, prop whitelist, pronoun lock,
  line count, refrain placement, age word-length.
- **Craft guidance** (advisory only): diversity audit, dropped articles,
  "meaning first."
- **Voice** (the card from W2): how this *specific* book sounds.

The model follows hierarchical prompts much better than flat ones. This also
makes future edits safe — when a rule misfires you know which tier to touch.

**W4. Refrain as a first-class object, not a regex.**
Today the gate counts refrain occurrences. Promote refrain to data: the bible
emits `{ refrainText, plantSpread, deepenSpread, transformSpread }`. The
writer is told the *function* of each occurrence, not just where to put it.
The gate validates the contract instead of inventing it. This is the
single biggest "feels like a real book" lever.

**W5. Replace the LLM critic with a focused rewrite step.**
The advisory critic in `services/writer/quality/gate.js` silently fails on
JSON/timeout and adds latency without reliability. Replace with a single,
scoped **"polish pass"** call after the deterministic gate is green: rewrite
only the spreads tagged by the gate as *weakest specific imagery* (count
abstract nouns / generic verbs per spread, take the bottom 2–3). Bounded,
cheap, observable, and aimed at the actual quality ceiling.

**W6. Auto-repair stays — but log every patch as a defect.**
The auto-repair at `engine.js:252` ("him hair" → "his hair") is fine as a
last-line safety net, but each patch should emit a structured log
(`writerV2:auto_repair`) so we can track which prompt rules need strengthening.
Today these patches are invisible.

**W7. Personalization checklist, applied *positively*.**
Add a tiny structured field to input: `signals = { pet?, room?, fear?, joy?,
phrase? }`. The bible is required to *use* at least 3 of the available
signals across the book. Today the system relies on the LLM noticing the
opportunity; making it a contract turns "AI book with the kid's name" into
"a book that's actually about this kid."

---

## Part 2 — Illustrating them

### What "amazing illustration" means (before any code)

1. **A coherent visual world.** Same palette, same lighting logic, same line
   weight — across 13 spreads.
2. **Camera variety with intent.** Not 13 medium shots. Wide establishing →
   intimate close-up → bird's-eye action → silhouette at twilight. Camera
   serves emotion.
3. **Composition that carries the feeling.** Negative space for loneliness,
   tight crop for intimacy, low angle for awe.
4. **The child is recognizable in 5 seconds** — not "could be any kid."
5. **What's drawn matches what's written.** No invented props, no missing
   actions.

The illustrator already does (1) and (4) well via the stateful Gemini session,
cover re-anchoring, and the prop whitelist. The plan focuses on the gaps:
(2), (3), (5), and trustworthy QA.

### Concrete moves — illustration

**I1. A tiny "shot list" alongside per-spread prompts.**
The story bible (W1) emits, per spread, a `shot` field with one of ~8 named
camera/composition presets (e.g. `wide_establish`, `intimate_close`,
`overhead_action`, `silhouette_dusk`). The shot is part of the prompt and is
*budgeted* at the book level: at least one wide, at least one close-up, at
least one unusual angle per book. Trivial to enforce in the planner; massive
visual lift.

**I2. Promote prose↔image mismatch to a real loop.**
This is the missing feedback edge. When `textQa` / `actionConsistencyQa` /
`writer_invented_prop` rejects a spread for a *prose-side* cause, write the
veto into `retryMemory` keyed to the writer, not the illustrator, and
re-run the writer for *that spread only* with the veto attached. Then
re-render. Bounded: max 1 prose-side rewrite per spread. Today these
failures hard-fail the book; this turns them into recoveries.

Files: `services/bookPipeline/illustrator/renderAllSpreads.js` (and Quad
variant) emits `prose_revision_request`; `services/bookPipeline/index.js`
reroutes to a per-spread writer call; `services/writer/engine.js` exposes
`reviseSpread(index, vetoes)`.

**I3. Harden "soft fail" — three states, not two.**
Today drift tags (`hair_continuity_drift`, `outfit_continuity_drift`) accept
after N attempts. Replace with three explicit states:

- `pass` — clean.
- `accept_with_note` — drift is mild *and* not on the cover spread *and* the
  child is still recognizable. Logged with a thumbnail link for human review.
- `fail` — recognizability lost; never ships.

The current "ship anyway after attempt 3" is a UX choice masquerading as a
QA result. Make the choice visible.

**I4. Pre-render policy check, cheap.**
`scenePolicyGate.js` only appends text. Add a 1-call vision pre-check on the
*first attempt's render only*: a small Gemini-Flash prompt asking "does this
image obey {policy_rules}?" with a strict JSON yes/no list. If no, regenerate
once before burning a full QA pass. Saves money on parent-staging and
cast-lock failures, which are repeatable defects.

**I5. Stop accepting on infra-only failures by default.**
`renderAllSpreads.js:101` promotes `qa_api_error` / `qa_unavailable` failures
to accept. Change default to **retry the QA call up to 3× with backoff**,
*then* accept-with-note if still down — and emit a `qa_infra_outage` metric.
Otherwise we silently ship un-validated images during Gemini's bad afternoons.

**I6. Cover composition: confirm, don't guess.**
A single Gemini-vision call decides whether a parent appears on the cover and
which secondaries exist. If wrong, downstream cast-lock and parent-staging
logic are wrong for the whole book. Two cheap fixes, in order:

- Re-run the detection a second time with a different prompt and require
  agreement; on disagreement, **fall back to the customer's stated cast** as
  ground truth (it already exists in the request).
- Optional: surface the detection in the customer-facing flow as a
  one-tap confirm. Engineering cost is small; confidence gain is huge.

**I7. Keep the quad path as default, but be honest about its failure mode.**
Quad doubles throughput and is the right default. Its risk is correlated
failure across both halves (one bad render kills two spreads). Add a
`quad_correlated_failure` tag and, on its third occurrence in a book, fall
back to legacy single-spread for the remaining renders. Self-healing without
a config flag.

---

## Part 3 — Cross-cutting fixes (small, high leverage)

**X1. One LLM client.** `storyPlanner.js`, `services/writer/themes/base.js`,
`services/qualityGates.js` each carry their own `fetchWithTimeout` /
`callOpenAI` / `callGeminiText`. Consolidate into `services/llm.js` with
typed routing, timeout budgets, retry policy, and cost emission. Necessary
groundwork for any future model swap (4.7 → 4.8, etc.) and removes three
copies of identical bug-prone HTTP code.

**X2. Single `bookContext` object across stages.** Today each stage hands
the next a different shaped record. Define one `BookContext` (story bible,
voice card, cast, signals, retryMemory, qaTagCounts) and pass it everywhere.
Eliminates a class of "the planner knew, but the writer didn't" bugs.

**X3. Observability that pays for itself.** Three counters per book, surfaced
in Cloud Logging:

- `writer.revise_loops_used`
- `illustrator.soft_fails_shipped` (I3 above)
- `prose_revision_requests` (I2 above)

If any climbs above a threshold over a rolling window, alert. These three
numbers tell you when a model regression has shipped — which is the actual
operational risk of this product.

**X4. Delete more than you add.** Targets to remove during this work:

- The duplicated LLM HTTP code (X1).
- The advisory critic (replaced by W5's polish pass).
- The flat 80-line system prompt (replaced by W3's tiered prompt).
- The "accept on infra failure" branch (replaced by I5's retry).

Net code should *shrink*.

---

## Part 4 — Sequencing

Do these in order. Each phase ships and is observable on its own.

**Phase A — Foundation (1 PR each, no behavior change).**
1. X1 — `services/llm.js` consolidation.
2. X2 — `BookContext` object.
3. X3 — observability counters.

**Phase B — Writing quality (visible in next batch of books).**
4. W1 — merge planners into `planStoryBible()`.
5. W2 — voice card.
6. W3 — tiered system prompt.
7. W4 — refrain as data.
8. W7 — personalization signals.
9. W5 — replace critic with polish pass; W6 — log auto-repairs.

**Phase C — Illustration quality and the loop.**
10. I1 — shot list.
11. I3 — three-state QA + I5 — retry on infra fails.
12. I2 — prose↔image feedback loop *(this is the single biggest "amazing"
    lever on the illustration side; do it after the loop's input quality is
    higher from Phase B)*.
13. I4 — pre-render policy check.
14. I6 — cover composition double-check.
15. I7 — quad correlated-failure fallback.

**Out of scope on purpose.** No new themes, no new model upgrades, no new
book formats, no fine-tunes. The above gets the existing pipeline to a
visibly different quality tier without expanding surface area.

---

## What you should *feel* in the books after this plan

- They sound like one narrator, not thirteen.
- The refrain hits and you smile when it transforms at the end.
- The child looks like the child, in a world that looks like one world.
- A spread never says "balloon" while showing a kite.
- The QA dashboard tells you, *before customers do*, when quality slips.

That's the bar. Everything in the plan above is in service of it; anything
not in service of it can wait.
