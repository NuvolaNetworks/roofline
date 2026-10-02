// A proposal shaped like 8 Square's Bobbywoods sample (sections, notes,
// quantities, no line prices) with made-up customer details — the shared
// fixture for the model, PDF and e-sign tests.
import { defaultProposalTemplate, type TemplateBody } from "../../lib/doc-template.ts";
import type { ModelInput } from "../../lib/proposal-model.ts";
import { SAMPLE_CUSTOMER, SAMPLE_LINES } from "../../lib/template-sample.ts";

export { SAMPLE_LINES };

export function sampleTemplate(): TemplateBody {
  const t = defaultProposalTemplate("8 Square Roofing & Construction");
  t.branding.tagline = "Your One Call. Total Home Transformation.";
  t.branding.stats = [
    { value: "25", label: "Years in business" },
    { value: "100+", label: "Trusted vendors" },
    { value: "8+", label: "Service areas" },
    { value: "1000s", label: "Jobs completed" },
  ];
  return t;
}

export function sampleInput(overrides: Partial<ModelInput> = {}): ModelInput {
  return {
    template: sampleTemplate(),
    proposal: { id: 42, name: "Roof replacement — 123 Sample Lane" },
    lines: SAMPLE_LINES,
    customer: SAMPLE_CUSTOMER,
    rep: { name: "Pat Rep", email: "pat@example.com", phone: "(512) 555-0199", address: "" },
    catalogueSpecs: [],
    files: new Map(),
    today: "Aug 24, 2026",
    ...overrides,
  };
}
