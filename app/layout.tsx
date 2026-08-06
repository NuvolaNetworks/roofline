import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Roofline — jobs, proposals, production",
  description: "The construction CRM, powered by AMOS.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
