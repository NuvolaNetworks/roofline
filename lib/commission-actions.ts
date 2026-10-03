"use server";

// Commission actions: pay out a job, save the formula, send statements now.
// Paying and settings are admin/manager only; reps only read.
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getDb } from "./db";
import { currentUser, type User } from "./auth";
import { requestOrigin } from "./request-origin";
import { kickAmosOutbox } from "./amos-worker";
import { CommissionError, markCommissionPaid, saveCommissionSettings, sendCommissionStatements } from "./commission";

async function requireManager(): Promise<User> {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (user.role === "rep") redirect("/commissions?error=Only+admins+and+managers+can+do+that.");
  return user;
}

const fail = (e: unknown): never => {
  if (e instanceof CommissionError) redirect(`/commissions?error=${encodeURIComponent(e.message)}`);
  throw e;
};

export async function payCommissionAction(jobId: number): Promise<void> {
  const user = await requireManager();
  try {
    await markCommissionPaid(getDb(), user.org_id, jobId, { id: user.id, name: user.name });
  } catch (e) {
    fail(e);
  }
  revalidatePath("/commissions");
  revalidatePath(`/jobs/${jobId}`);
  redirect("/commissions?paid=1");
}

export async function saveCommissionSettingsAction(formData: FormData): Promise<void> {
  const user = await requireManager();
  if (user.role !== "admin") redirect("/commissions?error=Only+admins+can+change+the+commission+formula.");
  const num = (k: string) => Number(String(formData.get(k) ?? "").replace(/[%\s]/g, ""));
  try {
    await saveCommissionSettings(getDb(), user.org_id, {
      overhead_pct: num("overhead_pct"),
      rep_share_pct: num("rep_share_pct"),
      statements_enabled: formData.get("statements_enabled") === "on",
    });
  } catch (e) {
    fail(e);
  }
  revalidatePath("/commissions");
  redirect("/commissions?saved=1");
}

export async function sendStatementsNowAction(): Promise<void> {
  const user = await requireManager();
  const r = await sendCommissionStatements(getDb(), user.org_id, {
    origin: await requestOrigin(),
    force: true,
    replyTo: user.email,
  });
  kickAmosOutbox();
  redirect(`/commissions?sent=${r.queued}`);
}
