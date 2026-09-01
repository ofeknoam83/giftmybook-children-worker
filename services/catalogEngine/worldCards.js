/**
 * World-law cards — the per-theme fixed-world invariants (Layer 1 of the
 * cross-spread world-consistency design).
 *
 * Each catalog theme carries a short versioned card of world facts (palette,
 * era, physical/magical laws, continuity) in data/worldCards.json. The card
 * is appended VERBATIM to every spread's scene prompt (scenes.js) and to the
 * theme's world-plate prompt (illustrator/worldPlate.js), so every stateless
 * render is specified against the same world instead of each render
 * re-inventing it. Cards are versioned data, never generated at runtime;
 * editing one changes pixels, so any edit bumps STYLE_VERSION (versions.js).
 *
 * Boot invariants (throw at require time — a bad card set must never serve):
 *  - every catalog theme_id has a card, and no card names an unknown theme
 *    (the catalog's theme structure is frozen; the overlay cannot add ids);
 *  - every card is a non-empty array of non-empty strings;
 *  - every card fits WORLD_CARD_MAX_BYTES of UTF-8 — the card rides all 12
 *    render prompts, so a bloated card dilutes the identity/style blocks.
 */

const raw = require('./data/worldCards.json');
const { listThemes } = require('./catalog');

const WORLD_CARD_MAX_BYTES = 900;

/** @returns {Object<string, string[]>} validated themeId → card lines */
function validateCards() {
  const cards = raw && typeof raw.cards === 'object' && raw.cards !== null ? raw.cards : null;
  if (!cards) throw new Error('worldCards.json: missing "cards" object');
  const themeIds = new Set(listThemes().map(t => t.themeId));
  const cardIds = Object.keys(cards);
  for (const id of themeIds) {
    if (!Object.prototype.hasOwnProperty.call(cards, id)) {
      throw new Error(`worldCards.json: catalog theme '${id}' has no world card`);
    }
  }
  for (const id of cardIds) {
    if (!themeIds.has(id)) throw new Error(`worldCards.json: card '${id}' names no catalog theme`);
    const lines = cards[id];
    if (!Array.isArray(lines) || lines.length === 0
      || !lines.every(l => typeof l === 'string' && l.trim().length > 0)) {
      throw new Error(`worldCards.json: card '${id}' must be a non-empty array of non-empty strings`);
    }
    const bytes = Buffer.byteLength(lines.join('\n'), 'utf8');
    if (bytes > WORLD_CARD_MAX_BYTES) {
      throw new Error(`worldCards.json: card '${id}' is ${bytes} UTF-8 bytes (max ${WORLD_CARD_MAX_BYTES}) — tighten it, it rides every render prompt`);
    }
  }
  return cards;
}

const CARDS = validateCards();

/**
 * The validated world-law lines for one theme.
 * @param {string} themeId catalog theme_id
 * @returns {string[]|null} card lines, or null for an unknown theme
 */
function getWorldCard(themeId) {
  return Object.prototype.hasOwnProperty.call(CARDS, themeId) ? CARDS[themeId] : null;
}

/**
 * The framed prompt block for one theme's card — the exact text appended to
 * a spread's scene prompt. Empty string for an unknown theme (a pinned
 * legacy definition must still render rather than fail on a missing card).
 * @param {string} themeId
 * @returns {string}
 */
function renderWorldCardBlock(themeId) {
  const lines = getWorldCard(themeId);
  if (!lines) return '';
  return [
    'WORLD LAWS (fixed for this book\'s world — every spread obeys the SAME laws):',
    ...lines.map(l => `- ${l}`),
  ].join('\n');
}

module.exports = { getWorldCard, renderWorldCardBlock, WORLD_CARD_MAX_BYTES };
