import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "./index.css"
import App from "./App"
import V2App from "./v2-app"
import V3App from "./v3-app"

/* ?v2 opens the UX v2 prototype (threads by project); ?v3 the calm-company
   prototype (People, Work, Goals); everything else is the current
   prototype, unchanged. */
const q = new URLSearchParams(location.search)

createRoot(document.getElementById("root")!).render(
  <StrictMode>{q.has("v3") ? <V3App /> : q.has("v2") ? <V2App /> : <App />}</StrictMode>,
)
