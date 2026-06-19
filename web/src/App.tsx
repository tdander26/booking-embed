import { lazy, Suspense } from 'react';
import { BookingApp } from './booking/BookingApp';
import { ManageBooking } from './manage/ManageBooking';
import { Spinner } from './components/ui';
import { resolveRoute } from './lib/tenant';

// Admin + signup are code-split so the public booking bundle stays lean.
const AdminApp = lazy(() =>
  import('./admin/AdminApp').then((m) => ({ default: m.AdminApp })),
);
const SignupWizard = lazy(() =>
  import('./signup/SignupWizard').then((m) => ({ default: m.SignupWizard })),
);

const loading = (label: string) => (
  <div className="py-16">
    <Spinner label={label} />
  </div>
);

export function App() {
  const { tenantSlug, view } = resolveRoute();

  if (view === 'signup') {
    return <Suspense fallback={loading('Loading…')}><SignupWizard /></Suspense>;
  }
  if (view === 'admin') {
    return (
      <Suspense fallback={loading('Loading admin…')}>
        <AdminApp tenantSlug={tenantSlug} />
      </Suspense>
    );
  }
  if (view === 'manage') {
    return <ManageBooking />;
  }
  return <BookingApp />;
}
