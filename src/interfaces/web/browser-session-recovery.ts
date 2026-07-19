import { browserSessionRequiresReload } from "./browser-client.js";

export const createBrowserSessionRecovery = (
  reload: () => void,
): ((error: unknown) => boolean) => {
  let requested = false;
  return (error: unknown): boolean => {
    if (!browserSessionRequiresReload(error)) return false;
    if (!requested) {
      requested = true;
      reload();
    }
    return true;
  };
};
