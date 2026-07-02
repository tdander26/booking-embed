// Exercises the email-usage meter against the Firestore emulator:
// recordEmailSend should atomically tally by total/type/day/tenant, and
// loadEmailUsage should read the current UTC month + today back. Run with the
// firestore emulator up:  node scripts/test-email-usage.mjs
process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8080';
process.env.GCLOUD_PROJECT ||= 'demo-booking';

const { recordEmailSend, loadEmailUsage } = await import('../lib/email/usage.js');

const assert = (cond, msg) => {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exit(1);
  }
  console.log('ok:', msg);
};

// Two fixed instants: same UTC month, different UTC days.
const day1 = new Date('2026-06-29T15:00:00.000Z');
const day2 = new Date('2026-06-30T15:00:00.000Z');

// 3 reminders + 2 confirmations on day1 (tenant a/b), 1 reminder on day2.
await recordEmailSend({ tenantId: 'practice-a', kind: 'reminder' }, day1);
await recordEmailSend({ tenantId: 'practice-a', kind: 'reminder' }, day1);
await recordEmailSend({ tenantId: 'practice-b', kind: 'reminder' }, day1);
await recordEmailSend({ tenantId: 'practice-a', kind: 'confirmation' }, day1);
await recordEmailSend({ tenantId: 'practice-b', kind: 'confirmation' }, day1);
await recordEmailSend({ tenantId: 'practice-a', kind: 'reminder' }, day2);
// one with no tenant (e.g. a platform/lab email) — must still tally totals.
await recordEmailSend({ kind: 'other' }, day2);

// Read back AS IF today were day2.
const u = await loadEmailUsage(day2);
console.log(JSON.stringify(u, null, 2));

assert(u.month === '2026-06', `month is 2026-06 (got ${u.month})`);
assert(u.total === 7, `month total is 7 (got ${u.total})`);
assert(u.today === 2, `today (day2) is 2 (got ${u.today})`);
assert(u.byDay['2026-06-29'] === 5, `day1 bucket is 5 (got ${u.byDay['2026-06-29']})`);
assert(u.byDay['2026-06-30'] === 2, `day2 bucket is 2 (got ${u.byDay['2026-06-30']})`);
assert(u.byType.reminder === 4, `reminders is 4 (got ${u.byType.reminder})`);
assert(u.byType.confirmation === 2, `confirmations is 2 (got ${u.byType.confirmation})`);
assert(u.byType.other === 1, `other is 1 (got ${u.byType.other})`);
assert(u.byTenant['practice-a'] === 4, `practice-a is 4 (got ${u.byTenant['practice-a']})`);
assert(u.byTenant['practice-b'] === 2, `practice-b is 2 (got ${u.byTenant['practice-b']})`);
assert(u.limits.perDay === 100 && u.limits.perMonth === 3000, 'Resend free-tier limits surfaced');

console.log('\nALL PASS — meter tallies and reads back correctly.');
process.exit(0);
