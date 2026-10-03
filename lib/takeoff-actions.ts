"use server";

// Blueprint takeoff actions. Uploading starts the read in the background and
// lands on the review page, which refreshes until the numbers are in.
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getDb } from "./db";
import { currentUser, visibleUserIds, type User } from "./auth";
import { FileRejected, formFile, putFile } from "./files";
import { amosExtractor } from "./amos-extract";
import { approveTakeoff, createTakeoff, getTakeoff, runExtraction, saveReview, TakeoffError, TRADES, type Trade } from "./takeoff";

async function requireUser(): Promise<User> {
  const user = await currentUser();
  if (!user) redirect("/login");
  return user;
}

async function visibleJob(user: User, jobId: number): Promise<void> {
  const job = await getDb().get<{ assignee_id: number | null }>("SELECT assignee_id FROM jobs WHERE id = ? AND org_id = ?", jobId, user.org_id);
  if (!job || !(await visibleUserIds(user)).includes(Number(job.assignee_id))) redirect("/jobs");
}

function startReading(orgId: string, takeoffId: number): void {
  const db = getDb();
  runExtraction(db, orgId, takeoffId, amosExtractor(db)).catch((err) =>
    console.error(`[roofline] takeoff ${takeoffId} read failed:`, err),
  );
}

export async function uploadBlueprintAction(jobId: number, formData: FormData): Promise<void> {
  const user = await requireUser();
  await visibleJob(user, jobId);
  const trade = String(formData.get("trade") ?? "") as Trade;
  const file = await formFile(formData, "blueprint");
  let takeoffId = 0;
  try {
    if (!file) throw new TakeoffError("Choose a blueprint PDF or image.");
    if (!TRADES.includes(trade)) throw new TakeoffError("Choose roofing, pool or new construction.");
    const stored = await putFile(getDb(), user.org_id, "blueprint", file.name, file.bytes);
    takeoffId = await createTakeoff(getDb(), user.org_id, jobId, stored.id, trade, user.id);
  } catch (e) {
    if (e instanceof TakeoffError || e instanceof FileRejected) redirect(`/jobs/${jobId}?takeoff_error=${encodeURIComponent(e.message)}#blueprints`);
    throw e;
  }
  startReading(user.org_id, takeoffId);
  redirect(`/takeoffs/${takeoffId}`);
}

async function ownTakeoff(user: User, id: number) {
  const t = await getTakeoff(getDb(), user.org_id, id);
  if (!t) redirect("/jobs");
  await visibleJob(user, t.job_id);
  return t;
}

export async function retryTakeoffAction(id: number): Promise<void> {
  const user = await requireUser();
  await ownTakeoff(user, id);
  await getDb().run("UPDATE takeoffs SET status = 'Reading', error = NULL WHERE id = ? AND org_id = ? AND status != 'Approved'", id, user.org_id);
  startReading(user.org_id, id);
  redirect(`/takeoffs/${id}`);
}

const values = (formData: FormData) => Object.fromEntries([...formData.entries()].filter(([k]) => k.startsWith("v_")).map(([k, v]) => [k.slice(2), String(v)]));

export async function saveTakeoffAction(id: number, formData: FormData): Promise<void> {
  const user = await requireUser();
  await ownTakeoff(user, id);
  try {
    await saveReview(getDb(), user.org_id, id, values(formData));
  } catch (e) {
    if (e instanceof TakeoffError) redirect(`/takeoffs/${id}?error=${encodeURIComponent(e.message)}`);
    throw e;
  }
  revalidatePath(`/takeoffs/${id}`);
  redirect(`/takeoffs/${id}?saved=1`);
}

export async function approveTakeoffAction(id: number, formData: FormData): Promise<void> {
  const user = await requireUser();
  const t = await ownTakeoff(user, id);
  let proposalId = 0;
  try {
    await saveReview(getDb(), user.org_id, id, values(formData));
    proposalId = (await approveTakeoff(getDb(), user.org_id, id, { id: user.id, name: user.name, email: user.email })).proposal_id;
  } catch (e) {
    if (e instanceof TakeoffError) redirect(`/takeoffs/${id}?error=${encodeURIComponent(e.message)}`);
    throw e;
  }
  revalidatePath(`/jobs/${t.job_id}`);
  redirect(`/proposals/${proposalId}`);
}
