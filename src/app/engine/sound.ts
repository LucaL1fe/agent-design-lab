// Sound in screens. An element with data-adl-sound plays its file in time with its own CSS animation: once per round,
// data-adl-sound-at ms into it (an element without an animation plays once, that long after the screen starts).
// Nothing plays until the person turns sound on, for one screen on the canvas or for Present mode; still pictures and
// snapshots never play anything. Audio runs through one Web Audio context, started from that click.

/** The latest round whose cue moment has passed at active time `t` (ms into the animation), or -1 before the first.
 *  A finished animation holds its time, so its last cue never repeats. */
export function dueRound(t: number, duration: number, rounds: number, at: number): number {
  if (!(rounds > 0)) return -1;
  const { d, cue } = timing(duration, at);
  if (!(t >= cue)) return -1;
  const r = Number.isFinite(d) ? Math.floor((t - cue) / d) : 0;
  return Math.min(r, Math.ceil(rounds) - 1);
}

/** The active time (ms) of a round's cue. */
export function cueTime(round: number, duration: number, at: number): number {
  const { d, cue } = timing(duration, at);
  return (Number.isFinite(d) ? round * d : 0) + cue;
}

/** A round without a length (no animation, or 0 s) never repeats; the cue sits inside the round. */
function timing(duration: number, at: number) {
  const d = duration > 0 ? duration : Number.POSITIVE_INFINITY;
  return { d, cue: Math.max(0, Math.min(at, d)) };
}

/** How long after its moment a cue may still play (a frame that came late); older cues are skipped silently. */
const LATE_MS = 300;

/** Plays decoded files through one gain (the volume). */
export class SoundPlayer {
  private ctx: AudioContext | undefined;
  private out: GainNode | undefined;
  private buffers = new Map<string, Promise<AudioBuffer | undefined>>();
  private playing = new Set<AudioBufferSourceNode>();
  private voices = new WeakMap<object, AudioBufferSourceNode>();
  private volume = 0.8;

  /** Call from a click: browsers only start audio after a gesture. */
  unlock() {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.out = this.ctx.createGain();
      this.out.connect(this.ctx.destination);
      this.setVolume(this.volume);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  /** 0 to 1; squared, so the middle of the slider sounds about half as loud. */
  setVolume(v: number) {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.out) this.out.gain.value = this.volume ** 2;
  }

  load(url: string): Promise<AudioBuffer | undefined> {
    let p = this.buffers.get(url);
    if (!p) {
      const ctx = this.ctx;
      p = ctx
        ? fetch(url)
            .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
            .then((b) => ctx.decodeAudioData(b))
            .catch(() => undefined)
        : Promise.resolve(undefined);
      if (ctx) this.buffers.set(url, p);
      while (this.buffers.size > 64) this.buffers.delete(this.buffers.keys().next().value!);
    }
    return p;
  }

  /** Play a file. With a key (the element that makes the sound) its previous play stops first: a cue that comes
   *  round again starts its sound over instead of piling up, as an app replays its one player. */
  play(url: string, key?: object) {
    const ctx = this.ctx;
    if (!ctx || !this.out) return;
    void this.load(url).then((b) => {
      if (!b || ctx.state === 'closed') return;
      const s = ctx.createBufferSource();
      s.buffer = b;
      s.connect(this.out!);
      s.onended = () => this.playing.delete(s);
      if (key) {
        const prev = this.voices.get(key);
        if (prev) stop(prev);
        this.voices.set(key, s);
      }
      this.playing.add(s);
      s.start();
    });
  }

  /** Cut whatever is playing (sound turned off). */
  stopAll() {
    for (const s of this.playing) stop(s);
    this.playing.clear();
  }
}

function stop(s: AudioBufferSourceNode) {
  try {
    s.stop();
  } catch {
    // already ended
  }
}

export const player = new SoundPlayer();

/** The element's first CSS animation, else the first one inside it (a wrapper around what moves). */
function animationOf(el: Element): Animation | undefined {
  const isCss = (a: Animation) => 'animationName' in a;
  return el.getAnimations().find(isCss) ?? el.getAnimations({ subtree: true }).find(isCss);
}

export function soundUrls(root: ShadowRoot): string[] {
  return [
    ...new Set(
      [...root.querySelectorAll<HTMLElement>('[data-adl-sound]')].map((el) => el.dataset.adlSound!).filter(Boolean),
    ),
  ];
}

/** Watches one mounted screen and plays its cues as their moments pass. Call tick() once per animation frame. */
export class SoundCues {
  private seen = new WeakMap<Element, { round: number; since: number }>();
  private play: (url: string, el: Element) => void;

  constructor(play: (url: string, el: Element) => void) {
    this.play = play;
  }

  /** Start the screen over: every animation from its start and every cue unplayed, so sound and motion begin
   *  together (an element without an animation plays again too). */
  startOver(root: ShadowRoot) {
    for (const a of root.getAnimations()) {
      try {
        a.currentTime = 0;
      } catch {
        // some animations cannot be seeked
      }
    }
    this.seen = new WeakMap();
  }

  tick(root: ShadowRoot, now: number) {
    // a paused screen (scrolled away, a gesture under load) is silent
    if ((root.host as HTMLElement).classList.contains('adl-paused')) return;
    for (const el of root.querySelectorAll<HTMLElement>('[data-adl-sound]')) {
      const url = el.dataset.adlSound;
      if (!url) continue;
      const at = Number(el.dataset.adlSoundAt ?? 0) || 0;
      let s = this.seen.get(el);
      if (!s) {
        s = { round: -1, since: now };
        this.seen.set(el, s);
      }
      let t: number;
      let d = Number.POSITIVE_INFINITY;
      let rounds = 1;
      const a = animationOf(el);
      if (a) {
        const ct = a.effect?.getComputedTiming();
        if (!ct || ct.localTime === null || ct.localTime === undefined) continue;
        t = Number(ct.localTime) - (ct.delay ?? 0);
        d = typeof ct.duration === 'number' ? ct.duration : 0;
        rounds = ct.iterations ?? 1;
      } else t = now - s.since;
      const r = dueRound(t, d, rounds, at);
      if (r < s.round) s.round = r; // restarted
      if (r <= s.round) continue;
      s.round = r;
      if (t - cueTime(r, d, at) <= LATE_MS) this.play(url, el);
    }
  }
}
