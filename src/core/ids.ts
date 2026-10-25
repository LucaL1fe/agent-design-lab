export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.~-]*$/;
export const PAGE_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

export function isValidId(id: string): boolean {
  return ID_RE.test(id) && id.length <= 80;
}

/** First free id: base, base~2, base~3, … (or base2, base3 when the base ends in a letter and `plain` is set). */
export function freeId(base: string, taken: (id: string) => boolean): string {
  if (!taken(base)) return base;
  for (let i = 2; ; i++) {
    const id = `${base}~${i}`;
    if (!taken(id)) return id;
  }
}

/** Short random id for notes, texts, sections ("n7k2"). */
export function shortId(prefix: string, taken: (id: string) => boolean): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  for (;;) {
    let s = prefix;
    for (let i = 0; i < 4; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
    if (!taken(s)) return s;
  }
}

/** Readable arrow ids: "T1>T2", then "T1>T2#2" for a second arrow between the same pair. */
export function arrowId(from: string, to: string, taken: (id: string) => boolean): string {
  const base = `${from}>${to}`;
  if (!taken(base)) return base;
  for (let i = 2; ; i++) {
    const id = `${base}#${i}`;
    if (!taken(id)) return id;
  }
}

export function pageIdFromName(name: string, taken: (id: string) => boolean): string {
  const base =
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'page';
  if (!taken(base)) return base;
  for (let i = 2; ; i++) if (!taken(`${base}-${i}`)) return `${base}-${i}`;
}
