/**
 * Idempotent, GET-guarded migration of the LIVE Firestore to the v2
 * multi-provider ("members") data model. Pure REST + the Firebase CLI's OAuth
 * token (cloud-platform scope) — no firebase-admin, no service-account key.
 *
 * Run AFTER deploying firestore.rules + indexes, BEFORE deploying the new
 * functions/web. The CLI token bypasses rules, so this works even before the
 * new rules are live, but deploy in this order so no code path reads a field
 * the data doesn't yet have:  rules/indexes -> THIS script -> functions -> web.
 *
 *   node functions/scripts/migrate-members.mjs <projectId>
 *
 * NEVER deletes clinical data. Every step is GET-guarded or a merge-PATCH of
 * only-new fields, so re-running is a no-op on already-migrated docs.
 *
 * Steps:
 *   1. members/mbr_todd        (owner; from OWNER_EMAIL)            create-if-missing
 *   2. members/mbr_anna        (Dr. Payne; placeholder, inactive)  create-if-missing
 *   3. availabilitySchedules/sched_anna (empty weekly) + tag sched_default with memberId
 *   4. private/google -> members/mbr_todd/connections/{connId}     IF a refreshToken exists
 *   5. eventTypes.memberIds=['mbr_todd'] + questions:[]            where absent (all types)
 *   6. bookings.memberId='mbr_todd' + memberName                  where absent (paginated)
 *   7. summary
 */
import fs from 'node:fs';

const PROJECT = process.argv[2] || 'momentum-booking';
const OWNER_EMAIL = (process.env.OWNER_EMAIL || 'doc@drtoddanderson.com').toLowerCase();
const OWNER_NAME = 'Dr. Todd Anderson';

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

// ---- REST value encoders (copied from seed-prod-rest.mjs) ----
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

// ---- REST value decoders (for GET-guards / reading legacy docs) ----
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

const authHeader = { Authorization: `Bearer ${TOKEN}` };

/** GET a doc. Returns {data} on 200, null on 404, throws on other errors. */
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

/** PATCH a doc with a full field set (no updateMask => replaces the listed fields). */
async function put(path, data) {
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

/** Merge-PATCH: only writes the keys in `data` (updateMask), leaves the rest. */
async function patchMerge(path, data) {
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

/** List a collection, paginating via pageToken. Yields {id, data} for each doc. */
async function* listCollection(col, pageSize = 200) {
  let pageToken;
  do {
    const u = new URL(`${base}/${col}`);
    u.searchParams.set('pageSize', String(pageSize));
    if (pageToken) u.searchParams.set('pageToken', pageToken);
    const res = await fetch(u, { headers: authHeader });
    if (!res.ok) {
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

/** sanitizeForDocId — mirrors functions/src/util/ids.ts exactly. */
function sanitizeForDocId(input) {
  return String(input).replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 120) || 'x';
}

const summary = {
  membersCreated: [],
  membersExisting: [],
  schedulesCreated: [],
  scheduleDefaultTagged: false,
  connectionMigrated: null,
  eventTypesBackfilled: [],
  eventTypesSkipped: [],
  bookingsBackfilled: 0,
  bookingsSkipped: 0,
};

// ---- Step 1: members/mbr_todd (owner) ----
{
  const existing = await get('members/mbr_todd');
  if (existing) {
    summary.membersExisting.push('mbr_todd');
  } else {
    await put('members/mbr_todd', {
      id: 'mbr_todd',
      name: OWNER_NAME,
      title: '',
      email: OWNER_EMAIL,
      active: true,
      featured: false,
      sortOrder: 1,
      isAdmin: true,
      defaultScheduleId: 'sched_default',
      createdAt: now,
      updatedAt: now,
      // writeConnectionId/writeCalendarId intentionally omitted until either the
      // private/google migration (step 4) sets them or Todd picks a calendar in
      // the admin UI. Unset => mock calendar, identical to today's behavior.
    });
    summary.membersCreated.push('mbr_todd');
  }
}

// ---- Step 2: members/mbr_anna (Dr. Payne, placeholder, inactive) ----
{
  const existing = await get('members/mbr_anna');
  if (existing) {
    summary.membersExisting.push('mbr_anna');
  } else {
    await put('members/mbr_anna', {
      id: 'mbr_anna',
      name: 'Dr. Anna Payne',
      title: '',
      email: '', // Todd sets her email in the admin UI
      active: false, // off until she connects + has availability
      featured: true, // featured / shown first
      sortOrder: 0,
      isAdmin: true,
      defaultScheduleId: 'sched_anna',
      createdAt: now,
      updatedAt: now,
    });
    summary.membersCreated.push('mbr_anna');
  }
}

// ---- Step 3: sched_anna (empty) + tag sched_default with memberId ----
{
  const annaSched = await get('availabilitySchedules/sched_anna');
  if (!annaSched) {
    // Mirror sched_default's tz when available; empty weekly so Dr. Payne has no
    // availability until configured (UI must route invitees to the other provider).
    const def = await get('availabilitySchedules/sched_default');
    const tz = def?.data?.timezone || 'America/Chicago';
    await put('availabilitySchedules/sched_anna', {
      id: 'sched_anna',
      name: 'Dr. Payne hours',
      timezone: tz,
      weekly: {}, // empty => no availability yet
      overrides: [],
      memberId: 'mbr_anna',
      createdAt: now,
      updatedAt: now,
    });
    summary.schedulesCreated.push('sched_anna');
  }

  // Tag the legacy shared schedule as owned by mbr_todd (merge — leaves weekly/overrides/tz).
  const def = await get('availabilitySchedules/sched_default');
  if (def && def.data.memberId !== 'mbr_todd') {
    await patchMerge('availabilitySchedules/sched_default', {
      memberId: 'mbr_todd',
      updatedAt: now,
    });
    summary.scheduleDefaultTagged = true;
  }
}

// ---- Step 4: private/google -> members/mbr_todd/connections/{connId} (if real token) ----
{
  const goog = await get('private/google');
  const refreshToken = goog?.data?.refreshToken;
  if (refreshToken) {
    const accountEmail = (goog.data.connectedEmail || OWNER_EMAIL || 'primary').toLowerCase();
    const calendarId = goog.data.calendarId || 'primary';
    // Lowercase before sanitizing to match the canonical connId() helper, so a
    // later admin re-connect upserts the SAME doc instead of orphaning this one.
    const cid = sanitizeForDocId((goog.data.connectedEmail || 'primary').toLowerCase());
    const connPath = `members/mbr_todd/connections/${cid}`;

    const existingConn = await get(connPath);
    if (!existingConn) {
      await put(connPath, {
        id: cid,
        accountEmail,
        refreshToken,
        scope: goog.data.scope || '',
        status: 'active',
        calendars: [
          {
            calendarId,
            summary: 'Primary',
            primary: true,
            selected: true,
            writable: true,
          },
        ],
        lastSyncedAt: now,
        createdAt: now,
        updatedAt: now,
      });
    }
    // Point the member's write target at this connection/calendar (merge).
    const todd = await get('members/mbr_todd');
    if (!todd?.data?.writeConnectionId) {
      await patchMerge('members/mbr_todd', {
        writeConnectionId: cid,
        writeCalendarId: calendarId,
        updatedAt: now,
      });
    }
    summary.connectionMigrated = { connId: cid, calendarId };
    // NOTE: private/google is intentionally NOT deleted — rollback safety net.
  }
}

// ---- Step 5: eventTypes backfill memberIds + questions ----
for await (const { id, data } of listCollection('eventTypes')) {
  const hasMembers = Array.isArray(data.memberIds) && data.memberIds.length > 0;
  const hasQuestions = Array.isArray(data.questions);
  if (hasMembers && hasQuestions) {
    summary.eventTypesSkipped.push(id);
    continue;
  }
  const patch = { updatedAt: now };
  if (!hasMembers) patch.memberIds = ['mbr_todd'];
  if (!hasQuestions) patch.questions = [];
  await patchMerge(`eventTypes/${id}`, patch);
  summary.eventTypesBackfilled.push(id);
}

// ---- Step 6: bookings backfill memberId + memberName (paginated) ----
for await (const { id, data } of listCollection('bookings')) {
  if (data.memberId) {
    summary.bookingsSkipped++;
    continue;
  }
  await patchMerge(`bookings/${id}`, {
    memberId: 'mbr_todd',
    memberName: OWNER_NAME,
  });
  summary.bookingsBackfilled++;
}

// ---- Step 7: summary ----
console.log('\n=== migrate-members complete for', PROJECT, '===');
console.log('members created   :', summary.membersCreated.join(', ') || '(none)');
console.log('members existing  :', summary.membersExisting.join(', ') || '(none)');
console.log('schedules created :', summary.schedulesCreated.join(', ') || '(none)');
console.log('sched_default tag :', summary.scheduleDefaultTagged ? 'memberId=mbr_todd added' : 'already tagged / n/a');
console.log(
  'connection migrated:',
  summary.connectionMigrated
    ? `${summary.connectionMigrated.connId} (cal ${summary.connectionMigrated.calendarId})`
    : 'none (no real refreshToken in private/google — mock mode preserved)',
);
console.log('eventTypes backfilled:', summary.eventTypesBackfilled.join(', ') || '(none)');
console.log('eventTypes skipped   :', summary.eventTypesSkipped.join(', ') || '(none)');
console.log('bookings backfilled  :', summary.bookingsBackfilled);
console.log('bookings skipped     :', summary.bookingsSkipped);
console.log('(private/google left intact as rollback safety net; no data deleted)');
