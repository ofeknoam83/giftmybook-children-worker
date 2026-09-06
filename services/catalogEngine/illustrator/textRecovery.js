'use strict';

const { createHash } = require('crypto');
const { downloadBuffer, uploadBuffer } = require('../../gcsStorage');
const { verifyImageText, repairImageText } = require('../../illustrationGenerator');
const { textVerificationCurrent } = require('../../shared/illustration/manuscript');
const { isRepairableTextBox } = require('../../shared/illustration/textRegion');

// An inconclusive reading is not a spelling error. Re-read the SAME pixels
// once before parking a book; never spend image calls on a reader outage.
async function checkSavedText(buffer, text, costTracker) {
  let verification = await verifyImageText(buffer, text, undefined, costTracker);
  if (verification.status === 'unverified') verification = await verifyImageText(buffer, text, undefined, costTracker);
  return verification;
}

/** Bounded edits of one saved image. Never replaces it with unverified pixels.
 * Attempts are content-addressed so a retry rechecks a saved edit instead of
 * paying for it again. All image calls share the caller's per-spread budget.
 */
async function recoverText({ buffer, text, verification, storageKey, spread, renderBudget, costTracker, log = () => {} }) {
  if (verification?.status !== 'mismatch') return { buffer, verification, repaired: false };
  const sourceHash = createHash('sha256').update(buffer).update(text).digest('hex').slice(0, 20);
  let current = verification;
  // Older readers included shop signs in a scene-wide box. Re-read narration
  // before spending an image attempt; a false mismatch needs no artwork edit.
  if (!isRepairableTextBox(current.textBox)) current = await checkSavedText(buffer, text, costTracker);
  if (current.status !== 'mismatch') return { buffer, verification: current, repaired: false };
  if (!isRepairableTextBox(current.textBox)) {
    log('warn', `Spread ${spread}: narration location still uncertain; saved artwork retained without an image attempt`);
    return { buffer, verification: current, repaired: false };
  }
  for (let attempt = 1; attempt <= 2; attempt++) {
    const key = storageKey.replace(/\.png$/, `.text-${sourceHash}-${attempt}.png`);
    let edited;
    try { edited = await downloadBuffer(key); }
    catch (err) {
      if (Number(err.code) !== 404) throw err;
      const used = renderBudget.used.get(spread) || 0;
      if (used >= renderBudget.limit) break;
      renderBudget.used.set(spread, used + 1);
      log('info', `Spread ${spread}: automatically correcting saved lettering (${attempt}/2)`);
      try {
        edited = await repairImageText(buffer, text, { textBox: current.textBox, costTracker });
        await uploadBuffer(edited, key, 'image/png');
      } catch (repairError) {
        log('warn', `Spread ${spread}: lettering edit could not finish (${repairError.message})`);
        break;
      }
    }
    const checked = await checkSavedText(edited, text, costTracker);
    if (textVerificationCurrent(checked, text)) {
      // Preserve the exact chosen original before the caller promotes an edit.
      await uploadBuffer(buffer, storageKey.replace(/\.png$/, `.text-original-${sourceHash}.png`), 'image/png');
      log('info', `Spread ${spread}: repaired lettering verified; saved original artwork retained`);
      return { buffer: edited, verification: checked, repaired: true, key };
    }
    if (checked.status === 'unverified') break;
  }
  return { buffer, verification: current, repaired: false };
}

module.exports = { checkSavedText, recoverText };
