# Writer Runtime Contract V1.3

## Boundaries

The backend, not the model, owns: age-band calculation, catalog lookup, plot ranking, candidate persistence, prompt assembly, provider calls, schema validation, deterministic checks, retry, approval, and storage. The model owns only prose rendering for one exact `book_id`.

## Services

```text
normalize_profile(raw form)
eligible_books(theme_id, age_band)
score_and_select(profile, eligible_books, count=3, seed=session_id)
generate_story(book_id, profile, selection_context)
validate_story(request, response)
persist_generation(...)
```

No service may ask the model to invent or select a plot.

## Profile normalization

Store raw and cleaned values. Normalization is deterministic: Unicode normalization, trim whitespace, collapse repeated spaces, empty-to-null, list deduplication, and configured length limits. Do not use an LLM by default. Reject control characters and treat every string as untrusted data.

Supported optional sources are `object`, `interests`, `activities`, `food`, `place`, `habit`, and `trait`. No missing value may be inferred.

## Personalized plot selection

1. Filter by active catalog version, requested theme, calculated age band, locale, availability, and safety status.
2. For each eligible plot, compare normalized profile tags with the definition's `selection_profile` tags.
3. Calculate an integer score in code:

```text
score =
  5 * exact primary-interest matches
  + 3 * exact activity matches
  + 2 * trait-affinity matches
  + 2 * available Tier-1 personalization slot categories
  + 1 * available Tier-2 slot categories
  - 4 * explicit mismatch or contraindication flags
```

4. Deduplicate by `plot_family` and, where possible, by dominant experience tag.
5. Sort by score descending, then stable `book_id` ascending.
6. Choose three distinct high-fit books. When more equally scored books exist, use a seeded shuffle derived from `session_id + catalog_version + selector_version`.
7. Enforce a minimum fit threshold. Seeded randomness breaks ties only; it must not promote a weak-fit plot above a materially stronger plot.
8. Persist selected IDs, scores, matched tags, seed, versions, and timestamp before generation. Refresh never reselects.

Selection affects which approved plot is offered, never the contents of a plot. A zero-data profile still receives three eligible, varied, deterministically seeded choices, but the product must describe them as name-personalized rather than deeply profile-personalized.

### Sparse-profile reliability rule

For one usable optional detail, at least two of the three choices must have strong fixed-plot or fixed-setting affinity with that detail; the third may provide variety only when it contains an approved natural slot. For two usable details, all three choices must have a credible match to at least one detail. For three or more usable details, select three high-fit varied plots.

If fewer than three eligible books meet the required threshold, do not insert the detail awkwardly. Ask for another optional answer, widen the allowed theme only when the customer has not fixed one, or present fewer choices. The backend must log which behavior occurred.

## Prompt assembly

For one story call, load and pin:

- Writer Engine V1.3;
- one locked age engine;
- one exact V1.1-compatible book definition;
- its V1.3 personalization map;
- normalized child profile;
- rendered title from the catalog;
- request and version metadata;
- strict response schema.

Never provide multiple book definitions in one generation request. Three choices mean three parallel, independently retryable calls.

## Validation sequence

Run in this order:

1. JSON parse and schema validation.
2. Identity/version echo validation.
3. exactly 12 spreads, numbered once each in order.
4. title equality with backend-rendered title.
5. required beat markers/facts, counts, refrain, and ending checks from the book definition.
6. age-engine deterministic bounds.
7. personalization evidence validation against profile and map.
8. callback-before-introduction and selected-detail/moment caps.
9. forbidden term, unsafe content, IP, and unsupported-claim rules.
10. optional editorial/LLM evaluator, never as the sole gate.

## Deterministic personalization checks

- Every evidence `source_field` and `source_value` must exist in normalized input.
- Every `slot_id` must exist for that spread and permit the declared moment type/source field.
- `selected_detail_count` is the number of unique `(source_field, normalized_value)` pairs.
- `moment_count` is the number of evidence records, not the number of string occurrences.
- Counts must obey map hard maxima. Falling below targets is allowed only for sparse input, no eligible pair, or editorial omission; record the reason.
- A callback requires a prior evidence record for the same detail with an introduction-capable moment type.
- Text requiring visual alignment must have `visual_required=true` and emit the matching `visual_slot_id`.
- Prohibited fields and omitted details must not appear in story text after normalized case/diacritic-insensitive matching. Exact string checks are necessary but not sufficient; include human sampling.
- Evidence offsets are optional; evidence itself is required in internal production output.

## Retry and repair

On structural failure, retry the same pinned request once with validation errors and temperature reduced. Do not change `book_id`, map, age engine, or profile. If still invalid, fail the candidate and regenerate only that candidate. Never silently substitute a different plot.

Content repair is restricted to the bounded failure classes (word bounds, personalization caps/legality, banned terms, leakage, the empty-evidence gate — never schema, identity, title, refrain, beat, or spread-structure failures). It may edit only the spread text implicated by the listed violations — removing a violating personalization moment edits its own spread; adding a moment required by the empty-evidence gate edits only a slot's designated spread — and `personalization_evidence`/`omitted_profile_fields` may change only to exactly describe those text edits. The repaired output must be revalidated against the complete 12-spread story, including deterministic evidence-to-spread text alignment. Maximum attempts and provider timeouts are configuration, logged per request.

## Persistence and idempotency

Use `request_id` as an idempotency key. Persist:

- raw and normalized profile snapshot hashes;
- chosen `book_id` and selection audit;
- writer, age-engine, catalog, map-schema, map-content, selector, model, and prompt-template versions;
- complete request payload hash;
- raw response, validated response, errors, retries, and approval status.

Never overwrite an accepted generation. A regeneration creates a new immutable attempt linked to the original request.

## Operational feature flags

- `plot_fit_ranking_v1_3`
- `personalization_maps_v1_3`
- `writer_engine_v1_3`
- `personalization_evidence_required`

Flags must be independently reversible. Rollback restores V1.1 generation using the already persisted `book_id`; it must not reselect candidates.

## Illustration handoff

The story response sends only approved visual-personalization instructions. Illustration code resolves `visual_slot_id` against the same map and fixed master-scene specification. The child appears in every story spread. Art generation never receives authority to alter plot, characters, counts, scene purpose, or text.

## Privacy and retention

Send the writer only the minimum structured profile needed for prose. Never send the child photo to the text model. Apply product retention and deletion policy to raw answers and generation logs. Do not log secrets, full signed asset URLs, or unnecessary sensitive data.
