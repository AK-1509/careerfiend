"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Re-renders the page every few seconds while background work is running. */
export function AutoRefresh({ seconds }: { seconds: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => router.refresh(), seconds * 1000);
    return () => clearInterval(t);
  }, [router, seconds]);
  return null;
}
