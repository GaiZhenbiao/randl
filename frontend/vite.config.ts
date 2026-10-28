import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
export default defineConfig({
  plugins: [
    {
      name: 'local-carbon-fonts',
      enforce: 'pre',
      transform(code, id) {
        if (id.endsWith('carbon-components-svelte/css/all.css'))
          return code.replace(/@font-face\{[^}]*\}/g, '');
      },
    },
    svelte(),
  ],
  server: {
    host: '127.0.0.1',
    proxy: Object.fromEntries(
      ['/api', '/graphql', '/files', '/storage'].map((path) => [path, 'http://127.0.0.1:8742']),
    ),
  },
  build: { chunkSizeWarningLimit: 800 },
});
