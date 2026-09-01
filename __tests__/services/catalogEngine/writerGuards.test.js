/**
 * Writer guardrails against personalization/word-count failures:
 * deterministic detail pre-selection (offer only what the map allows),
 * the explicit HARD LIMITS prompt line, and the targeted repair pass
 * classifier + prompt.
 */

const {
  selectOfferedDetails,
  isRepairable,
  buildRepairPrompt,
  buildStoryRequest,
  buildUserPrompt,
  checkRepairDelta,
} = require('../../../services/catalogEngine/writer');
const { usableDetails } = require('../../../services/catalogEngine/profile');
const { getBook } = require('../../../services/catalogEngine/catalog');
const { augmentsFor } = require('../../../services/catalogEngine/augments');

const PRONOUNS = { subject: 'she', object: 'her', possessive_adjective: 'her' };
const richProfile = {
  name: 'Emma', age: 2, pronouns: PRONOUNS,
  object: 'bunny Flopsy', interests: ['soccer', 'lego'], activities: ['baking'],
  food: 'pizza', place: 'the beach', habit: 'hums while thinking', trait: 'curious',
};

describe('selectOfferedDetails (structural max_details compliance)', () => {
  const map = {
    targets: { max_details: 2, max_moments: 4, min_details: 1, min_moments: 2 },
    detail_repeat_limit: 3,
    slots: [
      { slot_id: 's1', spread: 1, allowed_profile_fields: ['object'], allowed_moment_types: ['object_presence'], max_uses: 1 },
      { slot_id: 's2', spread: 5, allowed_profile_fields: ['object', 'food'], allowed_moment_types: ['food_celebration'], max_uses: 1 },
      { slot_id: 's3', spread: 9, allowed_profile_fields: ['habit'], allowed_moment_types: ['habit_behavior'], max_uses: 1 },
    ],
  };

  it('caps offered detail VALUES at max_details and drops fields with no legal slot', () => {
    const offered = selectOfferedDetails(richProfile, map);
    const count = usableDetails(offered).length;
    expect(count).toBe(2);
    // object has 2 supporting slots — highest priority, always kept.
    expect(offered.object).toBe('bunny Flopsy');
    // trait/place/interests/activities have NO legal slot in this map.
    expect(offered.trait).toBeNull();
    expect(offered.place).toBeNull();
    expect(offered.interests).toEqual([]);
    expect(offered.activities).toEqual([]);
  });

  it('is deterministic and never mutates the input', () => {
    const a = selectOfferedDetails(richProfile, map);
    const b = selectOfferedDetails(richProfile, map);
    expect(a).toEqual(b);
    expect(richProfile.trait).toBe('curious');
  });

  it('no map (name-only) returns the profile untouched', () => {
    expect(selectOfferedDetails(richProfile, null)).toBe(richProfile);
  });

  it('max_details: 0 is a real cap, not "uncapped" — no optional detail is offered', () => {
    const zeroCap = { ...map, targets: { ...map.targets, max_details: 0, min_details: 0 } };
    const offered = selectOfferedDetails(richProfile, zeroCap);
    expect(usableDetails(offered).length).toBe(0);
  });

  it('on a REAL approved map, the pinned request profile always fits the caps', () => {
    const bookId = 'christmas_2_3_cookie_day';
    const { request } = buildStoryRequest({ bookId, profile: richProfile, sessionId: 'sess_guard_1' });
    const { personalizationMap } = augmentsFor(bookId);
    expect(usableDetails(request.profile).length)
      .toBeLessThanOrEqual(personalizationMap.targets.max_details);
    // Every offered field has at least one slot that legally accepts it.
    const legalFields = new Set(personalizationMap.slots.flatMap(s => s.allowed_profile_fields || []));
    for (const d of usableDetails(request.profile)) expect(legalFields.has(d.field)).toBe(true);
  });

  it('the map-mode prompt carries the HARD LIMITS command line', () => {
    const bookId = 'christmas_2_3_cookie_day';
    const { request, book, ageBand, map: bookMap } = buildStoryRequest({ bookId, profile: richProfile, sessionId: 'sess_guard_2' });
    const prompt = buildUserPrompt({ request, book, theme: getBook(bookId).theme, ageBand, map: bookMap });
    expect(prompt).toContain('HARD LIMITS: use at most');
    expect(prompt).toContain(`at most ${bookMap.targets.max_details} distinct details`);
  });
});

describe('targeted repair pass', () => {
  it('classifies bounded failures as repairable', () => {
    expect(isRepairable([
      'spread 7: 64 words, must be 50-60 for age band 8-10',
      'selected_detail_count 5 exceeds map max_details 4',
      "evidence: slot s07_trait does not allow profile field 'activities'",
      'banned brand/IP term in story text: "Lego"',
    ])).toBe(true);
  });

  it('refuses plot-level or structural failures — and any mix containing one', () => {
    expect(isRepairable(["title must exactly equal the rendered title 'X'"])).toBe(false);
    expect(isRepairable(['spreads must be numbered 1-12 in order (got 1,2)'])).toBe(false);
    expect(isRepairable([
      'spread 7: 64 words, must be 50-60 for age band 8-10',
      "versions.writer_engine must echo '1.3.0'",
    ])).toBe(false);
    expect(isRepairable([])).toBe(false);
    expect(isRepairable(null)).toBe(false);
  });

  it('the repair prompt pins the previous response, the violations, and the do-not-change orders', () => {
    const request = { request_id: 'req_1', book_id: 'b1', versions: { writer_engine: '1.3.0' } };
    const response = { title: 'T', spreads: [{ spread: 1, text: 'hello' }] };
    const prompt = buildRepairPrompt({ request, response, errors: ['spread 1: 5 words, must be 12-25 for age band 1-3 (exact age 2)'] });
    expect(prompt).toContain('REPAIR TASK');
    expect(prompt).toContain('"title": "T"');
    expect(prompt).toContain('- spread 1: 5 words');
    expect(prompt).toContain('Do NOT change: the plot events');
    expect(prompt).toContain('req_1');
  });
});

describe('checkRepairDelta (contract minimal-edit boundary)', () => {
  const spreads = (texts) => texts.map((text, i) => ({ spread: i + 1, text }));
  const before = {
    spreads: spreads(['one alpha', 'two beta', 'three gamma']),
    personalization_evidence: [
      { source_field: 'food', source_value: 'pasta', moment_type: 'sensory', spread: 2, slot_id: 's2' },
    ],
  };

  it('permits only violation-implicated spreads', () => {
    const after = { ...before, spreads: spreads(['one alpha FIXED', 'two beta', 'three gamma']) };
    expect(checkRepairDelta({
      before, after, errors: ['spread 1: 200 words, must be 10-40'], map: null,
    })).toEqual([]);

    const overreach = { ...before, spreads: spreads(['one alpha FIXED', 'two beta', 'three gamma CHANGED']) };
    const problems = checkRepairDelta({
      before, after: overreach, errors: ['spread 1: 200 words, must be 10-40'], map: null,
    });
    expect(problems.join(' ')).toMatch(/spread 3.*unimplicated/);
  });

  it('cap errors implicate evidence-bearing and slot spreads, nothing else', () => {
    const map = { slots: [{ slot_id: 's2', spread: 2 }] };
    const legal = {
      spreads: spreads(['one alpha', 'two beta REWORDED', 'three gamma']),
      personalization_evidence: [],
    };
    expect(checkRepairDelta({
      before, after: legal, errors: ['moment_count 7 exceeds map max_moments 6'], map,
    })).toEqual([]);

    const illegal = {
      spreads: spreads(['one alpha CHANGED', 'two beta', 'three gamma']),
      personalization_evidence: before.personalization_evidence,
    };
    expect(checkRepairDelta({
      before, after: illegal, errors: ['moment_count 7 exceeds map max_moments 6'], map,
    }).join(' ')).toMatch(/spread 1.*unimplicated/);
  });

  it('evidence may not move to unimplicated spreads; total-word errors permit everything', () => {
    const sneaky = {
      spreads: before.spreads,
      personalization_evidence: [
        ...before.personalization_evidence,
        { source_field: 'object', source_value: 'bunny', moment_type: 'object_presence', spread: 3, slot_id: 's3' },
      ],
    };
    expect(checkRepairDelta({
      before, after: sneaky, errors: ['spread 1: 200 words, must be 10-40'], map: null,
    }).join(' ')).toMatch(/added or altered evidence on unimplicated spread 3/);

    const everything = { ...sneaky, spreads: spreads(['a new one', 'a new two', 'a new three']) };
    expect(checkRepairDelta({
      before, after: everything, errors: ['total 900 words, must be 300-450'], map: null,
    })).toEqual([]);
  });
});
