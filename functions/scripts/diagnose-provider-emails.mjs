/**
 * Read-only diagnostic for "a provider never receives booking notifications".
 *
 * Prints, for one tenant: every provider (member) with its email + active flag,
 * every event type with the memberIds it offers, and the most recent bookings
 * with the member they were assigned to and whether the provider-confirmation
 * email was actually sent. Between them these answer the two failure modes:
 *
 *   1. A provider isn't attached to any event type's memberIds  -> no booking is
 *      ever assigned to them, so they're never notified. (Fix: attach-provider.mjs)
 *   2. Bookings ARE assigned to them but the confirm-provider guard shows
 *      claimedAt with no sentAt -> the Resend send threw (domain/verification /
 *      suppression). (Fix: Resend dashboard.)
 *
 * Real project:  GCLOUD_PROJECT=your-id GOOGLE_APPLICATION_CREDENTIALS=sa.json \
 *                node functions/scripts/diagnose-provider-emails.mjs [tenantId]
 * Emulator:      FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 \
 *                node functions/scripts/diagnose-provider-emails.mjs [tenantId]
 *
 * tenantId defaults to "momentum" (the live single-practice tenant).
 */
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const tenantId = process.argv[2] || 'momentum';
const projectId = process.env.GCLOUD_PROJECT || process.env.VITE_FB_PROJECT_ID || 'demo-booking';

initializeApp({ projectId });
const db = getFirestore();
const tenant = db.collection('tenants').doc(tenantId);

async function main() {
  console.log(`\n=== Diagnostics for tenant "${tenantId}" (project ${projectId}) ===\n`);

  // --- Providers ---
  const members = (await tenant.collection('members').get()).docs.map((d) => ({
    id: d.id,
    ...d.data(),
  }));
  console.log(`Providers (members): ${members.length}`);
  for (const m of members) {
    const email = m.email ? m.email : '(NO EMAIL)';
    const flags = [m.active ? 'active' : 'INACTIVE', m.featured ? 'featured' : null, m.role]
      .filter(Boolean)
      .join(', ');
    console.log(`  - ${m.id}  ${m.name || '(no name)'}  <${email}>  [${flags}]`);
  }

  // --- Event types + which providers they offer ---
  const eventTypes = (await tenant.collection('eventTypes').get()).docs.map((d) => ({
    id: d.id,
    ...d.data(),
  }));
  console.log(`\nEvent types: ${eventTypes.length}`);
  for (const e of eventTypes) {
    const ids = Array.isArray(e.memberIds) ? e.memberIds : [];
    const label = ids.length ? ids.join(', ') : '(none -> legacy single-provider: owner)';
    console.log(`  - ${e.id}  "${e.name}"  active=${e.active !== false}  memberIds=[${label}]`);
  }

  // Which providers are offered by at least one event type?
  const offered = new Set(eventTypes.flatMap((e) => (Array.isArray(e.memberIds) ? e.memberIds : [])));
  const unattached = members.filter((m) => !offered.has(m.id));
  if (unattached.length) {
    console.log(`\n⚠  Providers NOT offered by any event type (bookings can't route to them):`);
    for (const m of unattached) console.log(`     ${m.id}  ${m.name}`);
    console.log(`   -> Fix with: node functions/scripts/attach-provider.mjs ${tenantId} <memberId>`);
  }

  // --- Recent bookings + provider-confirmation status ---
  const bookings = (await tenant.collection('bookings').get()).docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    .slice(0, 20);
  console.log(`\nRecent bookings (latest ${bookings.length}):`);
  const byMember = {};
  for (const b of bookings) {
    byMember[b.memberId] = (byMember[b.memberId] || 0) + 1;
    const guard = await tenant.collection('reminderSends').doc(`${b.id}_confirm-provider`).get();
    let status;
    if (!guard.exists) status = 'no provider-email attempt';
    else if (guard.data().sentAt) status = 'SENT';
    else status = 'CLAIMED but never sent (send threw -> Resend?)';
    console.log(
      `  - ${b.createdAt || '?'}  ${b.id}  member=${b.memberId} (${b.memberName || '?'})  provider-email: ${status}`,
    );
  }
  console.log(`\nBookings-per-member in that window:`);
  for (const [mid, n] of Object.entries(byMember)) {
    const m = members.find((x) => x.id === mid);
    console.log(`  ${mid} (${m?.name || '?'}): ${n}`);
  }
  console.log('');
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err.message || err);
    process.exit(1);
  },
);
