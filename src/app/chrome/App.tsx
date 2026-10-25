import { useEffect } from 'react';
import { app, copyProject, toast } from '../state/app.ts';
import { ProjectModel } from '../state/project.ts';
import { useStore } from '../state/store.ts';
import { CanvasView } from './CanvasView.tsx';
import { Home } from './Home.tsx';
import { Toasts } from './Toasts.tsx';
import { TopBar } from './TopBar.tsx';

export function App() {
  const pid = useStore(app, (s) => s.route.pid);
  const project = useStore(app, (s) => s.project);
  const error = useStore(app, (s) => s.projectError);

  useEffect(() => {
    if (!pid) {
      document.title = 'Agent Design Lab';
      return;
    }
    if (project?.id === pid) return;
    let cancelled = false;
    app.set({ project: undefined, projectError: undefined });
    ProjectModel.load(pid)
      .then((m) => {
        if (cancelled) return;
        m.on(() => app.set((s) => ({ docsVersion: s.docsVersion + 1 })));
        let told = 0;
        m.on((kind) => {
          // a change to a built-in example was refused: say so (once in a while) and offer the copy
          if (kind !== 'readonly' || Date.now() - told < 4000) return;
          told = Date.now();
          toast({
            kind: 'info',
            text: `“${m.docs.project.name}” is a built-in example and stays as it is. Make a copy to change it.`,
            action: { label: 'Make a copy', run: () => void copyProject(m.id) },
          });
        });
        app.set({ project: m });
        document.title = `${m.docs.project.name} · Agent Design Lab`;
      })
      .catch((e: Error) => !cancelled && app.set({ projectError: e.message }));
    return () => {
      cancelled = true;
    };
  }, [pid, project?.id]);

  return (
    <div className="app">
      <TopBar />
      {pid ? (
        project ? (
          <CanvasView key={project.id} />
        ) : (
          <div className="home">
            <div className="empty">
              {error ? (
                <>
                  <div className="big">This project could not be opened</div>
                  <div>{error}</div>
                </>
              ) : (
                <div className="big" style={{ color: 'var(--muted)' }}>
                  Opening…
                </div>
              )}
            </div>
          </div>
        )
      ) : (
        <Home />
      )}
      <Toasts />
    </div>
  );
}
