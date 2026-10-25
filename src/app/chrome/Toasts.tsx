import { app, dismiss } from '../state/app.ts';
import { useStore } from '../state/store.ts';

export function Toasts() {
  const toasts = useStore(app, (s) => s.toasts);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div className="toast" key={t.id}>
          {t.kind === 'ok' ? (
            <span className="ok">✓</span>
          ) : t.kind === 'agent' ? (
            <span className="ag">●</span>
          ) : t.kind === 'warn' ? (
            <span className="warn">!</span>
          ) : null}
          <span className="msg">{t.text}</span>
          {t.code ? <code>{t.code}</code> : null}
          {t.action ? (
            <button
              type="button"
              className="act"
              onClick={() => {
                t.action!.run();
                dismiss(t.id);
              }}
            >
              {t.action.label}
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}
