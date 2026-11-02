/**
 * The setup guides as paste-ready instructions for an agent, copied by the guides'
 * "Copy these steps for an agent" card (copyForAgent.ts). Each is herdrup's `agentPrompt`
 * byte for byte, snippets included, so an agent gets the same instruction from either app.
 */

/** FederationSetupView.swift 36: the save-a-machine command, also shown in the guide. */
export const federationAddCommand = "herdr machine add --label mac-studio user@mac-studio";

/** FederationSetupView.swift 39-48. */
export const federationAgentPrompt = [
  "Add another machine to my Herdr federation so its agents show up in HerdrUp.",
  "",
  "1. Install the jerryfane/herdr fork on that machine and start its Herdr server.",
  "2. Connect it over Tailscale or another trusted network. Check its SSH host key and authorize my home box's SSH public key.",
  `3. On my home box, save a profile: ${federationAddCommand}`,
  "4. After confirming the target, opt it in with `herdr machine federate mac-studio` (or the Federate button in HerdrUp Settings). Check `herdr machine status` for reachability.",
  "",
  "Ask me for the machine label and SSH user@host first. Explain that continuous federation gives the home box full SSH authority over that Herdr session; do not copy private keys.",
].join("\n");

/** AccountsSetupView.swift 36-43: the per-harness login commands. */
const accountsLoginSnippet = [
  "# Codex",
  "CODEX_HOME=~/.codex-work codex",
  "# Claude (then /login)",
  "CLAUDE_CONFIG_DIR=~/.claude-2 claude",
  "# Kimi",
  "KIMI_CODE_HOME=~/.kimi-work kimi",
].join("\n");

/** AccountsSetupView.swift 46-52: the [[accounts]] stanza. */
const accountsConfigSnippet = [
  "[[accounts]]",
  'id = "codex-work"',
  'kind = "codex"',
  'label = "Codex · work"',
  'config_dir = "/root/.codex-work"',
].join("\n");

/** AccountsSetupView.swift 57-69. */
export const accountsAgentPrompt = [
  "Set up another subscription (account) on my herdr home box so it shows up in the herdr app, and walk me through each step as you do it.",
  "",
  "1. Make a config-home folder for the account (one folder per account keeps their logins separate), e.g. ~/.codex-work or ~/.claude-2.",
  "2. Log in pointed at that folder — this writes the login into the folder, not the default one:",
  accountsLoginSnippet,
  "3. Register it in ~/.config/herdr/config.toml with an [[accounts]] block:",
  accountsConfigSnippet,
  "4. Apply it with no restart:",
  "herdr server reload-config",
  "",
  "First ask me which harness (codex / claude / kimi) and what label I want, then carry it out and tell me the exact steps and commands you ran.",
].join("\n");
