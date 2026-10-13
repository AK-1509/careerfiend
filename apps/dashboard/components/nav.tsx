"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Applications" },
  { href: "/tracker", label: "Tracker" },
  { href: "/jobs", label: "Jobs" },
  { href: "/skills", label: "Skills" },
  { href: "/bank", label: "Skill bank" },
  { href: "/profile", label: "Profile" },
  { href: "/email", label: "Email" },
  { href: "/watchlist", label: "Watchlist" },
  { href: "/projects", label: "Project Recommendations" },
  { href: "/settings", label: "Settings" },
];

/** `email`: show the Email tab (only when this site has a Gmail OAuth client configured). */
export function Nav({ email }: { email: boolean }) {
  const path = usePathname();
  return (
    <nav aria-label="Main">
      <ul>
        {LINKS.filter((l) => email || l.href !== "/email").map((l) => {
          const current = l.href === "/" ? path === "/" : path.startsWith(l.href);
          return (
            <li key={l.href}>
              <Link href={l.href} aria-current={current ? "page" : undefined}>
                {l.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
