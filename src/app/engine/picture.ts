// Screen names and pictures for the clipboard and for downloads (the action row above a screen, ⌘C, ⇧⌘C). The
// pictures come from the server (`adl render --base64`), so they are the same as `adl render`'s.
import { readingOrder } from '../../core/geom.ts';
import type { Id, PageDoc, Rect } from '../../core/types.ts';

/** The ids to copy as text: the screens among them in reading order, else every id as given. */
export function namesOf(page: PageDoc, rects: Map<Id, Rect>, ids: Id[]): Id[] {
  const screens = ids.filter((id) => page.items[id]?.kind === 'screen' && rects.has(id));
  if (!screens.length) return ids;
  return readingOrder(screens.map((id) => ({ id, rect: rects.get(id)! }))).map((x) => x.id);
}

/** "A1, A2 and A3" for a toast, shortened when there are many. */
export function namesText(names: Id[]): string {
  if (names.length <= 4) return names.join(', ');
  return `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`;
}

export const fileName = (name: string) => name.replace(/[^\w.-]+/g, '-');

export function b64Blob(b64: string, type: string): Blob {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

/** A PNG as a JPEG, white behind anything transparent. */
export async function toJpeg(png: Blob, quality = 0.92): Promise<Blob> {
  const bmp = await createImageBitmap(png);
  const c = document.createElement('canvas');
  c.width = bmp.width;
  c.height = bmp.height;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  return new Promise((ok, fail) =>
    c.toBlob((b) => (b ? ok(b) : fail(new Error('the JPEG could not be made'))), 'image/jpeg', quality),
  );
}

export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/** Text, a picture, or both on the clipboard. The picture may still be rendering: the write starts now, inside the
 *  click or key press (browsers only allow it there), and finishes when the picture is ready. */
export async function writeClipboard(text: string | undefined, png?: Promise<Blob>): Promise<void> {
  const clip = navigator.clipboard;
  if (!clip) throw new Error('this browser gives the page no clipboard');
  if (!png) return clip.writeText(text ?? '');
  if (typeof ClipboardItem === 'undefined' || !clip.write)
    throw new Error('this browser cannot copy pictures, use Download instead');
  const data: Record<string, Promise<Blob>> = { 'image/png': png };
  if (text !== undefined) data['text/plain'] = Promise.resolve(new Blob([text], { type: 'text/plain' }));
  return clip.write([new ClipboardItem(data)]);
}
