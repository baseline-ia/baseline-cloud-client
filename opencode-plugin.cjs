/**
 * baseline-cloud OpenCode plugin.
 *
 * Tracks skill invocations (chat.message) and token usage (event: step-finish)
 * and forwards both to the baseline-cloud server via the baseline-cloud CLI.
 *
 * Installed automatically by `baseline-cloud setup`.
 * Registered in ~/.opencode/config.json under `plugin`.
 */

'use strict'

const { execSync } = require('child_process')

// Per-session token accumulator. Keyed by sessionID.
const sessionTokens = {}

module.exports = {
  server: async function plugin(input) {
    return {
      // Accumulate tokens from step-finish events, flush on each step.
      event: async ({ event }) => {
        if (!event || event.type !== 'step-finish') return

        const sid = event.sessionID
        if (!sessionTokens[sid]) {
          sessionTokens[sid] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
        }
        const t = event.tokens || {}
        const acc = sessionTokens[sid]
        acc.input += t.input || 0
        acc.output += t.output || 0
        acc.cacheRead += (t.cache && t.cache.read) || 0
        acc.cacheWrite += (t.cache && t.cache.write) || 0

        const project = input.directory || process.cwd()
        try {
          execSync(
            [
              'baseline-cloud session track',
              `--input-tokens ${acc.input}`,
              `--output-tokens ${acc.output}`,
              `--cache-read-tokens ${acc.cacheRead}`,
              `--cache-write-tokens ${acc.cacheWrite}`,
              `--session-id "${sid}"`,
              `--project "${project}"`,
            ].join(' '),
            { stdio: 'ignore' }
          )
        } catch {
          // baseline-cloud not configured — silently skip
        }
      },

      // Detect /skill-name at the start of a user message.
      'chat.message': async (msgInput, output) => {
        const parts = output?.parts || []
        for (const part of parts) {
          if (part.type !== 'text' || !part.text) continue
          const match = part.text.trim().match(/^\/([a-z][a-z0-9:_-]*)/)
          if (match) {
            const project = input.directory || process.cwd()
            try {
              execSync(
                `baseline-cloud skill track --name "${match[1]}" --project "${project}"`,
                { stdio: 'ignore' }
              )
            } catch {
              // baseline-cloud not configured — silently skip
            }
          }
          break
        }
      },
    }
  },
}
