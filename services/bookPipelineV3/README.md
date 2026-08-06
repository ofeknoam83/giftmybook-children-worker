# bookPipelineV3 — writer + native illustrator (the only pipeline)

Implements `docs/PIPELINE_V3_DESIGN.md` (native-illustrator cutover 2026-07-15):

```
input      ageBand + profile (reuses v2 derivation incl. the age=0 fix)
planning   W0 creativeBrief → W1 conceptRoom ×3 (parallel, fixed angles) → W2 editorialSelection
           (A0 identity kit runs in parallel with the whole writing chain)
writing    W3 two manuscripts in parallel (prompt-variant diversity — anthropic rejects temperature)
writerQa   W4 mechanical gate (small, deterministic) → W5 blind 3-judge cross-family panel
           → W6 ≤2 targeted revision rounds → exhaustion ladder (other draft →
           fresh manuscript from runner-up concept → PipelineError judge_panel_exhausted)
           → post-panel polish pass
illustrating / layout   native illustrator A1–A4 (see illustrator/) → toLayoutPayload
```

- **Entry contract** identical to v1/v2: `{ generateBook, PipelineError }` returning `{ document, layout }`; the document satisfies `toLegacyStoryPlan`. V3 artifacts (concepts, judge reports, scene contracts, cost ledger) ride under `document.v3` — that namespace is the seam for milestone 2 (identity kit, native per-spread illustrator, typeset text, review queue).
- **No ship-anyway** (design D6): panel exhaustion throws `judge_panel_exhausted` with judge history in `issues`. Escape hatch for smoke tests: `BOOK_PIPELINE_V3_SHIP_ON_EXHAUSTION=1`.
- **Model routing** (`llm/modelRouter.js`): defaults use only already-provisioned vendors — BRIEF/CONCEPT/WRITER → `gpt-5.4`; EDITOR → `deepseek-v4-flash` (mid — 2026-07-15 latency fix; cross-family from the writer; `BOOK_PIPELINE_V3_EDITOR_TIER=strong` restores `deepseek-v4-pro`); judges = deepseek-v4-flash + gpt-5.4 + gemini-2.5-pro (three families, blind, median ≥ 4 on all 7 dimensions to pass). Override per deploy via `BOOK_PIPELINE_V3_<ROLE>_FAMILY` / `_TIER` — the anthropic family (`claude-opus-4-8`, client included) is the A/B flip-back option and needs `ANTHROPIC_API_KEY`. `assertV3Config()` fails the book before any LLM spend if a routed family has no key. No silent family fallback.
- **Gate roster** (`gate/runGate.js`): wordBudget, lineCount, bannedContent (brief + moralising lexicon), nameLock (spelling + pronouns), protagonistAntiVerb (v2), pastTense (v2 — runs only when the book's resolved narrative tense is `present`, i.e. the lap-baby bands; see `ageProfiles.narrativeTenseFor`), onomatopoeia (2026-08-02 — sound-effect usage: reduplication "tap tap"/pairs "tick tock" hard for INFANT/TODDLER/PRESCHOOL, exclamation/caps soft; budget of ONE moment per book via the `onomatopoeia_overuse` book lint), identityRhyme (v2, only when the manuscript's form is `rhymed_verse`). Everything else moved to the judge rubric — V3 lets the story pick its form, so v2's rhyme counterweights are gone.
- **Narrative tense (2026-08-02 customer feedback)**: past tense is the standard storybook register for PB_PRESCHOOL/PB_EARLY_READER (`narrativeConstraints.narrativeTense`, resolver `ageProfiles.narrativeTenseFor`, ops override `BOOK_PIPELINE_V3_NARRATIVE_TENSE=past|present`); the lap-baby bands stay present tense with the machine-checked pastTense gate. Past-tense books get the SOFT `tense_drift` book lint (past-marker evidence on <60% of spreads) feeding revision notes.
- **Reused from v2 by require** (do not fork): workflowEngine, artifactStore, ageProfiles, four gate checks, `deriveParentVisibility` + `buildSpreadsForLegacyIllustrator` from the v2 illustration adapter.
- Routing into this module: `services/pipelineRouter.js` — every book routes here (v3-only since W12; v1/v2 were deleted). Request `pipelineVersion` accepts only `'v3'` (anything else 400s), and the old `BOOK_PIPELINE_V2/V3` kill-switch envs warn and are ignored.
