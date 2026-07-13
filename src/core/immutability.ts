export const deepFreezeValue = <Value>(value: Value, seen = new WeakSet<object>()): Value => {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const descriptor of Object.values(descriptors)) {
    if ("value" in descriptor) deepFreezeValue(descriptor.value, seen);
  }
  if (!Object.isFrozen(value)) Object.freeze(value);
  return value;
};
