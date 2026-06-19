import { lazy, Suspense } from 'react';
import { BookingApp } from './booking/BookingApp';
import { ManageBooking } from './manage/ManageBooking';
import { Spinner } from './components/ui';

// Admin is code-split so the public booking bundle never loads Firebase/admin code.
const AdminApp = lazy(() =>
  import('./admin/AdminApp').then((m) => ({ default: m.AdminApp })),
);

export function App() {
  const path = window.location.pathname;
  if (path === '/admin' || path.startsWith('/admin/')) {
    return (
      <Suspense fallback={<div className="py-16"><Spinner label="Loading admin…" /></div>}>
        <AdminApp />
      </Suspense>
    );
  }
  if (path === '/manage' || path.startsWith('/manage')) {
    return <ManageBooking />;
  }
  return <BookingApp />;
}
