/**
 * Companion KIND — is the catalog theme's companion a PERSON or a
 * creature/character? One shared answer for every module that phrases a
 * rule around it (the sheet builder, the renderer's COMPANION block, the
 * spread QA, the contact-sheet gate), so the prompt that draws the
 * companion, the check that judges it, and the repair that fixes it never
 * disagree about what it is.
 *
 * Before ce-19 two copies of this regex lived apart (propSheet.js used
 * one to EXCLUDE human companions from getting a reference sheet; the
 * renderer used a shorter one to ALLOW the adult guide in the scene), so
 * Farmer Bea and Builder Sam were allowed in every render and pinned by
 * nothing — twelve stateless renders drew twelve different farmers.
 *
 * Companion naming is catalog data (overlay-patchable): the type phrase
 * is matched as text, never executed. Conservative on purpose: a type the
 * regex misses is treated as a creature (sheet + spec built the object
 * way, which still pins colours/markings); a false positive only changes
 * the WORDING of the sheet prompt and the check to person terms.
 */

/** Human-role words: a companion whose type carries one is a PERSON. */
const HUMAN_TYPE_RE = /\b(adult|adults|grown[- ]?ups?|human|humans|person|people|man|men|woman|women|boy|boys|girl|girls|kid|kids|child|children|baby|babies|toddler|toddlers|guide|teacher|farmer|builder|worker|ranger|keeper|driver|pilot|captain|sailor|chef|baker|doctor|nurse|librarian|coach|neighbou?r|villager|elder|uncle|aunt|grandma|grandpa|grandmother|grandfather|mother|father|mom|mum|dad|parent|parents|wizard|witch|knight|princess|prince|king|queen|astronaut|pirate|elf|elves|fairy|fairies)\b/i;

/** Words that make the PERSON a child — a companion the ONE-child rule cannot host as a second kid. */
const CHILD_TYPE_RE = /\b(boy|boys|girl|girls|kid|kids|child|children|baby|babies|toddler|toddlers)\b/i;

/**
 * Whether a companion TYPE phrase names a person (any human role, adult
 * or child, real or fairy-tale).
 * @param {*} type catalog theme.companion.type
 * @returns {boolean}
 */
function isHumanCompanionType(type) {
  return typeof type === 'string' && HUMAN_TYPE_RE.test(type);
}

/**
 * Whether a companion TYPE phrase names a CHILD person (the sheet's
 * "no child" check must not reject the subject itself).
 * @param {*} type
 * @returns {boolean}
 */
function isChildCompanionType(type) {
  return typeof type === 'string' && CHILD_TYPE_RE.test(type);
}

module.exports = { HUMAN_TYPE_RE, isHumanCompanionType, isChildCompanionType };
