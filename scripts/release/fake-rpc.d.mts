export interface FakeRpcHandle {
  readonly url: string;
  readonly nativeBalanceRaw: string;
  readonly token: Readonly<{
    readonly chainId: string;
    readonly address: string;
    readonly runtimeCode: string;
    readonly totalSupplyRaw: string;
    readonly accountBalanceRaw: string;
    readonly decimals: string;
    readonly name: string;
    readonly symbol: string;
  }>;
  readonly tokens: readonly FakeRpcHandle["token"][];
  readonly canonicalBlockReference: Readonly<{
    readonly blockHash: string;
    readonly requireCanonical: true;
  }>;
  readonly calls: readonly Readonly<{
    readonly method: string;
    readonly params: readonly unknown[];
  }>[];
  assertNoUnexpectedMethods(): void;
  setUnavailable(value: boolean): void;
  close(): Promise<void>;
}

export function startFakeRpc(): Promise<FakeRpcHandle>;
