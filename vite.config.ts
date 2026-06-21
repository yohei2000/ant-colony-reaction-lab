import { defineConfig } from 'vite';

export default defineConfig({
  base: '/ant-colony-reaction-lab/',
  build: {
    sourcemap: true,
    target: 'es2022'
  },
  server: {
    host: '127.0.0.1'
  },
  preview: {
    host: '127.0.0.1'
  }
});
