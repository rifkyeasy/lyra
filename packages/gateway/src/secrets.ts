// Plaintext secrets the operator hands off to the harness alongside the
// agent privkey. Shipped via a second ECIES envelope sealed to the same
// bootstrap pubkey as the privkey envelope; harness verifies the operator's
// signature covers both before decrypting.
//
// Phase 12: telegram bot token + allowlist + pairing-approved users. Future
// platforms will extend the same shape (discord, slack, etc.).

import { z } from 'zod'

export const TelegramSecretsSchema = z.object({
  botToken: z.string().min(20),
  allowedUserIds: z.array(z.number().int().nonnegative()),
  pairingApproved: z.array(z.number().int().nonnegative()).optional(),
})

export const GatewaySecretsSchema = z.object({
  telegram: TelegramSecretsSchema.optional(),
  /**
   * v0.23.0: operator-derived AES key for the PROFILE iNFT slot (scope
   * `lyra-profile-v1`). 32-byte hex prefixed with 0x. Without this key the
   * daemon can boot but profile slot stays in `no-profile-key` skipped state
   * until the operator runs `lyra profile init` (sandbox) or unlocks via
   * the chat UI (local). The key is HKDF-derived on the operator host from
   * a one-shot operator-key signature, NEVER from the agent privkey.
   */
  profileScopeKeyHex: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/, 'profileScopeKeyHex must be 0x-prefixed 32-byte hex')
    .optional(),
})

export type TelegramSecrets = z.infer<typeof TelegramSecretsSchema>
export type GatewaySecrets = z.infer<typeof GatewaySecretsSchema>

export function parseGatewaySecrets(json: string): GatewaySecrets {
  return GatewaySecretsSchema.parse(JSON.parse(json))
}
