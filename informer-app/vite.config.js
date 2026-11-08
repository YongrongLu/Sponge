import { defineConfig } from 'vite';
import informer from '@entrinsik/vite-plugin-informer';

// Two pages: index.html (big screen + dashboard) and m.html (the audience phone page the QR opens).
export default defineConfig({
    plugins: [informer()],
    build: { rollupOptions: { input: { main: 'index.html', m: 'm.html' } } }
});
