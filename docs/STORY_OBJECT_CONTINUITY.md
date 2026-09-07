# Recurring story-object continuity

The Book Bible now includes inanimate story objects as well as personalized items. A route marker, key, map, vehicle or plot-relevant landmark receives one fixed design and an explicit occurrence schedule. Personal items retain their existing decorative/carry-through policy.

## Data flow

1. `illustrator/storyObjects.js` reads the final manuscript, catalog beats, theme and authored object definitions together. One bounded JSON extraction resolves object families, aliases, instances, per-spread state and story-criticality. Evidence must quote the relevant manuscript/beat exactly; explicit object mentions cannot silently lose their occurrence. Catalog definitions cannot be omitted or rewritten. Invalid data, contradictions and unavailable planning fail with `identity_kit_failed` before spreads render.
2. The plan is elected with create-if-absent storage under `catalog-assets/story-objects/so-1/<input hash>.json`. Retries adopt the stored winner. The fingerprint includes the manuscript, beats, theme, authored definitions and version. Storage outages do not invent a replacement plan.
3. Prop sheets use a design-keyed namespace. The image must pass both the existing sheet content checks and the fixed-design check before election. A missing or unverified critical sheet stops the run. The fixed design remains authoritative over the vision-derived description.
4. Each spread receives the same sheet and design, plus only its scheduled instances and physical state. Groups are intentional; a moved, damaged or repaired instance keeps its identity. Plot objects do not inherit the personal-item rule that makes every prop small and decorative.
5. Spread QA verifies appearance, required presence, multiplicity and `state_match` (including stated clues and spatial relationships). The existing repair budgets apply. After repairs, final critical-family contact checks verify the selected artwork across spreads. Missing checks and residual critical defects require `consistency_unresolved` even when `CATALOG_SHIP_ON_EXHAUSTION=1`.

## Authoring a catalog design

Add a book ID entry in `services/catalogEngine/data/storyObjects.json`. Each definition needs `id`, `name`, noun-phrase `aliases`, `critical`, and `design` fields for `shape`, `material`, `colors`, `scale`, and `features`. These fix otherwise unspecified appearance; the final manuscript must not contradict them. Additional manuscript objects are still extracted automatically.

The first authored definition covers `safari_6_7_watering_hole_map`: a knee-high wooden post with one orange stripe on its front face. Multiple route markers share that design; the displaced third marker keeps its instance ID. Occurrence state comes from the actual manuscript rather than a hard-coded twelve-page sequence.

The planner supports up to six object families, twelve instances per family and twelve spreads. Exceeding those bounds requires review; objects are never silently truncated. Generic pronouns resolve within occurrences and are not allowed as ambiguous global aliases.

## Retries, review and rollout

- The object-plan hash enters the Book Bible/render namespace and each spread's QA record. A changed plan cannot reuse older approval. Current QA records retain the per-object verdicts; unchanged retries reuse the existing pixels.
- Older or unverified object QA is checked again. Reviewed artwork whose pixels change during lettering repair is rechecked for object state as well.
- The admin Book Bible exposes story-object sheets through the existing Props list; its JSON also contains the full plan, occurrence evidence and storage identity. Probe callbacks report critical failures through existing advisories/unresolved fields.
- Legacy PDF-only rebuilds preserve their existing artwork and namespace. Explicit illustration regeneration upgrades an existing book to object locks. This change alone does not repair or regenerate already-created books.
- Added model work is one text planning pass per changed manuscript, cached reference-sheet work per design/theme/style, and a final contact check per critical family. Automated tests mock model/storage calls; live visual quality and generation latency still require a staging book run.
- Before rollout, ensure `CATALOG_PROP_SHEETS` and `CATALOG_CONTACT_QA` are enabled. Disabling those layers does not permit critical story objects to ship unchecked.
