import { Badge, badgeVariants } from '@/components/ui/badge';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useHub } from '@/hub';
import { funnelOccupancy } from '@/lib/funnelPorts';
import type { FunnelPort } from '@/lib/types';

const Availability = ({ name, available }: { name: string; available: boolean }) => (
  <Badge variant={available ? 'success' : 'outline'} title={`${name} availability`}>
    {available ? `${name} ✓` : `no ${name}`}
  </Badge>
);

/** Tailscale is available: how many Funnel ports are in use, listed per port on hover (`title`) and on tap/click. */
function FunnelBadge({ funnelPorts }: { funnelPorts: FunnelPort[] }) {
  const o = funnelOccupancy(funnelPorts);
  const rows = o.rows.map((r) => r.text);
  return (
    <Popover>
      <PopoverTrigger className={badgeVariants({ variant: 'success' })} title={rows.join("\n")}>
        tailscale ✓ {o.label}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-auto p-3">
        <p className="mb-1 text-xs font-medium">Funnel ports</p>
        <ul className="flex flex-col gap-0.5 font-mono text-xs">
          {rows.map((text) => <li key={text}>{text}</li>)}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

export function Header() {
  const { data } = useHub();
  return (
    <header className="flex flex-wrap items-start justify-between gap-2">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">code-hub</h1>
        <p className="text-sm text-muted-foreground">
          launcher for everything under <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">~/cc-projects/</code>
        </p>
      </div>
      {data && (
        <div className="flex gap-1.5">
          <Availability name="cloudflared" available={data.cloudflaredAvailable} />
          {data.tailscaleAvailable ? <FunnelBadge funnelPorts={data.funnelPorts} /> : <Availability name="tailscale" available={false} />}
        </div>
      )}
    </header>
  );
}
