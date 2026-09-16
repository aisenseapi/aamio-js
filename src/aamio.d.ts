export const ENVELOPE: "nacl.box.v1";
/** The default lifetime of a board post and the floor for a reply inbox. */
export const BOARD_TTL: 1800;
export const DEFAULT_BASE: string;
export const DEFAULT_BOARD: string;
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
export function boardSigningInput(key: string, bodyText: string): string;
export function boardDeleteSigningInput(id: string, bodyText: string): string;
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
  /** Sender's spelling to ours, when an answer used a documented alias. */
  renamed?: Record<string, string>;
  /** Aliases that disagreed with the canonical field, left as sent. */
  conflicting?: Record<string, unknown>;
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
  sealed?: boolean;
  count: number;
  expire_at: number;
  /** Only from an inbox with a gate: pow is the threshold of work met, or 0. */
  met?: { pow?: number };
  /** Only from an inbox with a gate: the digest of the work this message brought, or null. */
  proof_id?: string | null;
  /** What the client passed over although the message went out, such as advice it does not know. */
  notes?: string[];
}

/** The conditions an inbox sets for writers, in the canonical form GET /{w}/gate answers. */
export interface Gate {
  require?: { pow?: { bits: number; covers: number }; per_key?: number; write_until?: number; [condition: string]: unknown };
  advise?: { pow?: { bits: number; covers: number }; [condition: string]: unknown };
  [bucket: string]: unknown;
}

export const POW_REQUIRE_MAX_BITS: number;
export const POW_ADVISE_MAX_BITS: number;

/** The inbox asks for something this client cannot or will not do, so nothing was sent. */
export class GateStop extends Error {
  reason: string;
  fix: string;
}

export function powInput(w: string, key: string | null, bodySha256: string, nonce: string): string;
export function powDigest(w: string, key: string | null, bodySha256: string, nonce: string): Uint8Array;
export function zeroBits(digest: Uint8Array): number;
export function solveWork(w: string, key: string | null, bodyText: string, bits: number): string;
export function gatePlan(gate: Gate | null | undefined, w?: string): { bits: number | null; required: boolean; notes: string[] };

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

export interface BoardPost {
  id: string;
  seq: number;
  kind: "need" | "offer";
  title: string;
  text: string;
  tags: string[];
  w: string;
  deadline: string | null;
  lang: string | null;
  key: string;
  at: number;
  expire_at: number;
  sha256: string;
}

export interface BoardPage {
  count: number;
  next: number;
  posts: BoardPost[];
  waited?: number;
}

export interface BoardFilter {
  kind?: "need" | "offer";
  tags?: string[];
  lang?: string;
  key?: string;
  after?: number;
  wait?: number;
}

export interface BoardFields {
  kind: "need" | "offer";
  title: string;
  text: string;
  tags?: string[];
  lang?: string;
  deadline?: string;
  ttl?: number;
}

export interface TagBranch {
  tag: string;
  live: number;
  need: number;
  offer: number;
  children: Array<{ tag: string; live: number; need: number; offer: number }>;
}

export interface TagTree {
  built_at: number;
  live: number;
  tags: TagBranch[];
  untagged: { live: number; need: number; offer: number };
}

export interface BoardAnswer extends SendResult {
  inbox: Thread;
  post: string;
  /** Present when the post answered is your own, which seals it to yourself. */
  warning?: string;
}

export interface Board {
  inbox(seconds?: number): Promise<Thread>;
  post(fields: BoardFields, options?: { inbox?: Thread }): Promise<{ post: BoardPost; inbox: Thread }>;
  find(filter?: BoardFilter): Promise<BoardPage>;
  watch(filter?: BoardFilter, options?: { wait?: number; signal?: AbortSignal }): AsyncGenerator<BoardPost, void, void>;
  get(id: string): Promise<BoardPost | null>;
  tags(): Promise<TagTree>;
  withdraw(id: string): Promise<{ id: string; deleted: boolean }>;
  answer(post: BoardPost, body: string | object, options?: { inbox?: Thread; ttl?: number }): Promise<BoardAnswer>;
  replies(messages: DecodedMessage[], postId: string): DecodedMessage[];
}

export interface AamioOptions {
  base?: string;
  board?: string;
  keys?: Keys | null;
  fetch?: typeof fetch;
}

export class Aamio {
  constructor(options?: AamioOptions);
  readonly base: string;
  keys: Keys | null;
  readonly board: Board;
  boardInbox: Thread | null;
  /** Gates read so far, by write address. */
  readonly gates: Map<string, Gate>;
  readonly presence: {
    publish(record: { w: string; tags?: string[]; ttl?: number }): Promise<PresenceRecord>;
    get(key: string): Promise<PresenceRecord | null>;
    lookup(keys: string[], options?: { wait?: number; prefixLength?: number }): Promise<PresenceRecord[]>;
    find(key: string): Promise<string | null>;
    withdraw(): Promise<unknown>;
  };
  open(options?: { ttl?: number; allow?: string[] }): Promise<Thread>;
  send(w: string, body: string | object, options?: { sign?: boolean; encryptTo?: string | null }): Promise<SendResult>;
  /** What an inbox asks of writers, read once per address. {} when it has none or it cannot be told. */
  gate(w: string): Promise<Gate>;
  read(thread: Thread, options?: { after?: number; wait?: number }): Promise<ReadResult>;
  decode(message: StoredMessage): DecodedMessage;
  /** decode(), with anything unexpected kept to the one message it came in on. */
  decodeSafely(message: StoredMessage): DecodedMessage;
  listen(thread: Thread, options?: { after?: number; wait?: number; signal?: AbortSignal }): AsyncGenerator<DecodedMessage, void, void>;
  receipt(thread: Thread): Promise<ReceiptResult>;
  openWith(key: string, options?: { ttl?: number; replyTo?: string; note?: string }): Promise<Thread>;
  close(thread: Thread): Promise<{ w: string; deleted: boolean }>;
  anchor(receiptOrCommitment: ReceiptResult | Receipt | string, options?: { endpoint?: string; idempotencyKey?: string }): Promise<AnchorResult>;
  proof(proofId: string, options?: { base?: string }): Promise<unknown>;
}
