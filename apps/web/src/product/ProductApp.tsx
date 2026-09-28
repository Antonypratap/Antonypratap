import { AppShell } from './shell/AppShell';
import { ProductDataProvider } from './state/data';
import type { Route } from './router';
import { Audit } from './screens/Audit';
import { Erp } from './screens/Erp';
import { Inbox } from './screens/Inbox';
import { InvoiceReview } from './screens/InvoiceReview';
import { Invoices } from './screens/Invoices';
import { Questions } from './screens/Questions';

function Screen({ route }: { route: Route }) {
  switch (route.name) {
    case 'questions':
      return <Questions />;
    case 'invoices':
      return <Invoices filter={route.filter} />;
    case 'invoice':
      return <InvoiceReview id={route.id} />;
    case 'erp':
      return <Erp tab={route.tab} />;
    case 'audit':
      return <Audit id={route.id} />;
    default:
      return <Inbox />;
  }
}

/** The Veyra product: every screen reads the Veyra API; the server is authoritative. */
export function ProductApp({ route }: { route: Route }) {
  return (
    <ProductDataProvider>
      <AppShell route={route}>
        <Screen route={route} />
      </AppShell>
    </ProductDataProvider>
  );
}
