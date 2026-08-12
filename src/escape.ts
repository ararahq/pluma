const MARKUP_SPECIALS = /[\\#$*_`@<>\[\]~]/g

export function escapeMarkup(text: string): string {
  return text.replace(MARKUP_SPECIALS, (ch) => `\\${ch}`)
}

export function escapeString(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}
