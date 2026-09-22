import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [tailwindcss()],
  esbuild: {
    jsx: 'automatic',
  },
  clearScreen: false,
  build: {
    modulePreload: false,
  },
  server: {
    port: 5173,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
});
