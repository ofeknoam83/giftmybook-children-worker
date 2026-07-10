# Book Pipeline V3 — Writer & Illustrator Redesign

Status: **DESIGN** (approved decisions locked with product owner, 2026-07-10)
Scope: **picture books** (ages 0–6). Early readers, chapter books, and graphic novels stay on their current paths until V3 is proven.

This document deliberately ignores how V1/V2 work and designs from first principles. The current system's failure modes (catalogued in `AUTHOR_REVIEW_AND_PLAN.md` and encoded in the V2 gate checks) are used only as evidence of what NOT to repeat.

---

## 1. Locked product decisions

These were decided explicitly with the product owner and are not open for re-litigation during implementation:

| # | Decision | Choice |
|---|---|---|
| D1 | Scope | Picture books first |
| D2 | Budget | Quality at almost any cost (2–3× current cost acceptable) |
| D3 | Models | Fully open — best model per job, any provider |
| D4 | Likeness | Child photo is a reference input to **every** spread render (via a character sheet), not just the cover |
| D5 | Text | Typeset by the layout engine over pure art; **never** baked into generated pixels |
| D6 | Failure policy | Human review queue. A book with a known defect is **never** auto-shipped |
| D7 | Parent preview | Cover approval only (current flow); everything after is unattended |
| D8 | Rhyme | The story decides its form (rhymed verse / rhythmic prose / sparse lyric). Rhyme is never forced |
| D9 | Quality bar | "Bookstore standard" — a parent would believe it's a published book; judged by a rubric distilled from acclaimed picture books |
| D10 | Language | English only (no localization hooks required) |
| D11 | Art style | One signature style, perfected |

## 2. Design principles

Derived from watching V1/V2 fail:

1. **Quality by construction, not by repair.** V2 spends its budget on retry storms after a mediocre first attempt. V3 spends it on richer briefs, stronger models, and *multiple candidates*, so the first accepted attempt is genuinely good.
2. **Generate → select, not generate → patch.** For subjective quality (story voice, art), producing N independent candidates and choosing the best beats iterating repairs on one — repairs converge to "not broken," never to "excellent."
3. **Ground truth flows one direction.** Identity comes from the photo → character sheet → every spread. No photocopy-of-a-photocopy chains (V2's cover → spread N−1 → spread N anchoring is where drift, phantom limbs, and skin-tone mismatch come from).
4. **Spreads are independent.** No stateful sessions, no quad batching. Each spread renders in parallel from the same references. This removes correlated failures, removes drift, and cuts wall-clock time.
5. **The writer and illustrator share a contract.** Every spread's text carries a machine-readable *scene contract* (who, where, doing what). The art director validates illustratability **before** any pixels are rendered and can bounce a spread back to the writer — the feedback loop V2 never had.
6. **Gates are few, deterministic, and honest.** Most of V2's 12 gate checks exist because forced rhyme corners the writer. With form freedom (D8), the mechanical gate shrinks to what is objectively breakage. Everything subjective moves to a judge panel with a real rubric. There is no "ship anyway" state (D6).

---

## 3. Architecture overview

```
 REQUEST (validated, age-banded — reuse existing validation/effectiveAge)
    │
    ├── A0. IDENTITY KIT (once per child, cached in GCS)
    │      photos → likeness brief → character model sheet (best-of-3, likeness-judged)
    │
    ▼
 W0. CREATIVE BRIEF          1 call, strong writer model
 W1. CONCEPT ROOM            3 story concepts in parallel, diverse angles
 W2. EDITORIAL SELECTION     judge picks + grafts → winning concept
 W3. MANUSCRIPT              best-of-2 full manuscripts, each spread with a scene contract
 W4. MECHANICAL GATE         deterministic, small (word budget, banned content, names,
                             identity-rhyme iff rhymed, age-feasible verbs)
 W5. JUDGE PANEL             3 judges, 3 model families, bookstore-standard rubric
 W6. REVISION                ≤2 targeted rounds → runner-up manuscript → REVIEW QUEUE
    │
    ▼
 A1. ART DIRECTION           1 multimodal call: shot list, text-safe zones, palette arc,
                             continuity locks, world plates; can bounce spreads to writer
 A2. RENDERING               13 spreads fully parallel, 2 candidates each,
                             refs = character sheet + photo + cover + world plate
 A3. SPREAD QA + SELECT      vision judges score candidates; pick best ≥ threshold;
                             1 repair wave → REVIEW QUEUE (spread-level)
 A4. BOOK PASS               contact-sheet review: variety, continuity, cover match
    │
    ▼
 LAYOUT                      typeset text into planned text-safe zones (new);
                             existing Lulu geometry, page order, cover PDF unchanged
    │
    ▼
 REVIEW QUEUE (terminal for failures)   or   DONE
```

Orchestration reuses the V2 `workflowEngine` shape (content-addressed artifacts per stage, bounded retries for *infra* errors only) — that part of V2 is good. What changes is every creative stage inside it.

---

## 4. The Writer ("Author Studio")

### W0 — Creative Brief (1 call)

Input: full sanitized request (name, age-in-months, gender, interests, anecdotes, customDetails, theme, emotional fields, heartfelt note).
Output (JSON):

- `child_as_character`: the child's *real* details ranked by story potential, with the 2–3 that will be **load-bearing** in the plot (not decoration).
- `gift_intent`: what the parent is actually buying (comfort before a sibling arrives, a birthday love letter, …). This is the emotional target every later judge scores against.
- `age_profile`: reuse the existing `PB_*.json` band data (words/spread, dialogue density, attention shape) — the band files are among the best artifacts in the current system.
- `constraints`: banned elements, safety notes, pronouns.

This replaces V2's seven sequential planning calls (personalization → intent → story bible → character bible → world bible → beat sheet) with one deep call plus the concept stage below. The multi-call chain added latency and drift between artifacts without adding craft.

### W1 — Concept Room (3 parallel calls)

Three *independent* story concepts, each forced through a different creative angle (e.g. quest, quiet-observational, call-and-response humor) and, where useful, different model families for diversity. Each concept:

- logline, external plot + internal emotional arc (they must be different things)
- **form choice** (D8): `rhymed_verse` | `rhythmic_prose` | `sparse_lyric`, with a justification — the concept must argue why its form serves this story and this age
- refrain (optional) as **first-class data** with its evolution across the arc — never regex-discovered later
- climax image and final-page note
- 3 sample lines written in the proposed voice (the cheapest possible voice audition)

### W2 — Editorial Selection (1 judge call)

A strong judge selects the winning concept against the brief's `gift_intent` and the rubric (§ W5), and may graft the best elements of the runners-up (e.g. concept B's refrain into concept A's plot). The runner-up is retained as the fallback seed for W6 exhaustion.

### W3 — Manuscript (best-of-2)

Two full 13-spread manuscripts are written from the winning concept (parallel, temperature-varied or cross-family). Each spread carries:

- `text` — the actual lines, within the band's word budget (a **typesetting** constraint now, not a style suggestion)
- `scene_contract` — the writer→illustrator interface:
  `{ setting, characters_present, hero_action (age-feasible verb), emotion, key_objects, time_of_day, continuity_notes }`
- `refrain_here: bool` — refrain placement is explicit data

Rules baked into the writer prompt: present tense for pre-reader bands; every line must be paraphrasable (meaning-sanity self-check); the child's load-bearing details from W0 must drive at least the midpoint and climax; no moralising abstractions ("believe in yourself" class).

### W4 — Mechanical Gate (deterministic, per manuscript)

Only objective breakage. Port these V2 checks (they earn their keep) and drop the rest:

| Kept | Why |
|---|---|
| word budget / line count per spread | hard typesetting limit |
| banned-content + moralising lexicon | objective, cheap |
| name spelling / pronoun lock | objective |
| age-feasible action verbs (`protagonistAntiVerb` concept) | prevents unillustratable text and "where she is kept" objectification |
| identity rhyme — **only when** `form=rhymed_verse` | still the ugliest rhyme defect |
| past-tense drift — only for pre-reader bands | objective |

Dropped: syllable windows, line-starter repetition, headline-noun repeat, filler-phrase blocklists, the LLM rhyme judge as a gate. These were counterweights to forced rhyme; with D8 they become judge-rubric material, not gates.

### W5 — Judge Panel (3 judges, 3 model families)

Both manuscripts (post-gate) are scored blind by three judges from **different model families** (to defeat self-preference), one shared rubric distilled from published picture-book craft:

1. **Read-aloud musicality** — does it scan spoken aloud, regardless of form?
2. **Emotional truth** — is the arc earned, does the climax pay off the setup?
3. **Page-turn pull** — does each spread end with a reason to turn?
4. **Concrete specificity** — things you can see and touch; zero abstractions
5. **Personalization depth** — would this story survive with a different child's details? (it must not)
6. **Age fit** — vocabulary, attention shape, emotional register for the band
7. **Meaning sanity** — every line paraphrasable by a judge; any failure here is an automatic fail

Scores 1–5 per dimension with mandatory line-level evidence. **Pass = median ≥4 on every dimension, no meaning-sanity flag from any judge.** The better manuscript wins; the judges' line-level notes become the revision brief for the loser-turned-fallback.

### W6 — Revision (bounded)

≤2 targeted revision rounds on the winning manuscript (only flagged spreads, judges re-score). If still failing: promote the runner-up manuscript through W5; if that also fails, write one fresh manuscript from the runner-up *concept*. Still failing → **review queue** with the full judge history attached. No warnings-and-ship.

---

## 5. The Illustrator ("Art Studio")

### A0 — Identity Kit (once per child, cached)

Runs as soon as photos are validated (in parallel with the writer):

1. **Likeness brief** — vision analysis of the photos (keep the current skin-tone-precision emphasis from `faceEngine`; it's correct) producing an illustrator-grade appearance description.
2. **Character model sheet** — ONE canonical image in the signature style: front / ¾ / profile turnaround, 2–3 expressions, full-body proportions. Generated with the **actual photos as reference inputs**, best-of-3 candidates, selected by a likeness judge that compares each candidate *to the photo* (cross-family vision check on this one dimension — it's the product's core promise).
3. Cached in GCS keyed by `childId` + photo hash + style version. The approved cover is attached to the kit as the **outfit/wardrobe ground truth** (it's the one image the parent has blessed).

### A1 — Art Direction (1 multimodal call)

Input: winning manuscript (all scene contracts), identity kit, approved cover.
Output, per spread:

- **Shot** — camera + composition from an enforced variety budget (≥4 distinct shot types across 13 spreads; no two adjacent spreads share a shot type). Fixes the "13 medium shots" problem structurally instead of QA-ing it after the fact.
- **Text-safe zone** — which page/quadrant stays visually quiet for typesetting (sky, wall, water…). This is a coordinate contract with the layout engine (D5).
- **Palette & lighting arc** — per act, so the book darkens/warms with the story.
- **Continuity locks** — outfit (from cover), recurring props with their spread lists, supporting-cast presence rules.
- **World plates** — for locations visited ≥2×, generate 1 reference image of the empty location; revisits reference the plate.

**The feedback edge:** if any scene contract is unillustratable (infant doing impossible locomotion, prop soup, unstageable action), the art director bounces that spread back to W6 for a targeted prose fix **before any rendering**. V2 discovered these problems after burning five render attempts.

### A2 — Rendering (13 spreads, fully parallel)

- One image per spread at ~2:1 spread aspect ratio, **no text in the image** (negative prompt + QA enforce this).
- References attached to every render: character sheet + best photo + cover (outfit/style) + world plate (if any). Identity never chains through previous spreads.
- **2 candidates per spread**, generated concurrently across the existing Gemini key pool. No sessions to rebuild, no quad slicing, no correlated pair failures.

### A3 — Spread QA & Selection (parallel per spread)

Vision judges score each candidate:

| Dimension | Notes |
|---|---|
| Likeness | vs photo AND character sheet; cross-family second opinion on this dimension only |
| Anatomy / integrity | limbs, hands, object coherence — the current tag taxonomy's anatomy tags are good training material for the judge prompt |
| Scene-contract adherence | the image shows the contracted action/setting (replaces action-mismatch QA) |
| Text-zone compliance | the contracted quiet zone is actually quiet |
| Style fidelity | signature style, no drift |
| Cast compliance | no phantom extras, no duplicated hero/caregiver |
| No lettering | any text/letterforms in the art is an automatic fail (D5) |

Best candidate ≥ threshold wins. If both fail: **one** repair wave (2 fresh candidates with the judges' specific defects in the prompt). Still failing → the spread enters the **review queue** — with all 4 candidates attached, because often a human's job is just "pick the acceptable one," which costs seconds.

### A4 — Book Pass (1 call)

A single contact-sheet review of the 13 selected images: shot variety actually delivered, outfit/prop continuity, cover-to-interior consistency, ending lands visually. Flags trigger at most one targeted regen wave for named spreads; residual flags → review queue.

---

## 6. Layout changes

- **Typesetting engine** (new work in `layoutEngine`): place text blocks inside each spread's contracted text-safe zone; one book typeface (reuse embedded fonts); auto-size within the band's word budget; widow/orphan control; verso/recto placement follows the art director's zone.
- Everything else is untouched: 8.5"×8.5" trim + bleed, 13 spreads / 32 pages, page order, Lulu compliance, cover PDF generation, upsell spreads.
- Retire on this path: quad slicing, `splitSpreadImage` mid-text hazards, all OCR text QA.

## 7. Human review queue (D6)

New terminal state replacing every "ship anyway" branch:

- Worker: book/spread enters `needs_review` with a structured payload — stage, defect summary, judge scores, candidate images, manuscript + judge history. Persisted via the existing checkpoint mechanism; progress callback notifies the main app.
- Main app (giftmybook-standalone): review dashboard listing queue items with actions: **approve as-is** / **pick candidate** / **regen spread with note** / **regen manuscript** / **cancel & refund**. Each action maps to a worker endpoint (the `/rebuild-cover-pdf` admin pattern already exists to copy).
- Print submission is blocked while any item for the book is open.

## 8. Model selection (D3 — fully open)

| Job | Primary | Rationale / fallback |
|---|---|---|
| W0 brief, W1 concepts, W3 manuscript, W6 revision | Claude (Opus-class) | strongest literary prose and voice; fallback GPT-5.4 |
| W2/W5 judge panel | Claude + GPT-5.4 + Gemini 3 | three families, blind scoring, defeats self-preference |
| A1 art director | Gemini 3 Pro (multimodal) | must *see* cover + character sheet; fallback GPT-5.4 vision |
| A0 character sheet, A2 spread render | Gemini 3 Pro Image ("Nano Banana Pro") | multi-reference input (photo + sheet + cover + plate), strongest character consistency; fallbacks: gemini-3.1-flash-image, gpt-image-2 |
| A3/A4 vision QA | Gemini 3 Flash + Claude vision (likeness only) | cheap at volume; second family where the core promise is judged |

Implemented behind a V3 `modelRouter` with the same per-role env-override pattern as V2 (`BOOK_PIPELINE_V3_<ROLE>_FAMILY`) — that mechanism works well. Requires adding `ANTHROPIC_API_KEY` to the environment and boot guard.

## 9. Cost & latency sketch (per book)

- **Text:** ~10 writer/judge calls first pass, ~16 worst case — comparable to V2's planner chain + revision loops, but concentrated in premium models. Net: moderately higher cost, similar latency.
- **Images:** character sheet 3 + spreads 26 (13×2) + repair wave ≤8 + world plates ~2 ≈ **31–39 generations**, vs V2's nominal 13–26 that routinely balloons past 40 with retry storms and session rebuilds. Similar-to-lower image spend with far better selection pressure.
- **Wall-clock:** dramatically lower — V2 renders serially through a session; V3's 13 spreads × 2 candidates run as ~26 parallel independent calls.

Within the D2 envelope with room to raise best-of-N on weak spots.

## 10. What V3 keeps from today

Request validation and sanitization, effective-age/band derivation and the `PB_*.json` band files, GCS storage + checkpointing, cost tracker, progress callbacks, the Gemini key pool + transient-error retry classification, the workflow-engine artifact pattern, Lulu layout geometry, and the cover pipeline (unchanged for now — cover redesign is explicitly out of scope).

## 11. Rollout

1. Build as `services/bookPipelineV3/`, routed for `picture_book` when `BOOK_PIPELINE_V3=on` (env or per-request override), V2 remains the default.
2. **Shadow phase:** run V3 alongside V2 for internal test books; both outputs land in the review dashboard for side-by-side comparison. Calibrate judge thresholds here against a small set of real published-book texts (the rubric's anchor).
3. Gradual percentage rollout; `BOOK_PIPELINE_V3=off` is the instant revert, mirroring the V2 cutover playbook.
4. Early readers migrate only after picture books are stable (D1).

## 12. Open items (not blocking design)

- Review-dashboard UI in giftmybook-standalone (worker-side contract is defined in §7).
- Assemble the judge-calibration exemplar set (public-domain / licensed picture-book texts).
- Signature-style bible: one authored style document + reference images, versioned with the identity-kit cache key.
- Cover pipeline redesign (later; it should eventually consume the identity kit too).
