import { describe, expect, it } from 'bun:test'
import { TELEGRAM_ALLOWED_UPDATES } from './listener'

/**
 * Regression test for v0.19.18 callback_query polling fix.
 *
 * v0.18.0 introduced inline-keyboard approvals but only subscribed to
 * `'message'` updates in `bot.start({ allowed_updates })`. v0.19.10 fixed
 * the handler-registration path but left the polling spec narrow, so every
 * keyboard tap was silently filtered out by Telegram before grammY ever
 * saw it. Operators saw the modal "do nothing" — the harness saw zero
 * resolution events. This test pins both kinds in the polling spec so a
 * future refactor cannot quietly drop the second one again.
 */
describe('TELEGRAM_ALLOWED_UPDATES', () => {
  it('subscribes to both message and callback_query updates', () => {
    expect(TELEGRAM_ALLOWED_UPDATES).toContain('message')
    expect(TELEGRAM_ALLOWED_UPDATES).toContain('callback_query')
  })

  it('does not over-subscribe to update kinds we have no handler for', () => {
    // Keep the wire payload minimal. Add new kinds only when a handler exists.
    expect([...TELEGRAM_ALLOWED_UPDATES].sort()).toEqual(['callback_query', 'message'])
  })
})
