/**
 * Garment lettering is CLOTHING (2026-09-08).
 *
 * An astronaut book's approved cover dressed the child in a spacesuit with
 * an agency emblem, a flag patch and a mission badge. Every character-sheet
 * candidate reproduced that outfit faithfully (cover likeness 1.0) and every
 * one was rejected `readable text on the sheet`, because the judge's text
 * question counted the letters on the patches as sheet text; the repair pass
 * was then asked to remove "readable text" while preserving every garment,
 * an instruction the model could only satisfy by ignoring one half of it,
 * so three saved candidates failed identically and — the candidates and
 * their verdicts being durable — every later regeneration replayed the same
 * failure with no new render. The same "ANY readable text" question sits in
 * the coloring line-sheet judge, the caption-layout spread QA and the
 * gift-video still judge, all of which see the same suit.
 *
 * The rule, stated once for every judge: lettering that is part of a
 * garment's own design is judged as CLOTHING — under the outfit checks
 * (present on the reference ⇒ correct; absent from it ⇒ an outfit
 * difference) — never as readable, painted or stray text. Text on the
 * background, on a sign, on a panel, beside or over the figures stays text.
 */

/** The judge-side exemption, appended to every "readable text" question. */
const GARMENT_LETTERING_JUDGE_NOTE = 'Lettering that is part of a garment\'s own design — a word, logo, emblem, patch, badge, name or number printed, embroidered or sewn ON the clothing a character wears — is CLOTHING, not text: never report it as readable, painted or stray text; judge it only under the outfit checks (correct when the reference shows it on that garment, an outfit difference when it does not).';

module.exports = { GARMENT_LETTERING_JUDGE_NOTE };
