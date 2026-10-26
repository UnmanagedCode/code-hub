import { useId, useState } from 'react';
import { LoaderCircleIcon, SettingsIcon } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useHub } from '@/hub';
import { cardLabel } from '@/lib/appView';
import { automationFor, autoShareClashWarning, mainCheckoutSettingsAllowed, portErrorFor, portNote, portPlaceholder, settingsDraftFor, settingsPatch, type SettingsDraft } from '@/lib/settingsForm';
import { PASSWORD_MASK, shareModes } from '@/lib/shareState';
import type { App } from '@/lib/types';

/**
 * An app's stored settings, reachable from its card in every state: the default share login, and — for a main
 * checkout — the fixed port (where `mainCheckoutSettingsAllowed`) and the automation toggles `automationFor` offers
 * (auto-start at boot, auto-share on start; the always-on conductor's auto-start shows disabled with its reason).
 * The draft is local: it is seeded when the dialog opens, and the modal dialog keeps the listing's rare refreshes
 * from reaching it.
 */
export function SettingsDialog({ app }: { app: App }) {
  const hub = useHub();
  const ids = useId();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<SettingsDraft>(() => settingsDraftFor(app));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<SettingsDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const onOpenChange = (next: boolean) => {
    if (next) {
      setDraft(settingsDraftFor(app));
      setError(null);
    }
    setOpen(next);
  };
  const portErr = portErrorFor(draft, app);
  const note = portNote(app);
  const save = async () => {
    const body = settingsPatch(draft, app);
    if (!body) return setOpen(false);
    setSaving(true);
    setError(null);
    try {
      await hub.saveSettings(app.id, body);
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };
  // A disabled checkbox renders unchecked, whatever the draft holds; `description` is attached to it for assistive tech.
  const check = (
    key: 'forgetPassword' | 'autoStart' | 'autoShare' | 'auth' | 'tls',
    label: string,
    { disabled = false, description = null }: { disabled?: boolean; description?: string | null } = {},
  ) => (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <Checkbox
          id={`${ids}-${key}`}
          checked={!disabled && draft[key]}
          disabled={disabled}
          aria-describedby={description ? `${ids}-${key}-desc` : undefined}
          onCheckedChange={(v) => set({ [key]: v === true })}
        />
        <Label htmlFor={`${ids}-${key}`} className="font-normal">{label}</Label>
      </div>
      {description && <p id={`${ids}-${key}-desc`} className="ml-6 text-xs text-muted-foreground">{description}</p>}
    </div>
  );
  const automation = automationFor(app);
  const modes = shareModes(!!hub.data?.cloudflaredAvailable, !!hub.data?.tailscaleAvailable);
  const chosen = modes.find((m) => m.mode === draft.mode);
  const clash = autoShareClashWarning(draft, app, hub.data?.apps ?? []);

  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => onOpenChange(true)}>
        <SettingsIcon aria-hidden />
        Settings
      </Button>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Settings — {cardLabel(app)}</DialogTitle>
            <DialogDescription>Stored for this app only; a worktree has its own.</DialogDescription>
          </DialogHeader>
          <form
            className="flex flex-col gap-4"
            aria-label="App settings"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-sm font-medium">Default share login</legend>
              <div className="grid grid-cols-[3rem_1fr] items-center gap-2">
                <Label htmlFor={`${ids}-user`}>user</Label>
                <Input id={`${ids}-user`} value={draft.username} placeholder="hub" onChange={(e) => set({ username: e.target.value })} />
                <Label htmlFor={`${ids}-pass`}>pass</Label>
                {/* The stored password never enters the DOM: the field starts blank, and blank keeps it. */}
                <Input
                  id={`${ids}-pass`}
                  value={draft.password}
                  autoComplete="off"
                  placeholder={app.settings.hasPassword ? `${PASSWORD_MASK} (stored — type to replace)` : 'random per share'}
                  onChange={(e) => set({ password: e.target.value })}
                />
              </div>
              {app.settings.hasPassword && check('forgetPassword', 'Forget stored password')}
              <p className="text-xs text-muted-foreground">Applies to new shares; a live share keeps its login.</p>
            </fieldset>
            {mainCheckoutSettingsAllowed(app) && (
              <fieldset className="flex flex-col gap-2">
                <legend className="mb-1 text-sm font-medium">Port</legend>
                <Label htmlFor={`${ids}-port`}>Fixed port</Label>
                <Input
                  id={`${ids}-port`}
                  inputMode="numeric"
                  value={draft.port}
                  placeholder={portPlaceholder(app)}
                  aria-invalid={!!portErr}
                  aria-describedby={portErr ? `${ids}-port-error` : undefined}
                  onChange={(e) => set({ port: e.target.value })}
                />
                {portErr && <p id={`${ids}-port-error`} className="text-xs text-destructive">{portErr}</p>}
                <p className="text-xs text-muted-foreground">Blank uses the manifest's port when it has one, else a free port. A busy port refuses the start.</p>
                {note && <p className="text-xs text-muted-foreground">{note}</p>}
              </fieldset>
            )}
            {(automation.autoStart || automation.autoShare) && (
              <fieldset className="flex flex-col gap-2">
                <legend className="mb-1 text-sm font-medium">Automation</legend>
                {automation.autoStart && check('autoStart', 'Start automatically when code-hub starts', {
                  disabled: !!automation.autoStart.disabledReason,
                  description: automation.autoStart.disabledReason,
                })}
                {automation.autoShare && check('autoShare', automation.autoShare.label)}
                {automation.autoShare && draft.autoShare && (
                  <div className="ml-6 flex flex-col gap-2">
                    <div role="radiogroup" aria-label="Auto-share via" className="flex flex-wrap gap-3">
                      {modes.map((m) => (
                        <label key={m.mode} className="flex items-center gap-1.5 text-sm">
                          <input
                            type="radio"
                            name={`${ids}-mode`}
                            value={m.mode}
                            checked={draft.mode === m.mode}
                            onChange={() => set({ mode: m.mode })}
                            className="accent-primary"
                          />
                          {m.label}
                        </label>
                      ))}
                    </div>
                    {chosen?.disabledReason && (
                      <p className="text-xs text-muted-foreground">{chosen.disabledReason} — the auto-share will fail until it is.</p>
                    )}
                    {draft.mode === 'lan' && check('auth', 'Authentication')}
                    {draft.mode === 'lan' && check('tls', 'TLS (HTTPS)')}
                    {draft.mode === 'tailscale' && (
                      <div role="radiogroup" aria-label="Funnel port" className="flex flex-wrap gap-3">
                        {(hub.data?.funnelPorts ?? []).map(({ port }) => (
                          <label key={port} className="flex items-center gap-1.5 text-sm">
                            <input
                              type="radio"
                              name={`${ids}-funnel-port`}
                              value={port}
                              checked={draft.funnelPort === port}
                              onChange={() => set({ funnelPort: port })}
                              className="accent-primary"
                            />
                            :{port}
                          </label>
                        ))}
                      </div>
                    )}
                    {clash && (
                      <Alert variant="warning">
                        <AlertDescription>{clash}</AlertDescription>
                      </Alert>
                    )}
                  </div>
                )}
              </fieldset>
            )}
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>Cancel</Button>
              <Button type="submit" size="sm" disabled={saving || !!portErr}>
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
