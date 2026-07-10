'use client'

import { usePathname } from 'next/navigation'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  useCurrentAccount,
  useDisconnectWallet,
  useSignPersonalMessage,
} from '@mysten/dapp-kit'

export type SuiAuthStatus =
  | 'loading'
  | 'unauthenticated'
  | 'signing'
  | 'authenticated'
  | 'error'

export type SuiAuth = {
  status: SuiAuthStatus
  /** Authenticated Sui address (0x + 64 hex), or null. */
  address: string | null
  isAuthed: boolean
  /** True while a sign-in is in flight (status === 'signing'). */
  isPending: boolean
  error: string | null
  signIn: () => Promise<void>
  signOut: () => Promise<void>
}

const SIGN_TIMEOUT_MS = 60_000

/**
 * Sui personal-message sign-in.
 *
 * Connecting a wallet auto-kicks the sign prompt (single-step), so the operator
 * never sees an intermediate "Sign Message" button after picking their wallet.
 * The signature proves ownership of the connected Sui address and mints an
 * iron-session cookie server-side. No transactions are sent.
 */
export function useSuiAuth(): SuiAuth {
  const pathname = usePathname()
  const account = useCurrentAccount()
  const { mutateAsync: signPersonalMessage } = useSignPersonalMessage()
  const { mutateAsync: disconnect } = useDisconnectWallet()

  const address = account?.address ?? null
  const isConnected = Boolean(address)

  const [status, setStatus] = useState<SuiAuthStatus>('loading')
  const [sessionAddress, setSessionAddress] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef(false)

  // Boot: check whether a server session already exists.
  useEffect(() => {
    let alive = true
    fetch('/api/auth/me', { credentials: 'include' })
      .then(r => r.json())
      .then((d: { address?: string | null }) => {
        if (!alive) return
        if (d?.address) {
          setSessionAddress(d.address)
          setStatus('authenticated')
        } else {
          setStatus('unauthenticated')
        }
      })
      .catch(() => {
        if (alive) setStatus('unauthenticated')
      })
    return () => {
      alive = false
    }
  }, [])

  const signIn = useCallback(async (): Promise<void> => {
    if (inFlight.current) return
    if (!isConnected || !address) {
      setError('connect a wallet first')
      return
    }
    inFlight.current = true
    setError(null)
    setStatus('signing')
    let timer: ReturnType<typeof setTimeout> | null = null
    try {
      const nonceResp = await fetch('/api/auth/nonce', { credentials: 'include' })
      const { nonce } = (await nonceResp.json()) as { nonce: string }

      const message = `Sign in to Lyra\naddress: ${address}\nnonce: ${nonce}`
      const messageBytes = new TextEncoder().encode(message)

      const signPromise = signPersonalMessage({ message: messageBytes })
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('signing timed out, wallet did not respond')),
          SIGN_TIMEOUT_MS,
        )
      })
      const { signature } = await Promise.race([signPromise, timeoutPromise])

      const verifyResp = await fetch('/api/auth/verify', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address, message, signature }),
      })
      if (!verifyResp.ok) {
        const j = (await verifyResp.json().catch(() => ({}))) as { reason?: string }
        throw new Error(j.reason || `verify failed (${verifyResp.status})`)
      }
      setSessionAddress(address)
      setStatus('authenticated')
    } catch (err) {
      const msg = (err as Error).message || 'sign-in failed'
      setError(msg)
      setStatus('unauthenticated')
    } finally {
      if (timer) clearTimeout(timer)
      inFlight.current = false
    }
  }, [address, isConnected, signPersonalMessage])

  const signOut = useCallback(async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' })
    } catch {
      // best effort
    }
    setSessionAddress(null)
    setStatus('unauthenticated')
    setError(null)
    try {
      await disconnect()
    } catch {
      // best effort
    }
  }, [disconnect])

  // Auto-trigger sign-in the moment a wallet connects, if no session exists —
  // but ONLY inside the console. Elsewhere (e.g. the marketing homepage) connecting
  // a wallet must not pop a sign-message prompt; the sign-in belongs to the console.
  useEffect(() => {
    if (!pathname?.startsWith('/console')) return
    if (!isConnected || !address) return
    if (status !== 'unauthenticated') return
    if (sessionAddress && sessionAddress.toLowerCase() === address.toLowerCase()) return
    // small delay lets the wallet UI close before opening the sign prompt
    const t = setTimeout(() => {
      void signIn()
    }, 200)
    return () => clearTimeout(t)
  }, [pathname, isConnected, address, status, sessionAddress, signIn])

  // If the connected wallet address no longer matches the session, clear it.
  useEffect(() => {
    if (!sessionAddress) return
    if (!isConnected) return
    if (address && address.toLowerCase() !== sessionAddress.toLowerCase()) {
      setSessionAddress(null)
      setStatus('unauthenticated')
    }
  }, [address, isConnected, sessionAddress])

  const authedAddress = status === 'authenticated' ? sessionAddress : null

  return {
    status,
    address: authedAddress,
    isAuthed: status === 'authenticated' && Boolean(authedAddress),
    isPending: status === 'signing',
    error,
    signIn,
    signOut,
  }
}
