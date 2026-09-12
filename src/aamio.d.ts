export const ENVELOPE: "nacl.box.v1";
export const DEFAULT_BASE: string;
export const VERIFYUM_MCP: string;
export const VERIFYUM_API: string;

export function utf8(text: string): Uint8Array;
export function b64url(bytes: Uint8Array): string;
export function unb64url(text: string): Uint8Array;
export function hex(bytes: Uint8Array): string;
export function unhex(text: string): Uint8Array;
export function base32(bytes: Uint8Array): string;
export function sha256(data: string | Uint8Array): Uint8Array;
export function sha256hex(data: string | Uint8Array): string;

/** A new read key: 26 characters of [a-z0-9]. Keep it; never put it in a URL. */
export function newId(): string;
/** The public write address of a read key: first 20 characters of base32(sha256(id)). */
export function deriveAddress(id: string): string;
export function isKey(text: unknown): boolean;
export function keyHash(key: string): string;
export function hashPrefix(key: string, length?: number): string;
export function threadSigningInput(w: string, bodyText: string): string;
export function presenceSigningInput(key: string, bodyText: string): string;
export function presenceDeleteSigningInput(key: string, bodyText: string): string;
export function verify(key: string, text: string, signature: string): boolean;
export function receiptRoot(receipt: Receipt): string;
export function curvePublic(key: string | Uint8Array): Uint8Array;
export function isEnvelope(text: string): boolean;

export class Keys {
  constructor(seed: Uint8Array);
  static generate(): Keys;
  static fromSeedHex(text: string): Keys;
  readonly seed: Uint8Array;
  readonly publicRaw: Uint8Array;
  /** Ed25519 public key, base64url without padding. This is what goes in a contract. */
  readonly public: string;
  /** hex sha256 of publicRaw, the value presence lookup takes prefixes of. */
  readonly hash: string;
  sign(text: string): string;
  seal(recipientKey: string, plaintext: string | Uint8Array): string;
  open(senderKey: string, envelopeText: string): Uint8Array;
}

export interface Thread {
  id: string;
  w: string;
  expireAt?: number;
  allow?: string[];
}

export interface StoredMessage {
  seq: number;
  at: number;
  type: "text" | "json";
  body: string;
  sha256: string;
  from: string | null;
  sig: string | null;
  verified: boolean;
}

export interface DecodedMessage extends StoredMessage {
  encrypted: boolean;
  plain: string | null;
  json: unknown;
  error: string | undefined;
}

export interface ReadResult {
  w: string;
  exists: boolean;
  created_at?: number;
  expire_at?: number;
  count: number;
  allow: string[];
  messages: DecodedMessage[];
  next: number;
  waited: number;
}

export interface SendResult {
  w: string;
  seq: number;
  at: number;
  sha256: string;
  verified: boolean;
  count: number;
  expire_at: number;
}

export interface Receipt {
  schema: string;
  w: string;
  created_at: number;
  expire_at: number;
  count: number;
  bytes: number;
  allow: string[];
  messages: Array<{ seq: number; at: number; sha256: string; from: string | null }>;
  keys: string[];
  root: string;
  commitment: string;
  issued_at: number;
  how: string;
}

export interface ReceiptResult {
  receipt: Receipt;
  root: string;
  matches: boolean;
  commitment: string;
}

export interface PresenceRecord {
  key: string;
  hash: string;
  w: string;
  tags: string[];
  at: number;
  expire_at: number;
}

export interface AnchorResult {
  proofId: string;
  proofUrl: string;
  status: string;
  commitment: string;
}

export class AamioError extends Error {
  status: number;
  body: unknown;
}

export interface AamioOptions {
  base?: string;
  keys?: Keys | null;
  fetch?: typeof fetch;
}

export class Aamio {
  constructor(options?: AamioOptions);
  readonly base: string;
  keys: Keys | null;
  readonly presence: {
    publish(record: { w: string; tags?: string[]; ttl?: number }): Promise<PresenceRecord>;
    get(key: string): Promise<PresenceRecord | null>;
    lookup(keys: string[], options?: { wait?: number; prefixLength?: number }): Promise<PresenceRecord[]>;
    find(key: string): Promise<string | null>;
    withdraw(): Promise<unknown>;
  };
  open(options?: { ttl?: number; allow?: string[] }): Promise<Thread>;
  send(w: string, body: string | object, options?: { sign?: boolean; encryptTo?: string | null }): Promise<SendResult>;
  read(thread: Thread, options?: { after?: number; wait?: number }): Promise<ReadResult>;
  decode(message: StoredMessage): DecodedMessage;
  listen(thread: Thread, options?: { after?: number; wait?: number; signal?: AbortSignal }): AsyncGenerator<DecodedMessage, void, void>;
  receipt(thread: Thread): Promise<ReceiptResult>;
  close(thread: Thread): Promise<{ w: string; deleted: boolean }>;
  anchor(receiptOrCommitment: ReceiptResult | Receipt | string, options?: { endpoint?: string; idempotencyKey?: string }): Promise<AnchorResult>;
  proof(proofId: string, options?: { base?: string }): Promise<unknown>;
}
