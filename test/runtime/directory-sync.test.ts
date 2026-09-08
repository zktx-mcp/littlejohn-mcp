import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import { syncDirectory } from "../../src/runtime/paths.js";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs/promises")>(),
  open: vi.fn(),
}));

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => {
  Object.defineProperty(process, "platform", platformDescriptor);
  vi.resetAllMocks();
});

describe("directory synchronization", () => {
  it("owns sync and finally-close including each failure outcome", async () => {
    Object.defineProperty(process, "platform", { ...platformDescriptor, value: "linux" });
    for (const failing of ["none", "open", "sync", "close", "sync_and_close"] as const) {
      const events: string[] = [];
      const syncFailure = new Error("sync failed");
      const closeFailure = new Error("close failed");
      vi.mocked(open).mockImplementation(async () => {
        events.push("open");
        if (failing === "open") throw syncFailure;
        return {
          async sync() {
            events.push("sync");
            if (failing === "sync" || failing === "sync_and_close") throw syncFailure;
          },
          async close() {
            events.push("close");
            if (failing === "close" || failing === "sync_and_close") throw closeFailure;
          },
        } as FileHandle;
      });
      const result = syncDirectory("/owned-directory");
      if (failing === "none") await expect(result).resolves.toBeUndefined();
      else await expect(result).rejects.toBe(
        failing === "close" || failing === "sync_and_close" ? closeFailure : syncFailure,
      );
      expect(open).toHaveBeenLastCalledWith("/owned-directory", constants.O_RDONLY);
      expect(events).toEqual(failing === "open" ? ["open"] : ["open", "sync", "close"]);
    }
  });

  it("retains the Windows no-op without acquiring a handle", async () => {
    Object.defineProperty(process, "platform", { ...platformDescriptor, value: "win32" });
    await syncDirectory("unused");
    expect(open).not.toHaveBeenCalled();
  });
});
