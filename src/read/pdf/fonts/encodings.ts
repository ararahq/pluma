/**
 * Simple-font encodings (byte -> Unicode) and a compact slice of the Adobe
 * Glyph List for /Differences entries and best-effort fallback when a font
 * has no ToUnicode CMap. Covers Latin text (the overwhelming case for
 * business documents); glyphs outside this table degrade to U+FFFD.
 * The glyph-name mapping is adapted from Adobe Glyph List data
 * (Copyright 2002-2019 Adobe, BSD-3-Clause); see NOTICE and
 * THIRD_PARTY_LICENSES/Adobe-AGL-BSD-3-Clause.txt.
 */

// prettier-ignore
const STANDARD_ENCODING: Record<number, number> = {
  32: 32, 33: 33, 34: 8221, 35: 35, 36: 36, 37: 37, 38: 38, 39: 8217, 40: 40, 41: 41,
  42: 42, 43: 43, 44: 44, 45: 45, 46: 46, 47: 47, 48: 48, 49: 49, 50: 50, 51: 51,
  52: 52, 53: 53, 54: 54, 55: 55, 56: 56, 57: 57, 58: 58, 59: 59, 60: 60, 61: 61,
  62: 62, 63: 63, 64: 64, 65: 65, 66: 66, 67: 67, 68: 68, 69: 69, 70: 70, 71: 71,
  72: 72, 73: 73, 74: 74, 75: 75, 76: 76, 77: 77, 78: 78, 79: 79, 80: 80, 81: 81,
  82: 82, 83: 83, 84: 84, 85: 85, 86: 86, 87: 87, 88: 88, 89: 89, 90: 90, 91: 91,
  92: 92, 93: 93, 94: 94, 95: 95, 96: 8216, 97: 97, 98: 98, 99: 99, 100: 100,
  101: 101, 102: 102, 103: 103, 104: 104, 105: 105, 106: 106, 107: 107, 108: 108,
  109: 109, 110: 110, 111: 111, 112: 112, 113: 113, 114: 114, 115: 115, 116: 116,
  117: 117, 118: 118, 119: 119, 120: 120, 121: 121, 122: 122, 123: 123, 124: 124,
  125: 125, 126: 126, 161: 161, 162: 162, 163: 163, 164: 8260, 165: 165, 166: 402,
  167: 167, 168: 164, 169: 39, 170: 8220, 171: 171, 172: 8249, 173: 8250, 174: 64257,
  175: 64258, 177: 8211, 178: 8224, 179: 8225, 180: 183, 182: 182, 183: 8226,
  184: 8218, 185: 8222, 186: 8221, 187: 187, 188: 8230, 189: 8240, 191: 191,
  193: 96, 194: 180, 195: 710, 196: 732, 197: 175, 198: 728, 199: 729, 200: 168,
  202: 730, 203: 184, 205: 733, 206: 733, 207: 733, 208: 8212, 225: 198, 227: 170,
  232: 216, 233: 338, 234: 186, 241: 230, 245: 305, 248: 248, 249: 339, 250: 223,
}

// prettier-ignore
const WIN_ANSI_ENCODING: Record<number, number> = {
  128: 8364, 130: 8218, 131: 402, 132: 8222, 133: 8230, 134: 8224, 135: 8225,
  136: 710, 137: 8240, 138: 352, 139: 8249, 140: 338, 142: 381, 145: 8216,
  146: 8217, 147: 8220, 148: 8221, 149: 8226, 150: 8211, 151: 8212, 152: 732,
  153: 8482, 154: 353, 155: 8250, 156: 339, 158: 382, 159: 376,
}

/** WinAnsi 0xA0-0xFF matches Latin-1 (Unicode code point equals byte value). */
function winAnsiExtended(byte: number): number {
  if (byte in WIN_ANSI_ENCODING) return WIN_ANSI_ENCODING[byte]
  if (byte >= 0xa0 && byte <= 0xff) return byte
  if (byte >= 0x20 && byte <= 0x7e) return byte
  return 0xfffd
}

// prettier-ignore
const MAC_ROMAN_HIGH: Record<number, number> = {
  128: 196, 129: 197, 130: 199, 131: 201, 132: 209, 133: 214, 134: 220, 135: 225,
  136: 224, 137: 226, 138: 228, 139: 227, 140: 229, 141: 231, 142: 233, 143: 232,
  144: 234, 145: 235, 146: 237, 147: 236, 148: 238, 149: 239, 150: 241, 151: 243,
  152: 242, 153: 244, 154: 246, 155: 245, 156: 250, 157: 249, 158: 251, 159: 252,
  160: 8224, 161: 176, 162: 162, 163: 163, 164: 167, 165: 8226, 166: 182, 167: 223,
  168: 174, 169: 169, 170: 8482, 171: 180, 172: 168, 174: 198, 175: 216,
  177: 177, 180: 165, 181: 181, 187: 170, 188: 186, 190: 230, 191: 248,
  192: 191, 193: 161, 194: 172, 196: 402, 199: 171, 200: 187, 201: 8230,
  202: 160, 203: 192, 204: 195, 205: 213, 206: 338, 207: 339, 208: 8211, 209: 8212,
  210: 8220, 211: 8221, 212: 8216, 213: 8217, 214: 247, 216: 255, 217: 376,
  218: 8260, 219: 8364, 220: 8249, 221: 8250, 222: 64257, 223: 64258, 224: 8225,
  225: 183, 226: 8218, 227: 8222, 228: 8240, 229: 194, 230: 202, 231: 193, 232: 203,
  233: 200, 234: 205, 235: 206, 236: 207, 237: 204, 238: 211, 239: 212, 241: 210,
  242: 218, 243: 219, 244: 217, 245: 305, 246: 710, 247: 732, 248: 175, 249: 728,
  250: 729, 251: 730, 252: 184, 253: 733, 254: 731, 255: 711,
}

export type EncodingName = "StandardEncoding" | "WinAnsiEncoding" | "MacRomanEncoding"

export function decodeByte(encoding: EncodingName | undefined, byte: number): number {
  if (byte >= 0x20 && byte <= 0x7e) return byte
  if (encoding === "MacRomanEncoding") return MAC_ROMAN_HIGH[byte] ?? 0xfffd
  if (encoding === "StandardEncoding") return STANDARD_ENCODING[byte] ?? 0xfffd
  return winAnsiExtended(byte)
}

/** Minimal Adobe Glyph List slice — Latin letters, digits, punctuation, ligatures. */
export const GLYPH_NAME_TO_UNICODE: Record<string, number> = {
  space: 32, exclam: 33, quotedbl: 34, numbersign: 35, dollar: 36, percent: 37,
  ampersand: 38, quotesingle: 39, quoteright: 8217, parenleft: 40, parenright: 41,
  asterisk: 42, plus: 43, comma: 44, hyphen: 45, period: 46, slash: 47,
  zero: 48, one: 49, two: 50, three: 51, four: 52, five: 53, six: 54, seven: 55,
  eight: 56, nine: 57, colon: 58, semicolon: 59, less: 60, equal: 61, greater: 62,
  question: 63, at: 64, bracketleft: 91, backslash: 92, bracketright: 93,
  asciicircum: 94, underscore: 95, grave: 96, quoteleft: 8216, braceleft: 123,
  bar: 124, braceright: 125, asciitilde: 126, fi: 64257, fl: 64258,
  endash: 8211, emdash: 8212, bullet: 8226, ellipsis: 8230, quotedblleft: 8220,
  quotedblright: 8221, dagger: 8224, daggerdbl: 8225, trademark: 8482,
  Adieresis: 196, adieresis: 228, Aring: 197, aring: 229, Ccedilla: 199, ccedilla: 231,
  Eacute: 201, eacute: 233, Ntilde: 209, ntilde: 241, Odieresis: 214, odieresis: 246,
  Udieresis: 220, udieresis: 252, agrave: 224, egrave: 232, ograve: 242, ugrave: 249,
  acircumflex: 226, ecircumflex: 234, ocircumflex: 244, ucircumflex: 251,
  ordfeminine: 170, ordmasculine: 186, degree: 176, section: 167, paragraph: 182,
  germandbls: 223, Oslash: 216, oslash: 248, AE: 198, ae: 230, OE: 338, oe: 339,
}

for (let i = 65; i <= 90; i++) GLYPH_NAME_TO_UNICODE[String.fromCharCode(i)] = i
for (let i = 97; i <= 122; i++) GLYPH_NAME_TO_UNICODE[String.fromCharCode(i)] = i

/** Resolves a glyph name from /Differences to a Unicode code point, best effort. */
export function glyphNameToUnicode(name: string): number {
  const known = GLYPH_NAME_TO_UNICODE[name]
  if (known !== undefined) return known
  const uniMatch = name.match(/^uni([0-9A-Fa-f]{4})$/)
  if (uniMatch) return Number.parseInt(uniMatch[1], 16)
  const uMatch = name.match(/^u([0-9A-Fa-f]{4,6})$/)
  if (uMatch) return Number.parseInt(uMatch[1], 16)
  if (name.length === 1) return name.charCodeAt(0)
  return 0xfffd
}
