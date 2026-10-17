import { RefreshCwIcon } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { AppCard, OrphanCard } from '@/components/AppCard';
import { useHub } from '@/hub';
import { groupApps, listView } from '@/lib/appView';
import type { SortKey } from '@/lib/types';

export function AppList({ sort }: { sort: SortKey }) {
  const hub = useHub();
  const apps = hub.data?.apps ?? [];
  const { state, stale } = listView({ loaded: !!hub.data, error: hub.error, apps });

  if (state === 'loading') {
    return (
      <div className="flex flex-col gap-3" role="status" aria-label="Loading apps…">
        {[0, 1, 2].map((i) => <Skeleton key={i} className="h-24 rounded-xl" />)}
      </div>
    );
  }
  if (state === 'error') {
    return (
      <Alert variant="destructive">
        <AlertDescription>
          <p>Failed to load: {hub.error}</p>
          <Button variant="outline" size="sm" onClick={() => void hub.refresh()}>
            <RefreshCwIcon aria-hidden />
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(min(36rem,100%),1fr))] items-start gap-3 [&>*]:min-w-0">
      {stale && (
        <Alert variant="warning" className="col-span-full">
          <AlertDescription>
            Can't reach code-hub — showing data from {hub.updatedAt?.toLocaleTimeString()}
          </AlertDescription>
        </Alert>
      )}
      {state === 'empty' ? (
        <p className="col-span-full py-8 text-center text-sm text-muted-foreground">No apps found. Add a .hub.json to a sibling project.</p>
      ) : (
        groupApps(apps, sort).map((g) => (g.kind === 'app'
          ? <AppCard key={g.app.id} app={g.app} worktrees={g.worktrees} />
          : <OrphanCard key={`orphan:${g.project}`} project={g.project} worktrees={g.worktrees} />))
      )}
    </div>
  );
}
