/**
 * Demo dataset + per-org defaults, factored out so they have exactly two
 * consumers each and cannot drift:
 *
 *   - DEMO_*: the sqlite demo seed (lib/db-sqlite.ts) AND the snapshot
 *     importer's demo-row filter (scripts/import-snapshot.ts). The filter
 *     must agree with the seed on what "demo data" is, or an import drags
 *     seed rows into a real org.
 *   - DEFAULT_*: product content (templates, catalogue, automations) seeded
 *     for the demo org and for every newly provisioned real org
 *     (lib/amos-auth.ts) — a fresh org shouldn't start with empty tooling.
 */
import type { Stage } from "./db.ts";

/** Fixed org id for the sqlite demo database (DATABASE_URL unset). */
export const DEMO_ORG_ID = "00000000-0000-4000-8000-000000000001";
export const DEMO_ORG_NAME = "Roofline Demo Co";

/** [email, name, role, manager index into this array (or null), password] */
export const DEMO_USERS: ReadonlyArray<
  readonly [string, string, "admin" | "manager" | "rep", number | null, string]
> = [
  ["jeff@demo.roofline", "Jeff Barnes", "admin", null, "demo2026"],
  ["dana@demo.roofline", "Dana Whitfield", "manager", 0, "demo2026"],
  ["marcus@demo.roofline", "Marcus Lee", "rep", 1, "demo2026"],
  ["priya@demo.roofline", "Priya Nair", "rep", 1, "demo2026"],
];

/** [name, type, phone, email, address] */
export const DEMO_CONTACTS: ReadonlyArray<
  readonly [string, string, string, string, string]
> = [
  ["Luc Pamella", "Homeowner", "(512) 555-0173", "luc.p@example.com", "3869 Dover Ferry Crossing, Austin, TX"],
  ["April Duley", "Homeowner", "(512) 555-0114", "april.d@example.com", "113 Flycatcher Cove, Cedar Creek, TX"],
  ["Paul Brigg", "Homeowner", "(512) 555-0147", "paul.b@example.com", "2409 Chimney Rock Road, Leander, TX"],
  ["Birdseye Builders", "Builder", "(512) 555-0190", "office@birdseye.example.com", "1709 Manans Street, Austin, TX"],
  ["Aaron Ortega", "Homeowner", "(512) 555-0166", "aaron.o@example.com", "1335 Cordova Cove, Cedar Park, TX"],
  ["Sandra Kim (State Farm)", "Insurance Agent", "(512) 555-0122", "s.kim@example.com", "Austin, TX"],
  ["Cleo Barrera", "Homeowner", "(512) 555-0158", "cleo.b@example.com", "610 Broad Street, Buda, TX"],
  ["Ruiz Framing Co.", "Crew lead", "(512) 555-0181", "ruiz@example.com", "Austin, TX"],
  ["Nancy Iverson", "Homeowner", "(512) 555-0135", "nancy.i@example.com", "88 Lakeway Drive, Lakeway, TX"],
];

/** [title, contact index, address, trade, workflow, source, stage,
 *   assignee index into DEMO_USERS, value_cents, cost_cents, scheduled_for,
 *   stage_since offset] */
export const DEMO_JOBS: ReadonlyArray<
  readonly [string, number, string, string, string, string, Stage, number, number, number, string | null, string]
> = [
  ["Roof replacement — hail claim", 0, "3869 Dover Ferry Crossing, Austin, TX", "Roofing", "Roofing", "Insurance referral", "Approved", 2, 1849900, 1108000, "2026-08-12", "-3 days"],
  ["Driveway extension", 1, "113 Flycatcher Cove, Cedar Creek, TX", "Concrete", "Construction", "Door knocking", "Prospect", 2, 782500, 501000, null, "-8 days"],
  ["Pergola build", 2, "2409 Chimney Rock Road, Leander, TX", "Carpentry", "Construction", "Referral", "Approved", 3, 1779000, 1090000, "2026-08-15", "-2 days"],
  ["New-build roofing package (4 lots)", 3, "1709 Manans Street, Austin, TX", "Roofing", "Roofing", "Builder relationship", "Prospect", 3, 6420000, 4180000, null, "-21 days"],
  ["Shingle repair after wind event", 4, "1335 Cordova Cove, Cedar Park, TX", "Roofing", "Service", "Office call", "Scheduled", 2, 485000, 262000, "2026-08-08", "-1 days"],
  ["Full re-roof + gutters", 6, "610 Broad Street, Buda, TX", "Roofing", "Roofing", "QR instant estimate", "New lead", 3, 0, 0, null, "-1 days"],
  ["Metal roof quote", 4, "97 County Road 200, Burnet, TX", "Roofing", "Roofing", "Networking", "Completed/Invoiced", 2, 2210000, 1402000, "2026-07-28", "-6 days"],
  ["Bathroom remodel", 1, "21307 Byerly Turk Drive, Pflugerville, TX", "Remodel", "Construction", "Repeat customer", "Ready for Commission", 3, 1560000, 967000, "2026-07-20", "-11 days"],
  ["Storm damage inspection", 8, "88 Lakeway Drive, Lakeway, TX", "Roofing", "Roofing", "Door knocking", "Assigned lead", 2, 0, 0, null, "-4 days"],
  ["Gutter replacement", 8, "88 Lakeway Drive, Lakeway, TX", "Gutters", "Service", "Referral", "Assigned lead", 3, 0, 0, null, "-19 days"],
  ["Commercial flat roof — retail strip", 3, "1200 Braker Lane, Austin, TX", "Roofing", "Roofing", "Networking", "New lead", 2, 0, 0, null, "-2 days"],
  ["Fascia + soffit repair", 6, "610 Broad Street, Buda, TX", "Carpentry", "Service", "Repeat customer", "Closed", 3, 342000, 208000, "2026-07-02", "-30 days"],
];

/** What the importer treats as demo rows (case-insensitive name match). */
export const DEMO_CONTACT_NAMES: ReadonlySet<string> = new Set(
  DEMO_CONTACTS.map(([name]) => name.toLowerCase()),
);
export const DEMO_JOB_TITLES: ReadonlySet<string> = new Set(
  DEMO_JOBS.map(([title]) => title.toLowerCase()),
);
export const DEMO_USER_EMAILS: ReadonlySet<string> = new Set(
  DEMO_USERS.map(([email]) => email.toLowerCase()),
);

/** [sku, name, unit, price_cents, cost_cents, source] */
export const DEFAULT_CATALOGUE: ReadonlyArray<
  readonly [string, string, string, number, number, string]
> = [
  ["GAF-TIMB-HDZ-CH", "GAF Timberline HDZ — Charcoal", "square", 12550, 8100, "srs_roofhub"],
  ["GAF-PROSTART-120", "GAF ProStart Starter Strip", "bundle", 6725, 4400, "srs_roofhub"],
  ["GAF-SEALAR-RIDGE", "GAF Seal-A-Ridge Cap Shingles", "bundle", 7850, 5100, "srs_roofhub"],
  ["SYN-FELT-10SQ", "Synthetic Underlayment 10SQ", "roll", 9200, 6000, "srs_roofhub"],
  ["DRIP-F5-WHT-10", "Drip Edge F5 White 10ft", "piece", 1180, 760, "srs_roofhub"],
  ["ICE-WATER-2SQ", "Ice & Water Shield 2SQ", "roll", 11400, 7400, "srs_roofhub"],
  ["VENT-RIDGE-4", "Ridge Vent 4ft section", "piece", 2250, 1450, "srs_roofhub"],
  ["NAIL-COIL-1.25", "Roofing nails, coil 1-1/4\"", "box", 6400, 4100, "srs_roofhub"],
  ["LAB-TEAROFF", "Labor — tear-off per square", "square", 5500, 3800, "custom"],
  ["LAB-INSTALL", "Labor — install per square", "square", 8500, 5900, "custom"],
  ["DUMP-30YD", "Dumpster — 30 yard", "each", 52500, 41000, "custom"],
];

/** [name, kind, fields] */
export const DEFAULT_TEMPLATES: ReadonlyArray<readonly [string, string, string]> = [
  ["Roofing contract (TX)", "contract", "homeowner, address, scope, total, deposit"],
  ["Certificate of Completion", "coc", "homeowner, address, completion_date"],
  ["Change order", "change_order", "homeowner, description, delta"],
  ["Workmanship warranty", "warranty", "homeowner, address, years"],
  ["Standard roofing proposal", "proposal", "line items, measurement, total"],
];

/** [name, trigger, action, channel, enabled] */
export const DEFAULT_AUTOMATIONS: ReadonlyArray<
  readonly [string, string, string, string, number]
> = [
  ["Install-day details", "Job scheduled", "Email homeowner install + delivery instructions", "email", 1],
  ["Deposit reminder", "Invoice unpaid 3 days", "Text homeowner the payment link", "sms", 1],
  ["Proposal follow-up", "Proposal sent, not viewed in 2 days", "Email rep to follow up", "email", 1],
  ["Stale lead nudge", "Lead in stage 14 days", "Task for the assigned rep", "task", 1],
  ["Post-job review request", "Job closed", "Email homeowner a review link", "email", 0],
];
