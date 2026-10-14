import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "./index.css"
import App from "./App"
import V2App from "./v2-app"

/* ?v2 opens the UX v2 prototype (threads by project); everything else is the
   current prototype, unchanged. */
const v2 = new URLSearchParams(location.search).has("v2")

createRoot(document.getElementById("root")!).render(
  <StrictMode>{v2 ? <V2App /> : <App />}</StrictMode>,
)
