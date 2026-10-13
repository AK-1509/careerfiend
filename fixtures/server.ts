/**
 * Local fixture site: job listings (/listings), ATS-like application forms
 * (/ats) and a submission recorder. Tests and the demo run against this
 * server; CareerFiend never runs automated tests against real job sites.
 *
 *   npm run fixtures            # http://localhost:4545
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));

export interface RecordedSubmission {
  form: string;
  at: string;
  fields: Record<string, string>;
  files: { field: string; filename: string; sha256: string; size: number }[];
}

export interface FixtureServer {
  url: string;
  port: number;
  submissions: RecordedSubmission[];
  close(): Promise<void>;
}

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".json": "application/json", ".js": "text/javascript" };

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

function staticFile(urlPath: string): string | null {
  const map: [string, string][] = [
    ["/listings/", "listings"],
    ["/ats/", "ats-pages"],
    ["/ats-api/", "ats-api"],
  ];
  for (const [prefix, dir] of map) {
    if (urlPath.startsWith(prefix)) {
      const rel = urlPath.slice(prefix.length);
      const file = path.join(ROOT, dir, rel);
      if (!file.startsWith(path.join(ROOT, dir))) return null;
      if (existsSync(file) && statSync(file).isFile()) return file;
    }
  }
  return null;
}

export function startFixtureServer(port = 0): Promise<FixtureServer> {
  const submissions: RecordedSubmission[] = [];
  const server: Server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" }).end("User-agent: *\nAllow: /\n");
        return;
      }
      if (req.method === "GET" && url.pathname === "/ats/_submissions") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(submissions));
        return;
      }
      if (req.method === "POST" && url.pathname === "/ats/_reset") {
        submissions.length = 0;
        res.writeHead(204).end();
        return;
      }
      const submit = /^\/ats\/submit\/([a-z0-9-]+)$/.exec(url.pathname);
      if (req.method === "POST" && submit) {
        const body = await readBody(req);
        const request = new Request("http://localhost/x", {
          method: "POST",
          headers: { "content-type": req.headers["content-type"] ?? "application/x-www-form-urlencoded" },
          body: new Uint8Array(body),
        });
        const form = await request.formData();
        const rec: RecordedSubmission = { form: submit[1]!, at: new Date().toISOString(), fields: {}, files: [] };
        for (const [k, v] of form.entries()) {
          if (typeof v === "string") rec.fields[k] = v;
          else {
            const buf = Buffer.from(await v.arrayBuffer());
            if (buf.length) rec.files.push({ field: k, filename: v.name, sha256: createHash("sha256").update(buf).digest("hex"), size: buf.length });
          }
        }
        submissions.push(rec);
        if (rec.form === "ambiguous") {
          await new Promise((r) => setTimeout(r, 1500));
          res
            .writeHead(200, { "content-type": "text/html" })
            .end("<!doctype html><html><body><h1>Please wait</h1><p>We are processing your request.</p></body></html>");
          return;
        }
        res
          .writeHead(200, { "content-type": "text/html" })
          .end(
            `<!doctype html><html><head><title>Application received</title></head><body><h1>Thank you for applying!</h1><p>Your application has been submitted. Reference number: FX-${submissions.length}.</p></body></html>`,
          );
        return;
      }
      if (req.method === "POST" && url.pathname === "/ats/login") {
        res.writeHead(200, { "content-type": "text/html" }).end("<html><body><h1>Invalid credentials</h1></body></html>");
        return;
      }
      const file = staticFile(url.pathname);
      if (req.method === "GET" && file) {
        res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
        return;
      }
      res.writeHead(404, { "content-type": "text/html" }).end("<h1>Not found</h1>");
    } catch (err) {
      res.writeHead(500).end(String(err));
    }
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      const p = typeof addr === "object" && addr ? addr.port : port;
      resolve({
        url: `http://localhost:${p}`,
        port: p,
        submissions,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.FIXTURE_PORT ?? 4545);
  startFixtureServer(port).then((s) => console.log(`Fixture site on ${s.url}  (listings: ${s.url}/listings/, forms: ${s.url}/ats/)`));
}
