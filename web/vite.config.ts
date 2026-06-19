import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// In production, Firebase Hosting rewrites `/api/**` to the `api` Cloud Function,
// which receives the FULL original path (e.g. `/api/availability`). The Express
// app is therefore mounted on `/api/*`.
//
// For `vite dev` we reproduce that by proxying `/api/*` straight to the Functions
// emulator. The emulator serves a function at
//   /<projectId>/<region>/<functionId>/<remainder>
// and passes <remainder> to Express as the request path. So to make Express see
// `/api/availability`, we target `/<projectId>/us-central1/api` + the original
// `/api/availability` path. Net result: dev and prod hit identical Express routes.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const projectId = env.VITE_FB_PROJECT_ID || 'demo-booking';
  return {
    plugins: [react()],
    build: {
      outDir: 'dist',
      rollupOptions: {
        input: {
          main: 'index.html',
          embedDemo: 'embed-demo.html',
        },
      },
    },
    server: {
      port: 5173,
      proxy: {
        '/api': {
          target: 'http://127.0.0.1:5001',
          changeOrigin: true,
          rewrite: (path) => `/${projectId}/us-central1/api${path}`,
        },
      },
    },
  };
});
