/**
 * Seed production Firestore via the REST API using the Firebase CLI's OAuth
 * token (cloud-platform scope). Avoids needing a service-account key just to
 * load starter data. Idempotent (PATCH overwrites the fixed-id docs).
 *
 *   node functions/scripts/seed-prod-rest.mjs <projectId>
 */
import fs from 'node:fs';

const PROJECT = process.argv[2] || 'momentum-booking';
const cfg = JSON.parse(
  fs.readFileSync(process.env.HOME + '/.config/configstore/firebase-tools.json', 'utf8'),
);
const TOKEN = cfg?.tokens?.access_token;
if (!TOKEN) {
  console.error('No Firebase CLI access token found. Run `firebase login` first.');
  process.exit(1);
}
const base = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const now = new Date().toISOString();

function val(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number')
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(val) } };
  if (typeof v === 'object') return { mapValue: { fields: fields(v) } };
  throw new Error('unsupported value: ' + typeof v);
}
function fields(o) {
  const f = {};
  for (const k of Object.keys(o)) if (o[k] !== undefined) f[k] = val(o[k]);
  return f;
}
async function put(path, data) {
  const res = await fetch(`${base}/${path}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: fields(data) }),
  });
  if (!res.ok) {
    console.error('FAIL', path, res.status, await res.text());
    process.exit(1);
  }
  console.log('ok ', path);
}

const TZ = 'America/Chicago';
const weekday = [
  { start: '09:00', end: '12:00' },
  { start: '13:00', end: '17:00' },
];
const baseET = {
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
  dailyBookingLimit: null,
  createdAt: now,
  updatedAt: now,
};

await put('branding/public', {
  displayName: 'Dr. Todd Anderson',
  tagline: 'Book a time that works for you',
  brandColor: '#C9A84C',
  welcomeText: 'Choose a meeting type below to get started.',
  timezone: TZ,
  updatedAt: now,
});
await put('availabilitySchedules/sched_default', {
  id: 'sched_default',
  name: 'Standard hours',
  timezone: TZ,
  weekly: { 1: weekday, 2: weekday, 3: weekday, 4: weekday, 5: weekday },
  overrides: [],
  createdAt: now,
  updatedAt: now,
});
await put('eventTypes/et_intro', {
  ...baseET,
  id: 'et_intro',
  slug: 'intro-call',
  name: 'Intro call',
  description: 'A quick 15-minute introduction.',
  durationMinutes: 15,
  slotIntervalMinutes: 15,
  sortOrder: 0,
});
await put('eventTypes/et_consult', {
  ...baseET,
  id: 'et_consult',
  slug: 'consultation',
  name: 'Consultation',
  description: 'A 60-minute consultation.',
  durationMinutes: 60,
  slotIntervalMinutes: 30,
  sortOrder: 1,
});

console.log('Seeded production Firestore for', PROJECT);
