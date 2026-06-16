import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'

/** Upsert `KEY=value` pairs in a dotenv file (creates it if absent). */
export async function upsertEnv(updates: Record<string, string>, file = '.env'): Promise<void> {
  let content = existsSync(file) ? await readFile(file, 'utf8') : ''
  for (const [k, v] of Object.entries(updates)) {
    const re = new RegExp(`^${k}=.*$`, 'm')
    if (re.test(content)) {
      content = content.replace(re, `${k}=${v}`)
    } else {
      content += `${content === '' || content.endsWith('\n') ? '' : '\n'}${k}=${v}\n`
    }
  }
  await writeFile(file, content)
}
