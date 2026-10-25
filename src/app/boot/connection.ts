// Server connection: HTTP helpers carrying the token, and a WebSocket that reconnects on its own.
import type { ClientMessage, ServerMessage } from '../../protocol/messages.ts';

interface Boot {
  token: string;
  version: string;
  workspace: string;
}

function readBoot(): Boot {
  const el = document.getElementById('adl-boot');
  if (!el?.textContent) return { token: '', version: 'dev', workspace: '' };
  return JSON.parse(el.textContent) as Boot;
}

export const boot = readBoot();

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('x-adl-token', boot.token);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const r = await fetch(path, { ...init, headers });
  const text = await r.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  if (!r.ok) throw new Error((body as { error?: string })?.error ?? `${r.status} ${r.statusText}`);
  return body as T;
}

export type ConnState = 'connecting' | 'open' | 'closed';

export class Connection {
  private ws?: WebSocket;
  private listeners = new Set<(m: ServerMessage) => void>();
  private stateListeners = new Set<(s: ConnState) => void>();
  private queue: string[] = [];
  private retry = 0;
  private opens = 0;
  state: ConnState = 'connecting';
  readonly clientId = Math.random().toString(36).slice(2, 10);

  connect() {
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?token=${encodeURIComponent(boot.token)}`;
    const ws = new WebSocket(url);
    this.ws = ws;
    this.setState('connecting');
    ws.onopen = () => {
      this.retry = 0;
      this.opens++;
      ws.send(JSON.stringify({ t: 'hello', clientId: this.clientId } satisfies ClientMessage));
      for (const m of this.queue.splice(0)) ws.send(m);
      this.setState('open');
    };
    ws.onmessage = (e) => {
      let m: ServerMessage;
      try {
        m = JSON.parse(String(e.data)) as ServerMessage;
      } catch {
        return;
      }
      if (m.t === 'hello') boot.token = m.token; // new after a server restart
      for (const l of [...this.listeners]) l(m);
    };
    ws.onclose = () => {
      this.setState('closed');
      const wait = Math.min(5000, 300 * 2 ** this.retry++);
      setTimeout(() => this.connect(), wait);
    };
  }

  /** True once the socket has opened more than once (the server went away and came back). */
  get reconnected() {
    return this.opens > 1;
  }

  private setState(s: ConnState) {
    this.state = s;
    for (const l of [...this.stateListeners]) l(s);
  }

  send(m: ClientMessage) {
    const data = JSON.stringify(m);
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(data);
    else if (m.t === 'tx') this.queue.push(data);
  }

  on(fn: (m: ServerMessage) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onState(fn: (s: ConnState) => void) {
    this.stateListeners.add(fn);
    return () => this.stateListeners.delete(fn);
  }
}

export const connection = new Connection();
