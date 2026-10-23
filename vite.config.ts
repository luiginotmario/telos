import { defineConfig } from "vite";

export default defineConfig({
  // listen on IPv4 and IPv6 (localhost, 127.0.0.1, and the LAN for phone testing)
  server: { host: true, port: 5288, strictPort: true },
  preview: { host: true, port: 5289 },
  build: { target: "es2022", assetsInlineLimit: 0, chunkSizeWarningLimit: 900 },
});
