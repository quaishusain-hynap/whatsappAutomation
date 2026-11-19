# MB Travels — WhatsApp Workspace

Shared-WhatsApp platform: multiple staff log in and chat with clients through one WhatsApp number, with full history, per-message staff attribution, and (in later phases) AI document parsing, a customer CRM, and booking workflows.

## Stack

- **server/** — Fastify 5 + TypeScript, Prisma 6 (PostgreSQL 16), socket.io, Baileys (linked-device WhatsApp)
- **web/** — React 19 + Vite + Tailwind 4, WhatsApp-Web-like UI
- **shared/** — DTOs, zod schemas, socket event map

## Running (development)

```bash
npm install
npm run dev        # starts server (:3001) and web (:5173) together
```

Open http://localhost:5173 — log in with the seeded admin `admin` / `admin123` (change this password from the Users page).

**Connect WhatsApp:** as admin, go to the *Connection* tab → *Connect / Show QR* → on the phone: WhatsApp → Linked devices → Link a device → scan. The session persists in `server/data/wa-auth/` across restarts; no re-scan needed unless you unlink.

## Configuration

`server/.env`:

| Var | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection (password URL-encoded) |
| `JWT_SECRET` | Auth token signing key |
| `PORT` | API port (default 3001) |
| `DATA_DIR` | Where WhatsApp credentials + media files live (back this up!) |
| `ANTHROPIC_API_KEY` | Needed from Phase 3 (document parsing) |

## Database

```bash
npm run migrate -w server   # prisma migrate dev
npm run seed -w server      # seed admin + primary WA account
```

## Important notes

- **Back up `server/data/`** — `wa-auth/` holds the WhatsApp session (losing it forces re-pairing) and `media/` holds all message attachments.
- **Ban risk:** this uses Baileys (an unofficial WhatsApp Web protocol library). Sends are serialized with human-like pacing, but Meta does not sanction this usage; the provider layer is abstracted so the official Cloud API can be swapped in later.
- Outgoing messages are attributed to the staff user who sent them (`messages.sent_by_user_id`) and labeled in the UI; sends/logins are recorded in `audit_log`.

## Roadmap (per approved plan)

- ✅ Phase 0–1: monorepo, schema, auth, Baileys connect, multi-user chat UI, attribution
- Phase 2: customer records + admin-defined custom fields, internal contacts (CA/accounts)
- Phase 3: document types + Claude-based parsing (tickets/invoices), entity panel, verification UI
- Phase 4: workflow engine, fare quotes, bookings with quoted-vs-actual margin tracking
- Phase 5: hardening + Linux VPS deploy (pm2, no Docker)
