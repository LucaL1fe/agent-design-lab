// Messages between the server and the app (WebSocket) plus the shapes of the main HTTP responses.
import type { Conflict } from '../core/merge.ts';
import type { SetOp } from '../core/ops.ts';
import type { Actor, PageDoc, ProjectDoc } from '../core/types.ts';
import type { Problem } from '../core/validate.ts';

export interface ScreenMeta {
  id: string;
  file: string;
  hash: string;
  title?: string;
  frame?: string;
  anchors: string[];
  gos: { el?: string; to: string }[];
  /** Files the screen plays in time with an element's animation (`data-adl-sound`), when it has any. */
  sounds?: { src: string; el: string; at?: number }[];
  warnings: string[];
  cost: { keyframes: number; animations: number; infinite: number; backdrop: number; bytes: number };
  sheets: string[];
  autoH?: number;
}

export interface CompiledScreenData {
  v: number;
  hash: string;
  id: string;
  file: string;
  title?: string;
  frame?: string;
  htmlAttrs: Record<string, string>;
  bodyAttrs: Record<string, string>;
  body: string;
  sheets: string[];
  localCss: string;
  hoisted: { fontLinks: string[]; css: string };
  text: string;
  anchors: string[];
  gos: { el?: string; to: string }[];
  sounds?: ScreenMeta['sounds'];
  deps: string[];
  cost: ScreenMeta['cost'];
  warnings: string[];
}

export interface ActivityEntry {
  at: string;
  actor: Actor;
  pid: string;
  page?: string;
  summary: string;
  ids?: string[];
  details?: string[];
}

export interface ProjectSummary {
  id: string;
  name: string;
  dir: string;
  pages: { id: string; name: string; screens: number; kind?: string }[];
  screens: number;
  lastActivity?: ActivityEntry;
  thumbs: string[];
  /** A built-in example: read-only, shown in every workspace. */
  example?: boolean;
}

export interface WorkspaceInfo {
  root: string;
  version: string;
  projects: ProjectSummary[];
  setUp: boolean;
  chrome: boolean;
  /** How to run the command line here: "./adl" in a clone, "npx adl", "adl" … */
  cli: string;
}

export interface ProjectState {
  id: string;
  dir: string;
  project: ProjectDoc;
  pages: Record<string, PageDoc>;
  screens: Record<string, ScreenMeta>;
  problems: Problem[];
  activity: ActivityEntry[];
  snaps: Record<string, SnapInfo>;
  /** A built-in example: read-only, `adl copy` makes an editable copy. */
  example?: boolean;
}

export interface SnapInfo {
  /** URL prefix; append -128.webp / -256.webp / -512.webp */
  url: string;
  w: number;
  h: number;
  /** Average colour, for placeholders. */
  avg?: string;
}

export interface AgentPresence {
  state: 'none' | 'connected' | 'writing' | 'running' | 'idle';
  text?: string;
  file?: string;
  session?: string;
  at: number;
  /** Per project: the time up to which the agent has been told about the person's changes. */
  seen?: Record<string, string>;
  /** Every agent session seen recently (several can work at once), newest first. */
  agents?: AgentSession[];
}

export interface AgentSession {
  session: string;
  /** The session's title in Claude Code, when it has one. */
  name?: string;
  state: AgentPresence['state'];
  text?: string;
  at: number;
}

export type ServerMessage =
  /** `token`: the server's current key (it changes on every start); `build`: the built app's entry script, so a tab
   *  opened before a rebuild can offer a reload. */
  | { t: 'hello'; serverId: string; version: string; token: string; build?: string | undefined }
  | {
      t: 'tx';
      pid: string;
      actor: Actor;
      ops: SetOp[];
      revs: Record<string, number>;
      summary?: string;
      clientId?: string;
      clientSeq?: number;
      conflicts?: Conflict[];
    }
  | { t: 'screens'; pid: string; changed: ScreenMeta[]; removed: string[] }
  | { t: 'problems'; pid: string; problems: Problem[] }
  | { t: 'activity'; entry: ActivityEntry }
  | { t: 'projects' }
  | { t: 'reload'; pid: string }
  | { t: 'snap'; pid: string; hash: string; snap: SnapInfo }
  | { t: 'snapProgress'; pid: string; done: number; total: number; running: boolean }
  | { t: 'agent'; presence: AgentPresence }
  | { t: 'navigate'; url: string }
  | { t: 'error'; message: string; clientSeq?: number };

export type ClientMessage =
  | { t: 'hello'; clientId: string }
  | { t: 'tx'; pid: string; ops: SetOp[]; summary?: string; clientSeq: number }
  | {
      t: 'view';
      pid: string;
      page: string;
      rect: { x: number; y: number; w: number; h: number };
      zoom: number;
      selection: string[];
      visible: string[];
    }
  | { t: 'ping' };
