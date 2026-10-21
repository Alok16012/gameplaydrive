import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { checkEs256Token } from "../../app/lib/server/supabaseAdmin.ts";

const ISS = "https://example.supabase.co/auth/v1";
const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const other = generateKeyPairSync("ec", { namedCurve: "P-256" });
const keys = (kid: string): KeyObject | null => (kid === "k1" ? publicKey : null);
const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const now = 1_800_000_000;

function token(claims: Record<string, unknown>, opts: { kid?: string; alg?: string; key?: KeyObject } = {}) {
  const head = enc({ alg: opts.alg ?? "ES256", kid: opts.kid ?? "k1", typ: "JWT" });
  const body = enc({ sub: "user-1", role: "authenticated", aud: "authenticated", iss: ISS, exp: now + 3600, ...claims });
  const sig = sign("sha256", Buffer.from(`${head}.${body}`), { key: opts.key ?? privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
  return `${head}.${body}.${sig}`;
}

test("access tokens: a valid ES256 token yields its user; forged or expired ones are refused", () => {
  assert.deepEqual(checkEs256Token(token({}), keys, ISS, now), { userId: "user-1" });
  assert.deepEqual(checkEs256Token(token({ aud: ["authenticated", "x"] }), keys, ISS, now), { userId: "user-1" });
  assert.equal(checkEs256Token(token({ exp: now - 1 }), keys, ISS, now), "invalid");
  assert.equal(checkEs256Token(token({}, { key: other.privateKey }), keys, ISS, now), "invalid");
  const t = token({});
  const [h, , s] = t.split(".");
  assert.equal(checkEs256Token(`${h}.${enc({ sub: "someone-else", role: "authenticated", aud: "authenticated", iss: ISS, exp: now + 3600 })}.${s}`, keys, ISS, now), "invalid");
  assert.equal(checkEs256Token("not-a-token", keys, ISS, now), "invalid");
});

test("access tokens: anything the local check can't decide goes to Supabase Auth", () => {
  assert.equal(checkEs256Token(token({}, { kid: "unknown" }), keys, ISS, now), "unknown");
  assert.equal(checkEs256Token(token({}, { alg: "HS256" }), keys, ISS, now), "unknown");
  assert.equal(checkEs256Token(token({ iss: "https://elsewhere/auth/v1" }), keys, ISS, now), "unknown");
  assert.equal(checkEs256Token(token({ role: "anon" }), keys, ISS, now), "unknown");
});
