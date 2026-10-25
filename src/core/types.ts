// The Agent Design Lab file format, version 1. Plain JSON documents that humans, agents and the app all edit.
// Unknown fields are kept as they are (extensions use `x-*` keys).

export type Id = string;
export type Actor = 'human' | 'agent' | 'import' | 'system';

/** A frame preset (a device or page size). `h: 'auto'` means the screen's measured content height. */
export interface FramePreset {
  w: number;
  h: number | 'auto';
  label?: string;
  radius?: number;
  background?: string;
}

export type StatusRole = 'approved' | 'existing' | 'review' | 'todo';

export interface StatusDef {
  id: string;
  label: string;
  color: string;
  /** Text colour on the banner; computed for contrast when missing. */
  ink?: string;
  role: StatusRole;
  /** Show the banner above the screen (default true; approved statuses usually set false). */
  banner?: boolean;
  createdBy?: Actor | 'builtin';
}

export interface ArrowStyleDef {
  label: string;
  color: string;
  dash?: number[];
  width?: number;
  /** Navigation arrows take part in present mode and the handoff (default true). Proposal links set false. */
  nav?: boolean;
}

export interface ProjectDoc {
  adl: 1;
  rev: number;
  name: string;
  /** Page ids in menu order. Page files live in pages/<id>.json. */
  pages: string[];
  /** The page whose approved screens are the build spec. */
  sourceOfTruth?: string;
  /** Default frame: a preset name or "WxH" / "Wxauto". */
  frame?: string;
  presets?: Record<string, FramePreset>;
  /** Shared stylesheets (project-relative paths). Adopted once by every screen that links them. */
  styles?: string[];
  /** Remote font stylesheets (e.g. Google Fonts CSS URLs). */
  fonts?: string[];
  statuses?: StatusDef[];
  /** Status given to new screens placed by agents. */
  defaultStatus?: string;
  arrowStyles?: Record<string, ArrowStyleDef>;
  /** Time in ms at which animations are frozen for snapshots and reference PNGs. */
  snapshotAt?: number;
  [extra: string]: unknown;
}

export interface Archived {
  at: string;
  by: Actor;
  reason: 'replaced' | 'rejected' | 'removed' | string;
  from: string;
  was?: { parent?: Id | undefined; x?: number | undefined; y?: number | undefined; status?: string | undefined };
  replacedBy?: Id;
  arrows?: Record<Id, Arrow>;
  note?: string;
  /** On a screen a pick replaced: what the pick took over from it (arrows by their new id on the page, the link arrow
   *  to the pick, notes, portals), so restoring the screen undoes the pick exactly. */
  handover?: Handover;
}

export interface Handover {
  arrows: Id[];
  link?: { id: Id; arrow: Arrow };
  notes: Id[];
  portals: { page: string; id: Id }[];
  /** Arrows of the replaced screen that would only have repeated an arrow the pick already had between the same two
   *  screens (its own arrow and label win), kept as they would have been moved, so an undo puts them back. */
  merged?: { id: Id; arrow: Arrow }[];
}

interface ItemBase {
  /** Position relative to the parent section (or the page). Missing = placed automatically. */
  x?: number;
  y?: number;
  parent?: Id;
  z?: number;
  /** Set when a human positions the item; layout tools never move pinned items. */
  pinned?: boolean;
  archived?: Archived;
  [extra: string]: unknown;
}

export interface ScreenItem extends ItemBase {
  kind: 'screen';
  /** Screen file id when it differs from the item id (the same HTML placed twice, e.g. at another frame). */
  screen?: string;
  /** Explicit HTML path when it is not screens/<screen>.html. */
  src?: string;
  /** Frame override: preset name or "WxH". */
  frame?: string;
  /** Caption; falls back to the HTML <title>, then the id. */
  title?: string;
  status?: string;
  /** The banner text shown after the status label, e.g. "what needs to be fixed". */
  banner?: string;
  /** A flow starts here (present mode, handoff). */
  entry?: boolean;
  /** This screen is a proposed replacement for another screen. */
  proposalFor?: Id;
}

export interface SectionItem extends ItemBase {
  kind: 'section';
  title: string;
  /** Size; when missing the section wraps its children. */
  w?: number;
  h?: number;
}

export type NoteColor = 'yellow' | 'blue' | 'green' | 'pink' | 'grey' | 'orange' | 'purple';

export interface NoteItem extends ItemBase {
  kind: 'note';
  text: string;
  color?: NoteColor;
  w?: number;
  /** Notes anchored to an item move with it. Coordinates are then relative to the anchor. */
  anchor?: Id;
  by?: Actor;
  resolved?: boolean;
  /** "small": a compact label (12 px), e.g. a short remark under a screen. */
  size?: 'small' | 'normal';
}

export interface TextItem extends ItemBase {
  kind: 'text';
  text: string;
  size?: 'h1' | 'h2' | 'h3' | 'body';
  w?: number;
}

export interface PortalItem extends ItemBase {
  kind: 'portal';
  text: string;
  /** "S6" (same page) or "page:<pageId>/<itemId>". */
  target?: string;
  w?: number;
  h?: number;
}

export interface ImageItem extends ItemBase {
  kind: 'image';
  src: string;
  title?: string;
  w: number;
  h?: number;
}

export type Item = ScreenItem | SectionItem | NoteItem | TextItem | PortalItem | ImageItem;
export type ItemKind = Item['kind'];

export type Side = 'top' | 'right' | 'bottom' | 'left';

export interface Trigger {
  on: 'tap' | 'auto' | 'condition' | 'back' | 'swipe' | 'system';
  /** data-adl-anchor name of the element in the source screen. */
  el?: string;
  /** For `auto`: milliseconds until the transition happens. */
  after?: number;
  /** Free-text condition, e.g. "only if reminders are off". */
  when?: string;
}

export interface Arrow {
  from: Id;
  to: Id;
  label?: string;
  style?: string;
  trigger?: Trigger;
  fromSide?: Side;
  toSide?: Side;
  /** Attach the arrow tail to an element (data-adl-anchor) inside the source screen. */
  fromEl?: string;
  /** Manual route points in page coordinates. */
  waypoints?: [number, number][];
  [extra: string]: unknown;
}

export interface PageDoc {
  adl: 1;
  rev: number;
  name: string;
  kind?: 'canvas' | 'history';
  items: Record<Id, Item>;
  arrows: Record<Id, Arrow>;
  [extra: string]: unknown;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Size {
  w: number;
  h: number;
}
