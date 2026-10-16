import { ExternalLinkIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ExternalLink } from '@/components/ExternalLink';
import { routeRows } from '@/lib/appView';
import type { App } from '@/lib/types';

export function RouteList({ app }: { app: App }) {
  const rows = routeRows(app);
  if (!rows) return null;
  return (
    <ul className="flex flex-col gap-2" aria-label="Routes">
      {rows.map((r) => (
        <li key={`${r.name}\u0000${r.path}`} className="flex items-center gap-3 rounded-md bg-muted/50 px-3 py-2">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            {r.name !== null && <span className="text-sm font-medium" title={r.path}>{r.name}</span>}
            {r.primary && <ExternalLink url={r.primary} className="truncate font-mono text-sm text-primary hover:underline" />}
            {r.rest.length > 0 && (
              <div className="flex flex-wrap gap-x-3 gap-y-0.5">
                {r.rest.map((u) => (
                  <ExternalLink key={u} url={u} className="font-mono text-xs text-muted-foreground hover:underline" />
                ))}
              </div>
            )}
          </div>
          {r.primary && (
            <Button asChild variant="outline" size="sm">
              <ExternalLink url={r.primary} fallback="none" aria-label={r.name ? `Open ${r.name}` : 'Open'}>
                Open
                <ExternalLinkIcon aria-hidden />
              </ExternalLink>
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}
