"use server";

// Public signing-page actions. No session: the link token IS the
// credential, resolved fresh on every call (expired/voided → refused).
import { redirect } from "next/navigation";
import { getDb } from "./db";
import { createFixedWindowLimiter } from "./rate-limit";
import { declineByToken, decodeSignaturePng, sessionForToken, signByToken, SignError } from "./esign";
import { clientInfo } from "./client-info";
import { requestOrigin } from "./request-origin";
import { issueDownloadLink } from "./esign";
import { notifyCompleted, notifyCustomerSigned, notifyDeclined } from "./esign-notify";
import { kickAmosOutbox } from "./amos-worker";

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
    const completed = await signByToken(db, session, {
      png,
      method: formData.get("method") === "drawn" ? "drawn" : "typed",
      typedName: String(formData.get("typed_name") ?? ""),
      consented: formData.get("consent") === "yes",
    }, client);
    const envelopeId = Number(session.envelope.id);
    if (completed) {
      await notifyCompleted(db, session.orgId, envelopeId, await issueDownloadLink(db, session.orgId, envelopeId), await requestOrigin());
    } else {
      await notifyCustomerSigned(db, session.orgId, envelopeId, await requestOrigin());
    }
    kickAmosOutbox();
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
    const reason = String(formData.get("reason") ?? "").trim();
    await declineByToken(db, session, reason, client);
    await notifyDeclined(db, session.orgId, Number(session.envelope.id), reason, await requestOrigin());
    kickAmosOutbox();
  } catch (err) {
    if (!(err instanceof SignError)) throw err;
    message = err.message;
  }
  redirect(back(token, message ? `error=${encodeURIComponent(message)}` : "declined=1"));
}
