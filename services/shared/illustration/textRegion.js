'use strict';

/** A bounded story column, in original-image fractions, safe for a local edit.
 * Scene-wide boxes (for example narration plus shop signs) must be re-located,
 * never expanded into a repair that could repaint the characters or scenery.
 */
function isRepairableTextBox(b) {
  return !!b && ['x', 'y', 'w', 'h'].every(k => Number.isFinite(b[k]))
    && b.x >= 0 && b.y >= 0 && b.w > 0 && b.h > 0
    && b.x + b.w <= 1.01 && b.y + b.h <= 1.01
    && b.w <= 0.6 && b.w * b.h <= 0.55;
}

module.exports = { isRepairableTextBox };
