// The build check from the terminal: is the real product built, does it match the design, and what does it look like?
//   adl build <ids…> <state> [--note "…"]     matching · deviating · blocked · wip · todo
//   adl build list                             progress per section, and everything not matching yet
//   adl capture <id> <device> <file>          a screenshot or recording of the real product next to the design
//   adl flow add <id> "<title>" <steps…>      a named path through the screens, with its own state and video
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  addCapture,
  addFlowCapture,
  BUILD_STATES,
  buildCountsText,
  buildDef,
  clearBuild,
  countBuild,
  countFlows,
  NEEDS_NOTE,
  parseBuildState,
  progressText,
  setBuild,
  setFlow,
  setFlowBuild,
} from '../../core/build.ts';
import { isValidId } from '../../core/ids.ts';
import type { BuildState, Capture, Id, PageDoc } from '../../core/types.ts';
import { register } from './registry.ts';
import { CommandError, plural, type Session, str, withEdit, withSession } from './session.ts';

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif']);
const VIDEO_EXT = new Set(['.mp4', '.webm', '.mov', '.m4v']);

function stateWords() {
  return BUILD_STATES.map((s) => s.id).join(', ');
}

function requireState(word: string | undefined): BuildState {
  const s = word ? parseBuildState(word) : undefined;
  if (!s) throw new CommandError(`"${word ?? ''}" is not a build state. Use one of: ${stateWords()}`);
  return s;
}

/** Split targets into screens and flows ("flow:<id>"), checking each exists on the page. */
function targets(s: Session, page: PageDoc, words: string[]): { screens: Id[]; flows: Id[] } {
  const screens: Id[] = [];
  const flows: Id[] = [];
  for (const w of words) {
    if (w.startsWith('flow:')) {
      const id = w.slice(5);
      if (!page.flows?.[id]) throw new CommandError(`No flow "${id}" on page "${s.page}" (adl flow list)`);
      flows.push(id);
      continue;
    }
    const it = page.items[w];
    if (!it || it.archived) throw new CommandError(`"${w}" is not on page "${s.page}"`);
    if (it.kind !== 'screen') throw new CommandError(`"${w}" is a ${it.kind}, not a screen`);
    screens.push(w);
  }
  return { screens, flows };
}

/** Screens of a section, nested sections included. */
function screensIn(page: PageDoc, section: Id | undefined): Id[] {
  const inside = (id: Id) => {
    if (!section) return true;
    const seen = new Set<Id>();
    let cur = page.items[id]?.parent;
    while (cur && !seen.has(cur)) {
      if (cur === section) return true;
      seen.add(cur);
      cur = page.items[cur]?.parent;
    }
    return false;
  };
  return Object.entries(page.items)
    .filter(([id, it]) => it.kind === 'screen' && !it.archived && inside(id))
    .map(([id]) => id);
}

function sectionArg(s: Session, page: PageDoc, want: string | undefined): Id | undefined {
  if (!want) return undefined;
  if (page.items[want]?.kind === 'section') return want;
  const w = want.toLowerCase();
  const hit = Object.entries(page.items).find(
    ([, it]) => it.kind === 'section' && !it.archived && it.title.toLowerCase() === w,
  );
  if (!hit) throw new CommandError(`No section "${want}" on page "${s.page}"`);
  return hit[0];
}

register({
  name: 'build',
  summary: 'The build check: set whether the real product matches a screen or flow, or list the progress',
  usage:
    'adl build <id|flow:<id>>... <todo|wip|matching|deviating|blocked> [--note "why"] | adl build list [--section <s>] [--state <x>] | adl build init [--section <s>] | adl build clear <id>...',
  run: async (args, ctx) => {
    const pos = [...args._];
    const sub = pos[0];
    if (sub === 'list') return list(args, ctx);
    if (sub === 'init')
      return withEdit(args, ctx, (s) => {
        const page = s.docs.pages[s.page]!;
        const section = sectionArg(s, page, str(args.section));
        const fresh = screensIn(page, section).filter((id) => {
          const it = page.items[id];
          return it?.kind === 'screen' && !it.build;
        });
        if (!fresh.length) return { ok: true, text: 'Every screen is in the build check already' };
        s.apply(setBuild(s.docs, s.page, fresh, 'todo', undefined, s.actor), `${s.who} started the build check`);
        return { ok: true, text: `${plural(fresh.length, 'screen')} in the build check (not built)`, data: fresh };
      });
    if (sub === 'clear')
      return withEdit(args, ctx, (s) => {
        const ids = pos.slice(1);
        if (!ids.length) throw new CommandError('Usage: adl build clear <id>...');
        const { screens } = targets(s, s.docs.pages[s.page]!, ids);
        s.apply(clearBuild(s.docs, s.page, screens), `${s.who} took ${screens.join(', ')} out of the build check`);
        return { ok: true, text: `${screens.join(', ')}: out of the build check` };
      });
    return withEdit(args, ctx, (s) => {
      if (pos.length < 2)
        throw new CommandError(`Usage: adl build <id>... <state> [--note "…"]. States: ${stateWords()}`);
      const state = requireState(pos.pop());
      const note = args.note === false ? '' : str(args.note);
      const page = s.docs.pages[s.page]!;
      const { screens, flows } = targets(s, page, pos);
      if (NEEDS_NOTE.has(state)) {
        const missing = [
          ...screens.filter((id) => {
            const it = page.items[id];
            return !note && !(it?.kind === 'screen' && it.build?.note);
          }),
          ...flows.filter((id) => !note && !page.flows?.[id]?.build?.note).map((id) => `flow:${id}`),
        ];
        if (missing.length)
          throw new CommandError(`"${state}" needs a reason: add --note "…" (missing for ${missing.join(', ')})`);
      }
      const all = setBuild(s.docs, s.page, screens, state, note, s.actor);
      for (const f of flows) all.push(...setFlowBuild(s.docs, s.page, f, state, note, s.actor));
      const label = buildDef(state)!.label;
      const who = [...screens, ...flows.map((f) => `flow ${f}`)];
      s.apply(all, `${s.who} set ${who.join(', ')} to ${label}`);
      return {
        ok: true,
        text: `${who.length === 1 ? who[0] : plural(who.length, 'item')} → ${label}${note ? `: “${note}”` : ''}`,
        data: { page: s.page, screens, flows, state, note },
      };
    });
  },
});

function list(args: Parameters<typeof withSession>[0], ctx: Parameters<typeof withSession>[1]) {
  return withSession(args, ctx, (s) => {
    const page = s.docs.pages[s.page]!;
    const section = sectionArg(s, page, str(args.section));
    const want = str(args.state) ? requireState(str(args.state)) : undefined;
    const lines: string[] = [];
    const counts = countBuild(page, section);
    const flowCounts = countFlows(page);
    if (!counts.length && !flowCounts.length)
      return { ok: true, text: 'Nothing is in the build check yet (adl build init)', data: { screens: [], flows: [] } };
    lines.push(`Screens: ${progressText(counts) || '0 tracked'} · ${buildCountsText(counts)}`);
    if (flowCounts.length) lines.push(`Flows: ${progressText(flowCounts)} · ${buildCountsText(flowCounts)}`);
    // per section, in page order
    if (!section) {
      for (const [sid, it] of Object.entries(page.items)) {
        if (it.kind !== 'section' || it.archived || it.parent) continue;
        const c = countBuild(page, sid);
        if (c.length) lines.push(`  ${it.title}: ${progressText(c)} · ${buildCountsText(c)}`);
      }
    }
    const rows: { id: string; state: BuildState; note?: string | undefined; captures: string[] }[] = [];
    for (const id of screensIn(page, section)) {
      const it = page.items[id];
      if (it?.kind !== 'screen' || !it.build) continue;
      if (want ? it.build.state !== want : it.build.state === 'matching') continue;
      rows.push({
        id,
        state: it.build.state,
        note: it.build.note,
        captures: (it.build.captures ?? []).map((c) => `${c.device}:${c.kind}`),
      });
    }
    for (const [fid, f] of Object.entries(page.flows ?? {})) {
      const st = f.build?.state ?? 'todo';
      if (want ? st !== want : st === 'matching') continue;
      rows.push({
        id: `flow:${fid}`,
        state: st,
        note: f.build?.note,
        captures: (f.build?.captures ?? []).map((c) => `${c.device}:${c.kind}`),
      });
    }
    if (rows.length) {
      lines.push(want ? `${buildDef(want)!.label}:` : 'Not matching yet:');
      for (const r of rows)
        lines.push(
          `  ${r.id} · ${buildDef(r.state)!.label}${r.note ? ` · ${r.note}` : ''}${r.captures.length ? ` · [${r.captures.join(', ')}]` : ''}`,
        );
    }
    return { ok: true, text: lines.join('\n'), data: { counts, flowCounts, rows } };
  });
}

// ---------- capture ----------

let encoders: string | undefined;
/** ffmpeg's encoder list ('' when there is no ffmpeg). Builds differ: some have no WebP encoder. */
function ffmpegEncoders(): string {
  if (process.env.ADL_NO_FFMPEG) return '';
  if (encoders === undefined) {
    const r = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' });
    encoders = r.status === 0 ? r.stdout : '';
  }
  return encoders;
}

function hasFfmpeg(): boolean {
  return ffmpegEncoders() !== '';
}

/** Small pictures and stills: WebP when this ffmpeg can write it, JPEG otherwise. */
function stillFormat(): { ext: string; args: string[] } {
  return /\blibwebp\b/.test(ffmpegEncoders())
    ? { ext: '.webp', args: ['-c:v', 'libwebp', '-quality', '82'] }
    : { ext: '.jpg', args: ['-q:v', '4'] };
}

function ffmpeg(args: string[]): boolean {
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { stdio: 'pipe' });
  return r.status === 0;
}

const safeName = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '-');

register({
  name: 'capture',
  summary:
    'Put a screenshot or recording of the real product next to a screen (or a flow): adl capture S4 phone shot.png',
  usage:
    'adl capture <id|flow:<id>> <device> <file> [--label "…"] [--poster <file>] [--thumb <file>] [--no-convert]  (device: phone, tablet, …)',
  run: (args, ctx) =>
    withEdit(args, ctx, (s) => {
      const [target, device, file] = args._;
      if (!target || !device || !file) throw new CommandError('Usage: adl capture <id|flow:<id>> <device> <file>');
      if (!isValidId(device.replace(/[^A-Za-z0-9_.-]/g, '')) || /[/\\]/.test(device))
        throw new CommandError(`"${device}" is not a device name (letters, digits, dashes), e.g. phone or tablet`);
      const page = s.docs.pages[s.page]!;
      const { screens, flows } = targets(s, page, [target]);
      const id = screens[0] ?? flows[0]!;
      const srcFile = path.resolve(ctx.cwd, file);
      if (!fs.existsSync(srcFile) || !fs.statSync(srcFile).isFile()) throw new CommandError(`No file ${file}`);
      const ext = path.extname(srcFile).toLowerCase();
      const kind: Capture['kind'] | undefined = IMAGE_EXT.has(ext) ? 'image' : VIDEO_EXT.has(ext) ? 'video' : undefined;
      if (!kind) throw new CommandError(`${file}: use an image (png, jpg, webp) or a video (mp4, webm, mov)`);
      const folder = path.join('captures', safeName(flows[0] ? `flow-${id}` : id));
      fs.mkdirSync(path.join(s.st.dir, folder), { recursive: true });
      const base = path.join(folder, `${safeName(device)}-${kind}`);
      const ff = args.convert !== false && hasFfmpeg();
      let rel: string;
      if (kind === 'image') {
        // PNG screenshots become WebP when ffmpeg can write it (a tenth of the size); otherwise kept as they are
        const webp = ff && ext !== '.webp' && stillFormat().ext === '.webp';
        rel = `${base}${webp ? '.webp' : ext}`;
        if (!webp || !ffmpeg(['-i', srcFile, '-c:v', 'libwebp', '-quality', '88', path.join(s.st.dir, rel)])) {
          rel = `${base}${ext}`;
          fs.copyFileSync(srcFile, path.join(s.st.dir, rel));
        }
      } else {
        // browsers play mp4 (H.264) and webm; a .mov is re-encoded when ffmpeg is there
        rel = `${base}${ext === '.mov' || ext === '.m4v' ? '.mp4' : ext}`;
        if (ext === '.mov' || ext === '.m4v') {
          if (!ff) throw new CommandError(`${file}: a ${ext} video needs ffmpeg to become an mp4 (or pass an mp4)`);
          if (!ffmpeg(['-i', srcFile, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', path.join(s.st.dir, rel)]))
            throw new CommandError(`ffmpeg could not convert ${file}`);
        } else fs.copyFileSync(srcFile, path.join(s.st.dir, rel));
      }
      const cap: Capture = { device, kind, src: rel.split(path.sep).join('/') };
      // a still for videos and a small picture for far zoom levels: given, or made with ffmpeg when it is there
      const given = (flag: string, suffix: string) => {
        const g = str(args[flag]);
        if (!g) return undefined;
        const from = path.resolve(ctx.cwd, g);
        if (!fs.existsSync(from)) throw new CommandError(`No file ${g}`);
        const to = `${base}.${suffix}${path.extname(from).toLowerCase()}`;
        fs.copyFileSync(from, path.join(s.st.dir, to));
        return to.split(path.sep).join('/');
      };
      const poster = given('poster', 'poster');
      const thumb = given('thumb', 'thumb');
      if (poster) cap.poster = poster;
      if (thumb) cap.thumb = thumb;
      if (ff && kind === 'video' && !cap.poster) {
        const f = stillFormat();
        const to = `${base}.poster${f.ext}`;
        if (
          ffmpeg(['-ss', '0.5', '-i', path.join(s.st.dir, rel), '-frames:v', '1', ...f.args, path.join(s.st.dir, to)])
        )
          cap.poster = to.split(path.sep).join('/');
      }
      if (ff && !cap.thumb) {
        const f = stillFormat();
        const to = `${base}.thumb${f.ext}`;
        const from = path.join(s.st.dir, kind === 'video' ? (cap.poster ?? rel) : rel);
        if (ffmpeg(['-i', from, '-frames:v', '1', '-vf', 'scale=256:-2', ...f.args, path.join(s.st.dir, to)]))
          cap.thumb = to.split(path.sep).join('/');
      }
      const label = str(args.label);
      if (label) cap.label = label;
      const ops = flows[0]
        ? addFlowCapture(s.docs, s.page, id, cap, s.actor)
        : addCapture(s.docs, s.page, id, cap, s.actor);
      s.apply(
        ops,
        `${s.who} added a ${device} ${kind === 'video' ? 'recording' : 'screenshot'} of ${flows[0] ? `flow ${id}` : id}`,
      );
      return {
        ok: true,
        text: `${flows[0] ? `flow ${id}` : id}: ${device} ${kind} → ${cap.src}${cap.poster ? ` (+ still)` : ''}${cap.thumb ? ' (+ small picture)' : ''}${ff ? '' : ' · no ffmpeg: no small picture made'}`,
        data: { id, capture: cap },
      };
    }),
});

// ---------- flows ----------

register({
  name: 'flow',
  summary: 'Named paths through the screens (a journey), each with its own build state and video',
  usage: 'adl flow add <id> "<title>" <screen ids…> | adl flow rm <id> | adl flow list',
  run: (args, ctx) => {
    const [sub, ...rest] = args._;
    if (sub === 'list' || !sub)
      return withSession(args, ctx, (s) => {
        const page = s.docs.pages[s.page]!;
        const flows = Object.entries(page.flows ?? {});
        if (!flows.length) return { ok: true, text: 'No flows on this page (adl flow add <id> "<title>" <steps…>)' };
        const lines = flows.map(
          ([id, f]) =>
            `${id} · ${f.title} · ${buildDef(f.build?.state ?? 'todo')!.label}${f.build?.note ? ` (${f.build.note})` : ''}\n    ${f.steps.join(' → ')}`,
        );
        return { ok: true, text: lines.join('\n'), data: page.flows };
      });
    if (sub === 'add' || sub === 'set')
      return withEdit(args, ctx, (s) => {
        const [id, title, ...steps] = rest;
        if (!id || !title || !steps.length) throw new CommandError('Usage: adl flow add <id> "<title>" <screen ids…>');
        if (!isValidId(id)) throw new CommandError(`"${id}" is not a valid id (letters, digits, - _ .)`);
        const page = s.docs.pages[s.page]!;
        targets(s, page, steps);
        const cur = page.flows?.[id];
        if (cur && sub === 'add' && args.force !== true)
          throw new CommandError(`Flow "${id}" exists. Use adl flow set to replace its steps, or another id.`);
        s.apply(
          setFlow(s.docs, s.page, id, { title, steps, ...(cur?.build ? { build: cur.build } : {}) }),
          `${s.who} ${cur ? 'changed' : 'added'} the flow ${id}`,
        );
        return { ok: true, text: `flow ${id} “${title}”: ${steps.join(' → ')}`, data: { id, steps } };
      });
    if (sub === 'rm' || sub === 'remove')
      return withEdit(args, ctx, (s) => {
        const id = rest[0];
        if (!id || !s.docs.pages[s.page]!.flows?.[id]) throw new CommandError(`No flow "${id ?? ''}"`);
        s.apply(setFlow(s.docs, s.page, id, undefined), `${s.who} removed the flow ${id}`);
        return { ok: true, text: `removed flow ${id}` };
      });
    throw new CommandError('Usage: adl flow add|set|rm|list');
  },
});
