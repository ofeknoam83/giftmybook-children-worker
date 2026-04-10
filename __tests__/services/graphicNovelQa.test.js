const {
  normalizeGraphicNovelPlan,
  summarizeGraphicNovelIssues,
  validateGraphicNovelPagesForRender,
} = require('../../services/graphicNovelQa');
const { buildGraphicNovelBlueprints } = require('../../services/comicLayoutPresets');

describe('graphicNovelQa', () => {
  test('normalizes page-aware plans into renderable pages and allPanels', () => {
    const plan = normalizeGraphicNovelPlan({
      title: 'Noam and the Sky Port',
      pages: [
        {
          pageNumber: 1,
          sceneNumber: 1,
          sceneTitle: 'Launch',
          layoutTemplate: 'cinematicTopStrip',
          dominantBeat: 'The world opens up',
          panels: [
            {
              panelNumber: 1,
              panelType: 'establishing',
              action: 'Noam sees the sky port for the first time.',
              balloons: [{ text: 'Whoa.', order: 1, anchor: 'left' }],
              captions: [{ text: 'The sky port glows awake.', placement: 'top-band' }],
              imagePrompt: 'Wide establishing shot of a glowing sky port.',
            },
          ],
        },
      ],
    });

    expect(plan.pages).toHaveLength(1);
    expect(plan.pages[0].panels[0].dialogue).toBe('Whoa.');
    expect(plan.pages[0].panels[0].caption).toBe('The sky port glows awake.');
    expect(plan.allPanels).toHaveLength(1);
    expect(plan.graphicNovelVersion).toBe('v2_premium');
  });

  test('reports structural issues for weak plans', () => {
    const plan = normalizeGraphicNovelPlan({
      title: 'Short Plan',
      pages: [
        {
          pageNumber: 1,
          sceneNumber: 1,
          sceneTitle: 'Only Page',
          layoutTemplate: 'conversationGrid',
          panels: [{ panelNumber: 1, panelType: 'dialogue', dialogue: 'A very long panel should still normalize.' }],
        },
      ],
    });

    const issues = summarizeGraphicNovelIssues(plan);
    expect(issues.some((issue) => issue.type === 'page_count')).toBe(true);
    expect(issues.some((issue) => issue.type === 'splash_count')).toBe(true);
  });

  test('validates pages against page blueprints', () => {
    const plan = normalizeGraphicNovelPlan({
      title: 'Blueprint Check',
      pages: [
        {
          pageNumber: 1,
          sceneNumber: 1,
          sceneTitle: 'Check',
          layoutTemplate: 'fourGrid',
          dominantBeat: 'A lot is happening',
          panels: [
            { panelNumber: 1, panelType: 'dialogue', dialogue: 'One line', balloons: [{ text: 'One line', order: 1 }] },
            { panelNumber: 2, panelType: 'dialogue', dialogue: 'Two line', balloons: [{ text: 'Two line', order: 1 }] },
            { panelNumber: 3, panelType: 'dialogue', dialogue: 'Three line', balloons: [{ text: 'Three line', order: 1 }] },
            { panelNumber: 4, panelType: 'dialogue', dialogue: 'Four line', balloons: [{ text: 'Four line', order: 1 }] },
          ],
        },
      ],
    });
    const blueprints = buildGraphicNovelBlueprints(plan.pages, 450, 666);
    const report = validateGraphicNovelPagesForRender(plan, blueprints);

    expect(report.ok).toBe(true);
    expect(report.pageReports).toHaveLength(1);
  });
});
