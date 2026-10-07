import Module from "node:module";
import { writeSync } from "node:fs";

// The real pinned SDK initializes with the real injected SQLite owner. Hold
// its return at the external module boundary to exercise partial acquisition.
const load = Module._load;
Module._load = function (name, ...rest) {
  const module = Reflect.apply(load, this, [name, ...rest]);
  if (name !== "@walletconnect/sign-client") return module;
  const SignClient = module.SignClient;
  return { ...module, SignClient: class {
    static async init(options) {
      await SignClient.init(options);
      writeSync(4, "sdk_initialized\n");
      return new Promise(() => {});
    }
  } };
};
