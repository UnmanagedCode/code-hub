import { useId } from 'react';
import { RefreshCwIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/native-select';
import { useHub } from '@/hub';
import { cn } from '@/lib/utils';
import type { SortKey } from '@/lib/types';

const SORTS: [SortKey, string][] = [['edited', 'Last edited'], ['name', 'Name'], ['status', 'Status']];

export function Toolbar({ sort, onSort }: { sort: SortKey; onSort: (s: SortKey) => void }) {
  const hub = useHub();
  const id = useId();
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex items-center gap-2">
        <label htmlFor={id} className="text-sm text-muted-foreground">Sort</label>
        <NativeSelect id={id} size="sm" value={sort} onChange={(e) => onSort(e.target.value as SortKey)}>
          {SORTS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </NativeSelect>
      </div>
      <Button variant="ghost" size="icon" aria-label="Refresh" onClick={() => void hub.refresh()}>
        <RefreshCwIcon className={cn(hub.fetching && 'animate-spin motion-reduce:animate-none')} aria-hidden />
      </Button>
    </div>
  );
}
