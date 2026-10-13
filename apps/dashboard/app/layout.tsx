import type { Metadata } from "next";
import Link from "next/link";
import { Nav } from "@/components/nav";
import { baseCtx, currentAccount } from "@/lib/ctx";
import { logoutAction } from "./login/actions";
import "./globals.css";

export const metadata: Metadata = { title: "CareerFiend", description: "Tailored résumés and cover letters for every job you apply to" };
export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const account = await currentAccount().catch(() => null);
  const c = baseCtx().config;
  return (
    <html lang="en">
      <body>
        <a className="skip" href="#main">
          Skip to content
        </a>
        <header className="top">
          <div className="inner">
            <Link className="brand" href="/">
              CareerFiend
            </Link>
            {account && <Nav email={!!c.GMAIL_OAUTH_CLIENT_ID} />}
            {account && (
              <form action={logoutAction} className="logout">
                <span className="small muted">{account.email} </span>
                <button type="submit" className="link">
                  Sign out
                </button>
              </form>
            )}
          </div>
        </header>
        <main id="main">{children}</main>
      </body>
    </html>
  );
}
