/**
 * The composer draft's line metrics, from herdrup 9845ecf ComposerView.swift 7-9 and 42-56
 * (ComposerStyle, ComposerTextMetrics.attributes()).
 *
 * The field is ComposerStyle.lineHeight (24 pt) per line, and its paragraph style fixes each
 * line at 24 with a baseline lift of lineHeight / 2 + descender - capHeight / 2 for Geist 16.
 * UIKit draws the following lines that lift closer together: in the accepted writer
 * references the draft's lines are 22.3-22.5 pt apart on both devices (24 - lift = 22.4),
 * and the first line, like the empty field's placeholder, sits 1 pt lower than a centred
 * 24 pt line box. herdr-app 380732 approved copying exactly that, for composer text only.
 */

/** ComposerStyle.fontSize and .lineHeight (Typography.scale is 1). */
export const COMPOSER_FONT_SIZE = 16;
export const COMPOSER_LINE = 24;

/** public/fonts/Geist-Regular.ttf: head.unitsPerEm, hhea.descender (UIFont.descender),
 *  OS/2.sCapHeight (UIFont.capHeight). Pinned by test/composerMetrics.test.ts. */
export const GEIST_REGULAR = { unitsPerEm: 1000, descender: -295, capHeight: 710 };

/** ComposerTextMetrics' baseline lift, in points. */
export function composerLift(font = GEIST_REGULAR, size = COMPOSER_FONT_SIZE, line = COMPOSER_LINE): number {
  const scale = size / font.unitsPerEm;
  return Math.max(0, line / 2 + font.descender * scale - (font.capHeight * scale) / 2);
}

/** The pitch UIKit draws the draft's lines at. */
export const COMPOSER_TEXT_PITCH = COMPOSER_LINE - composerLift();

/** Measured: the first line sits 1 pt below a centred 24 pt line box (writer and placeholder
 *  captures, both devices). With the shorter pitch's half-leading, that is 1 + lift / 2 above
 *  the text box. */
export const COMPOSER_FIRST_LINE_MEASURED = 1;
export const COMPOSER_TEXT_OFFSET = COMPOSER_FIRST_LINE_MEASURED + (COMPOSER_LINE - COMPOSER_TEXT_PITCH) / 2;
