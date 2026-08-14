import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base must match the GitHub repo name for Pages hosting
export default defineConfig({
  plugins: [react()],
  base: "/sig2noise/",
});
