export interface FakeRpcHandle {
  readonly url: string;
  readonly calls: readonly Readonly<{
    readonly method: string;
    readonly params: readonly unknown[];
  }>[];
  assertNoUnexpectedMethods(): void;
  close(): Promise<void>;
}

export function startFakeRpc(): Promise<FakeRpcHandle>;
