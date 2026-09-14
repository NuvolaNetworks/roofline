"use client";

import { useEffect, useState } from "react";

/**
 * Platform IdP return URL. The identity JWT is placed in the fragment
 * (`#amos_token=`) so it never hits server logs or Referer. This page lifts
 * it into the existing `/auth/amos?token=` handler, which then strips it.
 */
export default function AmosCallbackPage() {
  const [status, setStatus] = useState("Finishing sign-in…");
  useEffect(() => {
    const hash = window.location.hash.replace(/^#/, "");
    const token = new URLSearchParams(hash).get("amos_token");
    if (!token) {
      setStatus("Sign-in failed.");
      window.location.replace("/login?error=amos");
      return;
    }
    window.location.replace(`/auth/amos?token=${encodeURIComponent(token)}`);
  }, []);
  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <p className="text-sm text-[var(--muted)]">{status}</p>
    </div>
  );
}
