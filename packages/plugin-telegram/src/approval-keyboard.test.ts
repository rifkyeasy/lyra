import { describe, expect, it } from 'bun:test'
import {
  APPROVAL_CALLBACK_PREFIX,
  buildApprovalKeyboard,
  handleApprovalCallback,
  makeApprovalIdFactory,
  parseCallbackData,
} from './approval-keyboard'

describe('buildApprovalKeyboard', () => {
  it('produces 4 buttons in 2 rows with the correct callback_data prefix', () => {
    const k = buildApprovalKeyboard('a-1')
    expect(k.inline_keyboard.length).toBe(2)
    expect(k.inline_keyboard[0]!.length).toBe(2)
    expect(k.inline_keyboard[1]!.length).toBe(2)
    for (const row of k.inline_keyboard) {
      for (const btn of row) {
        const data = (btn as { callback_data?: string }).callback_data
        expect(data).toMatch(new RegExp(`^${APPROVAL_CALLBACK_PREFIX}:`))
        expect(data).toContain(':a-1')
      }
    }
  })
})

describe('parseCallbackData', () => {
  it('parses well-formed once callback', () => {
    expect(parseCallbackData('ea:once:a-1')).toEqual({ choice: 'once', approvalId: 'a-1' })
  })
  it('parses session/always/deny', () => {
    expect(parseCallbackData('ea:session:a-1')?.choice).toBe('session')
    expect(parseCallbackData('ea:always:a-1')?.choice).toBe('always')
    expect(parseCallbackData('ea:deny:a-1')?.choice).toBe('deny')
  })
  it('rejects malformed prefix', () => {
    expect(parseCallbackData('xx:once:a-1')).toBeNull()
  })
  it('rejects malformed choice', () => {
    expect(parseCallbackData('ea:nope:a-1')).toBeNull()
  })
  it('rejects empty string', () => {
    expect(parseCallbackData('')).toBeNull()
    expect(parseCallbackData(undefined)).toBeNull()
  })
})

describe('handleApprovalCallback', () => {
  function makePending() {
    const pending = new Map<string, (choice: 'once' | 'session' | 'always' | 'deny') => void>()
    let resolved: { id: string; choice: string } | null = null
    pending.set('a-1', choice => {
      resolved = { id: 'a-1', choice }
    })
    return { pending, getResolved: () => resolved }
  }

  it('resolves on first match + pops the entry', () => {
    const { pending, getResolved } = makePending()
    const r = handleApprovalCallback({
      callbackData: 'ea:once:a-1',
      fromUserId: 100,
      allowedUserIds: [100],
      pendingApprovals: pending,
    })
    expect(r.kind).toBe('resolved')
    expect(getResolved()?.choice).toBe('once')
    expect(pending.has('a-1')).toBe(false)
  })

  it('rejects unauthorized clicker', () => {
    const { pending } = makePending()
    const r = handleApprovalCallback({
      callbackData: 'ea:once:a-1',
      fromUserId: 999,
      allowedUserIds: [100],
      pendingApprovals: pending,
    })
    expect(r.kind).toBe('unauthorized')
    expect(pending.has('a-1')).toBe(true)
  })

  it('marks unknown approvalId', () => {
    const { pending } = makePending()
    const r = handleApprovalCallback({
      callbackData: 'ea:once:a-999',
      fromUserId: 100,
      allowedUserIds: [100],
      pendingApprovals: pending,
    })
    expect(r.kind).toBe('unknown-approval')
  })

  it('marks malformed callback', () => {
    const { pending } = makePending()
    const r = handleApprovalCallback({
      callbackData: 'garbage',
      fromUserId: 100,
      allowedUserIds: [100],
      pendingApprovals: pending,
    })
    expect(r.kind).toBe('malformed')
  })

  it('allows all when allowedUserIds is empty (pairing-only mode)', () => {
    const { pending } = makePending()
    const r = handleApprovalCallback({
      callbackData: 'ea:once:a-1',
      fromUserId: 9999,
      allowedUserIds: [],
      pendingApprovals: pending,
    })
    // Callers with empty allowedUserIds rely on the listener-side pairing
    // gate, so callback re-validation is permissive here.
    expect(r.kind).toBe('resolved')
  })

  it('second click on same approvalId returns unknown-approval', () => {
    const { pending } = makePending()
    handleApprovalCallback({
      callbackData: 'ea:once:a-1',
      fromUserId: 100,
      allowedUserIds: [100],
      pendingApprovals: pending,
    })
    const second = handleApprovalCallback({
      callbackData: 'ea:once:a-1',
      fromUserId: 100,
      allowedUserIds: [100],
      pendingApprovals: pending,
    })
    expect(second.kind).toBe('unknown-approval')
  })
})

describe('makeApprovalIdFactory', () => {
  it('returns monotonically increasing ids', () => {
    const next = makeApprovalIdFactory()
    expect(next()).toBe('a-1')
    expect(next()).toBe('a-2')
    expect(next()).toBe('a-3')
  })
})
