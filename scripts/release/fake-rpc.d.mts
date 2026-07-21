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
  readonly semanticReads: Readonly<{
    readonly account: Readonly<{
      readonly address: string;
      readonly nativeBalanceRaw: string;
      readonly token: FakeRpcHandle["token"];
    }>;
    readonly contract: Readonly<{
      readonly address: string;
      readonly runtimeCode: string;
      readonly byteLength: string;
      readonly codeHash: string;
    }>;
    readonly transaction: Readonly<{
      readonly transactionHash: string;
      readonly from: string;
      readonly to: string;
      readonly valueRaw: string;
      readonly input: string;
      readonly nonce: string;
      readonly gasLimitRaw: string;
      readonly type: string;
      readonly gasPriceRaw: string;
      readonly blockNumber: string;
      readonly transactionIndex: string;
      readonly cumulativeGasUsedRaw: string;
      readonly gasUsedRaw: string;
      readonly accessListAddress: string;
      readonly accessListStorageKey: string;
      readonly undecodedLogData: string;
      readonly transferToken: string;
      readonly transferFrom: string;
      readonly transferTo: string;
      readonly transferAmountRaw: string;
      readonly transaction: Readonly<Record<string, unknown>>;
      readonly receipt: Readonly<Record<string, unknown>>;
    }>;
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
