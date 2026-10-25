import type { FramePreset, ProjectDoc } from './types.ts';

export const BUILTIN_PRESETS: Record<string, FramePreset> = {
  'iphone-16': { w: 393, h: 852, label: 'iPhone 16', radius: 48 },
  'iphone-16-pro-max': { w: 440, h: 956, label: 'iPhone 16 Pro Max', radius: 54 },
  'iphone-se': { w: 375, h: 667, label: 'iPhone SE', radius: 0 },
  android: { w: 412, h: 915, label: 'Android phone', radius: 32 },
  ipad: { w: 820, h: 1180, label: 'iPad', radius: 24 },
  'android-tablet': { w: 800, h: 1280, label: 'Android tablet', radius: 24 },
  laptop: { w: 1280, h: 800, label: 'Laptop', radius: 10 },
  desktop: { w: 1440, h: 900, label: 'Desktop', radius: 10 },
  web: { w: 1440, h: 'auto', label: 'Web page (full length)', radius: 8 },
  'web-mobile': { w: 390, h: 'auto', label: 'Mobile web page (full length)', radius: 24 },
  board: { w: 1200, h: 'auto', label: 'Board', radius: 12 },
};

export const DEFAULT_FRAME = 'iphone-16';

/** Parse "390x844", "1440xauto" or a preset name. Returns undefined for unknown names. */
export function resolveFrame(
  spec: string | undefined,
  project?: Pick<ProjectDoc, 'presets' | 'frame'>,
): FramePreset | undefined {
  const s = (spec ?? project?.frame ?? DEFAULT_FRAME).trim();
  const m = s.match(/^(\d{2,5})\s*[x×]\s*(\d{2,5}|auto)$/i);
  if (m) return { w: Number(m[1]), h: m[2]!.toLowerCase() === 'auto' ? 'auto' : Number(m[2]) };
  return project?.presets?.[s] ?? BUILTIN_PRESETS[s];
}

export function frameLabel(spec: string, project?: Pick<ProjectDoc, 'presets'>): string {
  const p = resolveFrame(spec, project as ProjectDoc);
  if (!p) return spec;
  return p.label ?? `${p.w}×${p.h}`;
}
