import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Reputation Tracker",
  description: "Track what the web says about your organization.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-neutral-50 text-neutral-900 antialiased">{children}</body>
    </html>
  );
}
