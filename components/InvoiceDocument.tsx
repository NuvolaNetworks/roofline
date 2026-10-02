// HTML view of an invoice (lib/invoice-doc.ts model) — the homeowner's
// invoice page and the in-app preview.
import type { InvoiceModel } from "@/lib/invoice-doc";
import { addressLines, money } from "@/lib/proposal-model";

export default function InvoiceDocument({ m, logoSrc }: { m: InvoiceModel; logoSrc?: string | null }) {
  const accent = m.branding.accent;
  return (
    <section className="mx-auto w-full max-w-[816px] overflow-hidden rounded-sm bg-white text-[#29333d] shadow-md">
      <div className="h-2" style={{ background: accent }} />
      <div className="px-6 py-8 sm:px-10">
        <div className="flex flex-wrap items-start justify-between gap-4">
          {logoSrc ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logoSrc} alt={m.branding.company_name} className="max-h-14 max-w-[220px]" />
          ) : (
            <div className="bg-black px-4 py-3 text-sm font-bold uppercase text-white">{m.branding.company_name}</div>
          )}
          <div className="text-right">
            <div className="text-2xl font-bold">INVOICE</div>
            <div className="text-sm text-neutral-500">{m.number}</div>
          </div>
        </div>
        <div className="mt-8 flex flex-wrap justify-between gap-6 text-sm">
          <div>
            <div className="text-xs font-bold uppercase text-neutral-500">Bill to</div>
            {[m.customer.name, ...addressLines(m.customer.address), m.customer.email].filter(Boolean).map((l) => (
              <div key={l}>{l}</div>
            ))}
          </div>
          <div className="grid grid-cols-[auto_auto] gap-x-6 gap-y-1">
            <span className="text-xs font-bold uppercase text-neutral-500">Issued</span><span className="text-right">{m.issued_on}</span>
            <span className="text-xs font-bold uppercase text-neutral-500">Due</span><span className="text-right font-semibold">{m.due_on}</span>
            <span className="text-xs font-bold uppercase text-neutral-500">For</span><span className="max-w-56 text-right">{m.proposal_name}</span>
          </div>
        </div>
        <div className="mt-8 flex items-center justify-between rounded-md px-5 py-4" style={{ background: `${accent}14` }}>
          <div>
            <div className="text-lg font-bold">{m.title}</div>
            <div className="text-sm text-neutral-600">
              {m.percent !== null ? `${m.percent}% of the ${money(m.contract_cents)} contract` : `Toward the ${money(m.contract_cents)} contract`}
            </div>
          </div>
          <div className="text-2xl font-bold tabular-nums">{money(m.amount_cents)}</div>
        </div>
        <div className="ml-auto mt-6 w-full max-w-sm space-y-1 text-sm">
          {[
            ["Contract total", money(m.contract_cents)],
            ...(m.billed_before_cents ? [["Previously invoiced", money(m.billed_before_cents)]] : []),
            ...(m.paid_before_cents ? [["Previously paid", money(m.paid_before_cents)]] : []),
            ["This invoice", money(m.amount_cents)],
            ...(m.paid_cents ? [["Paid on this invoice", `− ${money(m.paid_cents)}`]] : []),
          ].map(([k, v]) => (
            <div key={k} className="flex justify-between text-neutral-600"><span>{k}</span><span className="tabular-nums">{v}</span></div>
          ))}
          <div className="flex justify-between border-t border-[#29333d] pt-2 text-base font-bold">
            <span>{m.balance_cents === 0 ? "Paid in full" : "Amount due"}</span>
            <span className="tabular-nums">{money(m.balance_cents)}</span>
          </div>
        </div>
        {m.payments.length ? (
          <div className="mt-6 text-sm">
            <div className="font-semibold">Payments received</div>
            {m.payments.map((p, i) => (
              <div key={i} className="flex justify-between text-neutral-600">
                <span>{p.received_on} · {p.method}</span><span className="tabular-nums">{money(p.amount_cents)}</span>
              </div>
            ))}
          </div>
        ) : null}
        {m.branding.payment_instructions ? (
          <div className="mt-8 rounded-md border border-[#d1d4d9] p-4 text-sm">
            <div className="mb-1 font-semibold">How to pay</div>
            <div className="whitespace-pre-line">{m.branding.payment_instructions}</div>
          </div>
        ) : null}
        {m.notes ? <p className="mt-4 whitespace-pre-line text-sm text-neutral-600">{m.notes}</p> : null}
        {m.scope.length ? (
          <details className="mt-8 text-sm">
            <summary className="cursor-pointer font-semibold">Scope of work (per signed proposal)</summary>
            <div className="mt-2 space-y-3">
              {m.scope.map((g, i) => (
                <div key={i}>
                  {g.name ? <div className="font-medium">{g.name}</div> : null}
                  {g.lines.map((l, j) => (
                    <div key={j} className="flex justify-between pl-3 text-neutral-600">
                      <span>{l.name}</span><span className="tabular-nums">{`${l.qty} ${l.unit}`.trim()}</span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </details>
        ) : null}
        <div className="mt-10 border-t border-[#d1d4d9] pt-3 text-xs text-neutral-500">
          {[m.branding.company_name, m.rep.name, m.rep.email, m.branding.phone].filter(Boolean).join(" · ")}
        </div>
      </div>
    </section>
  );
}
