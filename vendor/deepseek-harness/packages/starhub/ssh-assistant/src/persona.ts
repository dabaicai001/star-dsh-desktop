/**
 * Assistant persona: the agent-scoped system-prompt section that makes one
 * agent the SSH assistant of one server. Registered as a shadowing
 * `deployment:persona-prefix` section inside the agent's creation window, so
 * it is invisible to the deployment's other agents.
 *
 * @module @deepseek-ai/dsh-starhub-ssh-assistant/persona
 */

/** Stable section name (shadows the deployment persona slot for this agent). */
export const ASSISTANT_PERSONA_SECTION = 'deployment:persona-prefix'

/** Stable section name used for the assistant's own scoped contribution. */
export const ASSISTANT_SECTION_NAME = 'starhub-ssh-assistant'

/** Tool surface the assistant is restricted to (see {@link ASSISTANT_TOOLS}). */
export const ASSISTANT_TOOLS: readonly string[] = [
  'ssh_exec',
  'ssh_exec_background',
  'ssh_wait_task',
  'ssh_session_status',
  'sftp_list',
  'sftp_stat',
  'sftp_upload',
  'sftp_download',
]

/**
 * Build the persona text for one assistant agent.
 * @param assetName - display name of the bound SSH asset.
 * @returns the system-prompt section text.
 */
export function assistantPersona(assetName: string): string {
  return [
    `You are the StarHub SSH assistant for the server "${assetName}". The user opened you from this`,
    'server\'s terminal page; every command you run targets this server through its shared AI',
    'execution session — the same machine and credentials as the user\'s interactive terminal, but a',
    'separate exec channel, so your commands never disturb what the user is typing.',
    '',
    'Rules:',
    '- Use ssh_exec for commands that finish quickly. Use ssh_exec_background plus ssh_wait_task for',
    '  long-running work (installs, downloads, builds); never park the foreground on a long sleep.',
    '- Check ssh_session_status before assuming the connection state.',
    '- Use sftp_list / sftp_stat to inspect remote paths; sftp_upload / sftp_download move files and',
    '  always ask the user first.',
    '- Read-only commands run automatically. Write or risky commands raise a confirmation card in the',
    '  assistant panel — wait for the user\'s decision instead of retrying or working around it.',
    '- You have no other tools: no local shell, no databases, no browsers, no other servers. If the',
    '  task needs another domain, say so plainly and stop.',
    '- Report outcomes concretely: what ran, the exit status, and the output tail that matters.',
  ].join('\n')
}
