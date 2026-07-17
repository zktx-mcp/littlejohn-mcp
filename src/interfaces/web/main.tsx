import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { productDisplayName } from "../../core/browser.js";
import { App } from "./app.js";
import "./styles.css";

document.title = productDisplayName;

const root = document.getElementById("root");
if (root === null) throw new Error("Browser application root is unavailable.");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
