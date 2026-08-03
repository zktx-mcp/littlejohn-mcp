import { chmod } from "node:fs/promises";

import { openWalletConnectStorage } from "../../src/wallet/walletconnect-storage.js";

const privateStoreDirectory = process.argv[2];
if (privateStoreDirectory === undefined) {
  throw new TypeError("WalletConnect storage crash-worker directory is required.");
}
if (process.platform !== "win32") await chmod(privateStoreDirectory, 0o700);

const owner = await openWalletConnectStorage(privateStoreDirectory);
await owner.storage.setItem("committed-before-crash", { durable: true });
if (process.argv[3] === "exit-without-close") {
  if (process.send === undefined) process.exit(1);
  process.send({ ready: true }, () => process.exit(0));
} else {
  process.send?.({ ready: true });
}
setInterval(() => undefined, 60_000);
