import { initializeApp, type FirebaseApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, type Auth } from 'firebase/auth';

// Lazily initialized so the PUBLIC booking page (which only talks to /api) never
// loads Firebase or needs Firebase config — only the admin UI does.
let app: FirebaseApp | null = null;
let auth: Auth | null = null;

const useEmulators = import.meta.env.VITE_USE_EMULATORS === '1';

export function getFirebaseAuth(): Auth {
  if (!auth) {
    app = initializeApp({
      apiKey: import.meta.env.VITE_FB_API_KEY || 'demo-api-key',
      authDomain: import.meta.env.VITE_FB_AUTH_DOMAIN || undefined,
      projectId: import.meta.env.VITE_FB_PROJECT_ID || 'demo-booking',
      appId: import.meta.env.VITE_FB_APP_ID || undefined,
    });
    auth = getAuth(app);
    if (useEmulators) {
      connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
    }
  }
  return auth;
}
