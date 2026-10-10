export interface PreparedReviewDispatch<Result> {
  readonly source: Readonly<{kind: "transaction" | "signing"; operationId: string; resultDigest: string}>;
  readonly result?: Result;
  execute(): Promise<Result>;
  discard(): void;
}
