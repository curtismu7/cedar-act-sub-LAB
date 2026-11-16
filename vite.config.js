import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "web",
  plugins: [react()],
  build: { outDir: "../dist", emptyOutDir: true },
  server: {
    port: 17819,
    proxy: { "/api": "http://127.0.0.1:7819" }
  }
});
