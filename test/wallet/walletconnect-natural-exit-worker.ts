import { resolve } from "node:path";

import { readRuntimeConfiguration } from "../../src/runtime/configuration.js";
import walletExternalModulesValue from "../../src/wallet/external-modules.cjs";
import {
  loadWalletConnectProductionDependencies,
  type WalletConnectSdkInitOptions,
} from "../../src/wallet/walletconnect-client.js";

const projectId = "1".repeat(32);
const metadata = readRuntimeConfiguration({}).wallet.metadata;
const storeRoot = process.env["LITTLEJOHN_TEST_WALLETCONNECT_STORE_ROOT"];
if (storeRoot === undefined || storeRoot.length === 0) {
  throw new TypeError("The test WalletConnect store root is unavailable.");
}
const pairingTopic = "2".repeat(64);
const proposalId = 100;
const heartbeatInterval = setInterval(() => undefined, 60_000);
let approvalReject: ((error: unknown) => void) | undefined;
const approvalTimer = setTimeout(() => {
  approvalReject?.(new Error("Proposal timer was not released."));
}, 60_000);
const approval = new Promise<unknown>((_resolve, reject) => {
  approvalReject = reject;
});

delete process.env["DISABLE_GLOBAL_CORE"];
const walletExternalModules = walletExternalModulesValue as unknown as Readonly<{
  loadSignClientModule(): Promise<unknown>;
}>;
const signClientModule = await walletExternalModules.loadSignClientModule();
if (process.env["DISABLE_GLOBAL_CORE"] !== "true") {
  throw new TypeError("The wallet SDK loader did not disable the pinned global Core cache.");
}
const signClientDescriptor = Object.getOwnPropertyDescriptor(signClientModule, "SignClient");
if (
  signClientDescriptor === undefined ||
  !("value" in signClientDescriptor) ||
  typeof signClientDescriptor.value !== "function"
) {
  throw new TypeError("The pinned Sign Client constructor is unavailable.");
}
const SignClient = signClientDescriptor.value as new (options: unknown) => unknown;
const constructorOptions = {
  projectId,
  storageOptions: {
    database: resolve(storeRoot, "core-store"),
  },
  telemetryEnabled: false,
};
const firstSignClient = new SignClient(constructorOptions);
const firstCore = Object.getOwnPropertyDescriptor(firstSignClient, "core")?.value as unknown;
const exerciseHeartbeat = async (core: unknown): Promise<void> => {
  if (typeof core !== "object" || core === null) {
    throw new TypeError("The pinned Sign Client Core is unavailable.");
  }
  const heartbeat = Object.getOwnPropertyDescriptor(core, "heartbeat")?.value as unknown;
  if (typeof heartbeat !== "object" || heartbeat === null) {
    throw new TypeError("The pinned Sign Client heartbeat is unavailable.");
  }
  const prototype = Reflect.getPrototypeOf(heartbeat) as object | null;
  const initialize = prototype === null
    ? undefined
    : Object.getOwnPropertyDescriptor(prototype, "init")?.value as unknown;
  const stop = prototype === null
    ? undefined
    : Object.getOwnPropertyDescriptor(prototype, "stop")?.value as unknown;
  if (typeof initialize !== "function" || typeof stop !== "function") {
    throw new TypeError("The pinned Sign Client heartbeat lifecycle is unavailable.");
  }
  await Reflect.apply(initialize, heartbeat, []) as Promise<void>;
  Reflect.apply(stop, heartbeat, []);
};
await exerciseHeartbeat(firstCore);

const secondSignClient = new SignClient(constructorOptions);
const secondCore = Object.getOwnPropertyDescriptor(secondSignClient, "core")?.value as unknown;
if (typeof firstCore !== "object" || firstCore === null || firstCore === secondCore) {
  throw new TypeError("The pinned Sign Client reused one global Core instance.");
}
await exerciseHeartbeat(secondCore);

class TestRelayer {
  async transportClose(): Promise<void> {}
}

class TestHeartbeat {
  stop(): void {
    clearInterval(heartbeatInterval);
  }
}

let proposals: Array<{
  readonly id: number;
  readonly pairingTopic: string;
  readonly expiryTimestamp: number;
}> = [];
let pairings: Array<{ readonly topic: string }> = [];
const listeners = new Map<string, Set<(event: unknown) => void>>();
const emit = (event: string, value: unknown): void => {
  for (const listener of listeners.get(event) ?? []) listener(value);
};

const initializedClient = {
  core: {
    heartbeat: new TestHeartbeat(),
    relayer: new TestRelayer(),
    pairing: {
      disconnect: async ({ topic }: { readonly topic: string }) => {
        pairings = pairings.filter((value) => value.topic !== topic);
      },
      getPairings: () => pairings,
    },
    expirer: {
      set: (id: number) => {
        proposals = proposals.filter((proposal) => proposal.id !== id);
        clearTimeout(approvalTimer);
        approvalReject?.({ code: 0 });
        emit("proposal_expire", { id });
      },
    },
  },
  proposal: { getAll: () => proposals },
  engine: {
    pendingSessions: new Map<unknown, unknown>(),
    onSessionProposeResponse: async () => undefined,
    onSessionSettleRequest: async () => undefined,
  },
  session: {
    getAll: () => [],
    set: async () => undefined,
  },
  connect: async () => {
    proposals = [{
      id: proposalId,
      pairingTopic,
      expiryTimestamp: Math.floor(Date.now() / 1_000) + 300,
    }];
    pairings = [{ topic: pairingTopic }];
    return {
      uri: `wc:${pairingTopic}@2?relay-protocol=irn&symKey=${"5".repeat(64)}`,
      approval: () => approval,
    };
  },
  disconnect: async () => undefined,
  on: (event: string, listener: (event: unknown) => void) => {
    const eventListeners = listeners.get(event) ?? new Set<(event: unknown) => void>();
    eventListeners.add(listener);
    listeners.set(event, eventListeners);
  },
  off: (event: string, listener: (event: unknown) => void) => {
    listeners.get(event)?.delete(listener);
  },
};

class TestSignClient {
  static async init(): Promise<unknown> {
    return initializedClient;
  }
}

const drop = (..._arguments: readonly unknown[]): void => undefined;
const logger = {
  level: "error" as const,
  child: (_bindings: unknown) => logger,
  trace: drop,
  debug: drop,
  info: drop,
  warn: drop,
  error: drop,
  fatal: drop,
};

const options: WalletConnectSdkInitOptions = {
  projectId,
  name: metadata.name,
  metadata,
  storageOptions: {
    database: resolve(storeRoot, "store"),
  },
  telemetryEnabled: false,
  logger,
};

const dependencies = await loadWalletConnectProductionDependencies(async (key) =>
  key === "signClient"
    ? { SignClient: TestSignClient }
    : { create: () => ({}) },
);
const sdk = await dependencies.sdkFactory(options, { retainCleanup: () => undefined });
await sdk.initializeConnectionAttempts();
const connection = await sdk.startConnection({
  requiredNamespaces: {
    eip155: {
      chains: ["eip155:4663"],
      methods: ["eth_sendTransaction"],
      events: ["accountsChanged", "chainChanged"],
    },
  },
});
const approvalSettlement = connection.lifecycle.waitForApproval().then(
  () => undefined,
  () => undefined,
);
await connection.lifecycle.cancel();
await approvalSettlement;
await sdk.close();
