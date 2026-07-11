// The research articles — full, self-contained content rendered Medium-style at
// /research/[slug]. Each research card on /research links here (internal), so a
// reader stays on an article page instead of being bounced into the docs.

export type Block =
  | { type: 'p'; text: string }
  | { type: 'h2'; text: string }
  | { type: 'quote'; text: string }
  | { type: 'ul'; items: string[] }
  | { type: 'code'; code: string }

export interface Article {
  slug: string
  tag: string
  title: string
  subtitle: string
  readMin: number
  date: string
  body: Block[]
}

export const ARTICLES: Article[] = [
  {
    slug: 'verifiable-autonomy',
    tag: 'Thesis',
    title: 'Verifiable autonomy: the AI advises, code enforces',
    subtitle:
      'Why an autonomous agent should never hold your keys — and how deterministic gates make “the model was wrong” a non-event for your money.',
    readMin: 6,
    date: 'Jul 2026',
    body: [
      {
        type: 'p',
        text: 'Every argument against letting an AI touch money comes down to one word: trust. You can’t audit a model’s reasoning the way you audit a bank statement. It can be confidently wrong. It can be talked into things. So the usual answer is to keep the AI at arm’s length — let it suggest, but make a human click the button every time.',
      },
      {
        type: 'p',
        text: 'Lyra takes a different position. The AI is not the thing you trust. The rules are. The model proposes; deterministic code decides whether the proposal is allowed to happen. If the model is brilliant, great. If it’s hallucinating, the outcome is the same for your funds: nothing happens outside the lines you drew.',
      },
      { type: 'h2', text: 'The AI never holds the keys' },
      {
        type: 'p',
        text: 'Your money lives in an on-chain treasury you own, not in the agent’s wallet. The agent is a delegate with a spending limit, not a custodian. It can draw funds only through a policy-gated path that re-checks every rule on-chain at the moment of the transaction — budget, per-transaction cap, which assets, which protocols, an expiry, and a kill switch.',
      },
      {
        type: 'quote',
        text: 'A leaked agent key — or even a compromised server — is bounded by the policy and revocable by you. The platform never has unbounded access to your funds.',
      },
      { type: 'h2', text: 'Wrong model, right outcome' },
      {
        type: 'p',
        text: 'This is the whole point of moving the guardrails off the model and onto the chain. Prompt injection, a bad fine-tune, a jailbreak in the chat — none of them change what the code will let through. The limits aren’t a setting inside the AI that a clever message can flip. They’re enforced by a Move package on Sui that doesn’t read English and doesn’t get persuaded.',
      },
      {
        type: 'p',
        text: 'The result is a kind of autonomy you can actually verify. You don’t have to believe the agent is safe. You can read the policy, watch it get enforced on every action, and pull the whole treasury back whenever you want.',
      },
    ],
  },
  {
    slug: 'four-gate-pipeline',
    tag: 'Architecture',
    title: 'The four-gate write pipeline',
    subtitle:
      'Policy → simulate → approve → execute. How every transaction is checked before it ever broadcasts on Sui.',
    readMin: 5,
    date: 'Jul 2026',
    body: [
      {
        type: 'p',
        text: 'Most bots do the thing, then tell you if it broke. Lyra checks first. Every value-moving action runs through the same four gates, in order, and any gate can stop it before a single coin leaves your treasury.',
      },
      { type: 'h2', text: '1. Policy' },
      {
        type: 'p',
        text: 'Before anything is built, the requested action is measured against your deterministic policy: the per-transaction cap, the lifetime budget, the allowed assets and protocols, the slippage ceiling, and whether the agent is even allowed to write right now. Fail here and the pipeline stops with a plain-English reason.',
      },
      { type: 'h2', text: '2. Simulate' },
      {
        type: 'p',
        text: 'The transaction is dry-run against the live chain state. If it would revert, overspend, or leave a value unconsumed, that shows up now — before broadcast, not after. A doomed transaction never gets reported as a success.',
      },
      { type: 'h2', text: '3. Approve' },
      {
        type: 'p',
        text: 'Depending on your autonomy tier, small routine actions can execute automatically while anything above a threshold waits for your explicit approval — from the terminal, the web console, or a Telegram tap. You decide where the line sits.',
      },
      { type: 'h2', text: '4. Execute' },
      {
        type: 'p',
        text: 'Only a transaction that passed all three prior gates is signed and broadcast. The agent draws the funds from your treasury through the on-chain policy, which re-runs the full check one more time in Move — and the action leaves a receipt with its transaction digest.',
      },
      {
        type: 'quote',
        text: 'Fail-closed by design: if any gate is unsure, the answer is no. The safe failure is the one that does nothing.',
      },
    ],
  },
  {
    slug: 'sui-address-identity',
    tag: 'Identity',
    title: 'A Sui address is the agent identity',
    subtitle:
      'Each agent is a keypair. Its on-chain history of policy-checked transactions and receipts lets a track record be checked, not just claimed.',
    readMin: 5,
    date: 'Jul 2026',
    body: [
      {
        type: 'p',
        text: 'An AI agent that can act in the world needs an identity — but not a username in someone’s database. Lyra’s agents are Sui keypairs. The address is the identity, and everything the agent has ever done is attached to it on a public chain.',
      },
      { type: 'h2', text: 'Derived, not shared' },
      {
        type: 'p',
        text: 'Each owner gets an agent that is deterministically derived from their wallet. Sign in with your Sui address and the same agent resolves every time — no accounts to create, no keys to email around. The agent belongs to you because it comes from you.',
      },
      { type: 'h2', text: 'A track record you can check' },
      {
        type: 'p',
        text: 'Because every action is a policy-checked transaction that mints an on-chain receipt, an agent’s history isn’t a claim in a pitch deck — it’s a queryable ledger. What it spent, on which protocols, within which limits, when. You can audit an agent the way you audit an address.',
      },
      {
        type: 'quote',
        text: 'Reputation stops being a story the platform tells you and becomes something anyone can verify against the chain.',
      },
      {
        type: 'p',
        text: 'This is what makes delegation safe to reason about. The owner holds the capability that governs the agent; the agent holds only the ability to act within it. Rotate the key, tighten the policy, or revoke entirely — the identity and its history stay intact and legible.',
      },
    ],
  },
  {
    slug: 'policy-as-code',
    tag: 'Policy',
    title: 'Policy as code, not prompts',
    subtitle:
      'Why fund controls belong in deterministic code and an on-chain Move package — allowlists, caps, slippage and health-factor floors.',
    readMin: 6,
    date: 'Jul 2026',
    body: [
      {
        type: 'p',
        text: 'You can talk an AI into almost anything. That’s the entire problem with letting one near your money. So Lyra doesn’t keep the limits in the AI. They live in code — and the parts that matter live on-chain, in the lyra::policy Move package.',
      },
      { type: 'h2', text: 'What the policy controls' },
      {
        type: 'ul',
        items: [
          'A per-transaction cap and a lifetime budget, enforced on every draw.',
          'Allowlists for coins and protocols — the agent can only touch what you’ve authorized.',
          'A recipient allowlist for transfers, so a compromised agent can only pay known payees.',
          'A slippage ceiling for swaps, and an expiry after which the delegation simply stops working.',
        ],
      },
      { type: 'h2', text: 'Updatable without a redeploy' },
      {
        type: 'p',
        text: 'The Sui ecosystem keeps growing. New protocols and assets appear constantly, so the allowlists aren’t frozen at creation — the owner can authorize a new protocol or coin with a single transaction, gated by the capability only they hold. The agent can never widen its own limits; only the owner can.',
      },
      { type: 'h2', text: 'Enforced where it can’t be argued with' },
      {
        type: 'p',
        text: 'When the agent moves funds, the Move package re-runs the whole check on-chain: right signer, under budget, under the cap, allowed asset, allowed protocol, not expired, not revoked. Ask it to break a rule and the transaction aborts. There is no natural-language exception, because the enforcer doesn’t speak natural language.',
      },
      {
        type: 'quote',
        text: 'Your limits aren’t a setting someone can flip. They’re baked into the chain.',
      },
    ],
  },
  {
    slug: 'brain-and-memory',
    tag: 'Runtime',
    title: 'The agent’s brain & memory',
    subtitle:
      'The model-agnostic brain, file-based memory, and how context is assembled — and kept honest — on every turn.',
    readMin: 5,
    date: 'Jul 2026',
    body: [
      {
        type: 'p',
        text: 'The “brain” is the part that turns a plain-language goal into a plan. It’s deliberately model-agnostic: any OpenAI-compatible model can drive it. What matters isn’t which model you pick — it’s that whatever the brain decides still has to pass the gates before it touches funds.',
      },
      { type: 'h2', text: 'Memory that sticks' },
      {
        type: 'p',
        text: 'An agent that forgets everything each session isn’t one you’d trust with money. Lyra keeps a working memory of what it did and why, and stores its durable memory and receipts on Walrus — decentralized storage on Sui — so the record persists across sessions and can’t be quietly edited after the fact.',
      },
      { type: 'h2', text: 'Context, assembled per turn' },
      {
        type: 'p',
        text: 'On each turn the runtime assembles the context the model sees: the active policy and limits, the relevant memory, the tools available, and the current on-chain state. The model reasons over that — but it only ever proposes tool calls. The runtime, not the model, decides what actually runs.',
      },
      {
        type: 'quote',
        text: 'The model’s job is to be helpful. The runtime’s job is to make sure “helpful” never means “outside your rules.”',
      },
    ],
  },
  {
    slug: 'tools-and-plugins',
    tag: 'Runtime',
    title: 'Tools & plugins',
    subtitle:
      'The tool registry and plugin host that give the agent real capabilities — read, swap, lend, stake, transfer.',
    readMin: 5,
    date: 'Jul 2026',
    body: [
      {
        type: 'p',
        text: 'A brain with no hands is just a chatbot. Lyra’s capabilities come from a tool registry: each tool is a typed capability the agent can invoke, and a plugin host wires them in. The same registry powers the terminal, the web console, and Telegram — one set of tools, everywhere.',
      },
      { type: 'h2', text: 'What the agent can actually do' },
      {
        type: 'ul',
        items: [
          'Read: balances, positions, market rates, and its own on-chain history.',
          'Earn: supply, borrow, and withdraw across the major Sui money markets.',
          'Stake: native delegation and liquid staking.',
          'Swap: best-route across the big Sui exchanges.',
          'Transfer: send funds — bounded by the recipient allowlist.',
        ],
      },
      { type: 'h2', text: 'Every tool runs the same pipeline' },
      {
        type: 'p',
        text: 'Adding a capability doesn’t add a way around the rules. Every value-moving tool routes through the same policy → simulate → approve → execute pipeline, and sources funds from the treasury through the on-chain policy. A new protocol integration is a new tool plus one allowlist entry — never a new hole in the guardrails.',
      },
      {
        type: 'quote',
        text: 'Capabilities grow; the safety model doesn’t bend to fit them.',
      },
    ],
  },
]

export const ARTICLES_BY_SLUG: Record<string, Article> = Object.fromEntries(
  ARTICLES.map(a => [a.slug, a]),
)
