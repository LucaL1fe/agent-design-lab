import { register } from './registry.ts';

register({
  name: 'focus-tab',
  summary: 'Bring an open canvas tab to the front (used by `adl open`)',
  usage: 'adl focus-tab <url>',
  needsServer: true,
  hidden: true,
  run: async (args, ctx) => {
    const url = args._[0];
    const tabs = ctx.server ? ctx.server.views.size : 0;
    if (ctx.server && typeof url === 'string' && tabs) ctx.server.broadcast({ t: 'navigate', url });
    return { ok: true, text: tabs ? 'Focused the open tab' : 'No open tab', data: { tabs } };
  },
});
