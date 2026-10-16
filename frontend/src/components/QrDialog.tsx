import { ExternalLinkIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ExternalLink } from '@/components/ExternalLink';

/** The enlarged QR. `src` is a `data:` image from qrImageSrc; `url` names the share, `openUrl` is what Open opens. */
export function QrDialog({ open, onOpenChange, src, url, openUrl }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  src: string;
  url: string;
  openUrl: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Scan to open</DialogTitle>
          <DialogDescription className="font-mono break-all">{url}</DialogDescription>
        </DialogHeader>
        <img src={src} alt={`QR code for ${url}`} className="mx-auto aspect-square w-full max-w-72 rounded-md" />
        <Button asChild variant="outline">
          <ExternalLink url={openUrl} fallback="none">
            Open
            <ExternalLinkIcon aria-hidden />
          </ExternalLink>
        </Button>
      </DialogContent>
    </Dialog>
  );
}
