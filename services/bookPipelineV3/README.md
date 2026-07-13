# bookPipelineV3 — milestone 1 (writer + v1 illustrator adapter)

Implements the writer half of `docs/PIPELINE_V3_DESIGN.md`:

```
input      ageBand + profile (reuses v2 derivation incl. the age=0 fix)
planning   W0 creativeBrief → W1 conceptRoom ×3 (parallel, fixed angles) → W2 editorialSelection
writing    W3 two manuscripts in parallel (prompt-variant diversity — anthropic rejects temperature)
writerQa   W4 mechanical gate (small, deterministic) → W5 blind 3-judge cross-family panel
           → W6 ≤2 targeted revision rounds → exhaustion ladder (other draft →
           fresh manuscript from runner-up concept → PipelineError judge_panel_exhausted)
illustrating / layout   v1 renderAllSpreadsQuad via the adapter (same seam pattern as v2)
```

- **Entry contract** identical to v1/v2: `{ generateBook, PipelineError }` returning `{ document, layout }`; the document satisfies `toLegacyStoryPlan`. V3 artifacts (concepts, judge reports, scene contracts, cost ledger) ride under `document.v3` — that namespace is the seam for milestone 2 (identity kit, native per-spread illustrator, typeset text, review queue).
- **No ship-anyway** (design D6): panel exhaustion throws `judge_panel_exhausted` with judge history in `issues`. Escape hatch for smoke tests: `BOOK_PIPELINE_V3_SHIP_ON_EXHAUSTION=1`.
- **Model routing** (`llm/modelRouter.js`): defaults use only already-provisioned vendors — BRIEF/CONCEPT/WRITER → `gpt-5.4`; EDITOR → `deepseek-v4-pro` (cross-family from the writer); judges = deepseek + gpt-5.4 + gemini-2.5-pro (three families, blind, median ≥ 4 on all 7 dimensions to pass). Override per deploy via `BOOK_PIPELINE_V3_<ROLE>_FAMILY` / `_TIER` — the anthropic family (`claude-opus-4-8`, client included) is the A/B flip-back option and needs `ANTHROPIC_API_KEY`. `assertV3Config()` fails the book before any LLM spend if a routed family has no key. No silent family fallback.
- **Gate roster** (`gate/runGate.js`): wordBudget, lineCount, bannedContent (brief + moralising lexicon), nameLock (spelling + pronouns), protagonistAntiVerb (v2), pastTense (v2, pre-reader bands), identityRhyme (v2, only when the manuscript's form is `rhymed_verse`). Everything else moved to the judge rubric — V3 lets the story pick its form, so v2's rhyme counterweights are gone.
- **Reused from v2 by require** (do not fork): workflowEngine, artifactStore, ageProfiles, four gate checks, `deriveParentVisibility` + `buildSpreadsForLegacyIllustrator` from the v2 illustration adapter.
- Routing into this module: `services/pipelineRouter.js` (env kill-switches → checkpoint → request → default). V3 runs only on explicit `pipelineVersion: 'v3'` (the main app's admin test-book path), a v3 checkpoint, or `BOOK_PIPELINE_V3=on`.
