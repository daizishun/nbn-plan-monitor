import { spaceQueryClient } from "./local-sdk";
import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./space-styles.css";
import "./theme.css";

const rootEl = document.querySelector<HTMLElement>("[data-generated-space-root]");
if (!rootEl) {
  throw new Error("missing generated space root element");
}

// If you edit this file: keep `<QueryClientProvider client={spaceQueryClient}>`
// wrapping the app, and keep BOTH the `hatch-space-root` class AND the
// `data-hatch-space-root` attribute on the outer div. The styles in
// `space-styles.css` select on `.hatch-space-root[data-hatch-space-root]`
// to apply mobile safe-area insets (notches, gesture bars, etc.) and
// correct viewport sizing — dropping either breaks layout silently.
createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={spaceQueryClient}>
      <div className="hatch-space-root" data-hatch-space-root>
        <App />
      </div>
    </QueryClientProvider>
  </StrictMode>,
);
