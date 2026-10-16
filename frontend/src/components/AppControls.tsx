import { LoaderCircleIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useHub, type BusyAction } from '@/hub';
import { controlsFor } from '@/lib/appView';
import type { App } from '@/lib/types';

const Spinner = ({ on }: { on: boolean }) => (on ? <LoaderCircleIcon className="animate-spin" aria-hidden /> : null);

export function AppControls({ app }: { app: App }) {
  const hub = useHub();
  const busy: BusyAction | undefined = hub.busy[app.id];
  const c = controlsFor(app, !!busy);
  return (
    <div className="flex flex-wrap gap-2">
      {c.start && (
        <Button size="sm" disabled={c.start.disabled} onClick={() => hub.start(app.id)}>
          <Spinner on={busy === 'start'} />
          Start
        </Button>
      )}
      {c.stop && (
        <Button size="sm" variant="destructive" disabled={c.stop.disabled} onClick={() => hub.stop(app.id)}>
          <Spinner on={busy === 'stop'} />
          Stop
        </Button>
      )}
      {c.restart && (
        <Button size="sm" variant="outline" disabled={c.restart.disabled} onClick={() => hub.restart(app.id)}>
          <Spinner on={busy === 'restart'} />
          Restart
        </Button>
      )}
      {c.share && (
        <Button size="sm" variant={app.tunnel ? 'secondary' : 'outline'} disabled={c.share.disabled} onClick={() => hub.chooseShare(app.id)}>
          {c.share.label}
        </Button>
      )}
    </div>
  );
}
