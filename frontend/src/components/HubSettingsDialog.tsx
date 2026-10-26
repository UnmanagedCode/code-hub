import { useId, useState } from 'react';
import { LoaderCircleIcon, SettingsIcon } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { useHub } from '@/hub';
import { hubSettingsDraftFor, hubSettingsPatch, type HubSettingsDraft } from '@/lib/hubSettingsForm';

/**
 * The hub-wide settings, behind the toolbar's gear. The draft is seeded from the listing when the dialog opens, so
 * the gear waits for the first listing.
 */
export function HubSettingsDialog() {
  const hub = useHub();
  const ids = useId();
  const current = hub.data?.hubSettings ?? null;
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<HubSettingsDraft>({ bridgeFallback: true });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onOpenChange = (next: boolean) => {
    if (next && current) {
      setDraft(hubSettingsDraftFor(current));
      setError(null);
    }
    setOpen(next);
  };
  const save = async () => {
    const body = current && hubSettingsPatch(draft, current);
    if (!body) return setOpen(false);
    setSaving(true);
    setError(null);
    try {
      await hub.saveHubSettings(body);
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Button variant="ghost" size="icon" aria-label="Hub settings" disabled={!current} onClick={() => onOpenChange(true)}>
        <SettingsIcon aria-hidden />
      </Button>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Hub settings</DialogTitle>
            <DialogDescription>Apply to every app code-hub serves.</DialogDescription>
          </DialogHeader>
          <form
            className="flex flex-col gap-4"
            aria-label="Hub settings"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <Checkbox
                  id={`${ids}-bridge`}
                  checked={draft.bridgeFallback}
                  aria-describedby={`${ids}-bridge-desc`}
                  onCheckedChange={(v) => setDraft({ bridgeFallback: v === true })}
                />
                <Label htmlFor={`${ids}-bridge`} className="font-normal">Bridge-address fallback</Label>
              </div>
              <p id={`${ids}-bridge-desc`} className="ml-6 text-xs text-muted-foreground">
                When code-hub runs in a bridge-networked container and no host relay is connected, open each running
                app at the container's bridge address through a plain forwarder — no TLS, no login. Turned off, apps
                show their localhost URL.
              </p>
            </div>
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>Cancel</Button>
              <Button type="submit" size="sm" disabled={saving}>
                {saving && <LoaderCircleIcon className="animate-spin" aria-hidden />}
                Save
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
