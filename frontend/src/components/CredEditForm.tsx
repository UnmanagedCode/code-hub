import { useId } from 'react';
import { LoaderCircleIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useHub } from '@/hub';
import { credFieldsShown, credPasswordPlaceholder, resolveTlsReshareNote, tlsChanging } from '@/lib/shareState';
import type { App, CredDraft, ShareKind, Tunnel } from '@/lib/types';

/**
 * The Edit form of a live share. For a LAN share it is also the one place to flip authentication and TLS;
 * a tunnel or tailscale share is always gated, so there it only edits the login. Applies on Save (Enter too).
 */
export function CredEditForm({ app, shared, kind, draft }: { app: App; shared: Tunnel; kind: ShareKind; draft: CredDraft }) {
  const hub = useHub();
  const ids = useId();
  const isLan = kind === 'lan';
  const saving = hub.busy[app.id] === 'save';
  const set = (patch: Partial<CredDraft>) => hub.updateDraft(app.id, patch);
  const check = (key: 'auth' | 'tls', label: string) => (
    <div className="flex items-center gap-2">
      <Checkbox id={`${ids}-${key}`} checked={!!draft[key]} onCheckedChange={(v) => set({ [key]: v === true })} />
      <Label htmlFor={`${ids}-${key}`} className="font-normal">{label}</Label>
    </div>
  );

  return (
    <form
      className="flex flex-col gap-3 rounded-md border p-3"
      aria-label="Edit share login"
      onSubmit={(e) => {
        e.preventDefault();
        void hub.saveEdit(app.id, shared, kind);
      }}
    >
      {isLan && check('auth', 'Authentication')}
      {isLan && check('tls', 'TLS (HTTPS)')}
      {/* TLS can't flip in place: Save re-shares, so the link, QR and password all regenerate. */}
      {tlsChanging(draft, shared) && (
        <p className="text-xs text-muted-foreground">{resolveTlsReshareNote(draft.auth, app.settings)}</p>
      )}
      {credFieldsShown(draft, kind) && (
        <>
          <div className="grid grid-cols-[3rem_1fr] items-center gap-2">
            <Label htmlFor={`${ids}-user`}>user</Label>
            <Input
              id={`${ids}-user`}
              value={draft.username}
              placeholder={draft.username ? '' : 'leave blank to keep current'}
              onChange={(e) => set({ username: e.target.value })}
            />
            <Label htmlFor={`${ids}-pass`}>pass</Label>
            {/* A default password is masked: the draft starts blank (the real value never enters the DOM) and blank keeps it. */}
            <Input
              id={`${ids}-pass`}
              value={draft.password}
              autoComplete="off"
              placeholder={credPasswordPlaceholder(draft, shared)}
              onChange={(e) => set({ password: e.target.value })}
            />
          </div>
        </>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={() => hub.cancelEdit(app.id)}>Cancel</Button>
        <Button type="submit" size="sm" disabled={!!hub.busy[app.id]}>
          {saving && <LoaderCircleIcon className="animate-spin" aria-hidden />}
          Save
        </Button>
      </div>
    </form>
  );
}
