import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "./index.css"
import V3App from "./v3-app"

/* The prototype is the v3 calm-company screen at `/`. `?v3` is kept because
   old links carry it; it opens the same screen. */
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <V3App />
  </StrictMode>,
)
