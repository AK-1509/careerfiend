import { LM_PRESETS } from "@careerfiend/ai";
import { connectLmAction, skipLmAction } from "@/app/actions";

/**
 * The "connect your language model" prompt (public edition). Shown on the Daily
 * queue right after sign-up (with Skip) and on Settings.
 */
export function LmConnectForm({ back, showSkip }: { back: "/" | "/settings"; showSkip: boolean }) {
  return (
    <div className="stack">
      <form action={connectLmAction} className="stack" aria-label="Connect a language model">
        <input type="hidden" name="back" value={back} />
        <div className="grid two" style={{ gap: "0.5rem" }}>
          <div>
            <label htmlFor={`lm-provider-${back}`}>Provider</label>
            <select id={`lm-provider-${back}`} name="provider" defaultValue="anthropic" required>
              {LM_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor={`lm-model-${back}`}>Model</label>
            <input
              id={`lm-model-${back}`}
              name="model"
              type="text"
              placeholder="e.g. claude-sonnet-5-5, or the model id your provider lists"
              aria-describedby={`lm-model-help-${back}`}
            />
            <span id={`lm-model-help-${back}`} className="small muted">
              Blank uses the provider&apos;s default where it has one (Anthropic, DeepSeek).
            </span>
          </div>
          <div>
            <label htmlFor={`lm-key-${back}`}>API key</label>
            <input id={`lm-key-${back}`} name="apiKey" type="password" autoComplete="off" spellCheck={false} />
          </div>
          <div>
            <label htmlFor={`lm-base-${back}`}>API base URL (only for &quot;Other OpenAI-compatible API&quot;)</label>
            <input id={`lm-base-${back}`} name="baseUrl" type="url" placeholder="https://api.example.com/v1" />
          </div>
        </div>
        <details>
          <summary className="small">Advanced: a cheaper model for extraction steps</summary>
          <label htmlFor={`lm-fast-${back}`}>Fast model (optional)</label>
          <input id={`lm-fast-${back}`} name="fastModel" type="text" placeholder="e.g. claude-haiku-5-5" />
        </details>
        <details>
          <summary className="small">Where do I get a key?</summary>
          <ul className="small">
            {LM_PRESETS.filter((p) => p.keyUrl || p.note).map((p) => (
              <li key={p.id}>
                <strong>{p.label}</strong>
                {p.keyUrl && (
                  <>
                    {": "}
                    <a href={p.keyUrl} target="_blank" rel="noreferrer noopener">
                      {p.keyUrl.replace(/^https:\/\//, "")}
                    </a>
                  </>
                )}
                {p.note && <span className="muted"> {p.note}</span>}
              </li>
            ))}
          </ul>
        </details>
        <p className="small muted" style={{ margin: 0 }}>
          We send one tiny test request before saving. Your key is encrypted with a key unique to your account, is used only for your own requests, and is never
          shown again (only its last 4 characters). Usage is billed by your provider.
        </p>
        <div className="row">
          <button type="submit" className="primary">
            Test and connect
          </button>
        </div>
      </form>
      {showSkip && (
        <form action={skipLmAction}>
          <input type="hidden" name="back" value={back} />
          <button type="submit">Skip for now</button>{" "}
          <span className="small muted">Everything except Project Recommendations works without a model. You can connect one later in Settings.</span>
        </form>
      )}
    </div>
  );
}
