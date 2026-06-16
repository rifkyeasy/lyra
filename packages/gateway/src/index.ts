import { loadConfig } from 'lyra-core'
import { runGoal } from 'lyra-ai-agent'

/**
 * Long-running HTTP daemon exposing the policy-bound agent. The web console and
 * integrations POST a goal; the agent plans + executes it within policy and
 * returns the structured result (plan, status, tx, Walrus receipt).
 */
export function startGateway(
  port = Number(process.env.LYRA_GATEWAY_PORT ?? process.env.PORT ?? 8787),
) {
  const cfg = loadConfig()
  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url)
      const cors = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      }
      if (req.method === 'OPTIONS') return new Response(null, { headers: cors })

      if (url.pathname === '/health') {
        return Response.json({ ok: true, network: cfg.network, package: cfg.packageId }, { headers: cors })
      }
      if (req.method === 'POST' && url.pathname === '/api/goal') {
        let body: { goal?: string }
        try {
          body = (await req.json()) as { goal?: string }
        } catch {
          return Response.json({ error: 'invalid JSON' }, { status: 400, headers: cors })
        }
        if (!body.goal) return Response.json({ error: 'goal required' }, { status: 400, headers: cors })
        try {
          const result = await runGoal(body.goal, { log: false })
          return Response.json(result, { headers: cors })
        } catch (e) {
          return Response.json({ error: (e as Error).message }, { status: 500, headers: cors })
        }
      }
      return new Response('Lyra gateway — POST /api/goal {"goal":"…"}', { status: 200, headers: cors })
    },
  })
  console.log(`lyra-gateway listening on http://localhost:${port} (${cfg.network})`)
  return server
}
