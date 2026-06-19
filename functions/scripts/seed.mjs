/**
 * Seed the Firestore emulator (or a real project) with branding, an availability
 * schedule, and a couple of event types so the booking page works immediately.
 *
 * Local (emulator):   npm run seed
 * Real project:       GCLOUD_PROJECT=your-id GOOGLE_APPLICATION_CREDENTIALS=... \
 *                     node functions/scripts/seed.mjs --prod
 *
 * Re-running is safe: documents use fixed ids and are merged.
 */
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const prod = process.argv.includes('--prod');
if (!prod) {
  process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8080';
}
const projectId = process.env.GCLOUD_PROJECT || process.env.VITE_FB_PROJECT_ID || 'demo-booking';

initializeApp({ projectId });
const db = getFirestore();
const now = new Date().toISOString();

const TZ = process.env.SEED_TZ || 'America/Chicago';

async function main() {
  // Branding
  await db.collection('branding').doc('public').set(
    {
      displayName: 'Dr. Todd Anderson',
      tagline: 'Book a time that works for you',
      brandColor: '#C9A84C',
      welcomeText: 'Pick a meeting type below to get started.',
      timezone: TZ,
      updatedAt: now,
    },
    { merge: true },
  );

  // Availability schedule: Mon–Fri, 9–12 and 1–5, in the owner's tz.
  const weekday = [{ start: '09:00', end: '12:00' }, { start: '13:00', end: '17:00' }];
  await db.collection('availabilitySchedules').doc('sched_default').set(
    {
      id: 'sched_default',
      name: 'Standard hours',
      timezone: TZ,
      weekly: { 1: weekday, 2: weekday, 3: weekday, 4: weekday, 5: weekday },
      overrides: [],
      createdAt: now,
      updatedAt: now,
    },
    { merge: true },
  );

  // Event types
  const base = {
    active: true,
    color: '#C9A84C',
    location: { type: 'google_meet' },
    availabilityScheduleId: 'sched_default',
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 10,
    minNoticeMinutes: 120,
    maxDaysInFuture: 60,
    collectPhone: true,
    remindersMinutesBefore: [1440, 60],
    createdAt: now,
    updatedAt: now,
    dailyBookingLimit: null,
  };

  await db.collection('eventTypes').doc('et_intro').set(
    {
      ...base,
      id: 'et_intro',
      slug: 'intro-call',
      name: 'Intro call',
      description: 'A quick 15-minute introduction.',
      durationMinutes: 15,
      slotIntervalMinutes: 15,
      sortOrder: 0,
    },
    { merge: true },
  );

  await db.collection('eventTypes').doc('et_consult').set(
    {
      ...base,
      id: 'et_consult',
      slug: 'consultation',
      name: 'Consultation',
      description: 'A 60-minute consultation.',
      durationMinutes: 60,
      slotIntervalMinutes: 30,
      sortOrder: 1,
    },
    { merge: true },
  );

  console.log(`Seeded branding, schedule, and 2 event types into "${projectId}".`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
