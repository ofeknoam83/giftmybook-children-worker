const { digest } = require('../../shared/llm/visualJudge');
function spreadDependencies(bible, spread) {
  const m = bible.manifest;
  if (!m) return bible.hash;
  // Presence corrections alter the checking contract, not the paid image's
  // location. Markers track that contract separately and recheck these bytes.
  const objects = (bible.storyObjects?.renderObjects || bible.storyObjects?.objects || []).filter(d => d.occurrences.some(o => o.spread === spread));
  const ids = new Set(objects.map(d => `Story object: ${d.name}`));
  return digest({ version: 1, style: m.styleVersion, anchor: m.anchorHash, child: m.characterSheet?.hash,
    outfit: m.outfitSpec, world: m.worldPlate, companion: m.companion,
    emotion: bible.emotion?.plan?.[spread] || null,
    props: (m.renderProps || m.props).filter(p => !p.value.startsWith('Story object: ') || ids.has(p.value)),
    objects: objects.map(d => ({ ...d, occurrences: d.occurrences.filter(o => o.spread === spread) })) }).slice(0, 24);
}
module.exports = { spreadDependencies };
