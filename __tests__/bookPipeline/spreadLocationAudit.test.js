const {
  auditSpreadSpecsLocationDiversity,
  spreadReadsDomestic,
  maxDomesticSpreadsAllowed,
} = require('../../services/bookPipeline/planner/spreadLocationAudit');
const { TOTAL_SPREADS } = require('../../services/bookPipeline/constants');

function makeDoc(theme, domesticSpreadNums) {
  const domesticSet = new Set(domesticSpreadNums);
  const spreads = Array.from({ length: TOTAL_SPREADS }, (_, i) => {
    const n = i + 1;
    const domestic = domesticSet.has(n);
    return {
      spreadNumber: n,
      spec: domestic
        ? {
          location: 'Kitchen counter by the oven',
          plotBeat: 'Baking',
          focalAction: 'Mixing bowl',
        }
        : {
          location: 'Harbor pier at sunset, gulls and rope coils',
          plotBeat: 'Following the crumb map seaward',
          focalAction: 'Child reads the next clue on a piling',
        },
    };
  });
  return { request: { theme }, spreads };
}

describe('spreadLocationAudit', () => {
  it('flags too many domestic spreads for adventure theme', () => {
    const doc = makeDoc('adventure', [1, 2, 3, 4, 5, 6]);
    const r = auditSpreadSpecsLocationDiversity(doc);
    expect(r.ok).toBe(false);
    expect(r.domesticSpreadNumbers.length).toBe(6);
    expect(r.issues[0]).toMatch(/Too many home-interior/);
  });

  it('passes when domestic count at threshold', () => {
    const doc = makeDoc('adventure', [1, 2, 3, 4, 5]);
    const r = auditSpreadSpecsLocationDiversity(doc);
    expect(r.ok).toBe(true);
  });

  it('bedtime theme relaxes gate', () => {
    const doc = makeDoc('bedtime', Array.from({ length: 13 }, (_, i) => i + 1));
    expect(maxDomesticSpreadsAllowed('bedtime')).toBe(13);
    const r = auditSpreadSpecsLocationDiversity(doc);
    expect(r.ok).toBe(true);
  });

  it('mothers_day uses same domestic cap as adventure (strict spectacle)', () => {
    expect(maxDomesticSpreadsAllowed('mothers_day')).toBe(5);
    const doc = makeDoc('mothers_day', [1, 2, 3, 4, 5, 6]);
    expect(auditSpreadSpecsLocationDiversity(doc).ok).toBe(false);
  });

  it('spreadReadsDomestic detects couch and oven', () => {
    expect(spreadReadsDomestic({ location: 'Living room', plotBeat: '', focalAction: '' })).toBe(true);
    expect(spreadReadsDomestic({ location: 'Pier', plotBeat: 'sits on the couch', focalAction: '' })).toBe(true);
    expect(spreadReadsDomestic({ location: 'Museum atrium', plotBeat: 'climb', focalAction: '' })).toBe(false);
  });
});
