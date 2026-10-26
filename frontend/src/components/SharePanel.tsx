import { useId, useState } from 'react';
import { ExternalLinkIcon, LoaderCircleIcon } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/CopyButton';
import { CredEditForm } from '@/components/CredEditForm';
import { ExternalLink } from '@/components/ExternalLink';
import { QrDialog } from '@/components/QrDialog';
import { useHub } from '@/hub';
import { funnelPortChoices } from '@/lib/funnelPorts';
import { credRowValues, qrImageSrc, shareChooserModes, sharePanelView } from '@/lib/shareState';
import type { App } from '@/lib/types';

function ShareChooser({ app, funnel }: { app: App; funnel: boolean }) {
  const hub = useHub();
  const ids = useId();
  const funnelPorts = hub.data?.funnelPorts ?? [];
  const modes = shareChooserModes(!!hub.data?.cloudflaredAvailable, !!hub.data?.tailscaleAvailable, funnelPorts, app.id);
  const ports = funnelPortChoices(funnelPorts, app.id);
  return (
    <div className="flex flex-col gap-1.5" role="group" aria-label="Share via">
      <div className="flex flex-wrap gap-2">
        {modes.map((m) => (
          <Button
            key={m.mode}
            size="sm"
            variant="outline"
            disabled={!!m.disabledReason}
            aria-describedby={m.disabledReason ? `${ids}-${m.mode}` : undefined}
            // tailscale first asks which Funnel port; the other modes share at once.
            aria-pressed={m.mode === 'tailscale' ? funnel : undefined}
            onClick={() => (m.mode === 'tailscale' ? hub.chooseFunnelPort(app.id) : hub.doShare(app.id, m.mode))}
          >
            {m.label}
          </Button>
        ))}
        <Button size="sm" variant="ghost" onClick={() => hub.cancelShare(app.id)}>Cancel</Button>
      </div>
      {modes.filter((m) => m.disabledReason).map((m) => (
        <p key={m.mode} id={`${ids}-${m.mode}`} className="text-xs text-muted-foreground">{m.disabledReason}</p>
      ))}
      {funnel && (
        <>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Funnel port">
            {ports.map((p) => (
              <Button
                key={p.port}
                size="sm"
                variant="outline"
                disabled={!!p.disabledReason}
                aria-describedby={p.disabledReason ? `${ids}-port-${p.port}` : undefined}
                onClick={() => hub.doShare(app.id, 'tailscale', p.port)}
              >
                {p.label}
              </Button>
            ))}
          </div>
          {ports.filter((p) => p.disabledReason).map((p) => (
            <p key={p.port} id={`${ids}-port-${p.port}`} className="text-xs text-muted-foreground">{p.label} {p.disabledReason}</p>
          ))}
        </>
      )}
    </div>
  );
}

function CredRow({ label, value, display }: { label: string; value: string; display: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-10 shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-sm">{display}</span>
      <CopyButton value={value} label={`Copy ${label}`} />
    </div>
  );
}

export function SharePanel({ app }: { app: App }) {
  const hub = useHub();
  const [qrOpen, setQrOpen] = useState(false);
  const draft = hub.credEdit[app.id];
  const v = sharePanelView(hub.share[app.id], app, !!draft);

  if (v.view === 'none') return null;
  if (v.view === 'choosing') return <ShareChooser app={app} funnel={v.funnel} />;
  if (v.view === 'loading') {
    return (
      <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
        <LoaderCircleIcon className="size-4 animate-spin" aria-hidden />
        Sharing…
      </p>
    );
  }
  if (v.view === 'autoPending') {
    return (
      <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
        <LoaderCircleIcon className="size-4 animate-spin" aria-hidden />
        Sharing automatically…
      </p>
    );
  }
  if (v.view === 'autoFailed') {
    return (
      <Alert variant="destructive">
        <AlertDescription>Auto-share failed: {v.error}</AlertDescription>
      </Alert>
    );
  }
  if (v.view === 'error') {
    return (
      <Alert variant="destructive">
        <AlertDescription>{v.error}</AlertDescription>
      </Alert>
    );
  }

  const { shared, kind, openUrl } = v;
  const qrSrc = qrImageSrc(v.qrSvg);
  const pass = credRowValues(shared);
  return (
    <section className="flex flex-col gap-3 rounded-md border bg-muted/30 p-3" aria-label="Share">
      <div className="flex flex-col gap-1">
        <span className="font-mono text-sm break-all">{shared.url}</span>
        <span className="text-xs text-muted-foreground">{v.credNote}</span>
      </div>
      {v.fixedPortNotice && (v.fixedPortNotice.level === 'warn' ? (
        <Alert variant="warning">
          <AlertDescription>{v.fixedPortNotice.text}</AlertDescription>
        </Alert>
      ) : (
        <p className="text-xs text-muted-foreground">{v.fixedPortNotice.text}</p>
      ))}
      {v.reachNotice && (v.reachNotice.level === 'warn' ? (
        <Alert variant="warning">
          <AlertDescription>{v.reachNotice.text}</AlertDescription>
        </Alert>
      ) : (
        <p className="text-xs text-muted-foreground">{v.reachNotice.text}</p>
      ))}
      {v.extraUrls.length > 0 && (
        <div className="flex flex-wrap gap-x-3 gap-y-0.5">
          {v.extraUrls.map((u) => (
            <ExternalLink key={u} url={u} className="font-mono text-xs text-muted-foreground hover:underline" />
          ))}
        </div>
      )}
      {v.showCreds && (draft ? (
        <CredEditForm app={app} shared={shared} kind={kind} draft={draft} />
      ) : (
        <div className="flex flex-col gap-1.5">
          <CredRow label="user" value={shared.username ?? ''} display={shared.username ?? ''} />
          <CredRow label="pass" value={pass.copy ?? ''} display={pass.display ?? ''} />
        </div>
      ))}
      {qrSrc && (
        <>
          <button
            type="button"
            aria-label="Enlarge QR code"
            className="w-fit rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring"
            onClick={() => setQrOpen(true)}
          >
            <img src={qrSrc} alt="" className="size-28 rounded-md" />
          </button>
          <QrDialog open={qrOpen} onOpenChange={setQrOpen} src={qrSrc} url={shared.url} openUrl={openUrl} />
        </>
      )}
      <div className="flex flex-wrap gap-2">
        <Button asChild variant="outline" size="sm">
          <ExternalLink url={openUrl} fallback="none">
            Open
            <ExternalLinkIcon aria-hidden />
          </ExternalLink>
        </Button>
        <CopyButton value={openUrl} label="Copy link" />
        {v.canEdit && !draft && (
          <Button size="sm" variant="outline" onClick={() => hub.beginEdit(app.id, shared, kind)}>Edit</Button>
        )}
        <Button size="sm" variant="destructive" disabled={!!hub.busy[app.id]} onClick={() => hub.unshare(app.id)}>
          {hub.busy[app.id] === 'unshare' && <LoaderCircleIcon className="animate-spin" aria-hidden />}
          Unshare
        </Button>
      </div>
    </section>
  );
}
