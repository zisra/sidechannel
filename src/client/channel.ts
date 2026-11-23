import { decrypt, encrypt, importRoomKey, unwrapRoomKey, wrapRoomKey } from "../shared/crypto.ts";
import type { ClientMessage, Grant, MemberInfo, Payload, RoomState, Sealed, ServerMessage, StoredMessage } from "../shared/protocol.ts";
import { IDLE_MINUTES } from "../shared/protocol.ts";
import { copyText, h, icon, logo, mount, toast, type IconName } from "./dom.ts";
import { saveCreds, type Creds } from "./creds.ts";
import { renderMarkdown } from "./markdown.ts";
import { people, type Person } from "./names.ts";

export function inviteUrl(inviteId: string): string {
  return `${location.origin}/j#${inviteId}`;
}

const MAX_LENGTH = 4000;
const GROUP_WINDOW = 5 * 60 * 1000;
// The socket is pinged this often; with no traffic for STALE_AFTER it's
// treated as dead and replaced, rather than waiting for the browser to notice.
const PING_EVERY = 10_000;
const STALE_AFTER = 25_000;
const RETRY_DELAYS = [500, 1000, 2000, 4000, 8000];
const TYPING_SEND_EVERY = 2500;
const TYPING_SHOW_FOR = 4000;
const NOTIFY_KEY = "sidechannel:notify";

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const fullFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

type Msg = {
  kind: "msg";
  // Null until the server confirms it; until then `sealed` is kept for resending.
  seq: number | null;
  cid?: string;
  from: string;
  ts: number;
  text: string | null;
  reply?: number;
  edited: boolean;
  ct?: string;
  sealed?: Sealed;
  el?: HTMLElement;
};
type Note = { kind: "system"; text: string; locked: boolean; el?: HTMLElement };
type Entry = Msg | Note;
type Mode = { kind: "none" } | { kind: "edit"; msg: Msg } | { kind: "reply"; msg: Msg };

// Opens a channel view and returns a function that tears it down.
export function openChannel(creds: Creds, onGone: () => void): () => void {
  let ws: WebSocket | null = null;
  let key: CryptoKey | null = null;
  let connected = false;
  let online = navigator.onLine;
  let disposed = false;
  let attempts = 0;
  let lastHeard = 0;
  let pingTimer = 0;
  let retryTimer = 0;
  let queue = Promise.resolve();

  let state: RoomState | null = null;
  let names = new Map<string, Person>();
  const known = new Set<string>();
  const entries: Entry[] = [];
  const bySeq = new Map<number, Msg>();
  const byCid = new Map<string, Msg>();
  const waitingForKey: StoredMessage[] = [];
  let mode: Mode = { kind: "none" };
  let renderedInvite: string | null = null;
  let unread = 0;
  const typing = new Map<string, number>();

  // Layout

  const lockBadge = h("span", { class: "badge", hidden: true, title: "Channel locked" }, icon("lock"), h("span", { class: "badge-text" }, "locked"));
  const bellButton = h("button", { class: "icon-btn", type: "button" });
  const peopleButton = h("button", { class: "people-btn", type: "button", "aria-haspopup": "true", "aria-expanded": "false" });
  const peopleMenu = h("div", { class: "popover people-menu", hidden: true });
  const clearButton = h("button", { class: "btn btn-ghost btn-sm danger-btn", type: "button" }, "clear");
  const endButton = h("button", { class: "btn btn-ghost btn-sm danger-btn", type: "button" }, "end");
  const inviteSlot = h("div", { class: "invite-slot" });
  const log = h("div", { class: "log", role: "log", "aria-live": "polite" });
  const actionMenu = h("div", { class: "popover action-menu", role: "menu", hidden: true });
  const status = h("div", { class: "status", hidden: true });
  const typingLine = h("div", { class: "typing", "aria-live": "polite" });
  const jumpButton = h("button", { class: "jump-btn", type: "button", hidden: true }, "new messages", icon("down"));
  const modeLabel = h("span", { class: "mode-label" });
  const modeBar = h(
    "div",
    { class: "mode-bar", hidden: true },
    modeLabel,
    h("button", { class: "icon-btn sm", type: "button", "aria-label": "Cancel", onclick: () => setMode({ kind: "none" }) }, icon("close")),
  );
  const input = h("textarea", { class: "composer-input", rows: 1, maxlength: MAX_LENGTH, placeholder: "Message", "aria-label": "Message" });
  const sendButton = h("button", { class: "send-btn", type: "submit", "aria-label": "Send" }, icon("send"));
  const composer = h("form", { class: "composer" }, input, sendButton);

  const view = h(
    "div",
    { class: "page channel" },
    h(
      "header",
      { class: "bar" },
      h("div", { class: "bar-left" }, h("span", { class: "wordmark" }, logo(), h("span", { class: "wordmark-text" }, "sidechannel")), lockBadge),
      h("div", { class: "bar-right" }, bellButton, h("div", { class: "people" }, peopleButton, peopleMenu), clearButton, endButton),
    ),
    h("div", { class: "scroller" }, h("div", { class: "column" }, inviteSlot, log)),
    h("div", { class: "dock" }, h("div", { class: "column" }, jumpButton, status, modeBar, composer, typingLine)),
    actionMenu,
  );
  const scroller = view.querySelector<HTMLElement>(".scroller")!;
  mount(view);

  const touch = matchMedia("(pointer: coarse)").matches;
  const nearBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
  const toBottom = () => {
    scroller.scrollTop = scroller.scrollHeight;
    jumpButton.hidden = true;
  };
  jumpButton.addEventListener("click", toBottom);
  scroller.addEventListener(
    "scroll",
    () => {
      if (nearBottom()) jumpButton.hidden = true;
      closeActions();
    },
    { passive: true },
  );

  // Header controls

  // Both act for everyone, so each asks once more before doing it.
  confirmable(endButton, "end", "end for everyone?", () => send({ type: "end" }));
  confirmable(clearButton, "clear", "clear for everyone?", () => {
    if (connected) send({ type: "clear" });
    else toast("You're offline. Try again once you're reconnected");
  });

  // A click anywhere else, or Escape, backs out of the confirm right away.
  // On click rather than pointerdown: the label shrinking mid-press would
  // shift the header and make that same click miss its target.
  function confirmable(button: HTMLButtonElement, label: string, ask: string, run: () => void) {
    let armed = 0;
    const onOutside = (e: Event) => {
      if (!button.contains(e.target as Node)) disarm();
    };
    const onEscape = (e: KeyboardEvent) => e.key === "Escape" && disarm();
    button.addEventListener("click", () => {
      if (armed) {
        disarm();
        return run();
      }
      button.textContent = ask;
      button.classList.add("armed");
      armed = window.setTimeout(disarm, 3000);
      document.addEventListener("click", onOutside, true);
      document.addEventListener("keydown", onEscape);
    });
    function disarm() {
      clearTimeout(armed);
      armed = 0;
      button.textContent = label;
      button.classList.remove("armed");
      document.removeEventListener("click", onOutside, true);
      document.removeEventListener("keydown", onEscape);
    }
  }

  peopleButton.addEventListener("click", (e) => {
    e.stopPropagation();
    setMenu(peopleMenu.hidden !== false);
  });
  peopleMenu.addEventListener("click", (e) => e.stopPropagation());
  function setMenu(open: boolean) {
    peopleMenu.hidden = !open;
    peopleButton.setAttribute("aria-expanded", String(open));
  }

  // Notifications only ever say who wrote, never what: system notifications
  // can linger on screen and in the notification history.
  const canNotify = "Notification" in window;
  let notifyOn = canNotify && readPref() && Notification.permission === "granted";
  bellButton.hidden = !canNotify;
  renderBell();
  bellButton.addEventListener("click", async () => {
    if (notifyOn) {
      notifyOn = false;
    } else {
      const permission = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
      notifyOn = permission === "granted";
      if (!notifyOn) toast("Notifications are blocked in your browser settings");
    }
    writePref(notifyOn);
    renderBell();
  });
  function renderBell() {
    bellButton.replaceChildren(icon(notifyOn ? "bell" : "bellOff"));
    bellButton.classList.toggle("on", notifyOn);
    const label = notifyOn ? "Notifications on" : "Notifications off";
    bellButton.setAttribute("aria-label", label);
    bellButton.title = `${label} for background tabs`;
  }
  function notify(from: string) {
    if (!notifyOn || !document.hidden || Notification.permission !== "granted") return;
    const n = new Notification("sidechannel", { body: `${names.get(from)?.name ?? "Someone"} sent a message`, tag: creds.roomId });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  }

  // Composer

  input.addEventListener("keydown", (e) => {
    if (e.isComposing) return;
    // On phones Enter adds a line and the button sends; on desktop Enter sends.
    if (e.key === "Enter" && !e.shiftKey && !touch) {
      e.preventDefault();
      composer.requestSubmit();
      return;
    }
    if (e.key === "Escape" && mode.kind !== "none") {
      e.preventDefault();
      setMode({ kind: "none" });
      return;
    }
    // Up in an empty box edits your last message.
    if (e.key === "ArrowUp" && input.value === "" && mode.kind === "none") {
      const last = [...entries].reverse().find((m): m is Msg => m.kind === "msg" && m.from === creds.memberId && m.seq !== null);
      if (last) {
        e.preventDefault();
        startEdit(last);
      }
      return;
    }
    // Cmd/Ctrl+B, I, E and Shift+X wrap the selection in markdown.
    const k = e.key.toLowerCase();
    if ((e.metaKey || e.ctrlKey) && !e.altKey && SHORTCUTS[k] && e.shiftKey === (k === "x")) {
      e.preventDefault();
      wrapSelection(SHORTCUTS[k]);
    }
  });

  let lastTypingSent = 0;
  input.addEventListener("input", () => {
    autosize();
    const hasText = input.value.trim() !== "";
    composer.classList.toggle("has-text", hasText);
    if (hasText && mode.kind !== "edit" && Date.now() - lastTypingSent > TYPING_SEND_EVERY) {
      lastTypingSent = Date.now();
      send({ type: "typing" });
    }
  });

  composer.addEventListener("submit", (e) => {
    e.preventDefault();
    void submit();
  });

  function wrapSelection(marker: string) {
    const { selectionStart: start, selectionEnd: end, value } = input;
    const n = marker.length;
    const wrapped = value.slice(start - n, start) === marker && value.slice(end, end + n) === marker;
    if (wrapped) {
      input.setSelectionRange(start - n, end + n);
      replaceSelection(value.slice(start, end));
      input.setSelectionRange(start - n, end - n);
    } else {
      replaceSelection(marker + value.slice(start, end) + marker);
      input.setSelectionRange(start + n, end + n);
    }
  }

  // execCommand keeps the edit on the browser's undo stack; setRangeText is
  // the fallback where it isn't supported.
  function replaceSelection(text: string) {
    if (!document.execCommand("insertText", false, text)) {
      input.setRangeText(text, input.selectionStart, input.selectionEnd, "end");
      input.dispatchEvent(new Event("input"));
    }
  }

  function setInput(text: string) {
    input.value = text;
    composer.classList.toggle("has-text", text.trim() !== "");
    autosize();
  }

  function setMode(next: Mode) {
    const wasEditing = mode.kind === "edit";
    mode = next;
    modeBar.hidden = next.kind === "none";
    if (next.kind === "edit") {
      modeLabel.replaceChildren(icon("edit"), "editing message", h("span", { class: "hint" }, "esc to cancel"));
    } else if (next.kind === "reply") {
      modeLabel.replaceChildren(icon("reply"), "replying to ", h("b", {}, nameOf(next.msg.from)), h("span", { class: "hint" }, snippet(next.msg.text)));
    }
    if (wasEditing && next.kind !== "edit") setInput("");
    input.focus();
  }

  function startEdit(msg: Msg) {
    setMode({ kind: "edit", msg });
    setInput(msg.text ?? "");
    input.setSelectionRange(input.value.length, input.value.length);
  }

  async function submit() {
    const text = input.value.trim();
    if (!key || !state || state.invite !== null) return;
    if (mode.kind === "edit") {
      const msg = mode.msg;
      setMode({ kind: "none" });
      if (!text) return unsend(msg);
      if (text !== msg.text) await edit(msg, text);
      return;
    }
    if (!text) return;
    const reply = mode.kind === "reply" ? (mode.msg.seq ?? undefined) : undefined;
    setMode({ kind: "none" });
    setInput("");
    const payload: Payload = { text, reply };
    const msg: Msg = {
      kind: "msg",
      seq: null,
      cid: crypto.randomUUID(),
      from: creds.memberId,
      ts: Date.now(),
      text,
      reply,
      edited: false,
      sealed: await encrypt(key, JSON.stringify(payload), creds.roomId),
    };
    byCid.set(msg.cid!, msg);
    append(msg);
    toBottom();
    transmit(msg);
  }

  // Sends now if connected; otherwise it goes out with the rest of the
  // unconfirmed messages as soon as the connection is back.
  function transmit(msg: Msg) {
    if (connected && msg.sealed) send({ type: "msg", cid: msg.cid!, ...msg.sealed });
  }

  async function edit(msg: Msg, text: string) {
    if (msg.seq === null || !key) return;
    if (!connected) return void toast("You're offline. Try again once you're reconnected");
    const payload: Payload = { text, reply: msg.reply };
    const sealed = await encrypt(key, JSON.stringify(payload), creds.roomId);
    send({ type: "edit", seq: msg.seq, ...sealed });
    msg.text = text;
    msg.ct = sealed.ct;
    msg.edited = true;
    refresh(msg);
  }

  function unsend(msg: Msg) {
    if (msg.seq === null) return;
    if (!connected) return void toast("You're offline. Try again once you're reconnected");
    send({ type: "unsend", seq: msg.seq });
    remove(msg);
  }

  // Message actions: the ⋯ button, a right-click, or the quick icons shown
  // while Shift is held over a message.

  type Action = { icon: IconName; label: string; run: () => void; danger?: boolean };

  function actionsFor(msg: Msg): Action[] {
    const out: Action[] = [];
    const sent = msg.seq !== null;
    if (sent) out.push({ icon: "reply", label: "Reply", run: () => setMode({ kind: "reply", msg }) });
    if (msg.text !== null) {
      out.push({ icon: "copy", label: "Copy text", run: async () => (await copyText(msg.text!)) && toast("Copied") });
    }
    if (msg.from === creds.memberId && sent && connected) {
      out.push({ icon: "edit", label: "Edit", run: () => startEdit(msg) });
      out.push({ icon: "trash", label: "Unsend", run: () => unsend(msg), danger: true });
    }
    return out;
  }

  function openActions(msg: Msg, x: number, y: number) {
    const actions = actionsFor(msg);
    if (!actions.length) return;
    actionMenu.replaceChildren(
      ...actions.map((a) => {
        const item = h("button", { class: `menu-item ${a.danger ? "danger" : ""}`, type: "button", role: "menuitem" }, icon(a.icon), a.label);
        item.addEventListener("click", (e) => {
          e.stopPropagation();
          // Unsend can't be undone, so it asks once more in place.
          if (a.danger && !item.classList.contains("armed")) {
            item.classList.add("armed");
            item.replaceChildren(icon(a.icon), "Click again to unsend");
            return;
          }
          closeActions();
          a.run();
        });
        return item;
      }),
    );
    actionMenu.hidden = false;
    msg.el?.classList.add("active");
    actionMenu.dataset.for = String(entries.indexOf(msg));
    const { width, height } = actionMenu.getBoundingClientRect();
    actionMenu.style.left = `${Math.max(8, Math.min(x, innerWidth - width - 8))}px`;
    actionMenu.style.top = `${Math.max(8, Math.min(y, innerHeight - height - 8))}px`;
  }

  function closeActions() {
    if (actionMenu.hidden) return;
    actionMenu.hidden = true;
    log.querySelector(".msg.active")?.classList.remove("active");
  }
  actionMenu.addEventListener("click", (e) => e.stopPropagation());

  const onDocClick = () => {
    setMenu(false);
    closeActions();
  };
  document.addEventListener("click", onDocClick);

  // Holding Shift swaps the ⋯ button for the actions themselves.
  const setShift = (on: boolean) => view.classList.toggle("shift", on);
  const onKeyUp = (e: KeyboardEvent) => e.key === "Shift" && setShift(false);
  const onBlur = () => setShift(false);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);

  // Keyboard anywhere on the page

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Shift") return setShift(true);
    if (e.key === "Escape") {
      setMenu(false);
      closeActions();
      return;
    }
    const target = e.target as HTMLElement;
    const inField = !!target.closest("input, textarea, select, [contenteditable]");
    // Cmd+A outside the message box selects the conversation, not the page.
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a" && !inField) {
      e.preventDefault();
      const range = document.createRange();
      range.selectNodeContents(log);
      getSelection()?.removeAllRanges();
      getSelection()?.addRange(range);
      return;
    }
    // Typing anywhere goes into the message box. Focusing during keydown makes
    // the browser deliver that same keystroke (or paste) to the box.
    if (input.disabled || inField || e.altKey || e.isComposing) return;
    const paste = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "v";
    const printable = e.key.length === 1 && !e.metaKey && !e.ctrlKey;
    if (!paste && !printable) return;
    // Space on a focused button presses it; leave that alone.
    if (e.key === " " && target.closest("button, a")) return;
    input.focus();
  };
  document.addEventListener("keydown", onKey);

  const onVisible = () => {
    if (document.hidden) return;
    unread = 0;
    document.title = "sidechannel";
    if (!connected) reconnectNow();
  };
  document.addEventListener("visibilitychange", onVisible);

  const onOnline = () => {
    online = true;
    reconnectNow();
  };
  const onOffline = () => {
    online = false;
    render();
  };
  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);

  // Connection

  void (async () => {
    if (creds.key) key = await importRoomKey(creds.key);
    connect();
  })();
  render();

  function connect() {
    if (disposed) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${proto}://${location.host}/api/ws/${creds.roomId}`);
    ws = socket;
    socket.onopen = () => {
      lastHeard = Date.now();
      send({ type: "auth", memberId: creds.memberId, secret: creds.secret });
      clearInterval(pingTimer);
      pingTimer = window.setInterval(() => {
        if (Date.now() - lastHeard > STALE_AFTER) return dropped(socket);
        if (socket.readyState === WebSocket.OPEN) socket.send("ping");
      }, PING_EVERY);
    };
    socket.onmessage = ({ data }) => {
      lastHeard = Date.now();
      if (data === "pong") return;
      let msg: ServerMessage;
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }
      // Handlers are async (crypto), so run them strictly in order.
      queue = queue.then(() => handle(msg)).catch((err) => console.error(err));
    };
    socket.onclose = () => dropped(socket);
  }

  function dropped(socket: WebSocket) {
    if (ws !== socket || disposed) return;
    socket.onclose = null;
    try {
      socket.close();
    } catch {}
    ws = null;
    connected = false;
    clearInterval(pingTimer);
    render();
    clearTimeout(retryTimer);
    retryTimer = window.setTimeout(connect, RETRY_DELAYS[Math.min(attempts++, RETRY_DELAYS.length - 1)]);
  }

  function reconnectNow() {
    if (disposed || connected) return;
    clearTimeout(retryTimer);
    attempts = 0;
    if (ws) dropped(ws);
    clearTimeout(retryTimer);
    connect();
  }

  function send(msg: ClientMessage) {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  async function handle(msg: ServerMessage) {
    switch (msg.type) {
      case "welcome": {
        connected = true;
        attempts = 0;
        applyState(msg, state === null);
        if (msg.grant && !key) await acceptGrant(msg.grant);
        await catchUp(msg.backlog);
        render();
        return;
      }
      case "presence":
        applyState(msg, false);
        render();
        return;
      case "msg":
        return receive(msg);
      case "edit":
        return receiveEdit(msg.seq, msg);
      case "unsend": {
        const target = bySeq.get(msg.seq);
        if (target) remove(target);
        return;
      }
      case "clear":
        return clearAll();
      case "need_key":
        if (creds.key) {
          const grant = await wrapRoomKey(creds.key, msg.pub, `${creds.roomId}|${msg.id}`);
          send({ type: "grant", to: msg.id, ...grant });
        }
        return;
      case "grant":
        if (!key) await acceptGrant(msg);
        return;
      case "typing":
        return setTyping(msg.id, true);
      case "gone":
        return gone();
    }
  }

  // After (re)connecting: apply anything that changed while away, then send
  // whatever of ours the server hasn't confirmed yet.
  async function catchUp(backlog: StoredMessage[]) {
    if (!key) {
      waitingForKey.push(...backlog);
      return;
    }
    const present = new Set(backlog.map((m) => m.seq));
    const oldest = backlog[0]?.seq;
    for (const m of [...bySeq.values()]) {
      // Missing from the backlog means it was unsent while we were away,
      // unless it's just older than what the server keeps.
      if (!present.has(m.seq!) && (oldest === undefined || m.seq! > oldest)) remove(m);
    }
    for (const m of backlog) {
      const existing = bySeq.get(m.seq);
      if (existing) {
        if (existing.ct !== m.ct) await receiveEdit(m.seq, m);
      } else {
        await receive(m);
      }
    }
    for (const m of byCid.values()) if (m.seq === null) transmit(m);
    render();
  }

  async function acceptGrant(grant: Grant) {
    if (!creds.priv) return;
    try {
      creds.key = await unwrapRoomKey(creds.priv, grant, `${creds.roomId}|${creds.memberId}`);
    } catch {
      status.textContent = "Couldn't unlock this channel. Ask for a new invite.";
      return;
    }
    delete creds.priv;
    key = await importRoomKey(creds.key);
    // Keep the room key for this tab, so a reload still works.
    saveCreds(creds);
    send({ type: "have_key" });
    await catchUp(waitingForKey.splice(0));
  }

  async function unseal(m: Sealed): Promise<Payload | null> {
    try {
      const payload: Payload = JSON.parse(await decrypt(key!, m, creds.roomId));
      return { text: String(payload.text).slice(0, MAX_LENGTH), reply: Number.isInteger(payload.reply) ? payload.reply : undefined };
    } catch {
      return null;
    }
  }

  async function receive(m: StoredMessage) {
    if (bySeq.has(m.seq)) return;
    if (!key) {
      waitingForKey.push(m);
      return;
    }
    // Our own message coming back: it's confirmed now.
    const mine = m.cid ? byCid.get(m.cid) : undefined;
    if (mine && mine.from === m.from) {
      byCid.delete(m.cid!);
      mine.seq = m.seq;
      mine.ct = m.ct;
      delete mine.sealed;
      bySeq.set(m.seq, mine);
      refresh(mine);
      return;
    }

    const payload = await unseal(m);
    const msg: Msg = { kind: "msg", seq: m.seq, from: m.from, ts: m.ts, text: payload?.text ?? null, reply: payload?.reply, edited: !!m.edited, ct: m.ct };
    bySeq.set(m.seq, msg);
    const stick = nearBottom();
    append(msg);
    if (stick) toBottom();
    else jumpButton.hidden = false;
    setTyping(m.from, false);
    if (m.from !== creds.memberId && document.hidden) {
      unread++;
      document.title = `(${unread}) sidechannel`;
      notify(m.from);
    }
  }

  async function receiveEdit(seq: number, m: Sealed) {
    const msg = bySeq.get(seq);
    if (!msg || !key) return;
    const payload = await unseal(m);
    msg.text = payload?.text ?? null;
    msg.ct = m.ct;
    msg.edited = true;
    refresh(msg);
  }

  function applyState(next: RoomState, first: boolean) {
    const prev = state;
    state = next;
    names = people(next.members);
    for (const m of next.members) {
      if (!known.has(m.id) && !first && m.id !== creds.memberId) note(`${names.get(m.id)!.name} joined`);
      known.add(m.id);
    }
    if (prev?.invite && !next.invite) note("channel locked", true);
  }

  function gone() {
    disposed = true;
    onGone();
  }

  function setTyping(id: string, on: boolean) {
    clearTimeout(typing.get(id));
    if (on) typing.set(id, window.setTimeout(() => setTyping(id, false), TYPING_SHOW_FOR));
    else typing.delete(id);
    const who = [...typing.keys()].map(nameOf);
    typingLine.textContent =
      who.length === 0 ? "" : who.length === 1 ? `${who[0]} is typing…` : who.length === 2 ? `${who[0]} and ${who[1]} are typing…` : "several people are typing…";
  }

  // The log: entries render to rows; edits redraw one row, removals redraw
  // the log so grouping stays right.

  function append(entry: Entry) {
    const prev = entries[entries.length - 1];
    entries.push(entry);
    entry.el = row(entry, prev);
    log.append(entry.el);
  }

  function note(text: string, locked = false) {
    append({ kind: "system", text, locked });
    toBottom();
  }

  function refresh(msg: Msg) {
    const i = entries.indexOf(msg);
    if (i < 0 || !msg.el) return;
    const el = row(msg, entries[i - 1]);
    msg.el.replaceWith(el);
    msg.el = el;
  }

  function remove(msg: Msg) {
    const i = entries.indexOf(msg);
    if (i < 0) return;
    entries.splice(i, 1);
    if (msg.seq !== null) bySeq.delete(msg.seq);
    if (msg.cid) byCid.delete(msg.cid);
    if (mode.kind !== "none" && mode.msg === msg) setMode({ kind: "none" });
    const top = scroller.scrollTop;
    const stick = nearBottom();
    log.replaceChildren(...entries.map((e, j) => (e.el = row(e, entries[j - 1]))));
    if (stick) toBottom();
    else scroller.scrollTop = top;
  }

  // Clear for everyone: the messages blur away from the newest up, then the
  // log is rebuilt without them. Ours that haven't reached the server yet stay.
  async function clearAll() {
    const going = entries.filter((e): e is Msg => e.kind === "msg" && e.seq !== null);
    if (mode.kind !== "none" && going.includes(mode.msg)) setMode({ kind: "none" });
    closeActions();
    const rows = going.map((m) => m.el).filter((el): el is HTMLElement => !!el).reverse();
    if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const step = Math.min(40, 600 / Math.max(rows.length, 1));
      await Promise.all(
        rows.map(
          (el, i) =>
            el.animate(
              [
                { opacity: 1, filter: "blur(0)", transform: "none" },
                { opacity: 0, filter: "blur(6px)", transform: "translateY(-8px) scale(0.98)" },
              ],
              { duration: 320, delay: i * step, easing: "cubic-bezier(.4,0,.2,1)", fill: "forwards" },
            ).finished,
        ),
      );
    }
    for (const m of going) {
      bySeq.delete(m.seq!);
      entries.splice(entries.indexOf(m), 1);
    }
    for (let i = entries.length - 1; i >= 0; i--) if (entries[i].kind === "system") entries.splice(i, 1);
    log.replaceChildren(...entries.map((e, j) => (e.el = row(e, entries[j - 1]))));
    note("chat cleared");
  }

  function row(entry: Entry, prev: Entry | undefined): HTMLElement {
    if (entry.kind === "system") {
      return h("div", { class: `system ${entry.locked ? "locked" : ""}` }, entry.locked ? icon("lock") : null, entry.text);
    }
    const msg = entry;
    const mine = msg.from === creds.memberId;
    const followUp = prev?.kind === "msg" && prev.from === msg.from && msg.ts - prev.ts < GROUP_WINDOW && msg.reply === undefined;
    const when = { datetime: new Date(msg.ts).toISOString(), title: fullFormat.format(msg.ts) };

    const content = h("div", { class: "content" });
    if (msg.text === null) content.append(h("em", { class: "muted" }, "couldn't decrypt this message"));
    else {
      content.innerHTML = renderMarkdown(msg.text);
      decorateCode(content);
    }
    if (msg.edited) (content.lastElementChild ?? content).append(h("span", { class: "edited", title: "edited" }, " (edited)"));

    const pendingNote =
      msg.seq === null ? h("div", { class: "msg-status" }, connected && online ? "sending…" : "not sent yet · will send when you're back online") : null;

    const body = h(
      "div",
      { class: "body" },
      msg.reply !== undefined ? replyRef(msg.reply) : null,
      followUp
        ? null
        : h(
            "div",
            { class: "meta" },
            h("span", { class: "name", style: `--c:${names.get(msg.from)?.color ?? "gray"}` }, nameOf(msg.from)),
            mine ? h("span", { class: "you-tag" }, "you") : null,
            h("time", when, timeFormat.format(msg.ts)),
          ),
      content,
      pendingNote,
    );

    const dots = h("button", { class: "icon-btn sm dots", type: "button", "aria-label": "Message actions" }, icon("dots"));
    dots.addEventListener("click", (e) => {
      e.stopPropagation();
      const r = dots.getBoundingClientRect();
      openActions(msg, r.right - 180, r.bottom + 4);
    });
    const quick = h(
      "div",
      { class: "quick" },
      ...actionsFor(msg).map((a) => {
        const b = h("button", { class: `icon-btn sm ${a.danger ? "danger" : ""}`, type: "button", "aria-label": a.label, title: a.label }, icon(a.icon));
        b.addEventListener("click", (e) => {
          e.stopPropagation();
          a.run();
        });
        return b;
      }),
    );

    const el = h(
      "div",
      { class: `msg ${followUp ? "cont" : ""} ${msg.seq === null ? "pending" : ""}` },
      followUp ? h("time", { class: "gutter-time", ...when }, timeFormat.format(msg.ts).replace(/\s?[AP]M$/i, "")) : avatar(msg.from, "md"),
      body,
      h("div", { class: "msg-actions" }, dots, quick),
    );
    el.addEventListener("contextmenu", (e) => {
      // Keep the browser's own menu when there's selected text to copy.
      const sel = getSelection();
      if (sel && !sel.isCollapsed && el.contains(sel.anchorNode)) return;
      e.preventDefault();
      openActions(msg, e.clientX, e.clientY);
    });
    return el;
  }

  function replyRef(seq: number) {
    const target = bySeq.get(seq);
    const ref = h(
      "button",
      { class: "reply-ref", type: "button" },
      icon("reply"),
      target ? h("b", {}, nameOf(target.from)) : null,
      h("span", {}, target ? snippet(target.text) : "original message unavailable"),
    );
    ref.addEventListener("click", () => {
      const el = bySeq.get(seq)?.el;
      if (!el) return;
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      el.classList.remove("flash");
      void el.offsetWidth;
      el.classList.add("flash");
    });
    return ref;
  }

  // Code blocks get their language and a copy button.
  function decorateCode(content: HTMLElement) {
    for (const pre of content.querySelectorAll("pre")) {
      const code = pre.querySelector("code");
      const lang = code?.className.match(/language-(\S+)/)?.[1] ?? "";
      const copy = h("button", { class: "icon-btn sm", type: "button", "aria-label": "Copy code" }, icon("copy"));
      copy.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (await copyText(code?.textContent ?? "")) toast("Code copied");
      });
      const block = h("div", { class: "codeblock" }, h("div", { class: "code-head" }, h("span", {}, lang || "code"), copy));
      pre.replaceWith(block);
      block.append(pre);
    }
  }

  // Header, invite and status

  function render() {
    if (disposed) return;
    renderPeople();
    renderInvite();
    lockBadge.hidden = !state || state.invite !== null;

    let text = "";
    if (!online) text = "you're offline · messages will send when you're back";
    else if (!connected) text = state ? "connection lost · reconnecting…" : "connecting…";
    else if (!key) text = "waiting for someone in the channel to share the key…";
    status.hidden = !text;
    status.replaceChildren(!online ? icon("offline") : h("span", { class: "spinner" }), text);

    // Nobody can write until everyone has joined and the invite is gone, so
    // messages and the invite link are never on screen together.
    const waiting = !state || state.invite !== null;
    const usable = !!key && !waiting;
    const ready = connected && usable;
    const unlocked = input.disabled && usable;
    // Typing (and queueing) stays possible while disconnected.
    input.disabled = !usable;
    sendButton.disabled = !usable;
    composer.classList.toggle("disabled", !ready);
    input.placeholder =
      state && waiting ? `waiting for everyone to join · ${state.members.length}/${state.capacity}` : "Message";
    for (const m of entries) if (m.kind === "msg" && m.seq === null) refresh(m);
    // Ready to type as soon as the channel locks. Not on phones, where it
    // would pop the keyboard up unasked.
    if (unlocked && !touch) input.focus();
  }

  function renderPeople() {
    const members = state?.members ?? [];
    const here = members.filter((m) => m.online).length;
    peopleButton.replaceChildren(
      h("span", { class: "stack" }, ...members.slice(0, 4).map((m) => avatar(m.id, "sm", m.online))),
      h("span", { class: "count" }, `${here}`, h("span", { class: "of" }, `/${state?.capacity ?? "-"}`)),
    );
    peopleButton.setAttribute("aria-label", `${here} of ${members.length} people here`);
    peopleMenu.replaceChildren(
      ...members.map((m) =>
        h(
          "div",
          { class: "menu-row" },
          avatar(m.id, "sm", m.online),
          h("span", { class: "menu-name" }, nameOf(m.id), m.id === creds.memberId ? h("span", { class: "you" }, " (you)") : null),
          h("span", { class: `presence ${m.online ? "on" : ""}` }, m.online ? "online" : "away"),
        ),
      ),
      h("div", { class: "menu-foot" }, `deleted ${IDLE_MINUTES} min after everyone leaves`),
    );
  }

  function avatar(id: string, size: "sm" | "md", isOnline = true) {
    const p = names.get(id);
    const self = id === creds.memberId;
    return h(
      "span",
      { class: `avatar ${size} ${isOnline ? "" : "away"}`, style: `--c:${p?.color ?? "gray"}`, title: self ? `${p?.name} (you)` : p?.name },
      p?.initials ?? "",
    );
  }

  function renderInvite() {
    const invite = state?.invite ?? null;
    const joined = state?.members.length ?? 0;
    if (!invite) {
      inviteSlot.replaceChildren();
      renderedInvite = null;
      return;
    }
    const counter = inviteSlot.querySelector(".invite-count");
    if (invite === renderedInvite && counter) {
      counter.textContent = `${joined}/${state!.capacity} joined`;
      return;
    }
    renderedInvite = invite;
    const url = inviteUrl(invite);
    const copy = h("button", { class: "btn btn-secondary btn-sm", type: "button" }, icon("copy"), "copy");
    copy.addEventListener("click", async () => {
      if (await copyText(url)) toast("Invite link copied");
      else prompt("Copy this invite link", url);
    });
    inviteSlot.replaceChildren(
      h(
        "section",
        { class: "invite" },
        h("div", { class: "invite-head" }, h("span", {}, "invite link"), h("span", { class: "invite-count" }, `${joined}/${state!.capacity} joined`)),
        h("div", { class: "invite-row" }, h("code", { class: "invite-url" }, url.replace(/^https?:\/\//, "")), copy),
      ),
    );
  }

  function nameOf(id: string) {
    return names.get(id)?.name ?? "someone";
  }

  function autosize() {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
  }

  return () => {
    disposed = true;
    clearInterval(pingTimer);
    clearTimeout(retryTimer);
    for (const t of typing.values()) clearTimeout(t);
    document.removeEventListener("click", onDocClick);
    document.removeEventListener("keydown", onKey);
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("keyup", onKeyUp);
    window.removeEventListener("blur", onBlur);
    window.removeEventListener("online", onOnline);
    window.removeEventListener("offline", onOffline);
    ws?.close();
  };
}

const SHORTCUTS: Record<string, string> = { b: "**", i: "*", e: "`", x: "~~" };

function snippet(text: string | null): string {
  if (text === null) return "message";
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 80 ? `${flat.slice(0, 80)}…` : flat;
}

function readPref(): boolean {
  try {
    return localStorage.getItem(NOTIFY_KEY) === "on";
  } catch {
    return false;
  }
}

function writePref(on: boolean) {
  try {
    localStorage.setItem(NOTIFY_KEY, on ? "on" : "off");
  } catch {}
}
