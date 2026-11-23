// End-to-end encryption for a channel.
//
// The creator's browser makes a random room key. Nobody else gets it from a
// link: each joiner makes an ECDH key pair, sends only the public half, and a
// member who already holds the room key wraps it for them. The server relays
// the wrapped key but can't open it.

import type { Grant, Sealed } from "./protocol.ts";

const subtle = crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();
const ECDH = { name: "ECDH", namedCurve: "P-256" };

export function newRoomKey(): string {
  return toB64(crypto.getRandomValues(new Uint8Array(32)));
}

export function importRoomKey(rawB64: string): Promise<CryptoKey> {
  return subtle.importKey("raw", fromB64(rawB64), "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encrypt(key: CryptoKey, text: string, aad: string): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(aad) }, key, enc.encode(text));
  return { iv: toB64(iv), ct: toB64(new Uint8Array(ct)) };
}

export async function decrypt(key: CryptoKey, { iv, ct }: Sealed, aad: string): Promise<string> {
  const pt = await subtle.decrypt(
    { name: "AES-GCM", iv: fromB64(iv), additionalData: enc.encode(aad) },
    key,
    fromB64(ct),
  );
  return dec.decode(pt);
}

// Joiner: a key pair whose public half goes to the server.
export async function newJoinKeyPair(): Promise<{ pub: string; priv: string }> {
  const pair = (await subtle.generateKey(ECDH, true, ["deriveBits"])) as CryptoKeyPair;
  return {
    pub: toB64(new Uint8Array((await subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer)),
    priv: toB64(new Uint8Array((await subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer)),
  };
}

// Existing member: wrap the room key for a joiner's public key.
export async function wrapRoomKey(roomKeyB64: string, joinerPubB64: string, aad: string): Promise<Grant> {
  const eph = (await subtle.generateKey(ECDH, true, ["deriveBits"])) as CryptoKeyPair;
  const joinerPub = await subtle.importKey("raw", fromB64(joinerPubB64), ECDH, false, []);
  const wrapKey = await deriveWrapKey(eph.privateKey, joinerPub, aad);
  const sealed = await encrypt(wrapKey, roomKeyB64, aad);
  const epk = toB64(new Uint8Array((await subtle.exportKey("raw", eph.publicKey)) as ArrayBuffer));
  return { epk, ...sealed };
}

// Joiner: open a wrapped room key with the private half kept in their link.
export async function unwrapRoomKey(privB64: string, { epk, iv, ct }: Grant, aad: string): Promise<string> {
  const priv = await subtle.importKey("pkcs8", fromB64(privB64), ECDH, false, ["deriveBits"]);
  const ephPub = await subtle.importKey("raw", fromB64(epk), ECDH, false, []);
  const wrapKey = await deriveWrapKey(priv, ephPub, aad);
  return decrypt(wrapKey, { iv, ct }, aad);
}

async function deriveWrapKey(priv: CryptoKey, pub: CryptoKey, aad: string): Promise<CryptoKey> {
  const shared = await subtle.deriveBits({ name: "ECDH", public: pub }, priv, 256);
  const hkdf = await subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  return subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: enc.encode(aad), info: enc.encode("sidechannel key wrap v1") },
    hkdf,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export function toB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64(b64: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}
