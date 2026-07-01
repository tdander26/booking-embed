/**
 * Attach a provider (member) to event types so bookings can be made with them —
 * and therefore so they receive the provider booking-notification email.
 *
 * A booking is assigned to a member drawn from the event type's `memberIds`
 * array (see resolveMember in functions/src/scheduling/booking.ts). A provider
 * that isn't in any event type's memberIds is never selectable, so no booking is
 * ever routed to them and they're never notified. This adds the memberId to the
 * targeted event types' memberIds. Idempotent: already-attached types are skipped.
 *
 * Real project:  GCLOUD_PROJECT=your-id GOOGLE_APPLICATION_CREDENTIALS=sa.json \
 *   node functions/scripts/attach-provider.mjs <tenantId> <memberId> [eventTypeId ...]
 * Emulator:      FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 \
 *   node functions/scripts/attach-provider.mjs <tenantId> <memberId> [eventTypeId ...]
 *
 * With no eventTypeId args, ALL event types in the tenant are targeted.
 */
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

const [tenantId, memberId, ...eventTypeIds] = process.argv.slice(2);
if (!tenantId || !memberId) {
  console.error(
    'Usage: node functions/scripts/attach-provider.mjs <tenantId> <memberId> [eventTypeId ...]',
  );
  process.exit(1);
}

const projectId = process.env.GCLOUD_PROJECT || process.env.VITE_FB_PROJECT_ID || 'demo-booking';
initializeApp({ projectId });
const db = getFirestore();
const tenant = db.collection('tenants').doc(tenantId);

async function main() {
  // Guard: the member must exist and be sendable, or attaching them is pointless.
  const memberSnap = await tenant.collection('members').doc(memberId).get();
  if (!memberSnap.exists) {
    throw new Error(`Member "${memberId}" not found in tenant "${tenantId}". Create the provider first.`);
  }
  const member = memberSnap.data();
  if (!member.email) {
    throw new Error(`Member "${memberId}" (${member.name}) has no email — they can't be notified. Set an email first.`);
  }
  if (member.active === false) {
    console.warn(`⚠  Member "${memberId}" (${member.name}) is inactive; attaching anyway, but they stay hidden until active.`);
  }
  console.log(`Attaching ${memberId} (${member.name} <${member.email}>) in tenant "${tenantId}"\n`);

  // Resolve the target event types.
  let targets;
  if (eventTypeIds.length) {
    targets = [];
    for (const id of eventTypeIds) {
      const snap = await tenant.collection('eventTypes').doc(id).get();
      if (!snap.exists) {
        console.warn(`  ⚠  event type "${id}" not found — skipping`);
        continue;
      }
      targets.push({ id: snap.id, ...snap.data() });
    }
  } else {
    targets = (await tenant.collection('eventTypes').get()).docs.map((d) => ({ id: d.id, ...d.data() }));
  }

  let changed = 0;
  for (const e of targets) {
    const ids = Array.isArray(e.memberIds) ? e.memberIds : [];
    if (ids.includes(memberId)) {
      console.log(`  = ${e.id} "${e.name}" already offers ${memberId} — skip`);
      continue;
    }
    await tenant.collection('eventTypes').doc(e.id).set(
      { memberIds: FieldValue.arrayUnion(memberId), updatedAt: new Date().toISOString() },
      { merge: true },
    );
    changed += 1;
    console.log(`  + ${e.id} "${e.name}" now offers ${memberId}`);
  }

  console.log(`\nDone. ${changed} event type(s) updated, ${targets.length - changed} already correct.`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err.message || err);
    process.exit(1);
  },
);
