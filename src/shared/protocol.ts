// Messages exchanged between the browser and a Room over its WebSocket.
// Everything readable stays in the browser: `iv`/`ct` pairs are AES-GCM
// ciphertext the server can only pass along.

export type Sealed = { iv: string; ct: string };
export type Grant = Sealed & { epk: string };

export type MemberInfo = { id: string; n: number; online: boolean; hasKey: boolean };

export type RoomState = {
  capacity: number;
  // Present while people can still join.
  invite: string | null;
  members: MemberInfo[];
};

// `cid` is the sender's own id for the message, so a resend after a dropped
// connection can be recognised instead of posted twice.
export type StoredMessage = Sealed & { seq: number; from: string; ts: number; cid?: string; edited?: boolean };

export type ServerMessage =
  | ({ type: "welcome"; you: string; grant: Grant | null; backlog: StoredMessage[] } & RoomState)
  | ({ type: "presence" } & RoomState)
  | ({ type: "msg" } & StoredMessage)
  | ({ type: "edit"; seq: number } & Sealed)
  // Removed by its sender. Clients drop it without a trace.
  | { type: "unsend"; seq: number }
  // Every message so far was deleted.
  | { type: "clear" }
  | { type: "need_key"; id: string; pub: string }
  | ({ type: "grant" } & Grant)
  // Someone is typing. Relayed live, never stored.
  | { type: "typing"; id: string }
  | { type: "gone" };

export type ClientMessage =
  | { type: "auth"; memberId: string; secret: string }
  | ({ type: "msg"; cid: string } & Sealed)
  | ({ type: "edit"; seq: number } & Sealed)
  | { type: "unsend"; seq: number }
  | { type: "clear" }
  | ({ type: "grant"; to: string } & Grant)
  | { type: "have_key" }
  | { type: "typing" }
  | { type: "end" };

// Plaintext inside a message's ciphertext.
export type Payload = { text: string; reply?: number };

export type CreateRoomResponse = { roomId: string; inviteId: string; memberId: string; secret: string };
export type JoinResponse = { roomId: string; memberId: string; secret: string };

export const MIN_PEOPLE = 2;
export const MAX_PEOPLE = 10;
export const IDLE_MINUTES = 30;
