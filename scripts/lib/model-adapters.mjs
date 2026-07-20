// Model adapter boundary for the classifier. The domain service (classification.mjs)
// depends only on this shape and never on a concrete provider — the MCP server and
// n8n can later reuse the same service with the live adapter.
//
//   adapter.name        -> string
//   adapter.model       -> string
//   adapter.classify(packet) -> { text, usage:{input_tokens,output_tokens}, latency_ms }
//
// `text` is the model's raw response; parsing/validation/fail-closed is the domain's
// job, so a deliberately malformed recorded output exercises the retry+fail-closed path.

import { readFileSync } from 'node:fs';

const PRICING = {
  // USD per token; approximate published rates, used only for the 2B cost report.
  'claude-fable-5': { in: 3 / 1e6, out: 15 / 1e6 },
  default: { in: 3 / 1e6, out: 15 / 1e6 },
};

export function estimateCostUsd(model, usage) {
  const p = PRICING[model] || PRICING.default;
  return +(((usage?.input_tokens || 0) * p.in) + ((usage?.output_tokens || 0) * p.out)).toFixed(6);
}

// --- Deterministic fixture adapter (Runner 2A): returns recorded raw output ---
export function fixtureAdapter(recordedPath = 'fixtures/emails/model_recorded.json') {
  const recorded = JSON.parse(readFileSync(recordedPath, 'utf8'));
  return {
    name: 'fixture',
    model: 'recorded',
    async classify(packet) {
      const text = recorded[packet.fixture_name];
      if (text === undefined) throw new Error(`no recorded model output for ${packet.fixture_name}`);
      return { text, usage: { input_tokens: 0, output_tokens: 0 }, latency_ms: 0 };
    },
  };
}

// --- Live Anthropic adapter (Runner 2B): raw fetch, no SDK dependency ---
export function anthropicAdapter({ apiKey, model = 'claude-fable-5' } = {}) {
  if (!apiKey) {
    const e = new Error('ANTHROPIC_API_KEY is required for the live classifier (Runner 2B).');
    e.code = 'NO_API_KEY';
    throw e;
  }
  return {
    name: 'anthropic',
    model,
    async classify(packet) {
      const t0 = Date.now();
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model,
          max_tokens: 1024,
          system: packet.system,
          messages: [{ role: 'user', content: packet.user }],
        }),
      });
      const latency_ms = Date.now() - t0;
      const body = await res.json();
      if (!res.ok) throw new Error(`Anthropic API error (${res.status}): ${JSON.stringify(body).slice(0, 300)}`);
      const text = (body.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
      return { text, usage: body.usage || { input_tokens: 0, output_tokens: 0 }, latency_ms };
    },
  };
}
