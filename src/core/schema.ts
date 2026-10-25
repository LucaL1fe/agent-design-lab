// zod schemas for the file format. Loose objects: unknown fields are kept, so newer files and extensions survive.
import { z } from 'zod';

const num = z.number().finite();
const color = z.string().regex(/^#[0-9a-fA-F]{3,8}$|^[a-z]+$|^rgba?\(/, 'a colour like #FFD43B');

export const FramePresetSchema = z.looseObject({
  w: num.positive(),
  h: z.union([num.positive(), z.literal('auto')]),
  label: z.string().optional(),
  radius: num.min(0).optional(),
  background: z.string().optional(),
});

export const StatusSchema = z.looseObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase letters, digits and dashes'),
  label: z.string().min(1),
  color,
  ink: color.optional(),
  role: z.enum(['approved', 'existing', 'review', 'todo']),
  banner: z.boolean().optional(),
  createdBy: z.enum(['human', 'agent', 'import', 'system', 'builtin']).optional(),
});

export const ArrowStyleSchema = z.looseObject({
  label: z.string(),
  color,
  dash: z.array(num).optional(),
  width: num.optional(),
  nav: z.boolean().optional(),
});

export const ProjectSchema = z.looseObject({
  adl: z.literal(1),
  rev: z.number().int().min(0).default(0),
  name: z.string().min(1),
  pages: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'page ids are lowercase letters, digits and dashes')),
  sourceOfTruth: z.string().optional(),
  frame: z.string().optional(),
  presets: z.record(z.string(), FramePresetSchema).optional(),
  styles: z.array(z.string()).optional(),
  fonts: z.array(z.string()).optional(),
  statuses: z.array(StatusSchema).optional(),
  defaultStatus: z.string().optional(),
  arrowStyles: z.record(z.string(), ArrowStyleSchema).optional(),
  snapshotAt: num.min(0).optional(),
});

const base = {
  x: num.optional(),
  y: num.optional(),
  parent: z.string().optional(),
  z: num.optional(),
  pinned: z.boolean().optional(),
  archived: z.looseObject({ at: z.string(), by: z.string(), reason: z.string(), from: z.string() }).optional(),
};

export const ItemSchema = z.discriminatedUnion('kind', [
  z.looseObject({
    kind: z.literal('screen'),
    ...base,
    screen: z.string().optional(),
    src: z.string().optional(),
    frame: z.string().optional(),
    title: z.string().optional(),
    status: z.string().optional(),
    banner: z.string().optional(),
    entry: z.boolean().optional(),
    proposalFor: z.string().optional(),
  }),
  z.looseObject({
    kind: z.literal('section'),
    ...base,
    title: z.string(),
    w: num.positive().optional(),
    h: num.positive().optional(),
  }),
  z.looseObject({
    kind: z.literal('note'),
    ...base,
    text: z.string(),
    color: z.enum(['yellow', 'blue', 'green', 'pink', 'grey', 'orange', 'purple']).optional(),
    w: num.positive().optional(),
    anchor: z.string().optional(),
    by: z.string().optional(),
    resolved: z.boolean().optional(),
  }),
  z.looseObject({
    kind: z.literal('text'),
    ...base,
    text: z.string(),
    size: z.enum(['h1', 'h2', 'h3', 'body']).optional(),
    w: num.positive().optional(),
  }),
  z.looseObject({
    kind: z.literal('portal'),
    ...base,
    text: z.string(),
    target: z.string().optional(),
    w: num.positive().optional(),
    h: num.positive().optional(),
  }),
  z.looseObject({
    kind: z.literal('image'),
    ...base,
    src: z.string(),
    title: z.string().optional(),
    w: num.positive(),
    h: num.positive().optional(),
  }),
]);

const side = z.enum(['top', 'right', 'bottom', 'left']);
export const ArrowSchema = z.looseObject({
  from: z.string().min(1),
  to: z.string().min(1),
  label: z.string().optional(),
  style: z.string().optional(),
  trigger: z
    .looseObject({
      on: z.enum(['tap', 'auto', 'condition', 'back', 'swipe', 'system']),
      el: z.string().optional(),
      after: num.min(0).optional(),
      when: z.string().optional(),
    })
    .optional(),
  fromSide: side.optional(),
  toSide: side.optional(),
  fromEl: z.string().optional(),
  waypoints: z.array(z.tuple([num, num])).optional(),
});

export const PageSchema = z.looseObject({
  adl: z.literal(1),
  rev: z.number().int().min(0).default(0),
  name: z.string().min(1),
  kind: z.enum(['canvas', 'history']).optional(),
  items: z.record(z.string(), ItemSchema).default({}),
  arrows: z.record(z.string(), ArrowSchema).default({}),
});

export const WorkspaceConfigSchema = z.looseObject({
  adl: z.literal(1),
  workspace: z.string().optional(),
  projects: z.array(z.string()).optional(),
});

export interface SchemaIssue {
  path: string;
  message: string;
}

export function issuesOf(error: z.ZodError): SchemaIssue[] {
  return error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
}
