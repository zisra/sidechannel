// Everything needed to get back into a channel: the room, your member id and
// secret, and the room key (or, until it arrives, your private key for
// receiving it).
//
// It lives in this tab's sessionStorage and never in the URL, so it stays
// out of browser history and history sync. A reload keeps it; closing the
// tab drops it.
export type Creds = { roomId: string; memberId: string; secret: string; key?: string; priv?: string };

const STORAGE_KEY = "sidechannel:channel";

// Used when the browser blocks storage: the channel then survives
// navigation within the page, but not a reload.
let memory: Creds | null = null;

export function saveCreds(creds: Creds) {
  memory = { ...creds };
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(creds));
  } catch {}
}

export function loadCreds(): Creds | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw) return valid(JSON.parse(raw));
  } catch {}
  return memory;
}

export function clearCreds() {
  memory = null;
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {}
}

function valid(c: Partial<Creds> | null): Creds | null {
  const str = (v: unknown) => typeof v === "string" && v.length > 0;
  if (!c || !str(c.roomId) || !str(c.memberId) || !str(c.secret) || !(str(c.key) || str(c.priv))) return null;
  return c as Creds;
}
