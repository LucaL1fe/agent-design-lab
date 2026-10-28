import { describe, expect, it } from 'vitest';
import { ruleNeeds, transformCss } from '../../src/node/compile/css.ts';
import { type CompileContext, compileScreen } from '../../src/node/compile/screen.ts';

const files: Record<string, string> = {
  'styles/tokens.css': ':root{--color-bg:#101010}@import "./type.css";\n.btn{background:url(../assets/btn.png)}',
  'styles/type.css': 'body{font-family:var(--font-body)}',
};
const ctx = (file = 'screens/A.html'): CompileContext => ({
  file,
  id: 'A',
  fileUrl: (rel) => `/f/${rel}`,
  readFile: (rel) => files[rel],
  fileHash: (rel) => (rel in files ? String(files[rel]!.length) : undefined),
  sheetCache: new Map(),
});

const html = `<!doctype html><html lang="en" class="dark"><head>
<meta charset="utf-8"><meta name="adl:frame" content="390x844"><title>Breath complete</title>
<link rel="stylesheet" href="../styles/tokens.css">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces">
<style>
:root{--x:1}
.hero{height:100vh;width:50dvw;background:url('img/hero.webp')}
@media (min-width: 600px){.hero{padding:2rem}}
@media (prefers-reduced-motion: reduce){.hero{animation:none}}
@font-face{font-family:X;src:url(../assets/x.woff2)}
@keyframes pop{from{transform:scale(.9)}}
.pop{animation:pop .4s infinite}
</style></head>
<body class="theme" onload="alert(1)">
<main class="pop"><h1>Breath complete</h1>
<img src="img/leaf.png" alt="leaf">
<a href="javascript:alert(1)" data-adl-anchor="done" data-adl-go="T5">Done</a>
<script>alert(1)</script><iframe src="https://evil"></iframe>
<svg><script>alert(1)</script><use href="icons.svg#star"></use></svg>
<style>.late{color:red}</style>
</main></body></html>`;

describe('compileScreen', () => {
  const { screen, sheets } = compileScreen(html, ctx());
  it('reads title, frame and root attributes', () => {
    expect(screen.title).toBe('Breath complete');
    expect(screen.frame).toBe('390x844');
    expect(screen.htmlAttrs).toEqual({ lang: 'en', class: 'dark' });
    expect(screen.bodyAttrs).toEqual({ class: 'theme' });
  });
  it('removes scripts, frames and event handlers', () => {
    expect(screen.body).not.toMatch(/<script|<iframe|onload|javascript:/i);
    expect(screen.warnings.join(' ')).toMatch(/Removed/);
  });
  it('rewrites asset URLs and records dependencies', () => {
    expect(screen.body).toContain('src="/f/screens/img/leaf.png"');
    expect(screen.body).toContain('href="/f/screens/icons.svg#star"');
    expect(screen.localCss).toContain('url("/f/screens/img/hero.webp")');
    expect(screen.deps).toEqual(
      expect.arrayContaining(['screens/A.html', 'screens/img/leaf.png', 'styles/tokens.css', 'styles/type.css']),
    );
  });
  it('transforms CSS for the shadow root', () => {
    expect(screen.localCss).toContain('html{--x:1}');
    expect(screen.localCss).toContain('height:100cqh');
    expect(screen.localCss).toContain('width:50cqw');
    expect(screen.localCss).toContain('@container adl (min-width: 600px)');
    expect(screen.localCss).toContain('@media (prefers-reduced-motion: reduce)');
    expect(screen.localCss).toContain('@keyframes pop');
    expect(screen.localCss).toContain('.late{color:red}');
    expect(screen.hoisted.css).toContain('@font-face');
    expect(screen.hoisted.css).toContain('/f/assets/x.woff2');
    expect(screen.hoisted.fontLinks).toEqual(['https://fonts.googleapis.com/css2?family=Fraunces']);
  });
  it('compiles shared sheets once with local imports inlined', () => {
    expect(sheets).toHaveLength(1);
    expect(sheets[0]!.css).toContain('html{--color-bg:#101010}');
    expect(sheets[0]!.css).toContain('body{font-family:var(--font-body)}');
    expect(sheets[0]!.css).toContain('/f/assets/btn.png');
    expect(screen.sheets).toEqual([sheets[0]!.hash]);
  });
  it('extracts text, anchors and hotspots', () => {
    expect(screen.text).toContain('Breath complete');
    expect(screen.text).toContain('leaf');
    expect(screen.anchors).toEqual(['done']);
    expect(screen.gos).toEqual([{ el: 'done', to: 'T5' }]);
  });
  it('counts animation cost', () => {
    expect(screen.cost.keyframes).toBe(1);
    expect(screen.cost.infinite).toBe(1);
  });
  it('is deterministic', () => {
    expect(compileScreen(html, ctx()).screen.hash).toBe(screen.hash);
  });
});

describe('transformCss', () => {
  const c = { from: 'screens/A.html', fileUrl: (r: string) => `/f/${r}`, readFile: () => undefined };
  it('leaves url() and strings alone when converting units', () => {
    const r = transformCss(`.a{background:url("img/100vh.png");content:"10vh";height:calc(100vh - 20px)}`, c);
    expect(r.css).toContain('/f/screens/img/100vh.png');
    expect(r.css).toContain('"10vh"');
    expect(r.css).toContain('calc(100cqh - 20px)');
  });
  it('keeps media queries that are not about size', () => {
    expect(transformCss('@media print{.a{x:1}}', c).css).toContain('@media print');
    expect(transformCss('@media screen and (max-width:500px){.a{x:1}}', c).css).toContain(
      '@container adl (max-width:500px)',
    );
  });
  it('does not touch selectors inside keyframes', () => {
    expect(transformCss('@keyframes k{from{opacity:0}to{opacity:1}}', c).css).toBe(
      '@keyframes k{from{opacity:0}to{opacity:1}}',
    );
  });
});

describe('animation cost of shared stylesheets', () => {
  // one shared sheet with endless animations for 40 screens, each scoped to its own screen (onboarding motion.css)
  const motion = Array.from(
    { length: 40 },
    (_, i) => `.op[data-ms="S${i}"] .hero{animation:a${i} 2s infinite}@keyframes a${i}{from{opacity:0}}`,
  ).join('\n');
  const shared: Record<string, string> = {
    'styles/motion.css': `${motion}\n.op .btn.m-liq::before{animation:wave 2s linear infinite}\n.spin{animation:s 1s infinite}`,
  };
  const sctx = (): CompileContext => ({
    file: 'screens/S3.html',
    id: 'S3',
    fileUrl: (rel) => `/f/${rel}`,
    readFile: (rel) => shared[rel],
    fileHash: (rel) => (rel in shared ? String(shared[rel]!.length) : undefined),
    sheetCache: new Map(),
  });
  const page = (root: string) =>
    `<!doctype html><html><head><link rel="stylesheet" href="../styles/motion.css"></head><body>${root}</body></html>`;

  it('counts only the rules that can match the screen', () => {
    const { screen } = compileScreen(
      page('<div class="op" data-ms="S3"><img class="hero"><div class="btn m-liq">Go</div></div>'),
      sctx(),
    );
    expect(screen.cost.infinite).toBe(2); // its own .hero rule and the liquid button, not the 39 other screens' rules
    expect(screen.cost.keyframes).toBe(40);
    expect(screen.warnings.join(' ')).not.toMatch(/endless animations/);
  });
  it('still counts every rule that applies', () => {
    const spins = Array.from({ length: 31 }, () => '<i class="spin"></i>').join('');
    const { screen } = compileScreen(page(`<div class="op" data-ms="S3"><img class="hero">${spins}</div>`), sctx());
    expect(screen.cost.infinite).toBe(2);
    const many = `.op .spin{animation:s 1s infinite}`.repeat(31);
    const { screen: heavy } = compileScreen(
      `<!doctype html><html><head><style>${many}</style></head><body><div class="op"><i class="spin"></i></div></body></html>`,
      sctx(),
    );
    expect(heavy.cost.infinite).toBe(31);
    expect(heavy.warnings.join(' ')).toMatch(/31 endless animations/);
  });
});

describe('ruleNeeds', () => {
  it('lists the classes, ids and attributes each selector needs', () => {
    expect(ruleNeeds('.op[data-ms="S7"] .sheet>.row.hot')).toEqual([
      ['c:op', 'a:data-ms=S7', 'c:sheet', 'c:row', 'c:hot'],
    ]);
    expect(ruleNeeds('#a .b, [data-m~="liq"] i')).toEqual([['i:a', 'c:b'], ['w:data-m=liq']]);
    expect(ruleNeeds('html')).toEqual([[]]);
  });
  it('never requires what is inside :not() or :is()', () => {
    expect(ruleNeeds('.a:not(.b) .c:is(.d,.e)')).toEqual([['c:a', 'c:c']]);
  });
  it('treats prefix, substring and case-insensitive attribute selectors as presence', () => {
    expect(ruleNeeds('[data-x^="a"],[lang="EN" i]')).toEqual([['a:data-x'], ['a:lang']]);
  });
});

describe('adl:snapshot', () => {
  const doc = (meta: string) =>
    `<!doctype html><html><head>${meta}<title>X</title></head><body><div class="a"></div></body></html>`;
  it('reads the moment a screen freezes its animations in still pictures', () => {
    expect(compileScreen(doc('<meta name="adl:snapshot" content="4200">'), ctx()).screen.snapshotAt).toBe(4200);
    expect(compileScreen(doc('<meta name="adl:snapshot" content="900ms">'), ctx()).screen.snapshotAt).toBe(900);
    expect(compileScreen(doc(''), ctx()).screen.snapshotAt).toBeUndefined();
  });
  it('warns about a value that is not a time', () => {
    const { screen } = compileScreen(doc('<meta name="adl:snapshot" content="late">'), ctx());
    expect(screen.snapshotAt).toBeUndefined();
    expect(screen.warnings.join(' ')).toMatch(/adl:snapshot "late"/);
  });
});

describe('data-adl-sound', () => {
  const sfiles: Record<string, string> = { 'sounds/chime.wav': 'RIFF', 'sounds/pop.mp3': 'ID3' };
  const sctx = (): CompileContext => ({
    ...ctx(),
    readFile: (rel) => sfiles[rel],
    fileHash: (rel) => (rel in sfiles ? String(sfiles[rel]!.length) : undefined),
  });
  const doc = (body: string) => `<!doctype html><html><head><title>X</title></head><body>${body}</body></html>`;

  it('resolves each sound like an image, in document order, with its element and moment', () => {
    const { screen } = compileScreen(
      doc(
        '<main><div class="card big" data-adl-sound="../sounds/chime.wav" data-adl-sound-at="0.4s"><span id="star" data-adl-sound="../sounds/pop.mp3"></span></div></main>' +
          '<button data-adl-anchor="go" data-adl-sound="/sounds/pop.mp3" data-adl-sound-at="250ms">Go</button>',
      ),
      sctx(),
    );
    expect(screen.sounds).toEqual([
      { src: 'sounds/chime.wav', el: 'div.card.big', at: 400 },
      { src: 'sounds/pop.mp3', el: '#star' },
      { src: 'sounds/pop.mp3', el: '[data-adl-anchor="go"]', at: 250 },
    ]);
    // the canvas reads a URL it can fetch and a plain number of milliseconds
    expect(screen.body).toContain('data-adl-sound="/f/sounds/chime.wav"');
    expect(screen.body).toContain('data-adl-sound-at="400"');
    expect(screen.deps).toEqual(expect.arrayContaining(['sounds/chime.wav', 'sounds/pop.mp3']));
    expect(screen.warnings).toEqual([]);
  });

  it('warns about missing, foreign and non-audio files and about times it cannot read', () => {
    const { screen } = compileScreen(
      doc(
        '<i data-adl-sound="../sounds/gone.wav"></i><i data-adl-sound="https://example.com/a.mp3"></i>' +
          '<i data-adl-sound="../assets/a.png"></i><i data-adl-sound=""></i>' +
          '<i data-adl-sound="../sounds/pop.mp3" data-adl-sound-at="soon"></i><b data-adl-sound-at="1s"></b>',
      ),
      sctx(),
    );
    expect(screen.warnings).toEqual([
      'Sound ../sounds/gone.wav not found',
      'Sound https://example.com/a.mp3 is not a file in the project',
      'Sound ../assets/a.png is not an audio file (mp3, wav, ogg, m4a, aac, flac, opus or webm)',
      'data-adl-sound is empty',
      'data-adl-sound-at "soon" is not a time (e.g. 400ms or 0.4s)',
      'data-adl-sound-at without data-adl-sound on the same element',
    ]);
    // a missing file still counts (it plays once it is added); the others are dropped
    expect(screen.sounds).toEqual([
      { src: 'sounds/gone.wav', el: 'i' },
      { src: 'sounds/pop.mp3', el: 'i' },
    ]);
    expect(screen.body).not.toContain('example.com');
    expect(screen.body).not.toContain('soon');
  });

  it('leaves screens without sounds exactly as before (their versions and pictures stay)', () => {
    const { screen } = compileScreen(doc('<main>Quiet</main>'), sctx());
    expect('sounds' in screen).toBe(false);
  });
});
