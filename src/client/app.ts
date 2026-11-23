import { newJoinKeyPair, newRoomKey } from "../shared/crypto.ts";
import { IDLE_MINUTES, MAX_PEOPLE, MIN_PEOPLE, type CreateRoomResponse, type JoinResponse } from "../shared/protocol.ts";
import { inviteUrl, openChannel } from "./channel.ts";
import { clearCreds, loadCreds, saveCreds } from "./creds.ts";
import { copyText, h, icon, logo, mount, toast } from "./dom.ts";

let teardown: (() => void) | null = null;

function route() {
  teardown?.();
  teardown = null;
  const path = location.pathname.replace(/\/+$/, "") || "/";
  const hash = location.hash.slice(1);

  if (path === "/j") return hash ? invite(hash) : expired();
  if (path === "/c") {
    // The address bar only ever shows /c; the channel's secrets live in this
    // tab's session storage (see creds.ts).
    if (hash) history.replaceState(null, "", "/c");
    const creds = loadCreds();
    if (!creds) return notOpen();
    teardown = openChannel(creds, () => {
      teardown?.();
      teardown = null;
      clearCreds();
      ended();
    });
    return;
  }
  if (path !== "/") history.replaceState(null, "", "/");
  home();
}

function go(url: string, replace = false) {
  history[replace ? "replaceState" : "pushState"](null, "", url);
  route();
}

window.addEventListener("popstate", route);
// A different channel or invite link pasted into this tab.
window.addEventListener("hashchange", () => location.pathname !== "/" && route());

function topbar() {
  return h("header", { class: "bar" }, h("a", { class: "wordmark", href: "/" }, logo(), "sidechannel"));
}

// Home: pick how many people, make a channel, invite link lands on the clipboard.

function home() {
  let capacity = MIN_PEOPLE;
  const value = h("output", { class: "stepper-value", "aria-live": "polite" }, String(capacity));
  const minus = h("button", { class: "stepper-btn", type: "button", "aria-label": "Fewer people" }, icon("minus"));
  const plus = h("button", { class: "stepper-btn", type: "button", "aria-label": "More people" }, icon("plus"));
  const setCapacity = (n: number) => {
    capacity = Math.max(MIN_PEOPLE, Math.min(MAX_PEOPLE, n));
    value.textContent = String(capacity);
    minus.disabled = capacity === MIN_PEOPLE;
    plus.disabled = capacity === MAX_PEOPLE;
  };
  minus.addEventListener("click", () => setCapacity(capacity - 1));
  plus.addEventListener("click", () => setCapacity(capacity + 1));
  setCapacity(capacity);

  const error = h("p", { class: "error", hidden: true });
  const create = h("button", { class: "btn btn-primary", type: "button" }, "Create channel");
  create.addEventListener("click", () => {
    create.disabled = true;
    create.classList.add("loading");
    error.hidden = true;

    const key = newRoomKey();
    const room = fetch("/api/rooms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ capacity }),
    }).then(async (res) => {
      if (!res.ok) throw new Error(String(res.status));
      return (await res.json()) as CreateRoomResponse;
    });
    // Start the copy inside the click so the browser allows it.
    const copied = copyText(room.then((r) => inviteUrl(r.inviteId)));

    room.then(
      async (r) => {
        saveCreds({ roomId: r.roomId, memberId: r.memberId, secret: r.secret, key });
        go("/c");
        if (await copied) toast("Invite link copied");
      },
      () => {
        error.textContent = "Couldn't create a channel. Try again in a moment.";
        error.hidden = false;
        create.disabled = false;
        create.classList.remove("loading");
      },
    );
  });

  mount(
    h(
      "div",
      { class: "page" },
      topbar(),
      h(
        "main",
        { class: "home" },
        h("h1", {}, "Encrypted chat rooms that delete themselves."),
        h(
          "p",
          { class: "lede" },
          "Messages are end-to-end encrypted in your browser, the invite link stops working once everyone's in, " +
            `and the whole channel is deleted ${IDLE_MINUTES} minutes after the last person leaves.`,
        ),
        h(
          "div",
          { class: "create" },
          h("div", { class: "stepper" }, h("span", { class: "stepper-label" }, "people"), minus, value, plus),
          create,
        ),
        error,
      ),
    ),
  );
}

// Invite: nothing happens until Join is pressed, so link previews in chat apps can't use it up.

function invite(inviteId: string) {
  const error = h("p", { class: "error", hidden: true });
  const join = h("button", { class: "btn btn-primary", type: "button" }, "Join channel");
  join.addEventListener("click", async () => {
    join.disabled = true;
    join.classList.add("loading");
    try {
      const pair = await newJoinKeyPair();
      const res = await fetch("/api/join", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ inviteId, pub: pair.pub }),
      });
      if (res.status === 410) return go("/j", true);
      if (!res.ok) throw new Error(String(res.status));
      const r: JoinResponse = await res.json();
      // Replace the invite in history so Back doesn't lead to a dead link.
      saveCreds({ roomId: r.roomId, memberId: r.memberId, secret: r.secret, priv: pair.priv });
      go("/c", true);
    } catch {
      error.textContent = "Couldn't reach the server. Try again.";
      error.hidden = false;
      join.disabled = false;
      join.classList.remove("loading");
    }
  });

  panel(
    "You've been invited to a channel.",
    "Messages are end-to-end encrypted and deleted when the channel ends. You'll show up under a random name.",
    join,
    error,
  );
}

function panel(title: string, body: string, ...actions: Node[]) {
  mount(
    h(
      "div",
      { class: "page" },
      topbar(),
      h("main", { class: "panel" }, h("h2", {}, title), h("p", { class: "muted" }, body), h("div", { class: "actions" }, ...actions)),
    ),
  );
}

function expired() {
  panel(
    "This invite has expired.",
    "Invites stop working once everyone has joined or the channel has ended.",
    h("a", { class: "btn btn-secondary", href: "/" }, "Create your own"),
  );
}

function notOpen() {
  panel(
    "No channel open in this tab.",
    "A channel only lives in the tab it was opened in, so its keys never end up in your browser history. Closing that tab leaves the channel.",
    h("a", { class: "btn btn-secondary", href: "/" }, "Create a new one"),
  );
}

function ended() {
  panel("This channel has ended.", "Everything in it has been deleted.", h("a", { class: "btn btn-secondary", href: "/" }, "Create a new one"));
}

route();
