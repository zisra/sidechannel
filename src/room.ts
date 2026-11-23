import { DurableObject } from "cloudflare:workers";
import { randomId, sha256 } from "./util.ts";
import type { ClientMessage, Grant, RoomState, ServerMessage, StoredMessage } from "./shared/protocol.ts";
import { IDLE_MINUTES } from "./shared/protocol.ts";
import type { Invite } from "./invite.ts";

const IDLE_TIMEOUT = IDLE_MINUTES * 60 * 1000;
const MAX_LIFETIME = 24 * 60 * 60 * 1000;
const MAX_BACKLOG = 500;
const MAX_FRAME = 64 * 1024;
const RESEND_WINDOW = 50;

// `inviteId` is cleared the moment the room fills: from then on nothing on
// the server connects this room to the invite link that was shared.
type Meta = { roomId: string; capacity: number; inviteId: string | null; createdAt: number; seq: number };
type Member = { id: string; n: number; secretHash: string; pub: string | null; hasKey: boolean; grant: Grant | null };
type Session = { id: string };

// One channel. The server only ever sees ciphertext: it relays messages,
// keeps them (encrypted) so people can catch up after a reconnect, and wipes
// everything when the channel ends.
//
// Storage keys:
//   meta          Meta
//   m:<memberId>  Member
//   msg:<seq>     StoredMessage
export class Room extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Keepalives are answered without waking the object up.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  // RPC from the worker

  async init(init: { roomId: string; capacity: number; inviteId: string; creator: { id: string; secretHash: string } }) {
    const now = Date.now();
    const { creator } = init;
    await this.ctx.storage.put<Meta | Member>({
      meta: { roomId: init.roomId, capacity: init.capacity, inviteId: init.inviteId, createdAt: now, seq: 0 },
      [`m:${creator.id}`]: { id: creator.id, n: 1, secretHash: creator.secretHash, pub: null, hasKey: true, grant: null },
    });
    await this.ctx.storage.setAlarm(now + IDLE_TIMEOUT);
  }

  async join(pub: string): Promise<{ memberId: string; secret: string } | null> {
    const meta = await this.meta();
    if (!meta?.inviteId) return null;

    const members = await this.members();
    if (members.length >= meta.capacity) return null;

    const id = randomId(16);
    const secret = randomId(24);
    const member: Member = { id, n: members.length + 1, secretHash: await sha256(secret), pub, hasKey: false, grant: null };
    await this.ctx.storage.put(`m:${id}`, member);

    if (member.n >= meta.capacity) {
      const inviteId = meta.inviteId;
      meta.inviteId = null;
      await this.ctx.storage.put("meta", meta);
      await this.burnInvite(inviteId);
    }

    this.broadcast({ type: "presence", ...this.roomState(meta, [...members, member]) });
    // Anyone online who holds the key can hand it over right away,
    // even before the new person has connected.
    this.requestKeyFor(member);
    return { memberId: id, secret };
  }

  // WebSockets

  async fetch(): Promise<Response> {
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    if (!(await this.meta())) gone(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    if (typeof raw !== "string" || raw.length > MAX_FRAME) return;
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    const session = ws.deserializeAttachment() as Session | null;
    if (!session) return this.authenticate(ws, msg);

    const me = await this.ctx.storage.get<Member>(`m:${session.id}`);
    if (!me) return gone(ws);

    switch (msg.type) {
      case "msg":
        return this.relayMessage(ws, me, msg);
      case "edit":
        return this.editMessage(me, msg);
      case "unsend":
        return this.unsendMessage(me, msg);
      case "clear":
        return this.clearMessages();
      case "grant":
        return this.relayGrant(me, msg);
      case "have_key":
        return this.markHasKey(me);
      case "typing":
        if ((await this.meta())?.inviteId) return;
        return this.broadcast({ type: "typing", id: me.id }, ws);
      case "end":
        return this.end();
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string) {
    try {
      ws.close(code, reason);
    } catch {}
    await this.afterDisconnect(ws);
  }

  async webSocketError(ws: WebSocket) {
    await this.afterDisconnect(ws);
  }

  private async afterDisconnect(closed: WebSocket) {
    const meta = await this.meta();
    if (!meta) return;
    if (this.sockets().filter((ws) => ws !== closed).length === 0) {
      await this.ctx.storage.setAlarm(Math.min(Date.now() + IDLE_TIMEOUT, meta.createdAt + MAX_LIFETIME));
    }
    this.broadcast({ type: "presence", ...this.roomState(meta, await this.members(), closed) }, closed);
  }

  async alarm() {
    const meta = await this.meta();
    if (!meta) return;
    const expired = Date.now() >= meta.createdAt + MAX_LIFETIME;
    if (expired || this.sockets().length === 0) return this.end();
    // Someone reconnected right as the idle timer fired.
    await this.ctx.storage.setAlarm(meta.createdAt + MAX_LIFETIME);
  }

  // Handlers

  private async authenticate(ws: WebSocket, msg: ClientMessage) {
    const meta = await this.meta();
    if (!meta || msg.type !== "auth" || typeof msg.memberId !== "string") return gone(ws);
    const me = await this.ctx.storage.get<Member>(`m:${msg.memberId}`);
    if (!me || me.secretHash !== (await sha256(String(msg.secret)))) return gone(ws);

    ws.serializeAttachment({ id: me.id } satisfies Session);
    await this.ctx.storage.setAlarm(meta.createdAt + MAX_LIFETIME);

    const members = await this.members();
    const backlog = [...(await this.ctx.storage.list<StoredMessage>({ prefix: "msg:" })).values()];
    send(ws, { type: "welcome", you: me.id, grant: me.hasKey ? null : me.grant, backlog, ...this.roomState(meta, members) });
    this.broadcast({ type: "presence", ...this.roomState(meta, members) }, ws);

    if (!me.hasKey && !me.grant) this.requestKeyFor(me);
    if (me.hasKey) {
      for (const m of members) {
        if (!m.hasKey && !m.grant && m.pub) send(ws, { type: "need_key", id: m.id, pub: m.pub });
      }
    }
  }

  private async relayMessage(ws: WebSocket, me: Member, { cid, iv, ct }: Extract<ClientMessage, { type: "msg" }>) {
    if (typeof iv !== "string" || typeof ct !== "string" || typeof cid !== "string" || cid.length > 64) return;

    // A client resends whatever it hasn't seen confirmed after reconnecting.
    // If it already arrived, just confirm it again to the sender.
    const recent = await this.ctx.storage.list<StoredMessage>({ prefix: "msg:", reverse: true, limit: RESEND_WINDOW });
    const dupe = [...recent.values()].find((m) => m.cid === cid && m.from === me.id);
    if (dupe) return send(ws, { type: "msg", ...dupe });

    const meta = (await this.meta())!;
    // Nobody talks until everyone's in, so a screenshot of messages can
    // never also show the invite link that was shared.
    if (meta.inviteId) return;
    const entry: StoredMessage = { seq: ++meta.seq, from: me.id, ts: Date.now(), cid, iv, ct };
    await this.ctx.storage.put<Meta | StoredMessage>({ meta, [`msg:${pad(entry.seq)}`]: entry });
    if (entry.seq > MAX_BACKLOG) await this.ctx.storage.delete(`msg:${pad(entry.seq - MAX_BACKLOG)}`);
    this.broadcast({ type: "msg", ...entry });
  }

  private async editMessage(me: Member, { seq, iv, ct }: Extract<ClientMessage, { type: "edit" }>) {
    if (!Number.isInteger(seq) || typeof iv !== "string" || typeof ct !== "string") return;
    const key = `msg:${pad(seq)}`;
    const entry = await this.ctx.storage.get<StoredMessage>(key);
    if (!entry || entry.from !== me.id) return;
    await this.ctx.storage.put(key, { ...entry, iv, ct, edited: true });
    this.broadcast({ type: "edit", seq, iv, ct });
  }

  private async unsendMessage(me: Member, { seq }: Extract<ClientMessage, { type: "unsend" }>) {
    if (!Number.isInteger(seq)) return;
    const key = `msg:${pad(seq)}`;
    const entry = await this.ctx.storage.get<StoredMessage>(key);
    if (!entry || entry.from !== me.id) return;
    await this.ctx.storage.delete(key);
    this.broadcast({ type: "unsend", seq });
  }

  private async relayGrant(me: Member, { to, epk, iv, ct }: Extract<ClientMessage, { type: "grant" }>) {
    if (!me.hasKey || typeof to !== "string") return;
    const target = await this.ctx.storage.get<Member>(`m:${to}`);
    // First grant wins; later ones from other members are ignored.
    if (!target || target.hasKey || target.grant) return;
    target.grant = { epk, iv, ct };
    await this.ctx.storage.put(`m:${to}`, target);
    for (const ws of this.socketsOf(to)) send(ws, { type: "grant", ...target.grant });
  }

  // Anyone in the channel can clear it for everyone, like ending it.
  private async clearMessages() {
    const keys = [...(await this.ctx.storage.list({ prefix: "msg:" })).keys()];
    // storage.delete takes at most 128 keys at a time.
    for (let i = 0; i < keys.length; i += 128) await this.ctx.storage.delete(keys.slice(i, i + 128));
    this.broadcast({ type: "clear" });
  }

  private async markHasKey(me: Member) {
    if (me.hasKey) return;
    me.hasKey = true;
    me.grant = null;
    await this.ctx.storage.put(`m:${me.id}`, me);
    this.broadcast({ type: "presence", ...this.roomState((await this.meta())!, await this.members()) });
  }

  private async end() {
    const meta = await this.meta();
    for (const ws of this.ctx.getWebSockets()) gone(ws);
    if (meta?.inviteId) await this.burnInvite(meta.inviteId);
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  // Helpers

  private meta() {
    return this.ctx.storage.get<Meta>("meta");
  }

  private async members(): Promise<Member[]> {
    return [...(await this.ctx.storage.list<Member>({ prefix: "m:" })).values()].sort((a, b) => a.n - b.n);
  }

  // Authenticated sockets only.
  private sockets(): WebSocket[] {
    return this.ctx.getWebSockets().filter((ws) => ws.deserializeAttachment());
  }

  private socketsOf(memberId: string): WebSocket[] {
    return this.sockets().filter((ws) => session(ws).id === memberId);
  }

  private roomState(meta: Meta, members: Member[], closing?: WebSocket): RoomState {
    const online = new Set(
      this.sockets()
        .filter((ws) => ws !== closing)
        .map((ws) => session(ws).id),
    );
    return {
      capacity: meta.capacity,
      invite: meta.inviteId,
      members: members.map((m) => ({ id: m.id, n: m.n, online: online.has(m.id), hasKey: m.hasKey })),
    };
  }

  private requestKeyFor(member: Member) {
    if (!member.pub) return;
    for (const ws of this.sockets()) {
      if (session(ws).id !== member.id) send(ws, { type: "need_key", id: member.id, pub: member.pub });
    }
  }

  private broadcast(msg: ServerMessage, except?: WebSocket) {
    for (const ws of this.sockets()) if (ws !== except) send(ws, msg);
  }

  private async burnInvite(inviteId: string) {
    const ns = this.env.INVITES as DurableObjectNamespace<Invite>;
    await ns.get(ns.idFromName(inviteId)).burn();
  }
}

function session(ws: WebSocket): Session {
  return ws.deserializeAttachment() as Session;
}

function send(ws: WebSocket, msg: ServerMessage) {
  try {
    ws.send(JSON.stringify(msg));
  } catch {}
}

function gone(ws: WebSocket) {
  send(ws, { type: "gone" });
  try {
    ws.close(4404, "gone");
  } catch {}
}

function pad(n: number): string {
  return String(n).padStart(10, "0");
}
