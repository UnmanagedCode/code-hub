import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '@/App';
import { app, json, listing, stubFetch, type Call } from '@/test/fixtures';

afterEach(() => { vi.unstubAllGlobals(); });

const puts = (calls: Call[]) => calls.filter((c) => c.method === 'PUT');
const gets = (calls: Call[]) => calls.filter((c) => c.method === 'GET' && c.url === 'api/apps').length;

async function openHubSettings(bridgeFallback: boolean, extra: Record<string, unknown> = {}) {
  const user = userEvent.setup();
  const stub = stubFetch({
    'GET api/apps': listing([app({ id: 'web' })], { hubSettings: { bridgeFallback } }),
    'PUT api/hub-settings': { bridgeFallback: !bridgeFallback },
    ...extra,
  });
  render(<App />);
  await screen.findByRole('article', { name: 'web' });
  await user.click(screen.getByRole('button', { name: 'Hub settings' }));
  const dialog = await screen.findByRole('dialog', { name: 'Hub settings' });
  const checkbox = within(dialog).getByRole('checkbox', { name: 'Bridge-address fallback' });
  return { user, dialog, checkbox, ...stub };
}

describe('Hub settings dialog', () => {
  // Invariant: the toolbar offers the hub settings, and the dialog's checkbox shows the stored value.
  it('the toolbar opens it, and the checkbox reflects the stored setting', async () => {
    for (const stored of [true, false]) {
      const { checkbox, dialog, user } = await openHubSettings(stored);
      expect(checkbox.getAttribute('aria-checked')).toBe(String(stored));
      await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      document.body.innerHTML = '';
    }
  });

  // Invariant: a toggled Save sends one PUT with the new value, reloads the listing, and closes.
  it('toggle + Save → one PUT {bridgeFallback:false}, a reload, closed', async () => {
    const { user, dialog, checkbox, calls } = await openHubSettings(true);
    const before = gets(calls);
    await user.click(checkbox);
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(puts(calls)).toEqual([{ method: 'PUT', url: 'api/hub-settings', body: { bridgeFallback: false } }]);
    expect(gets(calls)).toBeGreaterThan(before);
  });

  // Invariant: an unchanged Save sends nothing.
  it('an unchanged Save sends no PUT', async () => {
    const { user, dialog, calls } = await openHubSettings(true);
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(puts(calls)).toEqual([]);
  });

  // Invariant: a refused save shows its error inside the dialog, which stays open.
  it('a refusal shows in the dialog, which stays open', async () => {
    const { user, dialog, checkbox } = await openHubSettings(true, {
      'PUT api/hub-settings': () => json({ error: 'disk full' }, 500),
    });
    await user.click(checkbox);
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText('disk full')).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Hub settings' })).toBe(dialog);
  });
});
