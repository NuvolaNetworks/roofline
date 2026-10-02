// Sample proposal data for previewing a template before any real proposal
// uses it (template editor preview + PDF). Fictional customer; the line
// shape mirrors a typical full re-roof.
import type { ModelLine, PartyInfo } from "./proposal-model.ts";

const L = (section: string, name: string, qty: number, unit: string, notes = "", cents = 10000): ModelLine => ({
  section, name, notes, qty, unit, unit_price_cents: cents, sku: name.toUpperCase().replace(/\W+/g, "-"),
});

export const SAMPLE_LINES: ModelLine[] = [
  L("Work Scope", "Summary: Complete Roof System Replacement", 1, "",
    "*Contractor will fully remove and dispose of all existing roofing layers down to the bare wood deck.\n*We will inspect the wood decking and replace any rotted boards as needed.\n*Finally, a thorough site cleanup and magnetic sweep for nails", 900000),
  L("Malarkey Roofing Section", "Malarkey Vista AR", 103, "bundle", "- FREE UPGRADE\n- Class 4 - Color: Weatherwood Plus", 4500),
  L("Malarkey Roofing Section", "Malarkey Ridgeflex SG", 9, "bundle", "- Standard Profile, Class 4 (31')", 7800),
  L("Roofing Accessories Section", "TopShield 85 Synthetic Underlayment", 4, "roll", "- Install synthetic underlayment", 15000),
  L("Roofing Accessories Section", "Drip Edge (2\")", 49, "each", "- Replace all drip edge (rakes & eaves), 2\" x 2\" x 10', Color: Match shingles", 1200),
  L("Ventilation & Flashing Section", "Direct Metals Bullet Pipe Boot (1.5)", 2, "each", "Remove and replace all pipe jack flashing with bullet boots.", 6500),
  L("Decking", "7/16\" 4' X 8' - OSB Sheathing", 2, "sheet", "***First 2 sheet are FREE, if more is needed, it will be $95 per sheet.***", 0),
  L("Clean Up", "Debris Removal", 1, "each", "We treat your property like our own; upon completion, our crew will perform a meticulous ground-to-roof cleanup.", 65000),
];

export const SAMPLE_CUSTOMER: PartyInfo = {
  name: "Jordan Sample",
  email: "jordan@example.com",
  phone: "(512) 555-0100",
  address: "123 Sample Lane, Manchaca, TX 78652",
};
