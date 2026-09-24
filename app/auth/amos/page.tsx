"use client";

import { useEffect, useState } from "react";

/**
 * The AMOS sign-in callback. The platform redirects here with the identity
 * token in the URL fragment (#amos_token=…), which never reaches a server log.
 * We hand it to our own API once, drop it from the address bar, and continue.
 */
export default function AmosCallbackPage() {
  const [message, setMessage] = useState("Finishing sign-in…");
  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const token = params.get("amos_token");
    window.history.replaceState(null, "", window.location.pathname);
    if (!token) {
      setMessage("No sign-in token was returned. Try signing in again.");
      return;
    }
    fetch("/api/auth/amos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    })
      .then(async (res) => {
        if (res.ok) {
          window.location.replace("/");
          return;
        }
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setMessage(body.error || "Sign-in was not accepted. Try again.");
      })
      .catch(() => setMessage("Could not reach Roofline to finish sign-in. Try again."));
  }, []);
  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-2xl border border-[var(--card-border)] bg-[var(--card)] p-8 text-center shadow-sm">
        <p className="text-sm text-[var(--muted)]">{message}</p>
        <a href="/login" className="mt-4 inline-block text-sm text-[var(--accent)] underline">
          Back to sign in
        </a>
      </div>
    </div>
  );
}
