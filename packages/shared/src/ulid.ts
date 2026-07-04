import { randomBytes } from "node:crypto";

const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function encodeTime(ms: number): string {
  let out = "";
  for (let i = 0; i < 10; i++) {
    out = B32[ms % 32] + out;
    ms = Math.floor(ms / 32);
  }
  return out;
}

export function ulid(ms: number = Date.now()): string {
  const rand = randomBytes(16);
  let out = encodeTime(ms);
  for (let i = 0; i < 16; i++) out += B32[rand[i] % 32];
  return out;
}
