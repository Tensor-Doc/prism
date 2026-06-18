// swarm-relay — agent-host WebSocket server for prism's shared mode.
//
// Six agents always inhabit the room, drifting + pulsing on their own.
// When a real human connects they take over one of the slots: the
// agent's id keeps broadcasting, but now the human's cursor + beats
// flow into it. When the human leaves, the slot resumes its agent life.
// More than six humans? We add slots dynamically.
//
// This makes the demo always-populated: a viewer who arrives alone
// still sees a living swarm; the moment they click `shared`, one of
// the cool grey "agent" stars warms into their colour and becomes
// theirs to steer.
//
// Run locally:
//   pnpm swarm-relay
// Then open the landing page with ?swarm=1 (defaults to ws://localhost:8081).

import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT ?? 8081);
const TICK_HZ = 30;
const INITIAL_AGENTS = 6;

// ── slot pool ────────────────────────────────────────────────
let nextConnId = 1;
let nextDynSlot = 1; // for slots added beyond the initial 6 when busy

// A "slot" is a persistent identity in the swarm. Vacant slots are
// driven by the relay's own tick; occupied slots forward whatever the
// human says with their id stamped on it.
function makeSlot(id, hue) {
  return {
    id,
    occupiedBy: null,         // ws connection id or null
    x: Math.random(),
    y: Math.random(),
    vx: (Math.random() - 0.5) * 0.004,
    vy: (Math.random() - 0.5) * 0.004,
    phase: Math.random() * Math.PI * 2,
    bpm: 60 + Math.floor(Math.random() * 20),  // 60..79
    lastBeatAt: Date.now() - Math.random() * 1000,  // staggered phase
    vacantHue: hue,
    occupiedHue: null,        // filled when a human takes over
  };
}

// Cool greys / blues for vacant agents — reads as "ambient room".
const VACANT_HUES = [205, 215, 225, 195, 235, 200];

const slots = [];
for (let i = 0; i < INITIAL_AGENTS; i++) {
  slots.push(makeSlot(`agent-${i + 1}`, VACANT_HUES[i % VACANT_HUES.length]));
}

function hueForId(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}

function findVacantSlot() {
  return slots.find((s) => s.occupiedBy === null) ?? null;
}

function findSlotByConnId(connId) {
  return slots.find((s) => s.occupiedBy === connId) ?? null;
}

function assignSlot(ws) {
  let slot = findVacantSlot();
  if (!slot) {
    // Past INITIAL_AGENTS — grow the pool with a "dynamic" slot whose
    // id includes a counter so it can never collide with an agent id.
    slot = makeSlot(`dyn-${nextDynSlot++}`, 195);
    slots.push(slot);
  }
  slot.occupiedBy = ws.__connId;
  slot.occupiedHue = hueForId(ws.__connId);
  return slot;
}

function vacateSlot(connId) {
  const slot = findSlotByConnId(connId);
  if (!slot) return null;
  slot.occupiedBy = null;
  slot.occupiedHue = null;
  // Dynamic slots get removed when their human leaves so we shrink back
  // to the agent baseline. Agent slots stay and resume their fake life.
  if (slot.id.startsWith("dyn-")) {
    const idx = slots.indexOf(slot);
    if (idx !== -1) slots.splice(idx, 1);
    return { slotId: slot.id, removed: true };
  }
  return { slotId: slot.id, removed: false };
}

// ── ws server ───────────────────────────────────────────────
const wss = new WebSocketServer({ port: PORT });
console.log(`[swarm-relay] listening on ws://0.0.0.0:${PORT}`);

// Host election: longest-connected client gets the host role. First
// connection becomes host. On host disconnect, the next-longest-running
// client is promoted and notified via a `role` packet.
let currentHostConnId = null;

function findHostWs() {
  for (const c of wss.clients) if (c.__connId === currentHostConnId) return c;
  return null;
}

function pickNextHost() {
  let oldest = null;
  for (const c of wss.clients) {
    if (c.readyState !== c.OPEN) continue;
    if (!oldest || c.__connectedAt < oldest.__connectedAt) oldest = c;
  }
  return oldest;
}

function broadcast(msg, exceptWs) {
  const out = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client !== exceptWs && client.readyState === client.OPEN) {
      client.send(out);
    }
  }
}

function sendTo(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

wss.on("connection", (ws) => {
  const connId = `peer-${nextConnId++}`;
  ws.__connId = connId;
  ws.__alive = true;
  ws.__connectedAt = Date.now();

  const slot = assignSlot(ws);
  ws.__slotId = slot.id;

  // First connection in the room → host. Otherwise audience.
  if (currentHostConnId === null) currentHostConnId = connId;
  const role = currentHostConnId === connId ? "host" : "audience";

  console.log(`[swarm-relay] + ${connId} → ${slot.id} role=${role} (${wss.clients.size} total)`);

  sendTo(ws, { kind: "hello", id: slot.id, hue: slot.occupiedHue, role });

  ws.on("pong", () => { ws.__alive = true; });

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); }
    catch { return; }
    const owned = findSlotByConnId(connId);
    if (!owned) return;

    // Schedule packets are the host's exclusive privilege — drop any
    // that arrive from a non-host (clients shouldn't send them, but the
    // server enforces it so a misbehaving client can't desync the room).
    if (msg.kind === "schedule" && connId !== currentHostConnId) {
      return;
    }

    msg.id = owned.id;
    msg.t = Date.now();
    if (msg.kind === "cursor") {
      msg.occupied = true;
      msg.hue = owned.occupiedHue;
      if (typeof msg.x01 === "number") owned.x = msg.x01;
      if (typeof msg.y01 === "number") owned.y = msg.y01;
    } else if (msg.kind === "beat") {
      owned.lastBeatAt = msg.t;
    } else if (msg.kind === "bpm") {
      if (typeof msg.bpm === "number" && msg.bpm > 30 && msg.bpm < 220) {
        owned.bpm = msg.bpm;
      }
    }
    broadcast(msg, ws);
  });

  ws.on("close", () => {
    const wasHost = connId === currentHostConnId;
    const result = vacateSlot(connId);
    console.log(`[swarm-relay] - ${connId} (${wss.clients.size - 1} remain)`);
    if (result?.removed) {
      broadcast({ kind: "bye", id: result.slotId, t: Date.now() });
    }
    if (wasHost) {
      // Elect the next-longest-connected client. They learn their new
      // role via a targeted `role` packet — no broadcast needed since
      // everyone else is still audience.
      const next = pickNextHost();
      if (next) {
        currentHostConnId = next.__connId;
        sendTo(next, { kind: "role", role: "host", t: Date.now() });
        console.log(`[swarm-relay]   host transferred to ${next.__connId} → ${next.__slotId}`);
      } else {
        currentHostConnId = null;
      }
    }
  });
});

// ── tick loop ───────────────────────────────────────────────
// Drives every vacant slot at TICK_HZ and emits beat packets when each
// slot's BPM clock fires. Occupied slots are skipped here — they're
// driven by their human via the message handler.
const tickIntervalMs = 1000 / TICK_HZ;
let lastTickAt = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = (now - lastTickAt) / 1000;
  lastTickAt = now;

  for (const slot of slots) {
    if (slot.occupiedBy !== null) continue;

    // Low-frequency drift + the odd flick. Same shape as the original
    // MockSwarmTransport so the visual feel is preserved.
    const t = now / 1000;
    const ax = Math.sin(t * 0.7 + slot.phase) * 0.0002;
    const ay = Math.cos(t * 0.5 + slot.phase * 1.3) * 0.0002;
    slot.vx = (slot.vx + ax) * 0.985;
    slot.vy = (slot.vy + ay) * 0.985;
    slot.x += slot.vx;
    slot.y += slot.vy;
    if (slot.x < 0.02 || slot.x > 0.98) { slot.vx *= -1; slot.x = Math.max(0.02, Math.min(0.98, slot.x)); }
    if (slot.y < 0.02 || slot.y > 0.98) { slot.vy *= -1; slot.y = Math.max(0.02, Math.min(0.98, slot.y)); }
    if (Math.random() < 0.005) {
      slot.vx += (Math.random() - 0.5) * 0.02;
      slot.vy += (Math.random() - 0.5) * 0.02;
    }

    broadcast({
      kind: "cursor",
      id: slot.id,
      x01: slot.x,
      y01: slot.y,
      occupied: false,
      hue: slot.vacantHue,
      t: now,
    });

    // Fire a beat when the BPM clock says so.
    const beatPeriodMs = 60_000 / slot.bpm;
    if (now - slot.lastBeatAt >= beatPeriodMs) {
      slot.lastBeatAt = now;
      broadcast({
        kind: "beat",
        id: slot.id,
        t: now,
      });
    }
  }
}, tickIntervalMs);

// ── heartbeat ───────────────────────────────────────────────
const pingInterval = setInterval(() => {
  for (const client of wss.clients) {
    if (!client.__alive) {
      console.log(`[swarm-relay] dropping silent ${client.__connId}`);
      client.terminate();
      continue;
    }
    client.__alive = false;
    try { client.ping(); } catch { /* ignore */ }
  }
}, 30_000);
wss.on("close", () => clearInterval(pingInterval));

const shutdown = () => {
  console.log("[swarm-relay] shutting down");
  wss.close(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
