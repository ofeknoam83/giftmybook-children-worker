/**
 * Illustrator V2 — Version tracking
 *
 * Reads from root version.json and exposes illustrator-specific version.
 */

const path = require('path');

let versionData = null;

function getVersion() {
  if (!versionData) {
    try {
      versionData = require(path.resolve(__dirname, '../../version.json'));
    } catch {
      versionData = { version: 'unknown', illustratorVersion: 'unknown' };
    }
  }
  return {
    appVersion: versionData.version,
    illustratorVersion: versionData.illustratorVersion || 'illustrator-v2.0.0',
  };
}

module.exports = { getVersion };
