import { Room } from "./room.ts";
import { Invite } from "./invite.ts";
import { randomId, sha256 } from "./util.ts";
import { MAX_PEOPLE, MIN_PEOPLE, type CreateRoomResponse, type JoinResponse } from "./shared/protocol.ts";

export { Room, Invite };

// Invite ids are 12 random bytes (96 bits): short enough to keep the link
// tidy, far too many to guess, and they only live until the room fills.
const INVITE_ID = /^[A-Za-z0-9_-]{16}$/;
// Raw uncompressed P-256 public key, base64url: 65 bytes -> 87 chars.
const PUBKEY = /^[A-Za-z0-9_-]{87}$/;

export default {
  async fetch(req, env) {
    const { pathname } = new URL(req.url);

    if (pathname === "/api/rooms" && req.method === "POST") return createRoom(req, env);
    if (pathname === "/api/join" && req.method === "POST") return joinRoom(req, env);

    const ws = pathname.match(/^\/api\/ws\/([A-Za-z0-9_-]{22})$/);
    if (ws) {
      if (req.headers.get("Upgrade") !== "websocket") return json({ error: "expected websocket" }, 426);
      return room(env, ws[1]).fetch(req);
    }

    return json({ error: "not found" }, 404);
  },
} satisfies ExportedHandler<Env>;

async function createRoom(req: Request, env: Env): Promise<Response> {
  const body = await readJson<{ capacity?: unknown }>(req);
  const capacity = Number(body?.capacity ?? MIN_PEOPLE);
  if (!Number.isInteger(capacity) || capacity < MIN_PEOPLE || capacity > MAX_PEOPLE) {
    return json({ error: `capacity must be ${MIN_PEOPLE}-${MAX_PEOPLE}` }, 400);
  }

  const roomId = randomId(16);
  const inviteId = randomId(12);
  const memberId = randomId(16);
  const secret = randomId(24);

  await room(env, roomId).init({
    roomId,
    capacity,
    inviteId,
    creator: { id: memberId, secretHash: await sha256(secret) },
  });
  await invite(env, inviteId).init(roomId);

  return json({ roomId, inviteId, memberId, secret } satisfies CreateRoomResponse);
}

async function joinRoom(req: Request, env: Env): Promise<Response> {
  const body = await readJson<{ inviteId?: unknown; pub?: unknown }>(req);
  const inviteId = typeof body?.inviteId === "string" ? body.inviteId : "";
  const pub = typeof body?.pub === "string" ? body.pub : "";
  if (!INVITE_ID.test(inviteId) || !PUBKEY.test(pub)) return expired();

  const roomId = await invite(env, inviteId).lookup();
  if (!roomId) return expired();

  const member = await room(env, roomId).join(pub);
  if (!member) return expired();

  return json({ roomId, ...member } satisfies JoinResponse);
}

function room(env: Env, roomId: string) {
  const ns = env.ROOMS as DurableObjectNamespace<Room>;
  return ns.get(ns.idFromName(roomId));
}

function invite(env: Env, inviteId: string) {
  const ns = env.INVITES as DurableObjectNamespace<Invite>;
  return ns.get(ns.idFromName(inviteId));
}

// Same answer for "never existed", "used up" and "room ended", so an old
// link says nothing about whether the channel is still going.
function expired(): Response {
  return json({ error: "expired" }, 410);
}

async function readJson<T>(req: Request): Promise<T | null> {
  try {
    return await req.json<T>();
  } catch {
    return null;
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
