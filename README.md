# KiChat

Real-time messaging, voice calls, and video calls. Node.js + Express + Socket.IO backend, Postgres for accounts and message history, WebRTC for peer-to-peer audio/video.

## How it works

- **Accounts** — username/password, hashed with bcrypt, sessions via JWT.
- **Messaging** — sent over Socket.IO, stored in Postgres, loaded as history when you open a conversation.
- **Calls** — the server only relays WebRTC signaling (who's calling whom, and the connection handshake). Audio/video itself flows directly between the two browsers, not through the server.

## Run it locally

1. Install dependencies:

   ```bash
   npm install
   ```

2. Get a Postgres database. Easiest options:
   - Install Postgres locally and create a database named `kichat`, or
   - Use a free hosted one (Render, Neon, Supabase) and copy its connection string.

3. Copy `.env.example` to `.env` and fill in `DATABASE_URL` and a random `JWT_SECRET`.

4. Start the server:

   ```bash
   npm start
   ```

5. Open `http://localhost:3000`, sign up, and open the same URL in a second browser (or incognito window) to sign up as a second user and test chat/calls between them.

Voice and video calls need two different accounts in two different browser tabs/windows to test — calling yourself from the same tab won't work.

## Deploy to Render

This repo includes a `render.yaml` blueprint that sets up the web service and a Postgres database together.

1. Push this project to a GitHub repository.
2. In the Render dashboard, click **New +** → **Blueprint**, and point it at your repo. Render will read `render.yaml` and provision:
   - A **Postgres** database (`kichat-db`)
   - A **web service** (`kichat`) wired to that database, with `JWT_SECRET` generated automatically
3. Once deployed, your app is live at `https://kichat.onrender.com` (or whatever subdomain Render assigns — rename the service to `kichat` in the Render dashboard if that exact name is taken, or already yours).

### Notes on Render's free tier

- Free Postgres databases on Render expire after a limited trial period; check Render's current pricing before relying on it for anything long-term. Any Postgres connection string works here (Neon and Supabase both have durable free tiers) — just set `DATABASE_URL` yourself if you skip the Render database.
- Free web services spin down when idle and take a few seconds to wake up on the next request.

### A note on call reliability

Calls use only a public STUN server (`stun.l.google.com`) to discover each caller's network address. This works for most home/office networks, but some strict corporate or mobile networks block direct peer-to-peer connections entirely. For guaranteed connectivity in that case, you'd add a TURN server (e.g. a free tier from Twilio, Xirsys, or metered.ca) and list it alongside the STUN server in `public/app.js` (`ICE_SERVERS`).

## Project structure

```
server.js          Express app, Socket.IO server, WebRTC signaling relay
db.js               Postgres connection + schema setup
middleware/auth.js   JWT signing/verification
routes/auth.js       /api/auth/register, /api/auth/login
routes/users.js      /api/users (directory), /api/users/me
routes/messages.js   /api/messages/:otherUserId (history)
public/              Front-end: login/register, chat UI, call UI
```
