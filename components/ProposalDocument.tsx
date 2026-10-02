// HTML rendering of a proposal render model — what the customer reads on
// the signing page and what the rep previews in-app. Same model, same block
// order as the PDF (lib/proposal-pdf.ts), laid out as paper "pages".
import type { RenderBlock, RenderModel } from "@/lib/proposal-model";
import { addressLines, money } from "@/lib/proposal-model";

export interface SignatureView {
  src: string;
  date: string;
}

interface Props {
  model: RenderModel;
  signatures?: Partial<Record<"customer" | "contractor", SignatureView>>;
  /** URL for an attachment (spec sheet) — null hides the link. */
  attachmentHref?: (fileId: number) => string | null;
  logoSrc?: string | null;
}

function Paper({ accent, title, children, model, logoSrc }: { accent: string; title?: string; children: React.ReactNode; model: RenderModel; logoSrc?: string | null }) {
  return (
    <section className="mx-auto mb-6 w-full max-w-[816px] overflow-hidden rounded-sm bg-white text-[#29333d] shadow-md">
      <div className="mx-3 mt-3 h-2" style={{ background: accent }} />
      <div className="px-6 pb-6 pt-4 sm:px-10">
        {title ? <h2 className="mb-5 text-2xl font-bold">{title}</h2> : null}
        {children}
      </div>
      <Footer model={model} logoSrc={logoSrc} />
    </section>
  );
}

function Mark({ model, logoSrc, large }: { model: RenderModel; logoSrc?: string | null; large?: boolean }) {
  if (logoSrc) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={logoSrc} alt={model.branding.company_name} className={large ? "mx-auto max-h-48 max-w-full" : "max-h-12 max-w-[160px]"} />;
  }
  if (large) {
    return (
      <div className="text-center">
        <div className="text-4xl font-bold uppercase tracking-tight text-white sm:text-5xl">{model.branding.company_name}</div>
        <div className="mx-auto mt-3 h-[3px] w-3/4" style={{ background: model.branding.accent }} />
      </div>
    );
  }
  return model.branding.company_name ? (
    <div className="max-w-[160px] bg-black px-3 py-2 text-center text-xs font-bold uppercase leading-tight text-white">
      {model.branding.company_name}
    </div>
  ) : null;
}

function Footer({ model, logoSrc }: { model: RenderModel; logoSrc?: string | null }) {
  const r = model.rep;
  return (
    <div className="mx-6 flex items-end justify-between border-t border-[#d1d4d9] py-4 text-xs sm:mx-10">
      <div className="leading-5">
        {[r.name, r.company, r.phone, r.email].filter(Boolean).map((l) => (
          <div key={l}>{l}</div>
        ))}
      </div>
      <Mark model={model} logoSrc={logoSrc} />
    </div>
  );
}

function Cover({ model, title, logoSrc }: { model: RenderModel; title: string; logoSrc?: string | null }) {
  const accent = model.branding.accent;
  const c = model.customer;
  return (
    <section className="mx-auto mb-6 w-full max-w-[816px] overflow-hidden rounded-sm bg-white text-[#29333d] shadow-md">
      <div className="bg-black px-6 pb-10 pt-14">
        <Mark model={model} logoSrc={logoSrc} large />
        {model.branding.tagline ? (
          <p className="mt-6 text-center text-sm italic text-neutral-400">{model.branding.tagline}</p>
        ) : null}
        {model.branding.stats.length ? (
          <div className="mt-8 grid" style={{ gridTemplateColumns: `repeat(${model.branding.stats.length}, minmax(0, 1fr))` }}>
            {model.branding.stats.map((s, i) => (
              <div key={i} className="border px-1 py-5 text-center" style={{ borderColor: accent }}>
                <div className="text-2xl font-bold sm:text-4xl" style={{ color: accent }}>{s.value}</div>
                <div className="mt-1 text-[10px] font-bold uppercase tracking-wide text-white">{s.label}</div>
              </div>
            ))}
          </div>
        ) : null}
      </div>
      <div className="h-2" style={{ background: accent }} />
      <div className="flex flex-wrap justify-between gap-6 px-6 py-8 sm:px-10">
        <div>
          <div className="text-xs">Date Prepared</div>
          <div className="text-xs font-bold">{model.proposal.date_prepared}</div>
          <div className="mt-2 text-3xl font-bold">{title}</div>
        </div>
        <div className="text-right leading-6">
          {[c.name, c.email, c.phone, ...addressLines(c.address)].filter(Boolean).map((l) => (
            <div key={l}>{l}</div>
          ))}
        </div>
      </div>
      <Footer model={model} logoSrc={logoSrc} />
    </section>
  );
}

function Block({ block, props }: { block: RenderBlock; props: Props }) {
  const { model, signatures = {}, attachmentHref, logoSrc } = props;
  const accent = model.branding.accent;
  switch (block.type) {
    case "cover":
      return <Cover model={model} title={block.title} logoSrc={logoSrc} />;
    case "line_items":
      return (
        <Paper accent={accent} title={block.title} model={model} logoSrc={logoSrc}>
          <div className="flex justify-between border-b border-[#29333d] pb-2 text-xs text-neutral-500">
            <span>Item</span>
            <span className="flex gap-10">
              <span>Qty</span>
              {block.show_prices ? <span className="w-20 text-right">Amount</span> : null}
            </span>
          </div>
          {block.groups.map((g, gi) => (
            <div key={gi} className="mt-5">
              <h3 className="border-b border-[#d1d4d9] pb-2 text-lg">{g.name || "Items"}</h3>
              {g.lines.map((l, li) => (
                <div key={li} className="ml-3 flex justify-between gap-4 border-b border-[#e4e6e9] py-3 text-sm">
                  <div className="min-w-0">
                    <div>{l.name}</div>
                    {l.notes.map((n, ni) => (
                      <div key={ni} className="text-[13px] text-black">{n}</div>
                    ))}
                  </div>
                  <div className="flex shrink-0 gap-6 tabular-nums">
                    <span>{l.qty} {l.unit}</span>
                    {block.show_prices ? <span className="w-20 text-right">{money(l.amount_cents)}</span> : null}
                  </div>
                </div>
              ))}
            </div>
          ))}
          {block.show_subtotal ? (
            <div className="mt-4 flex justify-between border-t border-[#29333d] pt-4 text-lg">
              <span>Estimate subtotal</span>
              <span className="tabular-nums">{money(block.subtotal_cents)}</span>
            </div>
          ) : null}
        </Paper>
      );
    case "summary":
      return (
        <Paper accent={accent} title={block.title} model={model} logoSrc={logoSrc}>
          {block.intro ? <p className="mb-5 text-sm">{block.intro}</p> : null}
          {block.rows.map((r, i) => (
            <div key={i} className="mb-3 flex justify-between rounded border border-[#d1d4d9] px-5 py-4">
              <span className="font-bold">{r.label}</span>
              <span className="tabular-nums">{money(r.amount_cents)}</span>
            </div>
          ))}
          <div className="ml-auto mt-6 flex w-1/2 min-w-[220px] justify-between border-t border-[#29333d] pt-3 font-bold">
            <span>Total</span>
            <span className="tabular-nums">{money(block.total_cents)}</span>
          </div>
          <div className="mt-8 space-y-6">
            {block.signers.map((s) => {
              const sig = signatures[s.role];
              return (
                <div key={s.role} className="grid grid-cols-[1fr_180px] gap-4">
                  <div>
                    <div className="flex h-14 items-end border-b border-neutral-400">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      {sig ? <img src={sig.src} alt={`Signature of ${s.label}`} className="max-h-12" /> : null}
                    </div>
                    <div className="mt-1 text-xs">{s.label}</div>
                  </div>
                  <div>
                    <div className="flex h-14 items-end border-b border-neutral-400 pb-1 text-xs">{sig?.date ?? ""}</div>
                    <div className="mt-1 text-xs">Date</div>
                  </div>
                </div>
              );
            })}
          </div>
          {block.consent ? <p className="mt-6 text-xs leading-6 text-neutral-500">{block.consent}</p> : null}
        </Paper>
      );
    case "attachments":
      return (
        <Paper accent={accent} title={block.title || "Attachments"} model={model} logoSrc={logoSrc}>
          <p className="mb-3 text-sm text-neutral-600">These product documents are part of this proposal.</p>
          <ul className="space-y-2 text-sm">
            {block.files.map((f) => {
              const href = attachmentHref?.(f.file_id);
              return (
                <li key={f.file_id} className="flex items-center justify-between rounded border border-[#d1d4d9] px-4 py-3">
                  <span>{f.filename}</span>
                  {href ? (
                    <a href={href} target="_blank" rel="noreferrer" className="text-sm font-medium" style={{ color: accent }}>
                      View
                    </a>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </Paper>
      );
    case "text":
      return (
        <Paper accent={accent} title={block.title} model={model} logoSrc={logoSrc}>
          <div className="space-y-3 text-sm leading-6">
            {block.nodes.map((n, i) =>
              n.kind === "heading" ? (
                <h3 key={i} className="pl-6 pt-2 font-bold">{n.text}</h3>
              ) : n.kind === "bullet" ? (
                <p key={i}>· {n.text}</p>
              ) : (
                <p key={i}>{n.text}</p>
              ),
            )}
          </div>
        </Paper>
      );
  }
}

export default function ProposalDocument(props: Props) {
  return (
    <div>
      {props.model.blocks.map((b, i) => (
        <Block key={i} block={b} props={props} />
      ))}
    </div>
  );
}
