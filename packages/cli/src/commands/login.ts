/**
 * `nebula login` / `nebula logout` — password profile.
 *
 * First login unlocks the agent key once via the operator wallet, then
 * re-encrypts it under a password (scrypt + AES-256-GCM) into ~/.nebula/profile.json.
 * After that, logging in needs only the password, and a 12h session keeps later
 * commands from re-prompting. `logout` clears the session.
 */
import { cancel, isCancel, note, outro, password } from '@clack/prompts'
import { findAndLoadConfig } from '../config/load'
import { decryptSecret, encryptSecret } from '../profile/crypto'
import {
  clearSession,
  readProfile,
  readSession,
  writeProfile,
  writeSession,
} from '../profile/store'
import { unlockAgentSigner } from './_unlock'

export async function runLogin(): Promise<void> {
  const found = await findAndLoadConfig(process.cwd())
  if (!found) {
    note('No nebula.config.ts found. Run `nebula init` first.', 'login')
    return
  }
  const config = found.config
  const now = Date.now()
  const agentAddress = config.identity.agent
  if (!agentAddress) {
    note('No agent yet — run `nebula init` first.', 'login')
    return
  }

  if (await readSession(now, agentAddress)) {
    outro('Already logged in — session is active.')
    return
  }

  const profile = await readProfile()
  if (profile && profile.address.toLowerCase() === agentAddress.toLowerCase()) {
    const pw = await password({ message: 'Profile password' })
    if (isCancel(pw)) {
      cancel('Aborted.')
      return
    }
    try {
      const pk = decryptSecret(profile.cipher, String(pw))
      await writeSession(profile.address, pk, now)
      outro("Logged in. Session active for 12h — commands won't re-prompt.")
    } catch {
      cancel('Wrong password.')
    }
    return
  }

  // First time: unlock the agent key once via the operator, then seal it under a password.
  note('First login — creating your password profile (one-time operator unlock).', 'login')
  const unlocked = await unlockAgentSigner(config)
  if (!unlocked) {
    cancel('Could not unlock the agent key to create the profile.')
    return
  }
  try {
    const pw1 = await password({ message: 'Choose a profile password (min 8 characters)' })
    if (isCancel(pw1) || String(pw1).length < 8) {
      cancel('Password too short or aborted.')
      return
    }
    const pw2 = await password({ message: 'Confirm password' })
    if (isCancel(pw2) || String(pw2) !== String(pw1)) {
      cancel('Passwords do not match.')
      return
    }
    await writeProfile(unlocked.agentAddress, encryptSecret(unlocked.agentPrivkey, String(pw1)))
    await writeSession(unlocked.agentAddress, unlocked.agentPrivkey, now)
    outro('Profile created. Next time, just `nebula login` with your password.')
  } finally {
    await unlocked.close()
  }
}

export async function runLogout(): Promise<void> {
  await clearSession()
  outro('Logged out — session cleared. The next command will ask for your password.')
}
