/**
 * Grant the `admin` custom claim to a user, which unlocks the /admin UI in
 * production. (In the emulator any signed-in user is already treated as admin.)
 *
 * Real project:  GCLOUD_PROJECT=your-id GOOGLE_APPLICATION_CREDENTIALS=sa.json \
 *                node functions/scripts/grant-admin.mjs you@example.com
 * Emulator:      FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 \
 *                node functions/scripts/grant-admin.mjs you@example.com
 *
 * The user must already exist (sign up in the app first). The user must sign out
 * and back in for the new claim to appear in their ID token.
 */
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

const email = process.argv[2];
if (!email) {
  console.error('Usage: node functions/scripts/grant-admin.mjs <email>');
  process.exit(1);
}

const projectId = process.env.GCLOUD_PROJECT || process.env.VITE_FB_PROJECT_ID || 'demo-booking';
initializeApp({ projectId });
const auth = getAuth();

async function main() {
  const user = await auth.getUserByEmail(email);
  await auth.setCustomUserClaims(user.uid, { admin: true });
  console.log(`Granted admin to ${email} (uid ${user.uid}). They must re-login.`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err.message || err);
    process.exit(1);
  },
);
