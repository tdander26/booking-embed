/**
 * Mint a self-serve signup ACCESS CODE (platform-admin tool).
 *
 * Writes the HASHED code to `signupCodes/{sha256(code)}` in the project's
 * Firestore using the Firebase CLI's OAuth token (cloud-platform scope → IAM,
 * which bypasses security rules — same path the migration uses). The RAW code is
 * printed ONCE and never stored; only its SHA-256 hash lives in Firestore.
 *
 *   node functions/scripts/mint-signup-code.mjs [projectId] [--label "..."] [--max N] [--expires ISO]
 *
 *     projectId    default: momentum-booking
 *     --label      human-readable label stored on the code (default: "manual")
 *     --max        max number of practices this code can create (default: 1)
 *     --expires    ISO datetime after which the code stops working (default: never)
 *
 * A clinic then onboards at https://<app>/signup — Google sign-in + this code.
 * (The same thing is available in-app via POST /api/platform/signup-codes for the
 * platform owner; this script is the headless/CLI equivalent.)
 */
import fs from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const PROJECT =
  process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'momentum-booking';
const label = arg('--label', 'manual');
const maxUses = parseInt(arg('--max', '1'), 10);
const expiresAt = arg('--expires', null);

if (!Number.isInteger(maxUses) || maxUses < 1) {
  console.error('--max must be a positive integer');
  process.exit(1);
}

const cfgPath = process.env.HOME + '/.config/configstore/firebase-tools.json';
let token;
try {
  token = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))?.tokens?.access_token;
} catch {
  /* fall through */
}
if (!token) {
  console.error('No Firebase CLI token found. Run `firebase login` (or `firebase login --reauth`) first.');
  process.exit(1);
}

const base = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const now = new Date().toISOString();

// Readable-ish, unguessable: MHW-XXXXXXXX (uppercased url-safe chars).
const code =
  'MHW-' +
  randomBytes(8).toString('base64url').replace(/[^A-Za-z0-9]/g, '').slice(0, 8).toUpperCase();
const hash = createHash('sha256').update(code).digest('hex');

const fields = {
  label: { stringValue: label },
  maxUses: { integerValue: String(maxUses) },
  uses: { integerValue: '0' },
  active: { booleanValue: true },
  expiresAt: expiresAt ? { stringValue: expiresAt } : { nullValue: null },
  createdAt: { stringValue: now },
  createdBy: { stringValue: 'cli' },
};

const res = await fetch(`${base}/signupCodes/${hash}`, {
  method: 'PATCH',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ fields }),
});
if (!res.ok) {
  console.error('Mint failed:', res.status, await res.text());
  process.exit(1);
}

console.log('');
console.log('  Signup access code (save it — shown once):');
console.log('  ┌─────────────────────────────┐');
console.log(`     ${code}`);
console.log('  └─────────────────────────────┘');
console.log(`  project: ${PROJECT}  |  label: ${label}  |  max uses: ${maxUses}${expiresAt ? `  |  expires: ${expiresAt}` : ''}`);
console.log(`  stored as hash ${hash.slice(0, 16)}…  (raw code is never stored)`);
console.log('');
