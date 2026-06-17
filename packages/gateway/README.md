# lyra-gateway

The always-on **gateway daemon** for **lyra**. Keeps the agent online when the
TUI is closed: runs the Telegram listener, routes inline-keyboard approvals, and
serves a local control plane. Runs locally on your machine (no remote sandbox);
started with `lyra gateway start`.

## Install

```bash
bun add lyra-gateway
```

Requires [bun](https://bun.sh).

## Use

You don't usually run this directly — `lyra gateway start` (from
[`lyra-ai-agent`](https://www.npmjs.com/package/lyra-ai-agent)) spawns it with
Touch ID + a cached operator session, decrypts the local keystore, and brings the
listeners online. Documented here for transparency.

See the [root README](https://github.com/rifkyeasy/lyra#readme).
