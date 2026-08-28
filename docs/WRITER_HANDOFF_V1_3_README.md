> **IMPLEMENTATION STATUS (2026-08-28, this repo):** the sidecar-coverage and
> structural gates below are CLEARED: all 228 `selection_profile` +
> `personalization_map` sidecars exist and schema-validate
> (`services/catalogEngine/data/augments/approved/` — 12 hand-tuned references
> + 216 generated archetype scaffolds, coverage asserted at boot and by
> tests), and fit ranking, deep personalization, and the evidence requirement
> are ON by default (`CATALOG_*=0` envs are kill-switches — see CLAUDE.md).
> The 48-book editorial regression matrix (05_TESTING) has NOT been executed
> in this repo — it needs live writer output, so it remains an outstanding
> editorial gate to run post-deploy via the story-only admin mode
> (`/v13/generate-stories`). The text below is the vendored handoff, kept
> verbatim as the source specification.

# GiftMyBook Writer Production Handoff V1.3

**Release date:** 24 August 2026  
**Status:** authoritative architecture and integrated catalog; personalization-map authoring still required before full launch  
**Supersedes for new development:** Writer V1.1 and Writer documentation V1.2

## What V1.3 contains

- The complete real V1.1 catalog: 12 themes, 228 fixed plots, exactly 12 ordered beats per plot.
- Writer Engine V1.3 with controlled personalization.
- Four age bands: **1–3, 4–5, 6–7, 8–10**.
- Exact-age calibration for ages 1, 2, and 3.
- Deterministic, fit-weighted candidate-selection rules.
- Sparse-profile reliability behavior.
- Per-book personalization-map schema and catalog augmentation guide.
- Runtime request/response schema, validation order, retry, persistence, and rollback rules.
- Regression/release plan and an executable structural release validator.
- Historical V1.1 engine and schemas for audit and rollback.

## Production flow

```text
questionnaire -> normalized profile -> eligible fixed plots
-> deterministic fit ranking -> persist three book IDs
-> three independent writer calls -> deterministic validation
-> persist three complete 12-spread stories
```

The writer never receives only a theme and age and never invents a plot. There are no autonomous agents in the production path.

## Critical launch status

The catalog plots are complete. The V1.3 personalization architecture is complete. However, the 228 book-specific `selection_profile` and `personalization_map` sidecars have **not** been editorially authored in the supplied V1.1 or V1.2 packages.

Therefore:

- fixed-plot, name-personalized generation can be implemented from this package;
- deep profile-based ranking and 4–6 controlled personalization moments must remain feature-flagged;
- do not fabricate generic maps at runtime;
- full launch requires map coverage, schema validation, and the 48-book editorial regression gate described in `05_TESTING`.

## Youngest-band migration

The routing key is now `1-3`. Existing IDs containing `2_3` remain unchanged as stable identifiers. Application code must never infer age eligibility by parsing `book_id`; read the catalog age-band key.

## Authoritative order

1. Safety/no-IP and schema rules.
2. Fixed catalog definition and 12 ordered beats.
3. Exact-age engine.
4. Approved per-book personalization map.
5. Supplied child profile.
6. Prose polish.

## First CTO actions

1. Run `python3 tools/validate_release.py`.
2. Load the combined V1.3 catalog and route ages 1–3 to `1-3`.
3. Implement generation with personalization-map features disabled.
4. Author and approve 12 reference maps, one per theme.
5. Implement selection profiles and deterministic ranking.
6. Run sparse/rich fixtures, then the 48-book matrix.
7. Expand map coverage to all 228 definitions before enabling deep personalization globally.

