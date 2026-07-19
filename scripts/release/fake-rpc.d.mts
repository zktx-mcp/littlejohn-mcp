export interface FakeRpcHandle {
  readonly url: string;
  readonly token: Readonly<{
    readonly chainId: string;
    readonly address: string;
    readonly runtimeCode: string;
    readonly totalSupplyRaw: string;
    readonly decimals: string;
    readonly name: string;
    readonly symbol: string;
  }>;
  readonly canonicalBlockReference: Readonly<{
    readonly blockHash: string;
    readonly requireCanonical: true;
  }>;
  readonly calls: readonly Readonly<{
    readonly method: string;
    readonly params: readonly unknown[];
  }>[];
  assertNoUnexpectedMethods(): void;
  close(): Promise<void>;
}

export function startFakeRpc(): Promise<FakeRpcHandle>;
