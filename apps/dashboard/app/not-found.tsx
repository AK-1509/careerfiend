import Link from "next/link";

export default function NotFound() {
  return (
    <>
      <h1>Not found</h1>
      <p>
        <Link href="/">Back to the daily queue</Link>
      </p>
    </>
  );
}
