"use client";

// Draw-or-type signature capture. Either way the result is a transparent
// PNG data URL in a hidden `signature` input (plus `method` and
// `typed_name`), which the server validates and stamps into the PDF.
import { useEffect, useRef, useState } from "react";

const W = 600;
const H = 160;
const SCRIPT_FONT = `'Snell Roundhand', 'Segoe Script', 'Brush Script MT', 'Apple Chancery', cursive`;

export default function SignaturePad({ defaultName = "", accent = "#1c5cab" }: { defaultName?: string; accent?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const [mode, setMode] = useState<"draw" | "type">("type");
  const [typed, setTyped] = useState(defaultName);
  const [dataUrl, setDataUrl] = useState("");
  const [drawn, setDrawn] = useState(false);

  const ctx = () => {
    const c = canvas.current!;
    const g = c.getContext("2d")!;
    return { c, g };
  };

  const clear = () => {
    const { c, g } = ctx();
    g.clearRect(0, 0, c.width, c.height);
    setDrawn(false);
    setDataUrl("");
  };

  // Typed mode: render the name in a script face.
  useEffect(() => {
    if (mode !== "type") return;
    const { c, g } = ctx();
    g.clearRect(0, 0, c.width, c.height);
    const name = typed.trim();
    if (!name) {
      setDataUrl("");
      return;
    }
    let size = 72;
    g.fillStyle = "#1b2430";
    g.textBaseline = "middle";
    do {
      g.font = `${size}px ${SCRIPT_FONT}`;
      size -= 4;
    } while (g.measureText(name).width > W - 40 && size > 20);
    g.fillText(name, 20, H / 2 + 6);
    setDataUrl(c.toDataURL("image/png"));
  }, [mode, typed]);

  const pos = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
  };

  const down = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (mode !== "draw") return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = true;
    last.current = pos(e);
  };
  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current || mode !== "draw") return;
    const { g } = ctx();
    const p = pos(e);
    g.strokeStyle = "#1b2430";
    g.lineWidth = 3;
    g.lineCap = "round";
    g.lineJoin = "round";
    g.beginPath();
    g.moveTo(last.current!.x, last.current!.y);
    g.lineTo(p.x, p.y);
    g.stroke();
    last.current = p;
    setDrawn(true);
  };
  const up = () => {
    if (!drawing.current) return;
    drawing.current = false;
    if (drawn) setDataUrl(canvas.current!.toDataURL("image/png"));
  };

  const switchTo = (m: "draw" | "type") => {
    setMode(m);
    clear();
  };

  const tab = (m: "draw" | "type", label: string) => (
    <button
      type="button"
      onClick={() => switchTo(m)}
      className={`rounded-md px-3 py-1 text-sm ${mode === m ? "text-white" : "text-neutral-600 hover:bg-black/5"}`}
      style={mode === m ? { background: accent } : undefined}
    >
      {label}
    </button>
  );

  return (
    <div>
      <div className="mb-2 flex gap-1">
        {tab("type", "Type")}
        {tab("draw", "Draw")}
      </div>
      {mode === "type" ? (
        <input
          name="typed_name"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder="Type your full name"
          className="mb-2 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm"
          maxLength={80}
          autoComplete="name"
        />
      ) : null}
      <div className="relative rounded-lg border border-dashed border-neutral-400 bg-white">
        <canvas
          ref={canvas}
          width={W}
          height={H}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerLeave={up}
          className={`block h-auto w-full ${mode === "draw" ? "cursor-crosshair touch-none" : ""}`}
          aria-label={mode === "draw" ? "Draw your signature" : "Signature preview"}
        />
        <div className="pointer-events-none absolute bottom-6 left-5 right-5 border-b border-neutral-300" />
        {mode === "draw" && !drawn ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-neutral-400">
            Sign here with your mouse or finger
          </div>
        ) : null}
      </div>
      {mode === "draw" ? (
        <button type="button" onClick={clear} className="mt-1 text-xs text-neutral-500 hover:underline">
          Clear
        </button>
      ) : null}
      <input type="hidden" name="signature" value={dataUrl} />
      <input type="hidden" name="method" value={mode === "draw" ? "drawn" : "typed"} />
    </div>
  );
}
