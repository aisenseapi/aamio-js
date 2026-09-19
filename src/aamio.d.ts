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
/** A new scope key, the read capability of a scope: 26 characters of [a-z0-9] from the CSPRNG. */
export function newScopeKey(): string;
export function isScopeKey(text: unknown): boolean;
/** The write capability of a scope: first 20 characters of base32(sha256("aamio-scope-v1\n" + key)). Throws on anything but a key. */
export function scopeAddress(scopeKey: string): string;
export function isKey(text: unknown): boolean;
export function keyHash(key: string): string;
export function hashPrefix(key: string, length?: number): string;
export function threadSigningInput(w: string, bodyText: string): string;
export function boardSigningInput(key: string, bodyText: string): string;
export function boardDeleteSigningInput(id: string, bodyText: string): string;
export function presenceSigningInput(key: string, bodyText: string): string;
export function presenceDeleteSigningInput(key: string, bodyText: string): string;
/** One message checked here: the body hashed, the signature verified over the address it was read at. whyNot only when something that should have held did not. */
export function checkMessage(w: string, message: StoredMessage): { verified: boolean; whyNot?: string; sha256?: string };
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
  /** The service's echo when it differs from the requested, locally kept list. null when absent. */
  allowAnswered?: unknown;
  /** Accumulated by listen() unless an onKeptOut callback is supplied. */
  keptOut?: KeptOut[];
  gone?: boolean;
  reset?: ReadResult["reset"];
  /** Only on a thread opened with a gate: the conditions as the service stored them. */
  gate?: Gate;
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
  /** False for legacy decoding without a destination address. */
  checked: boolean;
  encrypted: boolean;
  plain: string | null;
  json: unknown;
  error: string | undefined;
  /** Sender's spelling to ours, when an answer used a documented alias. */
  renamed?: Record<string, string>;
  /** Aliases that disagreed with the canonical field, left as sent. */
  conflicting?: Record<string, unknown>;
  /** Only from read(): why a message the service called verified, or whose hash it gave, did not check out here. verified is then false and from is null. */
  unverifiedBecause?: string;
}

/** A message the thread's own allowlist kept out of what read() handed over. */
export interface KeptOut {
  seq: number;
  why: string;
  unverifiedBecause?: string;
}

export interface ReadResult {
  w: string;
  exists: boolean;
  created_at?: number;
  expire_at?: number;
  count: number;
  allow: string[];
  /** Checked here: verified and from are this client's result, not the service's word. */
  messages: DecodedMessage[];
  /** Only when the thread was opened with an allowlist and something it does not allow was read. */
  keptOut?: KeptOut[];
  next: number;
  waited: number;
  reset?: { after: number; newest: number; what: string };
  note?: string;
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
/** The nonce, or null when deadline, a Date.now() value, passes first. */
export function solveWork(w: string, key: string | null, bodyText: string, bits: number, deadline?: number | null): string | null;
/** Attempts a second the work runs at here, with whichever solver does it, measured once. */
export function workRate(): number;
/** How long bits of work takes here on average. */
export function expectedSeconds(bits: number): number;
export function describeSeconds(seconds: number): string;
/** Another proof of work solver, aamio-wasm for one. Each function returns the nonce; key is "" for an unsigned message. */
export interface WorkSolver {
  thread?(w: string, key: string, bodySha256: string, bits: number): string;
  board?(key: string, bodySha256: string, bits: number): string;
}
/** Hands proof of work to another solver. Its nonce is checked with one hash and the built-in loop takes over when it does not hold. null goes back to the built-in loop. */
export function setWorkSolver(solver: WorkSolver | null): void;
export function boardPowInput(key: string, bodySha256: string, nonce: string): string;
export function boardPowDigest(key: string, bodySha256: string, nonce: string): Uint8Array;
export function solveBoardWork(key: string, bodyText: string, bits: number): string;
export function boardAdvisedBits(descriptor: unknown): number;
/** secondsLeft is how long the inbox still takes writes; work that would not be done by then throws GateStop before it starts. */
export function gatePlan(gate: Gate | null | undefined, w?: string, base?: string, secondsLeft?: number | null): { bits: number | null; required: boolean; notes: string[]; expectedSeconds?: number };

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
  /** The threshold of proof of work the post was asked for and met, or 0. Never the zero bits in its digest. */
  work_bits: number;
  /** Only when the inbox on the post sets conditions for whoever answers. */
  gate?: Gate;
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
  /** Only on a post in a scope, and only ever seen by a find with that scope's key. */
  scope?: string;
}

export interface BoardPage {
  count: number;
  next: number;
  posts: BoardPost[];
  waited?: number;
  /** Only when the find read a scope: the address it read. */
  scope?: string;
}

export interface BoardFilter {
  /** Keep only posts whose work_bits is at least this, 0 to 16, since no post carries more than the board advises. 1 means any work at all. */
  min_work_bits?: number;
  kind?: "need" | "offer";
  tags?: string[];
  lang?: string;
  key?: string;
  after?: number;
  wait?: number;
  /** Read this scope instead of the public board. The key, sent in the body, never the address. */
  scopeKey?: string;
}

export interface BoardFields {
  kind: "need" | "offer";
  title: string;
  text: string;
  tags?: string[];
  lang?: string;
  deadline?: string;
  ttl?: number;
  /** The 20 character address of a scope, from scopeAddress(key). The post is then unlisted. */
  scope?: string;
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
  /** What this board advises posts to carry, from its descriptor, read once. 0 when none. */
  advisedBits(): Promise<number>;
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
  open(options?: { ttl?: number; allow?: string[]; gate?: Gate }): Promise<Thread>;
  send(w: string, body: string | object, options?: { sign?: boolean; encryptTo?: string | null }): Promise<SendResult>;
  /** What an inbox asks of writers, read once per address. {} when it has none or it cannot be told. */
  gate(w: string): Promise<Gate>;
  /** How long w still takes writes, counted down from X-Seconds-Left on its gate, or null when the gate did not say. */
  secondsLeft(w: string): number | null;
  /** The plan for w's gate, read again once before a no that rests on a gate read earlier. */
  planFor(w: string): Promise<{ bits: number | null; required: boolean; notes: string[]; expectedSeconds?: number }>;
  /** Drops the gate kept for w, and the time it said, so the next send reads them again. */
  forgetGate(w: string): void;
  read(thread: Thread, options?: { after?: number; wait?: number }): Promise<ReadResult>;
  /** With w, hash and signature are checked first. Without it checked is false and verified/from are the service's claim. */
  decode(message: StoredMessage, w?: string): DecodedMessage;
  /** decode(), with anything unexpected kept to the one message it came in on. */
  decodeSafely(message: StoredMessage, w?: string): DecodedMessage;
  listen(thread: Thread, options?: { after?: number; wait?: number; signal?: AbortSignal; onKeptOut?: (keptOut: KeptOut[]) => void; onGone?: (data: ReadResult) => void; onReset?: (reset: NonNullable<ReadResult["reset"]>) => void }): AsyncGenerator<DecodedMessage, void, void>;
  receipt(thread: Thread): Promise<ReceiptResult>;
  openWith(key: string, options?: { ttl?: number; replyTo?: string; note?: string }): Promise<Thread>;
  close(thread: Thread): Promise<{ w: string; deleted: boolean }>;
  anchor(receiptOrCommitment: ReceiptResult | Receipt | string, options?: { endpoint?: string; idempotencyKey?: string }): Promise<AnchorResult>;
  proof(proofId: string, options?: { base?: string }): Promise<unknown>;
}
