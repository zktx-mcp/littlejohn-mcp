const mask64 = (1n << 64n) - 1n;
const roundConstants = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an,
  0x8000000080008000n, 0x000000000000808bn, 0x0000000080000001n,
  0x8000000080008081n, 0x8000000000008009n, 0x000000000000008an,
  0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n,
  0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n,
  0x000000000000800an, 0x800000008000000an, 0x8000000080008081n,
  0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
] as const;
const rotations = [
  0, 1, 62, 28, 27,
  36, 44, 6, 55, 20,
  3, 10, 43, 25, 39,
  41, 45, 15, 21, 8,
  18, 2, 61, 56, 14,
] as const;

const rotateLeft = (value: bigint, count: number): bigint => {
  if (count === 0) return value & mask64;
  const shift = BigInt(count);
  return ((value << shift) | (value >> (64n - shift))) & mask64;
};

const permute = (state: bigint[]): void => {
  for (const roundConstant of roundConstants) {
    const c = new Array<bigint>(5);
    const d = new Array<bigint>(5);
    for (let x = 0; x < 5; x += 1) {
      c[x] = (state[x] as bigint) ^ (state[x + 5] as bigint) ^ (state[x + 10] as bigint) ^
        (state[x + 15] as bigint) ^ (state[x + 20] as bigint);
    }
    for (let x = 0; x < 5; x += 1) {
      d[x] = (c[(x + 4) % 5] as bigint) ^ rotateLeft(c[(x + 1) % 5] as bigint, 1);
    }
    for (let index = 0; index < 25; index += 1) state[index] = (state[index] as bigint) ^ (d[index % 5] as bigint);

    const b = new Array<bigint>(25).fill(0n);
    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) {
        const destinationX = y;
        const destinationY = (2 * x + 3 * y) % 5;
        b[destinationX + 5 * destinationY] = rotateLeft(state[x + 5 * y] as bigint, rotations[x + 5 * y] as number);
      }
    }
    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) {
        state[x + 5 * y] = (b[x + 5 * y] as bigint) ^
          ((~(b[((x + 1) % 5) + 5 * y] as bigint) & mask64) & (b[((x + 2) % 5) + 5 * y] as bigint));
      }
    }
    state[0] = (state[0] as bigint) ^ roundConstant;
  }
};

const keccak256Bytes = (input: Uint8Array): Uint8Array => {
  const rate = 136;
  const paddedLength = Math.ceil((input.length + 1) / rate) * rate;
  const padded = new Uint8Array(paddedLength);
  padded.set(input);
  padded[input.length] = 0x01;
  padded[padded.length - 1] = (padded[padded.length - 1] as number) | 0x80;

  const state = new Array<bigint>(25).fill(0n);
  for (let offset = 0; offset < padded.length; offset += rate) {
    for (let lane = 0; lane < rate / 8; lane += 1) {
      let value = 0n;
      for (let byte = 0; byte < 8; byte += 1) {
        value |= BigInt(padded[offset + lane * 8 + byte] as number) << BigInt(byte * 8);
      }
      state[lane] = (state[lane] as bigint) ^ value;
    }
    permute(state);
  }

  const output = new Uint8Array(32);
  for (let index = 0; index < output.length; index += 1) {
    output[index] = Number(((state[Math.floor(index / 8)] as bigint) >> BigInt((index % 8) * 8)) & 0xffn);
  }
  return output;
};

export const keccak256Hex = (hexBytes: string): string => {
  if (!/^0x(?:[0-9a-f]{2})*$/.test(hexBytes)) throw new TypeError("Expected canonical hexadecimal bytes.");
  const bytes = new Uint8Array((hexBytes.length - 2) / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hexBytes.slice(2 + index * 2, 4 + index * 2), 16);
  }
  return `0x${Buffer.from(keccak256Bytes(bytes)).toString("hex")}`;
};
