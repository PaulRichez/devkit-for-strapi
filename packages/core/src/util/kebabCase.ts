/**
 * lodash's `kebabCase` (4.17/4.18), ported line for line so a name DevKit derives
 * is byte-identical to the one Strapi registers: Strapi's API loader keys every
 * API folder, content-type folder and artifact file by `_.kebabCase` (see
 * `index/loaderNames.ts`). The edge cases (acronyms, digits, Latin letters,
 * apostrophes) are lodash's own; `test/loader-names.test.ts` checks this port
 * against the real lodash.
 *
 * lodash is MIT-licensed — Copyright OpenJS Foundation and other contributors
 * <https://openjsf.org/>, based on Underscore.js.
 */

const rsAstralRange = '\\ud800-\\udfff';
const rsComboMarksRange = '\\u0300-\\u036f';
const reComboHalfMarksRange = '\\ufe20-\\ufe2f';
const rsComboSymbolsRange = '\\u20d0-\\u20ff';
const rsComboRange = rsComboMarksRange + reComboHalfMarksRange + rsComboSymbolsRange;
const rsDingbatRange = '\\u2700-\\u27bf';
const rsLowerRange = 'a-z\\xdf-\\xf6\\xf8-\\xff';
const rsMathOpRange = '\\xac\\xb1\\xd7\\xf7';
const rsNonCharRange = '\\x00-\\x2f\\x3a-\\x40\\x5b-\\x60\\x7b-\\xbf';
const rsPunctuationRange = '\\u2000-\\u206f';
const rsSpaceRange =
  ' \\t\\x0b\\f\\xa0\\ufeff\\n\\r\\u2028\\u2029\\u1680\\u180e\\u2000\\u2001\\u2002\\u2003\\u2004\\u2005\\u2006\\u2007\\u2008\\u2009\\u200a\\u202f\\u205f\\u3000';
const rsUpperRange = 'A-Z\\xc0-\\xd6\\xd8-\\xde';
const rsVarRange = '\\ufe0e\\ufe0f';
const rsBreakRange = rsMathOpRange + rsNonCharRange + rsPunctuationRange + rsSpaceRange;

const rsApos = "['’]";
const rsBreak = '[' + rsBreakRange + ']';
const rsCombo = '[' + rsComboRange + ']';
const rsDigits = '\\d+';
const rsDingbat = '[' + rsDingbatRange + ']';
const rsLower = '[' + rsLowerRange + ']';
const rsMisc = '[^' + rsAstralRange + rsBreakRange + rsDigits + rsDingbatRange + rsLowerRange + rsUpperRange + ']';
const rsFitz = '\\ud83c[\\udffb-\\udfff]';
const rsModifier = '(?:' + rsCombo + '|' + rsFitz + ')';
const rsNonAstral = '[^' + rsAstralRange + ']';
const rsRegional = '(?:\\ud83c[\\udde6-\\uddff]){2}';
const rsSurrPair = '[\\ud800-\\udbff][\\udc00-\\udfff]';
const rsUpper = '[' + rsUpperRange + ']';
const rsZWJ = '\\u200d';

const rsMiscLower = '(?:' + rsLower + '|' + rsMisc + ')';
const rsMiscUpper = '(?:' + rsUpper + '|' + rsMisc + ')';
const rsOptContrLower = '(?:' + rsApos + '(?:d|ll|m|re|s|t|ve))?';
const rsOptContrUpper = '(?:' + rsApos + '(?:D|LL|M|RE|S|T|VE))?';
const reOptMod = rsModifier + '?';
const rsOptVar = '[' + rsVarRange + ']?';
const rsOptJoin = '(?:' + rsZWJ + '(?:' + [rsNonAstral, rsRegional, rsSurrPair].join('|') + ')' + rsOptVar + reOptMod + ')*';
const rsOrdLower = '\\d*(?:1st|2nd|3rd|(?![123])\\dth)(?=\\b|[A-Z_])';
const rsOrdUpper = '\\d*(?:1ST|2ND|3RD|(?![123])\\dTH)(?=\\b|[a-z_])';
const rsSeq = rsOptVar + reOptMod + rsOptJoin;
const rsEmoji = '(?:' + [rsDingbat, rsRegional, rsSurrPair].join('|') + ')' + rsSeq;

const reApos = RegExp(rsApos, 'g');
const reComboMark = RegExp(rsCombo, 'g');
const reUnicodeWord = RegExp(
  [
    rsUpper + '?' + rsLower + '+' + rsOptContrLower + '(?=' + [rsBreak, rsUpper, '$'].join('|') + ')',
    rsMiscUpper + '+' + rsOptContrUpper + '(?=' + [rsBreak, rsUpper + rsMiscLower, '$'].join('|') + ')',
    rsUpper + '?' + rsMiscLower + '+' + rsOptContrLower,
    rsUpper + '+' + rsOptContrUpper,
    rsOrdUpper,
    rsOrdLower,
    rsDigits,
    rsEmoji,
  ].join('|'),
  'g',
);
const reHasUnicodeWord = /[a-z][A-Z]|[A-Z]{2}[a-z]|[0-9][a-zA-Z]|[a-zA-Z][0-9]|[^a-zA-Z0-9 ]/;
// eslint-disable-next-line no-control-regex -- lodash's own ASCII word class
const reAsciiWord = /[^\x00-\x2f\x3a-\x40\x5b-\x60\x7b-\x7f]+/g;
const reLatin = /[\xc0-\xd6\xd8-\xf6\xf8-\xffĀ-ſ]/g;

/** Latin-1 Supplement and Latin Extended-A letters → basic Latin (lodash `deburredLetters`). */
const DEBURRED: Record<string, string> = {
  '\xc0': 'A', '\xc1': 'A', '\xc2': 'A', '\xc3': 'A', '\xc4': 'A', '\xc5': 'A',
  '\xe0': 'a', '\xe1': 'a', '\xe2': 'a', '\xe3': 'a', '\xe4': 'a', '\xe5': 'a',
  '\xc7': 'C', '\xe7': 'c',
  '\xd0': 'D', '\xf0': 'd',
  '\xc8': 'E', '\xc9': 'E', '\xca': 'E', '\xcb': 'E',
  '\xe8': 'e', '\xe9': 'e', '\xea': 'e', '\xeb': 'e',
  '\xcc': 'I', '\xcd': 'I', '\xce': 'I', '\xcf': 'I',
  '\xec': 'i', '\xed': 'i', '\xee': 'i', '\xef': 'i',
  '\xd1': 'N', '\xf1': 'n',
  '\xd2': 'O', '\xd3': 'O', '\xd4': 'O', '\xd5': 'O', '\xd6': 'O', '\xd8': 'O',
  '\xf2': 'o', '\xf3': 'o', '\xf4': 'o', '\xf5': 'o', '\xf6': 'o', '\xf8': 'o',
  '\xd9': 'U', '\xda': 'U', '\xdb': 'U', '\xdc': 'U',
  '\xf9': 'u', '\xfa': 'u', '\xfb': 'u', '\xfc': 'u',
  '\xdd': 'Y', '\xfd': 'y', '\xff': 'y',
  '\xc6': 'Ae', '\xe6': 'ae',
  '\xde': 'Th', '\xfe': 'th',
  '\xdf': 'ss',
  'Ā': 'A', 'Ă': 'A', 'Ą': 'A',
  'ā': 'a', 'ă': 'a', 'ą': 'a',
  'Ć': 'C', 'Ĉ': 'C', 'Ċ': 'C', 'Č': 'C',
  'ć': 'c', 'ĉ': 'c', 'ċ': 'c', 'č': 'c',
  'Ď': 'D', 'Đ': 'D', 'ď': 'd', 'đ': 'd',
  'Ē': 'E', 'Ĕ': 'E', 'Ė': 'E', 'Ę': 'E', 'Ě': 'E',
  'ē': 'e', 'ĕ': 'e', 'ė': 'e', 'ę': 'e', 'ě': 'e',
  'Ĝ': 'G', 'Ğ': 'G', 'Ġ': 'G', 'Ģ': 'G',
  'ĝ': 'g', 'ğ': 'g', 'ġ': 'g', 'ģ': 'g',
  'Ĥ': 'H', 'Ħ': 'H', 'ĥ': 'h', 'ħ': 'h',
  'Ĩ': 'I', 'Ī': 'I', 'Ĭ': 'I', 'Į': 'I', 'İ': 'I',
  'ĩ': 'i', 'ī': 'i', 'ĭ': 'i', 'į': 'i', 'ı': 'i',
  'Ĵ': 'J', 'ĵ': 'j',
  'Ķ': 'K', 'ķ': 'k', 'ĸ': 'k',
  'Ĺ': 'L', 'Ļ': 'L', 'Ľ': 'L', 'Ŀ': 'L', 'Ł': 'L',
  'ĺ': 'l', 'ļ': 'l', 'ľ': 'l', 'ŀ': 'l', 'ł': 'l',
  'Ń': 'N', 'Ņ': 'N', 'Ň': 'N', 'Ŋ': 'N',
  'ń': 'n', 'ņ': 'n', 'ň': 'n', 'ŋ': 'n',
  'Ō': 'O', 'Ŏ': 'O', 'Ő': 'O',
  'ō': 'o', 'ŏ': 'o', 'ő': 'o',
  'Ŕ': 'R', 'Ŗ': 'R', 'Ř': 'R',
  'ŕ': 'r', 'ŗ': 'r', 'ř': 'r',
  'Ś': 'S', 'Ŝ': 'S', 'Ş': 'S', 'Š': 'S',
  'ś': 's', 'ŝ': 's', 'ş': 's', 'š': 's',
  'Ţ': 'T', 'Ť': 'T', 'Ŧ': 'T',
  'ţ': 't', 'ť': 't', 'ŧ': 't',
  'Ũ': 'U', 'Ū': 'U', 'Ŭ': 'U', 'Ů': 'U', 'Ű': 'U', 'Ų': 'U',
  'ũ': 'u', 'ū': 'u', 'ŭ': 'u', 'ů': 'u', 'ű': 'u', 'ų': 'u',
  'Ŵ': 'W', 'ŵ': 'w',
  'Ŷ': 'Y', 'ŷ': 'y', 'Ÿ': 'Y',
  'Ź': 'Z', 'Ż': 'Z', 'Ž': 'Z',
  'ź': 'z', 'ż': 'z', 'ž': 'z',
  'Ĳ': 'IJ', 'ĳ': 'ij',
  'Œ': 'Oe', 'œ': 'oe',
  'ŉ': "'n", 'ſ': 's',
};

function deburr(s: string): string {
  // lodash's `basePropertyOf` lookup: a Latin letter missing from the table becomes 'undefined', as there.
  return s.replace(reLatin, (c) => String(DEBURRED[c])).replace(reComboMark, '');
}

function words(s: string): string[] {
  return (reHasUnicodeWord.test(s) ? s.match(reUnicodeWord) : s.match(reAsciiWord)) ?? [];
}

/** `_.kebabCase(s)`: `fooBar` → `foo-bar`, `foo_manager` → `foo-manager`, `foo-PDF` → `foo-pdf`. */
export function kebabCase(s: string): string {
  return words(deburr(s).replace(reApos, '')).reduce((out, word, i) => out + (i ? '-' : '') + word.toLowerCase(), '');
}
