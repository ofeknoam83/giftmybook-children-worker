/**
 * Single source of truth for "how old is the child on celebration day" (e.g. birthday books).
 * Prefers birth date + reference date over a possibly stale `age` field from the client.
 */

/**
 * @param {string|Date|undefined} raw
 * @returns {Date|null}
 */
function parseBirthDate(raw) {
  if (!raw) return null;
  if (raw instanceof Date && !isNaN(raw.getTime())) return raw;
  const d = new Date(String(raw).trim());
  if (!isNaN(d.getTime())) return d;
  return null;
}

/**
 * Age in full years at referenceDate (birthday not yet reached this year => subtract one).
 *
 * @param {object} childDetails
 * @param {string|Date|undefined} [childDetails.birthDate]
 * @param {string|Date|undefined} [childDetails.childBirthDate]
 * @param {number|string|undefined} [childDetails.age]
 * @param {number|string|undefined} [childDetails.childAge]
 * @param {Date|string} [referenceDate] - defaults to now (e.g. order day)
 * @returns {number}
 */
function computeCelebrationAge(childDetails = {}, referenceDate = new Date()) {
  const ref = referenceDate instanceof Date ? referenceDate : new Date(referenceDate);
  if (isNaN(ref.getTime())) return _fallbackAge(childDetails);

  const birth = parseBirthDate(
    childDetails.birthDate || childDetails.childBirthDate || childDetails.birth_date,
  );
  if (!birth) return _fallbackAge(childDetails);

  let age = ref.getFullYear() - birth.getFullYear();
  const monthDiff = ref.getMonth() - birth.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && ref.getDate() < birth.getDate())) {
    age -= 1;
  }
  return Math.max(0, age);
}

function _fallbackAge(childDetails) {
  const a = parseInt(childDetails.age ?? childDetails.childAge ?? '5', 10);
  return Number.isFinite(a) && a >= 0 ? a : 5;
}

module.exports = { computeCelebrationAge, parseBirthDate };
