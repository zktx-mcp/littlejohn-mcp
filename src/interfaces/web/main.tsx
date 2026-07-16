import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { productDisplayName } from "../../core/browser.js";
import { WalletOperationPage } from "./wallet-operation-page.js";
import "./styles.css";

document.title = `${productDisplayName} Wallet Operation`;

const root = document.getElementById("root");
if (root === null) throw new Error("Wallet operation application root is unavailable.");

createRoot(root).render(
  <StrictMode>
    <WalletOperationPage />
  </StrictMode>,
);
