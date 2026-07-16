export {};

declare global {
  type HeadersInit = Exclude<ConstructorParameters<typeof Headers>[0], undefined>;
}
