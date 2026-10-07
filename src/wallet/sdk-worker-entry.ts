import { runWalletSdkWorker } from "./sdk-worker.js";

// This fixed executable is the only SDK entry. No credential, topic or request
// appears in command arguments, environment variables or standard output.
if (process.send === undefined || !process.connected) process.exit(1);
runWalletSdkWorker({
  send: (message, callback) => { process.send!(message, callback); },
  on: (event, listener) => { process.on(event, listener); },
}, (code) => process.exit(code));
