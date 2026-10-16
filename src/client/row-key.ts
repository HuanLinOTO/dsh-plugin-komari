/**
 * The three constants that must agree for the configure card to appear.
 *
 * The Plugins page matches \`plugins.row.config\` registrations by the EXACT
 * string \`<package.json name>#<cordis.patch.yml row id>\`; a mismatch makes the
 * entry point vanish silently. tests/row-key.spec.ts pins them to the files
 * that define them.
 */

/** package.json \`name\` (also the \`name\` of the cordis.patch.yml row). */
export const PKG_NAME = '@huanlin/dsh-plugin-komari'

/** cordis.patch.yml row id (= settings entry id = \`ctx.configForms.get()\` argument). */
export const ENTRY_ID = 'dsh-komari'

/** \`plugins.row.config\` key. */
export const ROW_KEY = `${PKG_NAME}#${ENTRY_ID}`
