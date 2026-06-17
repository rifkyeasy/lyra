import { describe, expect, it } from 'bun:test'
import { formatApprovalResolution } from './listener'

/**
 * Regression test for v0.19.19: every choice maps to a human-readable
 * suffix so the post-click modal edit shows the operator what they tapped.
 * v0.19.18 left modals visible after click because the listener only
 * answered the popup but never edited the message body. v0.19.19 edits the
 * text to append this suffix and removes the inline keyboard.
 */
describe('formatApprovalResolution', () => {
  it('labels each choice distinctly with the clicker user id', () => {
    expect(formatApprovalResolution('once', 42)).toBe('✅ Allowed once (by 42)')
    expect(formatApprovalResolution('session', 42)).toBe('✅ Allowed for session (by 42)')
    expect(formatApprovalResolution('always', 42)).toBe('✅ Always allowed (by 42)')
    expect(formatApprovalResolution('deny', 42)).toBe('❌ Denied (by 42)')
  })

  it('uses ✅ for permitting choices and ❌ only for deny', () => {
    for (const choice of ['once', 'session', 'always'] as const) {
      expect(formatApprovalResolution(choice, 1)).toMatch(/^✅/)
    }
    expect(formatApprovalResolution('deny', 1)).toMatch(/^❌/)
  })
})
