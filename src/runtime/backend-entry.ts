import { createWalletOwnerApplication } from "../wallet/application.js";
import { createChainOwnerApplication } from "../chain/application.js";
import { createInterfaceOwnerApplication } from "../interfaces/application.js";
import { LocalRuntime } from "./composition.js";
import { runBackend } from "./backend.js";

void runBackend({ host: {
  on: (event, listener) => { process.on(event, listener); },
  removeListener: (event, listener) => { process.removeListener(event, listener); },
}, createRuntime: onShutdownRequested => LocalRuntime.create({
  walletApplicationFactory: createWalletOwnerApplication,
  chainApplicationFactory: createChainOwnerApplication,
  interfaceApplicationFactory: createInterfaceOwnerApplication,
  onShutdownRequested,
}) }).then(code => process.exit(code), () => process.exit(1));
