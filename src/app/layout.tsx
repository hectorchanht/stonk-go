import "~/styles/globals.css";

import { GeistSans } from "geist/font/sans";
import { type Metadata } from "next";

import { Providers } from "~/app/_components/providers";

export const metadata: Metadata = {
  title: "stonk-go · personal investing portfolio",
  description:
    "A simple self-hosted portfolio tracker: holdings, transactions, and live market prices.",
  icons: [
    { rel: "icon", url: "/favicon.png", type: "image/png" },
    { rel: "apple-touch-icon", url: "/apple-touch-icon.png" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${GeistSans.variable} dark`}>
      <body className="bg-zinc-950">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
