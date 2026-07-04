#!/usr/bin/env -S npx tsx
// End-to-end check against a deployed stack.
// Prereqs: deployed stack, active receipt rule set, verified domain,
// env: AGENT_IDENTITY_API_URL, AGENT_IDENTITY_FLEET_KEY, E2E_SMTP_SENDER
// (an address you can send from, e.g. via `aws sesv2 send-email` from the
// same account once the domain is verified, or any external mailbox).
import { AgentIdentityClient, loadOrCreateProfile } from "@agent-identity/client";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const profile = loadOrCreateProfile("e2e", mkdtempSync(join(tmpdir(), "aid-e2e-")));
const client = new AgentIdentityClient({
  apiUrl: process.env.AGENT_IDENTITY_API_URL!,
  keypair: profile,
  fleetKey: process.env.AGENT_IDENTITY_FLEET_KEY,
});

const id1 = await client.register();
const id2 = await client.register();
if (id1.address !== id2.address) throw new Error("register not idempotent!");
console.log(`identity: ${id1.agentId} <${id1.address}>`);
console.log(`\nSend a test email to ${id1.address} now (subject: e2e-ping).`);
console.log("Polling for it (up to 5 minutes)...");

const deadline = Date.now() + 300_000;
for (;;) {
  const { emails } = await client.listEmails({ limit: 10 });
  const hit = emails.find((e) => e.subject.includes("e2e-ping"));
  if (hit) {
    const full = await client.getEmail(hit.id);
    console.log("RECEIVED:", JSON.stringify(full, null, 2));
    break;
  }
  if (Date.now() > deadline) throw new Error("timed out waiting for e2e-ping");
  await new Promise((r) => setTimeout(r, 5000));
}
console.log("E2E OK");
