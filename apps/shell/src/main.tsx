import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { loadShellConfig } from "./config.js";
import { registerServiceWorker } from "./register.js";
import "./styles.css";

const root = createRoot(document.getElementById("root") as HTMLElement);

loadShellConfig().then(
  (config) => {
    document.title = config.feedName;
    registerServiceWorker(config);
    root.render(
      <StrictMode>
        <App config={config} />
      </StrictMode>,
    );
  },
  (e: unknown) => {
    root.render(<p role="alert">Could not load the reader configuration: {e instanceof Error ? e.message : String(e)}</p>);
  },
);
