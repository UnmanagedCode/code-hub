import { Badge } from '@/components/ui/badge';
import { useHub } from '@/hub';

const Availability = ({ name, available }: { name: string; available: boolean }) => (
  <Badge variant={available ? 'success' : 'outline'} title={`${name} availability`}>
    {available ? `${name} ✓` : `no ${name}`}
  </Badge>
);

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
          <Availability name="tailscale" available={data.tailscaleAvailable} />
        </div>
      )}
    </header>
  );
}
