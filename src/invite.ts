import { DurableObject } from "cloudflare:workers";

// Unused invites clean themselves up after a day even if the room never fills.
const INVITE_LIFETIME = 24 * 60 * 60 * 1000;

// Maps an invite id to its room. Kept separate from the room so the invite
// link and the personal links share nothing visible.
export class Invite extends DurableObject<Env> {
  async init(roomId: string): Promise<void> {
    await this.ctx.storage.put("room", roomId);
    await this.ctx.storage.setAlarm(Date.now() + INVITE_LIFETIME);
  }

  async lookup(): Promise<string | null> {
    return (await this.ctx.storage.get<string>("room")) ?? null;
  }

  async burn(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}
