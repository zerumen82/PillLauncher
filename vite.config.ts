import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [tailwindcss()],
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
