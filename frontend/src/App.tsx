import { useState } from 'react';
import { AppList } from '@/components/AppList';
import { Header } from '@/components/Header';
import { Toolbar } from '@/components/Toolbar';
import { HubProvider, useHub } from '@/hub';
import type { SortKey } from '@/lib/types';

function Footer() {
  const { updatedAt } = useHub();
  return <footer className="pb-2 text-center text-xs text-muted-foreground">{updatedAt && `updated ${updatedAt.toLocaleTimeString()}`}</footer>;
}

export function App() {
  const [sort, setSort] = useState<SortKey>('edited');
  return (
    <HubProvider>
      <main className="mx-auto flex min-h-full max-w-2xl flex-col gap-3 p-3 sm:p-4">
        <Header />
        <Toolbar sort={sort} onSort={setSort} />
        <div className="flex-1">
          <AppList sort={sort} />
        </div>
        <Footer />
      </main>
    </HubProvider>
  );
}
