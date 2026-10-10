import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
const root = process.env.LITTLEJOHN_TEST_PACKAGE_ROOT;
const dist = root ? new URL("dist/", pathToFileURL(`${root}/`)) : new URL("../../dist/", import.meta.url);
const { runCli, createProcessTerminal } = await import(new URL("cli.js", dist));
const { RuntimeClient } = await import(new URL("runtime/client.js", dist));
const { createStdioMcp, loadMcpAppResource } = await import(new URL("interfaces/index.js", dist));
const terminal = createProcessTerminal();
const result = await runCli([], {
  terminal, settleOutput: () => terminal.outputOwner.settle(),
  createRuntime: () => RuntimeClient.create({ spawnBackend: environment => {
    const child = spawn(process.execPath, ["--import", fileURLToPath(new URL("./backend-egress.mjs", import.meta.url)), fileURLToPath(new URL("runtime/backend-entry.js", dist))], {
      detached: true, stdio: "ignore", env: { ...environment,
        LITTLEJOHN_TEST_RELAY_PORT: process.env.LITTLEJOHN_TEST_RELAY_PORT,
        ...(process.env.LITTLEJOHN_TEST_BACKEND_GATE ? { LITTLEJOHN_TEST_BACKEND_GATE: process.env.LITTLEJOHN_TEST_BACKEND_GATE } : {}),
      },
    });
    // The spawning test driver owns this inventory before a late detached
    // bootstrap can outlive its foreground launcher. It is not readiness data.
    if (child.pid !== undefined) writeFileSync(join(environment.LITTLEJOHN_DATA_DIR,
      `backend-candidate-${child.pid}`), "started", { mode: 0o600 });
    child.unref(); return child;
  } }),
  waitForPoll: () => { throw new Error("No direct CLI wallet flow is used by this MCP fixture."); },
  createMcp: runtime => createStdioMcp(runtime, process.stdin, terminal.outputOwner.mcpOutput, loadMcpAppResource()),
});
if (result.processDisposition === "process_exit_required") process.exit(result.exitCode);
else process.exitCode = result.exitCode;
