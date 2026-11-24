# sidechannel

Throwaway, end-to-end encrypted chat rooms. Make a channel, paste the invite
link wherever you're talking, and it's gone when you're done.

## How it works

- **Create channel** makes a room for 2 people by default (up to 10). The invite link is copied to your clipboard.
- Opening the invite does nothing until someone presses **Join**, so link
  previews in chat apps can't use it up.
- Once the room is full the invite is deleted, and the room forgets it ever
  had one. Nobody can send messages before then, so messages and the invite
  link are never on screen together.
- The room ends when someone presses **End**, 30 minutes after everyone
  leaves, or after 24 hours at most. Everything is deleted.

### Encryption

The creator's browser makes a random room key. It never goes in a link that
gets shared. Each joiner's browser makes a key pair and sends only the public
half; a member who already has the room key encrypts it for them. Messages are
AES-GCM encrypted in the browser, and the server only stores and relays
ciphertext until the room ends.

Everything needed to get back into a room (your member secret and the room
key) lives in the tab's session storage, never in the URL, so it stays out of
browser history and history sync. The address bar only ever shows `/c`. A
reload keeps you in; closing the tab leaves the room.

What it doesn't protect against: the other person (screenshots, retelling),
and a malicious server operator swapping keys during the exchange. There's no
key verification step, on purpose, to keep it simple.

## Develop

```sh
pnpm install
pnpm dev           # http://localhost:8787
pnpm test          # end-to-end tests against a local server
pnpm typecheck
```

- `src/worker.ts`, `src/room.ts`, `src/invite.ts`: the Cloudflare Worker and its Durable Objects
- `src/shared/`: the message protocol and the encryption, used by browser and tests
- `src/client/`: the browser app, bundled to `public/app.js` by esbuild

## Deploy

Needs a free Cloudflare account.

```sh
pnpm exec wrangler login
pnpm run deploy
```

It goes live at `https://sidechannel.<your-subdomain>.workers.dev`.
