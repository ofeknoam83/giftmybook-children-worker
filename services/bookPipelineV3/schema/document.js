/**
 * bookPipelineV3 — internal artifact shapes + validators.
 *
 * These are the WRITER-side artifacts (Concept, Manuscript, SceneContract,
 * JudgeReport). The document RETURNED by the pipeline is the v1-shaped book
 * document produced by the illustration adapter (see
 * orchestration/activities/illustrationDirector.js) with V3 artifacts
 * preserved under `doc.v3` for milestone 2's native art director.
 *
 * Validators throw with precise messages — a malformed LLM artifact must
 * fail at the stage that produced it, not three stages later.
 */

const FORM_CHOICES = ['rhymed_verse', 'rhythmic_prose', 'sparse_lyric'];

const SCENE_CONTRACT_FIELDS = [
  'setting', 'characters_present', 'hero_action', 'emotion',
  'key_objects', 'time_of_day', 'continuity_notes',
];

const JUDGE_DIMENSIONS = [
  'read_aloud_musicality',
  'emotional_truth',
  'page_turn_pull',
  'concrete_specificity',
  'personalization_depth',
  'age_fit',
  'meaning_sanity',
];

function fail(where, msg) {
  throw new Error(`bookPipelineV3 schema (${where}): ${msg}`);
}

/**
 * @param {object} sc
 * @param {string} where — context for error messages (e.g. 'spread 5')
 */
function assertSceneContract(sc, where = 'scene_contract') {
  if (!sc || typeof sc !== 'object') fail(where, 'scene_contract missing');
  for (const field of SCENE_CONTRACT_FIELDS) {
    if (!(field in sc)) fail(where, `scene_contract.${field} missing`);
  }
  if (typeof sc.setting !== 'string' || !sc.setting.trim()) fail(where, 'scene_contract.setting must be a non-empty string');
  if (!Array.isArray(sc.characters_present)) fail(where, 'scene_contract.characters_present must be an array');
  if (typeof sc.hero_action !== 'string' || !sc.hero_action.trim()) fail(where, 'scene_contract.hero_action must be a non-empty string');
  if (!Array.isArray(sc.key_objects)) fail(where, 'scene_contract.key_objects must be an array');
  return sc;
}

/**
 * Normalize + validate a concept emitted by the concept room.
 */
function normalizeConcept(raw, { angleId } = {}) {
  if (!raw || typeof raw !== 'object') fail('concept', 'empty concept');
  const id = String(raw.id || raw.angle || angleId || '').trim();
  if (!id) fail('concept', 'concept.id missing');
  const form = String(raw.form_choice || '').trim();
  if (!FORM_CHOICES.includes(form)) fail(`concept ${id}`, `form_choice '${form}' not one of ${FORM_CHOICES.join('|')}`);
  if (!raw.logline || typeof raw.logline !== 'string') fail(`concept ${id}`, 'logline missing');
  if (!Array.isArray(raw.sample_lines) || raw.sample_lines.length === 0) fail(`concept ${id}`, 'sample_lines missing');
  return {
    id,
    angle: String(raw.angle || angleId || id),
    logline: raw.logline,
    external_plot: String(raw.external_plot || ''),
    internal_arc: String(raw.internal_arc || ''),
    form_choice: form,
    form_justification: String(raw.form_justification || ''),
    refrain: raw.refrain && typeof raw.refrain === 'object' && raw.refrain.text
      ? { text: String(raw.refrain.text), evolution: Array.isArray(raw.refrain.evolution) ? raw.refrain.evolution : [] }
      : null,
    climax_image: String(raw.climax_image || ''),
    final_page_note: String(raw.final_page_note || ''),
    sample_lines: raw.sample_lines.map(String).slice(0, 5),
    load_bearing_details: Array.isArray(raw.load_bearing_details) ? raw.load_bearing_details.map(String) : [],
  };
}

/**
 * Normalize + validate a manuscript emitted by the writer or revisor.
 *
 * @param {object} raw — { title, form, refrain, spreads: [...] }
 * @param {{ id?: string, expectedSpreads?: number, model?: string }} opts
 */
function normalizeManuscript(raw, { id = 'A', expectedSpreads = null, model = null } = {}) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.spreads)) {
    fail(`manuscript ${id}`, 'expected { spreads: [...] }');
  }
  const form = String(raw.form || '').trim();
  if (!FORM_CHOICES.includes(form)) fail(`manuscript ${id}`, `form '${form}' not one of ${FORM_CHOICES.join('|')}`);

  const spreads = raw.spreads.map((s) => {
    const spread = typeof s.spread === 'number' ? s.spread : null;
    if (spread === null) fail(`manuscript ${id}`, 'spread entry missing numeric `spread`');
    const lines = Array.isArray(s.lines) ? s.lines.map(String).filter((l) => l.trim()) : [];
    if (lines.length === 0) fail(`manuscript ${id}`, `spread ${spread} has no lines`);
    assertSceneContract(s.scene_contract, `manuscript ${id} spread ${spread}`);
    return {
      spread,
      lines,
      text: lines.join('\n'),
      refrain_here: s.refrain_here === true,
      scene_contract: s.scene_contract,
    };
  });
  spreads.sort((a, b) => a.spread - b.spread);

  if (expectedSpreads && spreads.length !== expectedSpreads) {
    fail(`manuscript ${id}`, `expected ${expectedSpreads} spreads, got ${spreads.length}`);
  }
  const seen = new Set();
  for (const s of spreads) {
    if (seen.has(s.spread)) fail(`manuscript ${id}`, `duplicate spread number ${s.spread}`);
    seen.add(s.spread);
  }

  return {
    id,
    title: String(raw.title || ''),
    form,
    refrain: raw.refrain && typeof raw.refrain === 'object' && raw.refrain.text
      ? { text: String(raw.refrain.text), evolution: Array.isArray(raw.refrain.evolution) ? raw.refrain.evolution : [] }
      : null,
    spreads,
    model,
    generated_at: new Date().toISOString(),
  };
}

/**
 * Validate ONE judge's report for one or two manuscripts. Returns the
 * normalized report or throws — the judgePanel activity catches per-judge
 * and degrades the panel rather than failing the run on one flaky judge.
 *
 * @param {object} raw — the judge's JSON
 * @param {{ judge: string, family: string, model: string, expectedLabels: string[] }} meta
 */
function normalizeJudgeReport(raw, { judge, family, model, expectedLabels }) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.manuscripts)) {
    fail(`judge ${judge}`, 'expected { manuscripts: [...] }');
  }
  const byLabel = new Map();
  for (const m of raw.manuscripts) {
    const label = String(m.label || '').trim();
    if (!expectedLabels.includes(label)) fail(`judge ${judge}`, `unexpected manuscript label '${label}'`);
    const scores = {};
    for (const dim of JUDGE_DIMENSIONS) {
      const entry = m.scores?.[dim];
      const score = typeof entry === 'number' ? entry : entry?.score;
      if (typeof score !== 'number' || score < 1 || score > 5) {
        fail(`judge ${judge}`, `manuscript ${label} dimension ${dim} score invalid (${JSON.stringify(score)})`);
      }
      scores[dim] = {
        score,
        evidence: Array.isArray(entry?.evidence) ? entry.evidence : [],
      };
    }
    byLabel.set(label, {
      label,
      scores,
      meaning_sanity_fail: m.meaning_sanity_fail === true,
      flagged_spreads: Array.isArray(m.flagged_spreads)
        ? m.flagged_spreads
          .filter((f) => typeof f?.spread === 'number')
          .map((f) => ({
            spread: f.spread,
            dimension: String(f.dimension || ''),
            issue: String(f.issue || ''),
            suggestion: String(f.suggestion || ''),
          }))
        : [],
      one_line_verdict: String(m.one_line_verdict || ''),
    });
  }
  for (const label of expectedLabels) {
    if (!byLabel.has(label)) fail(`judge ${judge}`, `manuscript ${label} missing from report`);
  }
  return { judge, family, model, manuscripts: byLabel };
}

module.exports = {
  FORM_CHOICES,
  SCENE_CONTRACT_FIELDS,
  JUDGE_DIMENSIONS,
  assertSceneContract,
  normalizeConcept,
  normalizeManuscript,
  normalizeJudgeReport,
};
