// Starter files for `adl init` and `adl screen new`. Deliberately plain: the skill replaces them with the project's own
// design system before drawing screens.

export const TOKENS_CSS = `/* Design tokens: the single source for colours, type, spacing, radii and motion.
   Every screen links this file. Replace these starter values with the project's design system
   before drawing screens; screens use only var(--...) values from here. */
:root {
  /* colour roles */
  --color-bg: #ffffff;
  --color-surface: #f4f4f2;
  --color-text: #1b1b18;
  --color-muted: #6b6b66;
  --color-line: #e3e3de;
  --color-accent: #3b6cf6;
  --color-accent-ink: #ffffff;
  --color-success: #2f9e5b;
  --color-warning: #d98a1c;
  --color-danger: #d64545;

  /* type */
  --font-sans: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --text-xs: 12px;
  --text-sm: 14px;
  --text-md: 16px;
  --text-lg: 20px;
  --text-xl: 28px;
  --text-2xl: 36px;
  --leading: 1.4;

  /* spacing (4 px grid) */
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-6: 24px;
  --space-8: 32px;
  --space-12: 48px;

  /* shape and depth */
  --radius-sm: 8px;
  --radius-md: 12px;
  --radius-lg: 20px;
  --radius-full: 999px;
  --shadow-sm: 0 1px 2px rgb(0 0 0 / 0.08);
  --shadow-md: 0 4px 16px rgb(0 0 0 / 0.12);

  /* motion */
  --ease-out: cubic-bezier(0.2, 0.8, 0.2, 1);
  --dur-fast: 150ms;
  --dur-med: 300ms;
}

html,
body {
  margin: 0;
  background: var(--color-bg);
  color: var(--color-text);
  font: var(--text-md) / var(--leading) var(--font-sans);
}
`;

export const COMPONENTS_CSS = `/* Shared components (buttons, cards, inputs, lists, tab bars ...), built only from tokens.css.
   Screens reuse these classes instead of restyling the same thing per screen. */
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  min-height: 48px;
  padding: 0 var(--space-6);
  border: 0;
  border-radius: var(--radius-full);
  background: var(--color-accent);
  color: var(--color-accent-ink);
  font: 600 var(--text-md) / 1 var(--font-sans);
}
`;

export const BRIEF_MD = `# {name}

What is being designed, for whom, and what good looks like. Claude writes this first and keeps it current.

- **Product:**
- **Audience:**
- **Platform and frames:** (e.g. iPhone 390x844, desktop 1280 wide)
- **Tone and brand:**
- **Flows to design:**
- **Out of scope:**
`;

export function screenHtml(opts: { title: string; frame?: string | undefined; lang?: string }): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  return `<!doctype html>
<html lang="${opts.lang ?? 'en'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${opts.frame ? `<meta name="adl:frame" content="${esc(opts.frame)}">\n` : ''}<title>${esc(opts.title)}</title>
<link rel="stylesheet" href="../styles/tokens.css">
<link rel="stylesheet" href="../styles/components.css">
<style>
  /* rules for this screen only; shared ones go in styles/components.css */
  .screen { min-height: 100vh; display: flex; flex-direction: column; padding: var(--space-6); box-sizing: border-box; }
</style>
</head>
<body>
<main class="screen">
  <h1>${esc(opts.title)}</h1>
</main>
</body>
</html>
`;
}
