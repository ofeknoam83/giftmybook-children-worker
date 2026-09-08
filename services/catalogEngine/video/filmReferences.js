const { filmError } = require('./filmScript');

/** Select video references without changing the book's illustration kit.
 * Personalization props are decorative; story props use the pinned critical
 * flag. Unknown story-object metadata is retained rather than guessed away.
 * @param {object} bible
 * @returns {{sheets: object[], omittedProps: string[]}}
 */
function selectFilmReferenceSheets(bible) {
  const definitions = new Map((bible.storyObjects?.objects || []).map(def => [def.id, def]));
  const omittedProps = [];
  const sheets = [['character', bible.sheet], ['companion', bible.companion]]
    .filter(([, sheet]) => sheet?.base64).map(([kind, sheet]) => ({ kind, sheet }));
  for (const prop of bible.props || []) {
    if (!prop.sheet?.base64 && !prop.sheet?.omitted) continue;
    if (!prop.storyObjectId || definitions.get(prop.storyObjectId)?.critical === false) {
      omittedProps.push(prop.value);
      continue;
    }
    sheets.push({ kind: 'prop', sheet: prop.sheet });
  }
  if (sheets.length > 7) throw filmError(
    `The film still needs ${sheets.length} character and essential prop reference images after excluding ${omittedProps.length} noncritical props; Kling supports seven. Review the essential props or split their references by scene.`,
    'film_reference_budget',
  );
  return { sheets, omittedProps };
}

module.exports = { selectFilmReferenceSheets };
