"use server";

// Public signing-page actions. No session: the link token IS the
// credential, resolved fresh on every call (expired/voided → refused).
import { redirect } from "next/navigation";
import { getDb } from "./db";
import { createFixedWindowLimiter } from "./rate-limit";
import { declineByToken, decodeSignaturePng, sessionForToken, signByToken, SignError } from "./esign";
import { clientInfo } from "./client-info";

const limited = createFixedWindowLimiter({ windowMs: 60_000, max: 10 });

const back = (token: string, q: string) => `/sign/${encodeURIComponent(token)}?${q}`;

export async function submitSignature(token: string, formData: FormData) {
  const client = await clientInfo();
  if (limited(`sign|${token}|${client.ip}`)) redirect(back(token, "error=" + encodeURIComponent("Too many attempts — wait a minute and try again.")));
  const db = getDb();
  const session = await sessionForToken(db, token);
  if (!session) redirect(back(token, ""));
  let message = "";
  try {
    const png = await decodeSignaturePng(String(formData.get("signature") ?? ""));
    await signByToken(db, session, {
      png,
      method: formData.get("method") === "drawn" ? "drawn" : "typed",
      typedName: String(formData.get("typed_name") ?? ""),
      consented: formData.get("consent") === "yes",
    }, client);
  } catch (err) {
    if (!(err instanceof SignError)) throw err;
    message = err.message;
  }
  redirect(back(token, message ? `error=${encodeURIComponent(message)}` : "signed=1"));
}

export async function declineSignature(token: string, formData: FormData) {
  const client = await clientInfo();
  if (limited(`sign|${token}|${client.ip}`)) redirect(back(token, ""));
  const db = getDb();
  const session = await sessionForToken(db, token);
  if (!session) redirect(back(token, ""));
  let message = "";
  try {
    await declineByToken(db, session, String(formData.get("reason") ?? "").trim(), client);
  } catch (err) {
    if (!(err instanceof SignError)) throw err;
    message = err.message;
  }
  redirect(back(token, message ? `error=${encodeURIComponent(message)}` : "declined=1"));
}
