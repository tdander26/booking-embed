/**
 * Idempotent, GET-guarded migration of the LIVE single-practice Firestore into
 * the multi-tenant model. Copies every ROOT collection into
 * `tenants/{TENANT}/…`, folds branding into the tenant doc, stamps `tenantId`
 * on bookings, and marks the owner member `role:'owner'`.
 *
 * Pure REST + the Firebase CLI's OAuth token (cloud-platform scope) — no
 * firebase-admin, no service-account key.
 *
 *   node functions/scripts/migrate-tenants.mjs <projectId> [tenantSlug] [--dry-run]
 *     projectId   default: momentum-booking
 *     tenantSlug  default: momentum   (must equal DEFAULT_TENANT in firebase.ts)
 *     --dry-run   logs every write instead of performing it
 *
 * SAFETY: NEVER deletes or edits a ROOT doc — the destination subtree
 * (tenants/{slug}/…) is disjoint, so re-running is a no-op on already-copied
 * docs (dest GET-guard) and the original data stays authoritative for rollback.
 * Take a `gcloud firestore export` before the real run anyway.
 *
 * Deploy order:  indexes/rules -> THIS script -> functions -> web.
 * Run close to the functions deploy (locks/counters are short-lived; re-run
 * this script right after the deploy to capture any locks created in between).
 */
import fs from 'node:fs';

const PROJECT = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'momentum-booking';
const TENANT = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : 'momentum';
const DRY = process.argv.includes('--dry-run');
const OWNER_EMAIL = (process.env.OWNER_EMAIL || 'doc@drtoddanderson.com').toLowerCase();

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
const authHeader = { Authorization: `Bearer ${TOKEN}` };

// ---- REST value encoders ----
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
// ---- REST value decoders ----
function unwrap(v) {
  if (v == null) return undefined;
  if ('nullValue' in v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(unwrap);
  if ('mapValue' in v) return unfields(v.mapValue.fields || {});
  return undefined;
}
function unfields(f) {
  const o = {};
  for (const k of Object.keys(f || {})) o[k] = unwrap(f[k]);
  return o;
}

async function get(path) {
  const res = await fetch(`${base}/${path}`, { headers: authHeader });
  if (res.status === 404) return null;
  if (!res.ok) {
    console.error('GET FAIL', path, res.status, await res.text());
    process.exit(1);
  }
  const j = await res.json();
  return { name: j.name, data: unfields(j.fields || {}) };
}

async function put(path, data) {
  if (DRY) {
    console.log('  [dry-run] PUT', path);
    return;
  }
  const res = await fetch(`${base}/${path}`, {
    method: 'PATCH',
    headers: { ...authHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: fields(data) }),
  });
  if (!res.ok) {
    console.error('PATCH FAIL', path, res.status, await res.text());
    process.exit(1);
  }
}

async function patchMerge(path, data) {
  if (DRY) {
    console.log('  [dry-run] PATCH(merge)', path, Object.keys(data).join(','));
    return;
  }
  const mask = Object.keys(data)
    .map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`)
    .join('&');
  const res = await fetch(`${base}/${path}?${mask}`, {
    method: 'PATCH',
    headers: { ...authHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: fields(data) }),
  });
  if (!res.ok) {
    console.error('PATCH(merge) FAIL', path, res.status, await res.text());
    process.exit(1);
  }
}

async function* listCollection(col, pageSize = 200) {
  let pageToken;
  do {
    const u = new URL(`${base}/${col}`);
    u.searchParams.set('pageSize', String(pageSize));
    if (pageToken) u.searchParams.set('pageToken', pageToken);
    const res = await fetch(u, { headers: authHeader });
    if (!res.ok) {
      // A missing collection lists as empty (200, no documents); other errors fail.
      console.error('LIST FAIL', col, res.status, await res.text());
      process.exit(1);
    }
    const j = await res.json();
    for (const d of j.documents || []) {
      const id = d.name.split('/').pop();
      yield { id, data: unfields(d.fields || {}) };
    }
    pageToken = j.nextPageToken;
  } while (pageToken);
}

const T = `tenants/${TENANT}`;
const summary = {
  tenantCreated: false,
  ownerMemberId: null,
  members: 0,
  connections: 0,
  eventTypes: 0,
  schedules: 0,
  bookings: 0,
  slotLocks: 0,
  dayCounters: 0,
  reminderSends: 0,
  skipped: 0,
};

/** Copy a root doc to a dest path, GET-guarded (idempotent). `transform` may add
 * fields. Returns true if copied, false if dest already existed. */
async function copyDoc(srcData, destPath, transform) {
  const exists = await get(destPath);
  if (exists) {
    summary.skipped++;
    return false;
  }
  const data = transform ? transform({ ...srcData }) : srcData;
  await put(destPath, data);
  return true;
}

// ---- Step 0: resolve the owner member id (email match, else mbr_todd) ----
let ownerMemberId = 'mbr_todd';
{
  for await (const { id, data } of listCollection('members')) {
    if ((data.email || '').toLowerCase() === OWNER_EMAIL) {
      ownerMemberId = id;
      break;
    }
  }
  summary.ownerMemberId = ownerMemberId;
}

// ---- Step 1: tenant doc (branding folded in) ----
{
  const existing = await get(T);
  if (existing) {
    console.log(`tenant ${TENANT} already exists — leaving as-is`);
  } else {
    const b = (await get('branding/public'))?.data ?? {};
    await put(T, {
      slug: TENANT,
      practiceName: b.displayName || 'Momentum',
      status: 'active',
      ownerMemberId,
      ownerEmail: OWNER_EMAIL,
      displayName: b.displayName || 'Momentum',
      tagline: b.tagline ?? undefined,
      avatarUrl: b.avatarUrl ?? undefined,
      brandColor: b.brandColor || '#C9A84C',
      welcomeText: b.welcomeText ?? undefined,
      timezone: b.timezone || 'America/Chicago',
      createdAt: now,
      updatedAt: now,
    });
    summary.tenantCreated = true;
  }
}

// ---- Step 2: members (+ their connections subcollection) ----
for await (const { id, data } of listCollection('members')) {
  const copied = await copyDoc(data, `${T}/members/${id}`, (d) => ({
    ...d,
    role: id === ownerMemberId ? 'owner' : d.role || 'admin',
    updatedAt: d.updatedAt || now,
  }));
  if (copied) summary.members++;
  // Connections subcollection (refresh tokens) — copy verbatim.
  for await (const conn of listCollection(`members/${id}/connections`)) {
    const c = await copyDoc(conn.data, `${T}/members/${id}/connections/${conn.id}`);
    if (c) summary.connections++;
  }
}

// ---- Step 3: event types ----
for await (const { id, data } of listCollection('eventTypes')) {
  if (await copyDoc(data, `${T}/eventTypes/${id}`)) summary.eventTypes++;
}

// ---- Step 4: availability schedules ----
for await (const { id, data } of listCollection('availabilitySchedules')) {
  if (await copyDoc(data, `${T}/availabilitySchedules/${id}`)) summary.schedules++;
}

// ---- Step 5: bookings (stamp tenantId) ----
for await (const { id, data } of listCollection('bookings')) {
  const copied = await copyDoc(data, `${T}/bookings/${id}`, (d) => ({
    ...d,
    tenantId: TENANT,
  }));
  if (copied) summary.bookings++;
}

// ---- Step 6: slot locks + day counters (short-lived; best-effort) ----
for await (const { id, data } of listCollection('slotLocks')) {
  if (await copyDoc(data, `${T}/slotLocks/${id}`)) summary.slotLocks++;
}
for await (const { id, data } of listCollection('dayCounters')) {
  if (await copyDoc(data, `${T}/dayCounters/${id}`)) summary.dayCounters++;
}

// ---- Step 7: reminderSends (idempotency guards; copy so no double-send) ----
for await (const { id, data } of listCollection('reminderSends')) {
  if (await copyDoc(data, `${T}/reminderSends/${id}`)) summary.reminderSends++;
}

// ---- Summary ----
console.log(`\n=== migrate-tenants ${DRY ? '(DRY RUN) ' : ''}complete: ${PROJECT} -> ${T} ===`);
console.log('owner member       :', summary.ownerMemberId);
console.log('tenant doc         :', summary.tenantCreated ? 'created' : 'already existed');
console.log('members copied     :', summary.members);
console.log('connections copied :', summary.connections);
console.log('eventTypes copied  :', summary.eventTypes);
console.log('schedules copied   :', summary.schedules);
console.log('bookings copied    :', summary.bookings, '(tenantId stamped)');
console.log('slotLocks copied   :', summary.slotLocks);
console.log('dayCounters copied :', summary.dayCounters);
console.log('reminderSends copied:', summary.reminderSends);
console.log('docs skipped (exist):', summary.skipped);
console.log('(ROOT collections left intact as rollback safety net; no data deleted)');
