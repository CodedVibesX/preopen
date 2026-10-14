import "./globals.css";
import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "preopen",
  description: "The newest NYC food businesses, so new the Health Department has not inspected them yet, turned into walkable door to door days and a HubSpot import.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
