import type { ReactNode } from 'react';
import { ChevronDownIcon, GitBranchIcon, XIcon } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { AppControls } from '@/components/AppControls';
import { RouteList } from '@/components/RouteList';
import { SharePanel } from '@/components/SharePanel';
import { useHub } from '@/hub';
import { accentClass } from '@/lib/accent';
import { cardSections } from '@/lib/cardExpansion';
import { sharePanelView } from '@/lib/shareState';
import { autoStartNotice, cardLabel, metaItems, routeRows, statusTone, statusWord, type MetaItem, type StatusTone } from '@/lib/appView';
import { cn } from '@/lib/utils';
import type { App } from '@/lib/types';

const DOT: Record<StatusTone, string> = {
  success: 'bg-success',
  warning: 'bg-warning animate-pulse motion-reduce:animate-none',
  destructive: 'bg-destructive',
  muted: 'bg-muted-foreground',
};
const WORD: Record<StatusTone, string> = {
  success: 'text-success',
  warning: 'text-warning',
  destructive: 'text-destructive',
  muted: 'text-muted-foreground',
};

function Meta({ item }: { item: MetaItem }) {
  switch (item.kind) {
    case 'branch':
      return <Badge variant="info" className="font-mono"><GitBranchIcon aria-hidden />{item.text}</Badge>;
    case 'alwaysOn':
      return <Badge variant="secondary">{item.text}</Badge>;
    case 'outdated':
      return <Badge variant="warning">{item.text}</Badge>;
    case 'sourceMissing':
      return <Badge variant="destructive">{item.text}</Badge>;
    case 'id':
    case 'sha':
      return <span className="font-mono">{item.text}</span>;
    case 'edited':
      return <span title={item.title}>{item.text}</span>;
  }
}

function CardShell({ id, subcard, label, children }: { id: string; subcard?: boolean; label: string; children: ReactNode }) {
  return (
    <Card
      aria-label={label}
      role="article"
      className={cn('gap-3 border-l-4 px-4 py-3', accentClass(id), subcard && 'bg-muted/40 shadow-none')}
    >
      {children}
    </Card>
  );
}

function Worktrees({ project, worktrees }: { project: string; worktrees: App[] }) {
  const hub = useHub();
  if (!worktrees.length) return null;
  const n = worktrees.length;
  return (
    <Collapsible open={hub.worktreesOpen.has(project)} onOpenChange={() => hub.toggleWorktrees(project)} className="flex flex-col gap-2">
      <CollapsibleTrigger asChild>
        <Button variant="ghost" size="sm" className="group w-fit text-muted-foreground">
          {n} worktree{n > 1 ? 's' : ''}
          <ChevronDownIcon className="transition-transform group-data-[state=open]:rotate-180 motion-reduce:transition-none" aria-hidden />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="ml-3 flex flex-col gap-2">
        {worktrees.map((w) => <AppCard key={w.id} app={w} subcard />)}
      </CollapsibleContent>
    </Collapsible>
  );
}


export function AppCard({ app, worktrees = [], subcard = false }: { app: App; worktrees?: App[]; subcard?: boolean }) {
  const hub = useHub();
  const tone = statusTone(app.status);
  const meta = metaItems(app, Date.now());
  const actionError = hub.actionError[app.id];
  const startNotice = autoStartNotice(app);
  const shareView = sharePanelView(hub.share[app.id], app, !!hub.credEdit[app.id]);
  const sections = cardSections({
    expanded: hub.expandedCards.has(app.id),
    hasRoutes: !!routeRows(app),
    shareView: shareView.view,
    worktreeCount: worktrees.length,
  });
  // Every body section is empty when `toggle` is false, so a stored-open card whose body has emptied renders collapsed.
  const open = sections.toggle && hub.expandedCards.has(app.id);
  return (
    <CardShell id={app.id} subcard={subcard} label={cardLabel(app)}>
      <Collapsible open={open} onOpenChange={() => hub.toggleCard(app.id)} className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <span className={cn('size-2.5 shrink-0 rounded-full', DOT[tone])} aria-hidden />
        <h2 className="min-w-0 flex-1 truncate font-semibold">{app.name}</h2>
        <span className={cn('text-sm', WORD[tone])}>{statusWord(app.status)}</span>
        {app.port ? <span className="font-mono text-xs text-muted-foreground">:{app.port}</span> : null}
        {sections.toggle && (
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="icon-sm" className="group" aria-label={`${cardLabel(app)} details`}>
              <ChevronDownIcon className="transition-transform group-data-[state=open]:rotate-180 motion-reduce:transition-none" aria-hidden />
            </Button>
          </CollapsibleTrigger>
        )}
      </div>
      {meta.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {meta.map((item) => <Meta key={item.kind} item={item} />)}
        </div>
      )}
      {app.error && (
        <pre className="max-h-32 overflow-auto font-mono text-xs whitespace-pre-wrap text-destructive">{app.error}</pre>
      )}
      {startNotice && (
        <Alert variant="destructive">
          <AlertDescription>{startNotice}</AlertDescription>
        </Alert>
      )}
      {actionError && (
        <Alert variant="destructive" className="pr-10">
          <AlertDescription>{actionError}</AlertDescription>
          <Button variant="ghost" size="icon-sm" className="absolute top-1.5 right-1.5" aria-label="Dismiss error" onClick={() => hub.dismissError(app.id)}>
            <XIcon aria-hidden />
          </Button>
        </Alert>
      )}
      <AppControls app={app} />
      {sections.share === 'summary' && <SharePanel app={app} view={shareView} />}
      <CollapsibleContent className="flex flex-col gap-3">
        {sections.routes && <RouteList app={app} />}
        {sections.share === 'body' && <SharePanel app={app} view={shareView} />}
        {sections.worktrees && <Worktrees project={app.project} worktrees={worktrees} />}
      </CollapsibleContent>
      </Collapsible>
    </CardShell>
  );
}

/** A header-only parent for worktrees whose main checkout isn't listed, so those worktrees are never hidden. */
export function OrphanCard({ project, worktrees }: { project: string; worktrees: App[] }) {
  return (
    <CardShell id={project} label={project}>
      <div className="flex items-center gap-2">
        <h2 className="min-w-0 flex-1 truncate font-semibold">{project}</h2>
        <span className="text-sm text-muted-foreground">no main checkout</span>
      </div>
      <Worktrees project={project} worktrees={worktrees} />
    </CardShell>
  );
}
