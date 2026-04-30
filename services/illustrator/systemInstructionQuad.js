/**
 * Re-export quad-only system instruction so callers can import from this file
 * without pulling quad prompts into legacy paths.
 */

const { buildSystemInstructionQuad } = require('./systemInstruction');

module.exports = { buildSystemInstructionQuad };
