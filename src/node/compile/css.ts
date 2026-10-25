// CSS transforms that make a screen render inside a Shadow DOM host exactly like it renders as a standalone page.
// (Strategy measured in bench/spikes/s1-fidelity.ts: real <html>/<body> elements inside the shadow root.)
import path from 'node:path';
import postcss, { type AtRule, type Declaration, type Root, type Rule } from 'postcss';
import selectorParser from 'postcss-selector-parser';
import valueParser from 'postcss-value-parser';

export interface CssContext {
  /** Project-relative path of the file this CSS comes from (for resolving url() and @import). */
  from: string;
  /** Turns a project-relative path into the URL the browser loads. */
  fileUrl: (rel: string) => string;
  /** Reads a project file (for local @import). */
  readFile: (rel: string) => string | undefined;
  /** Remote stylesheet text (cached by the caller); undefined when unavailable. */
  remote?: (url: string) => string | undefined;
}

export interface CssResult {
  css: string;
  /** Rules that only work at document level: @font-face, @property, @font-palette-values. */
  hoisted: string;
  /** Remote stylesheets that must stay <link>s in the document (font services). */
  fontLinks: string[];
  /** Project files this CSS depends on. */
  deps: string[];
  warnings: string[];
  cost: { keyframes: number; animations: number; infinite: number; backdrop: number };
  /** The same animation and blur cost per rule, with what each rule needs in a document to match (see ruleNeeds). */
  rules: RuleCost[];
}

/** A rule's animation and blur cost. `needs`: one list per selector of the tokens (`c:class`, `i:id`, `a:attr`,
 * `a:attr=value`, `w:attr=word`) a document must contain for that selector to match; null = always counts. */
export interface RuleCost {
  needs: string[][] | null;
  animations: number;
  infinite: number;
  backdrop: number;
}

/** What each selector of a rule requires: the classes, ids and attributes of its own compounds (never the arguments
 * of :not(), :is() and the like). A document without one of them cannot match that selector, so a shared stylesheet
 * with rules for many screens only counts, per screen, the rules that can apply there. */
export function ruleNeeds(selector: string): string[][] | null {
  try {
    const out: string[][] = [];
    selectorParser((root) => {
      root.each((sel) => {
        const need: string[] = [];
        for (const n of sel.nodes) {
          if (n.type === 'class') need.push(`c:${n.value}`);
          else if (n.type === 'id') need.push(`i:${n.value}`);
          else if (n.type === 'attribute') {
            const name = n.attribute.toLowerCase();
            if (n.value !== undefined && !n.insensitive && n.operator === '=') need.push(`a:${name}=${n.value}`);
            else if (n.value !== undefined && !n.insensitive && n.operator === '~=') need.push(`w:${name}=${n.value}`);
            else need.push(`a:${name}`);
          }
        }
        out.push(need);
      });
    }).processSync(selector);
    return out.length ? out : null;
  } catch {
    return null;
  }
}

/** The tokens ruleNeeds speaks of, for one element's attributes. */
export function elementTokens(attrs: { name: string; value: string }[], into: Set<string>) {
  for (const { name, value } of attrs) {
    const n = name.toLowerCase();
    into.add(`a:${n}`);
    into.add(`a:${n}=${value}`);
    for (const w of value.split(/\s+/)) if (w) into.add(`w:${n}=${w}`);
    if (n === 'class') for (const w of value.split(/\s+/)) if (w) into.add(`c:${w}`);
    if (n === 'id' && value) into.add(`i:${value}`);
  }
}

/** Sum of the rules that can match a document with these tokens. */
export function ruleCost(
  rules: RuleCost[],
  tokens: Set<string>,
): { animations: number; infinite: number; backdrop: number } {
  const out = { animations: 0, infinite: 0, backdrop: 0 };
  for (const r of rules) {
    if (r.needs && !r.needs.some((need) => need.every((t) => tokens.has(t)))) continue;
    out.animations += r.animations;
    out.infinite += r.infinite;
    out.backdrop += r.backdrop;
  }
  return out;
}

const SIZE_FEATURE = /\b(min-|max-)?(width|height|aspect-ratio|orientation|inline-size|block-size)\b/i;
const NON_SIZE_FEATURE =
  /\b(prefers-[a-z-]+|hover|any-hover|pointer|any-pointer|print|resolution|color-gamut|forced-colors|display-mode|scripting|update|monochrome|inverted-colors|dynamic-range)\b/i;
export const FONT_HOSTS =
  /^https?:\/\/(fonts\.googleapis\.com|fonts\.bunny\.net|use\.typekit\.net|fonts\.cdnfonts\.com|api\.fontshare\.com)\//i;
const VIEWPORT_UNIT = /^(-?(?:\d+\.?\d*|\.\d+))(d|s|l)?v(w|h|min|max|i|b)$/i;

export function isRemote(u: string): boolean {
  return /^(https?:)?\/\//i.test(u);
}

/** Resolve a URL found in `fromFile` to a project-relative path; undefined for remote/data/special URLs. */
export function resolveRel(fromFile: string, u: string): string | undefined {
  const url = u.trim();
  if (!url || isRemote(url) || /^(data|blob|about|mailto|tel|javascript|vbscript):/i.test(url) || url.startsWith('#'))
    return undefined;
  const clean = url.split('#')[0]!.split('?')[0]!;
  if (!clean) return undefined;
  const rel = clean.startsWith('/') ? clean.slice(1) : path.posix.join(path.posix.dirname(fromFile), clean);
  const norm = path.posix.normalize(rel);
  if (norm.startsWith('..')) return undefined;
  return norm;
}

function rewriteUrls(value: string, ctx: CssContext, deps: string[]): string {
  if (!/url\(/i.test(value)) return value;
  const parsed = valueParser(value);
  parsed.walk((node) => {
    if (node.type !== 'function' || node.value.toLowerCase() !== 'url') return;
    const arg = node.nodes[0];
    if (!arg) return;
    const raw = arg.value;
    const rel = resolveRel(ctx.from, raw);
    if (rel) {
      deps.push(rel);
      node.nodes = [
        {
          type: 'string',
          value: ctx.fileUrl(rel),
          quote: '"',
          sourceIndex: 0,
          sourceEndIndex: 0,
          unclosed: false,
        } as never,
      ];
    }
    return false;
  });
  return parsed.toString();
}

function convertViewportUnits(value: string): string {
  if (!/v(w|h|min|max|i|b)\b/i.test(value)) return value;
  const parsed = valueParser(value);
  let changed = false;
  parsed.walk((node) => {
    if (node.type === 'function' && node.value.toLowerCase() === 'url') return false;
    if (node.type === 'word') {
      const m = node.value.match(VIEWPORT_UNIT);
      if (m) {
        const unit = m[3]!.toLowerCase();
        node.value = `${m[1]}cq${unit}`;
        changed = true;
      }
    }
    return undefined;
  });
  return changed ? parsed.toString() : value;
}

function convertMediaQuery(params: string): string | undefined {
  if (!SIZE_FEATURE.test(params) || NON_SIZE_FEATURE.test(params)) return undefined;
  if (params.includes(',')) return undefined; // lists of queries: keep as @media (rare in screens)
  let q = params.trim().replace(/^only\s+/i, '');
  q = q.replace(/^(screen|all)\s+and\s+/i, '');
  if (/^(screen|all)$/i.test(q)) return undefined;
  if (/^not\s/i.test(q)) return undefined;
  return q;
}

export function transformCss(source: string, ctx: CssContext, seen = new Set<string>()): CssResult {
  const deps: string[] = [];
  const warnings: string[] = [];
  const fontLinks: string[] = [];
  const hoisted = postcss.root();
  const cost = { keyframes: 0, animations: 0, infinite: 0, backdrop: 0 };
  const rules: RuleCost[] = [];
  const byRule = new Map<object, RuleCost>();
  const costOf = (d: Declaration): RuleCost => {
    const parent = d.parent as Rule | AtRule | undefined;
    const key = parent ?? root;
    let r = byRule.get(key);
    if (!r) {
      r = {
        needs: parent?.type === 'rule' ? ruleNeeds((parent as Rule).selector) : null,
        animations: 0,
        infinite: 0,
        backdrop: 0,
      };
      byRule.set(key, r);
      rules.push(r);
    }
    return r;
  };
  let root: Root;
  try {
    root = postcss.parse(source, { from: undefined });
  } catch (e) {
    warnings.push(`CSS in ${ctx.from} could not be parsed: ${(e as Error).message.split('\n')[0]}`);
    return { css: '', hoisted: '', fontLinks, deps, warnings, cost, rules: [] };
  }

  // @import: local files are inlined, font services become document links, other remote CSS is fetched
  root.walkAtRules('import', (at) => {
    const m = at.params.match(/^(?:url\()?\s*['"]?([^'")\s]+)['"]?\s*\)?\s*(.*)$/);
    const url = m?.[1];
    if (!url) {
      at.remove();
      return;
    }
    if (FONT_HOSTS.test(url)) {
      fontLinks.push(url);
      at.remove();
      return;
    }
    if (isRemote(url)) {
      const text = ctx.remote?.(url);
      if (text === undefined) warnings.push(`Remote stylesheet ${url} could not be loaded`);
      else {
        const inner = transformCss(text, { ...ctx, from: ctx.from }, seen);
        mergeInto(inner, at);
      }
      at.remove();
      return;
    }
    const rel = resolveRel(ctx.from, url);
    if (!rel || seen.has(rel)) {
      at.remove();
      return;
    }
    const text = ctx.readFile(rel);
    if (text === undefined) {
      warnings.push(`@import ${url} in ${ctx.from}: file not found`);
      at.remove();
      return;
    }
    deps.push(rel);
    seen.add(rel);
    const inner = transformCss(text, { ...ctx, from: rel }, seen);
    mergeInto(inner, at);
    at.remove();
  });

  function mergeInto(inner: CssResult, at: AtRule) {
    deps.push(...inner.deps);
    warnings.push(...inner.warnings);
    fontLinks.push(...inner.fontLinks);
    if (inner.hoisted) hoisted.append(postcss.parse(inner.hoisted));
    if (inner.css) at.before(postcss.parse(inner.css).nodes);
    cost.keyframes += inner.cost.keyframes;
    cost.animations += inner.cost.animations;
    cost.infinite += inner.cost.infinite;
    cost.backdrop += inner.cost.backdrop;
    rules.push(...inner.rules);
  }

  root.walkAtRules((at) => {
    const name = at.name.toLowerCase();
    if (name === 'font-face' || name === 'property' || name === 'font-palette-values') {
      at.walkDecls((d) => {
        d.value = rewriteUrls(d.value, ctx, deps);
      });
      hoisted.append(at.clone());
      at.remove();
      return;
    }
    if (/keyframes$/.test(name)) cost.keyframes++;
    if (name === 'media') {
      const q = convertMediaQuery(at.params);
      if (q) {
        at.name = 'container';
        at.params = `adl ${q}`;
      }
    }
  });

  root.walkRules((rule) => {
    const parent = rule.parent as AtRule | undefined;
    if (parent?.type === 'atrule' && /keyframes$/i.test(parent.name)) return;
    if (/:root\b/.test(rule.selector)) rule.selectors = rule.selectors.map((s) => s.replace(/:root\b/g, 'html'));
  });

  root.walkDecls((d) => {
    const prop = d.prop.toLowerCase();
    d.value = rewriteUrls(d.value, ctx, deps);
    d.value = convertViewportUnits(d.value);
    if (prop === 'animation' || prop === 'animation-name') {
      cost.animations++;
      costOf(d).animations++;
      if (/\binfinite\b/i.test(d.value)) {
        cost.infinite++;
        costOf(d).infinite++;
      }
    } else if (prop === 'animation-iteration-count' && /\binfinite\b/i.test(d.value)) {
      cost.infinite++;
      costOf(d).infinite++;
    } else if (prop === 'backdrop-filter' || prop === '-webkit-backdrop-filter') {
      if (!/^none$/i.test(d.value.trim())) {
        cost.backdrop++;
        costOf(d).backdrop++;
      }
    }
  });

  return {
    css: root.toString(),
    hoisted: hoisted.toString(),
    fontLinks: [...new Set(fontLinks)],
    deps: [...new Set(deps)],
    warnings,
    cost,
    rules,
  };
}
