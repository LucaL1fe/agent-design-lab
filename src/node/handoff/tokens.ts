// Design tokens from styles/tokens.css (custom properties on :root) to a typed list and the W3C Design Tokens format
// (DTCG), so a builder can import them into any styling system.
import postcss from 'postcss';

export type TokenType =
  | 'color'
  | 'dimension'
  | 'duration'
  | 'cubicBezier'
  | 'fontFamily'
  | 'shadow'
  | 'number'
  | 'other';

export interface Token {
  /** Without the leading "--". */
  name: string;
  value: string;
  type: TokenType;
  /** First part of the name ("color" for --color-accent). */
  group: string;
}

const COLOR = /^(#[0-9a-f]{3,8}|(rgb|rgba|hsl|hsla|oklch|oklab|lab|lch|color)\(.+\)|transparent|currentcolor|[a-z]+)$/i;

export function tokenType(name: string, value: string): TokenType {
  const v = value.trim();
  if (/^font/.test(name) && !/^[\d.]+(px|rem|em)?$/.test(v) && !/^\d{3}$/.test(v)) return 'fontFamily';
  if (/^shadow/.test(name)) return 'shadow';
  if (/^cubic-bezier\(/.test(v) || /^ease/.test(name)) return 'cubicBezier';
  if (/^-?[\d.]+m?s$/.test(v)) return 'duration';
  if (/^-?[\d.]+(px|rem|em|%|vh|vw)$/.test(v)) return 'dimension';
  if (/^-?[\d.]+$/.test(v)) return 'number';
  if (/^#[0-9a-f]{3,8}$/i.test(v) || /^(rgb|rgba|hsl|hsla|oklch|oklab|lab|lch|color)\(/i.test(v)) return 'color';
  if (/^(color|bg|fg|text-color|surface)/.test(name) && COLOR.test(v)) return 'color';
  return 'other';
}

/** Custom properties declared on :root / html in the given CSS. Later declarations win. */
export function parseTokens(css: string): Token[] {
  const out = new Map<string, Token>();
  let root: postcss.Root;
  try {
    root = postcss.parse(css);
  } catch {
    return [];
  }
  root.walkRules((rule) => {
    if (!rule.selectors.some((s) => /^(:root|html)$/.test(s.trim()))) return;
    // tokens inside @media (e.g. dark mode) are variants, not the base set
    if (rule.parent?.type === 'atrule') return;
    rule.each((d) => {
      if (d.type !== 'decl' || !d.prop.startsWith('--')) return;
      const name = d.prop.slice(2);
      const value = d.value.trim();
      out.set(name, { name, value, type: tokenType(name, value), group: name.split('-')[0] ?? name });
    });
  });
  return [...out.values()];
}

/** DTCG: { color: { accent: { $type: "color", $value: "#3b6cf6" } } } — references become "{group.name}". */
export function toDtcg(tokens: Token[]): Record<string, unknown> {
  const names = new Set(tokens.map((t) => t.name));
  const out: Record<string, Record<string, unknown>> = {};
  const ref = (v: string) =>
    v.replace(/var\(--([\w-]+)\)/g, (m, n: string) => (names.has(n) ? `{${n.replace('-', '.')}}` : m));
  for (const t of tokens) {
    const [group, ...rest] = t.name.split('-');
    const key = rest.join('-') || 'base';
    out[group!] ??= {};
    const $type = t.type === 'other' ? undefined : t.type;
    out[group!]![key] = { ...($type ? { $type } : {}), $value: ref(t.value) };
  }
  return out;
}

/** Colour values a screen uses that are not tokens (for the design-system lint). */
export function rawColors(css: string): string[] {
  const out = new Set<string>();
  for (const m of css.matchAll(/#[0-9a-f]{3,8}\b|(?:rgba?|hsla?|oklch)\([^)]*\)/gi)) out.add(m[0].toLowerCase());
  return [...out];
}
