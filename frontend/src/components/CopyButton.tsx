import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';

export const FEEDBACK_MS = 1500;

/** Copies `value` (never what is shown, which may be masked) and says whether it worked. */
export function CopyButton({ value, label }: { value: string; label: string }) {
  const [result, setResult] = useState<'Copied' | 'Copy failed' | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    let ok = false;
    try {
      await navigator.clipboard.writeText(value);
      ok = true;
    } catch {
      // No clipboard (an insecure context) or permission refused.
    }
    setResult(ok ? 'Copied' : 'Copy failed');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setResult(null), FEEDBACK_MS);
  };

  return (
    <Button type="button" variant="outline" size="sm" aria-label={label} onClick={copy}>
      <span aria-live="polite">{result ?? 'Copy'}</span>
    </Button>
  );
}
