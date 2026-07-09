import {
  createHash, createPrivateKey, createPublicKey,
  generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify,
} from "node:crypto";

export interface Keypair {
  privateKeyPem: string;
  publicKeySpkiBase64: string;
}

export function generateKeypair(): Keypair {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeySpkiBase64: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
  };
}

export function fingerprint(publicKeySpkiBase64: string): string {
  return createHash("sha256").update(Buffer.from(publicKeySpkiBase64, "base64")).digest("hex");
}

export function canonicalString(
  method: string, pathWithQuery: string, timestamp: string, body: string,
): string {
  const bodyHash = createHash("sha256").update(body).digest("hex");
  return `${method.toUpperCase()}\n${pathWithQuery}\n${timestamp}\n${bodyHash}`;
}

export function sign(message: string, privateKeyPem: string): string {
  const key = createPrivateKey(privateKeyPem);
  return cryptoSign(null, Buffer.from(message), key).toString("base64");
}

export function verify(
  message: string, signatureBase64: string, publicKeySpkiBase64: string,
): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.from(publicKeySpkiBase64, "base64"), format: "der", type: "spki",
    });
    return cryptoVerify(null, Buffer.from(message), key, Buffer.from(signatureBase64, "base64"));
  } catch {
    return false;
  }
}
