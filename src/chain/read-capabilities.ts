import { accountBalanceCapability } from "../account-assets/balance-capability.js";
import { addressInspectCapability, chainStatusCapability, transactionInspectCapability } from "./read-contracts.js";

export const chainReadCapabilities = Object.freeze([accountBalanceCapability, addressInspectCapability, chainStatusCapability, transactionInspectCapability] as const);
