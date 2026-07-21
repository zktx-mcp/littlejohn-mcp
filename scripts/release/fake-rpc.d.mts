export interface FakeRpcHandle {
  readonly url: string;
  readonly assetSourceUrl: string;
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
    readonly currentMultiplier: string;
    readonly pendingMultiplier: string;
    readonly pendingEffectiveAt: string;
    readonly assetUid?: string;
  }>;
  readonly defaultTokens: readonly FakeRpcHandle["token"][];
  readonly officialCandidate: FakeRpcHandle["token"] & Readonly<{ readonly assetUid: string }>;
  readonly tokens: readonly FakeRpcHandle["token"][];
  readonly canonicalBlockReference: Readonly<{
    readonly blockHash: string;
    readonly requireCanonical: true;
  }>;
  readonly calls: readonly Readonly<{
    readonly method: string;
    readonly params: readonly unknown[];
  }>[];
  readonly failures: readonly Readonly<{
    readonly method: string | null;
    readonly params: readonly unknown[];
    readonly message: string;
  }>[];
  assertNoUnexpectedMethods(): void;
  setUnavailable(value: boolean): void;
  setAssetSourceUnavailable(value: boolean): void;
  close(): Promise<void>;
}

export function startFakeRpc(): Promise<FakeRpcHandle>;
