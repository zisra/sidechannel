// Runs the real worker under `wrangler dev` and drives it like two browsers.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import * as e2e from "../src/shared/crypto.ts";
import type { CreateRoomResponse, JoinResponse, ServerMessage } from "../src/shared/protocol.ts";

const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
let server: ChildProcess;

before(async () => {
  server = spawn("npx", ["wrangler", "dev", "--port", String(PORT), "--ip", "127.0.0.1"], {
    stdio: "ignore",
    detached: true,
  });
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(BASE + "/")).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("wrangler dev did not start");
});

after(() => process.kill(-server.pid!));

const post = (path: string, body: unknown) =>
  fetch(BASE + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

type Keys = { room?: string; priv?: string };
type Of<T extends ServerMessage["type"]> = Extract<ServerMessage, { type: T }>;
type Waiter = { match: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void };

// A minimal client that does what the browser app does with keys.
async function connect(roomId: string, memberId: string, secret: string, keys: Keys) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/ws/${roomId}`);
  const inbox: ServerMessage[] = [];
  const waiters: Waiter[] = [];

  ws.onmessage = async ({ data }) => {
    const msg: ServerMessage = JSON.parse(data);
    if (msg.type === "need_key" && keys.room) {
      const grant = await e2e.wrapRoomKey(keys.room, msg.pub, `${roomId}|${msg.id}`);
      ws.send(JSON.stringify({ type: "grant", to: msg.id, ...grant }));
    }
    const grant = msg.type === "grant" ? msg : msg.type === "welcome" ? msg.grant : null;
    if (grant && !keys.room) {
      keys.room = await e2e.unwrapRoomKey(keys.priv!, grant, `${roomId}|${memberId}`);
      ws.send(JSON.stringify({ type: "have_key" }));
    }
    inbox.push(msg);
    for (const w of [...waiters]) {
      if (w.match(msg)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(msg);
      }
    }
  };

  // Resolves with the first message of `type` (already received or upcoming) passing `where`.
  function next<T extends ServerMessage["type"]>(type: T, where: (m: Of<T>) => boolean = () => true) {
    const match = (m: ServerMessage) => m.type === type && where(m as Of<T>);
    return new Promise<Of<T>>((resolve, reject) => {
      const hit = inbox.find(match);
      if (hit) return resolve(hit as Of<T>);
      waiters.push({ match, resolve: resolve as (m: ServerMessage) => void });
      setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), 5000);
    });
  }

  await new Promise((r) => (ws.onopen = r));
  ws.send(JSON.stringify({ type: "auth", memberId, secret }));
  return { ws, keys, next, inbox };
}

async function createRoom(capacity = 2) {
  const res = await post("/api/rooms", { capacity });
  assert.equal(res.status, 200);
  return { ...((await res.json()) as CreateRoomResponse), roomKey: e2e.newRoomKey() };
}

async function join(inviteId: string) {
  const pair = await e2e.newJoinKeyPair();
  const res = await post("/api/join", { inviteId, pub: pair.pub });
  return { status: res.status, pair, body: res.status === 200 ? ((await res.json()) as JoinResponse) : null };
}

async function joinOk(inviteId: string) {
  const j = await join(inviteId);
  assert.equal(j.status, 200);
  return { pair: j.pair, ...j.body! };
}

const allHaveKey = (m: Of<"presence">) => m.members.every((x) => x.hasKey);

test("invite burns once the room is full", async () => {
  const room = await createRoom(2);
  const first = await joinOk(room.inviteId);
  assert.equal(first.roomId, room.roomId);
  assert.equal((await join(room.inviteId)).status, 410);
});

test("invite stays open until capacity is reached", async () => {
  const room = await createRoom(3);
  await joinOk(room.inviteId);
  await joinOk(room.inviteId);
  assert.equal((await join(room.inviteId)).status, 410);
});

test("unknown invites and bad capacities are rejected", async () => {
  assert.equal((await join("A".repeat(16))).status, 410);
  assert.equal((await post("/api/rooms", { capacity: 1 })).status, 400);
  assert.equal((await post("/api/rooms", { capacity: 11 })).status, 400);
});

test("key exchange, encrypted chat and catch-up", async () => {
  const room = await createRoom(2);
  const creator = await connect(room.roomId, room.memberId, room.secret, { room: room.roomKey });
  await creator.next("welcome");

  const j = await joinOk(room.inviteId);
  const joiner = await connect(j.roomId, j.memberId, j.secret, { priv: j.pair.priv });
  await joiner.next("welcome");
  await creator.next("presence", allHaveKey);
  assert.equal(joiner.keys.room, room.roomKey);

  const key = await e2e.importRoomKey(room.roomKey);
  const sealed = await e2e.encrypt(key, JSON.stringify({ text: "hello there" }), room.roomId);
  creator.ws.send(JSON.stringify({ type: "msg", cid: "c1", ...sealed }));
  const got = await joiner.next("msg");
  assert.ok(!got.ct.includes("hello"));
  assert.equal(JSON.parse(await e2e.decrypt(key, got, room.roomId)).text, "hello there");

  // Reconnecting picks up what was said.
  joiner.ws.close();
  const again = await connect(j.roomId, j.memberId, j.secret, { room: joiner.keys.room });
  const welcome = await again.next("welcome");
  assert.equal(welcome.backlog.length, 1);
  assert.equal(welcome.invite, null);

  creator.ws.close();
  again.ws.close();
});

test("joiner gets the key even if they connect while the creator is away", async () => {
  const room = await createRoom(2);
  const j = await joinOk(room.inviteId);
  const joiner = await connect(j.roomId, j.memberId, j.secret, { priv: j.pair.priv });
  await joiner.next("welcome");
  assert.equal(joiner.keys.room, undefined);

  const creator = await connect(room.roomId, room.memberId, room.secret, { room: room.roomKey });
  await joiner.next("grant");
  await creator.next("presence", allHaveKey);
  assert.equal(joiner.keys.room, room.roomKey);

  creator.ws.close();
  joiner.ws.close();
});

test("ending a room wipes it for everyone", async () => {
  const room = await createRoom(3);
  const creator = await connect(room.roomId, room.memberId, room.secret, { room: room.roomKey });
  await creator.next("welcome");
  const j = await joinOk(room.inviteId);
  const joiner = await connect(j.roomId, j.memberId, j.secret, { priv: j.pair.priv });
  await joiner.next("welcome");

  creator.ws.send(JSON.stringify({ type: "end" }));
  await creator.next("gone");
  await joiner.next("gone");

  const back = await connect(room.roomId, room.memberId, room.secret, { room: room.roomKey });
  await back.next("gone");
  assert.equal((await join(room.inviteId)).status, 410);
});

test("typing is relayed to the others only", async () => {
  const room = await createRoom(2);
  const creator = await connect(room.roomId, room.memberId, room.secret, { room: room.roomKey });
  await creator.next("welcome");
  const j = await joinOk(room.inviteId);
  const joiner = await connect(j.roomId, j.memberId, j.secret, { priv: j.pair.priv });
  await joiner.next("welcome");

  creator.ws.send(JSON.stringify({ type: "typing" }));
  const typing = await joiner.next("typing");
  assert.equal(typing.id, room.memberId);
  await assert.rejects(creator.next("typing"));

  creator.ws.close();
  joiner.ws.close();
});

async function pair() {
  const room = await createRoom(2);
  const creator = await connect(room.roomId, room.memberId, room.secret, { room: room.roomKey });
  await creator.next("welcome");
  const j = await joinOk(room.inviteId);
  const joiner = await connect(j.roomId, j.memberId, j.secret, { priv: j.pair.priv });
  await joiner.next("welcome");
  await creator.next("presence", allHaveKey);
  const key = await e2e.importRoomKey(room.roomKey);
  const seal = (text: string) => e2e.encrypt(key, JSON.stringify({ text }), room.roomId);
  return { room, creator, joiner, key, seal, close: () => (creator.ws.close(), joiner.ws.close()) };
}

test("a resent message is confirmed, not posted twice", async () => {
  const { creator, joiner, seal, close } = await pair();
  const sealed = await seal("once");
  creator.ws.send(JSON.stringify({ type: "msg", cid: "same", ...sealed }));
  creator.ws.send(JSON.stringify({ type: "msg", cid: "same", ...sealed }));
  creator.ws.send(JSON.stringify({ type: "msg", cid: "after", ...(await seal("after")) }));
  await joiner.next("msg", (m) => m.cid === "after");
  const copies = (inbox: ServerMessage[]) => inbox.filter((m) => m.type === "msg" && m.cid === "same").length;
  assert.equal(copies(joiner.inbox), 1);
  // The sender gets a confirmation for each attempt, so it can stop retrying.
  assert.equal(copies(creator.inbox), 2);
  close();
});

test("only the sender can edit or unsend, and others see it", async () => {
  const { creator, joiner, key, seal, room, close } = await pair();
  creator.ws.send(JSON.stringify({ type: "msg", cid: "m1", ...(await seal("first")) }));
  const sent = await joiner.next("msg", (m) => m.cid === "m1");

  // The joiner can't touch someone else's message.
  joiner.ws.send(JSON.stringify({ type: "unsend", seq: sent.seq }));
  creator.ws.send(JSON.stringify({ type: "edit", seq: sent.seq, ...(await seal("second")) }));
  const edit = await joiner.next("edit");
  assert.equal(JSON.parse(await e2e.decrypt(key, edit, room.roomId)).text, "second");

  creator.ws.send(JSON.stringify({ type: "unsend", seq: sent.seq }));
  const gone = await joiner.next("unsend");
  assert.equal(gone.seq, sent.seq);
  close();
});

test("clearing deletes the history for everyone", async () => {
  const { room, creator, joiner, seal, close } = await pair();
  creator.ws.send(JSON.stringify({ type: "msg", cid: "a", ...(await seal("one")) }));
  creator.ws.send(JSON.stringify({ type: "msg", cid: "b", ...(await seal("two")) }));
  await joiner.next("msg", (m) => m.cid === "b");

  joiner.ws.send(JSON.stringify({ type: "clear" }));
  await creator.next("clear");
  await joiner.next("clear");

  const again = await connect(room.roomId, room.memberId, room.secret, { room: room.roomKey });
  assert.equal((await again.next("welcome")).backlog.length, 0);
  again.ws.close();
  close();
});

test("nobody can send until everyone has joined", async () => {
  const room = await createRoom(3);
  const creator = await connect(room.roomId, room.memberId, room.secret, { room: room.roomKey });
  await creator.next("welcome");
  const key = await e2e.importRoomKey(room.roomKey);
  const seal = (text: string) => e2e.encrypt(key, JSON.stringify({ text }), room.roomId);

  await joinOk(room.inviteId);
  creator.ws.send(JSON.stringify({ type: "msg", cid: "early", ...(await seal("too early")) }));
  await joinOk(room.inviteId);
  await creator.next("presence", (m) => m.invite === null);
  creator.ws.send(JSON.stringify({ type: "msg", cid: "ok", ...(await seal("now")) }));
  await creator.next("msg", (m) => m.cid === "ok");
  assert.equal(creator.inbox.filter((m) => m.type === "msg" && m.cid === "early").length, 0);
  creator.ws.close();
});

test("a wrong secret is turned away", async () => {
  const room = await createRoom(2);
  const intruder = await connect(room.roomId, room.memberId, "wrong", {});
  await intruder.next("gone");
});
