import path from "node:path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { hostApiPlugin } from "./host-plugin"

export default defineConfig({
  plugins: [react(), tailwindcss(), hostApiPlugin()],
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
})
