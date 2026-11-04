// The build puts this module in place of buzz-app's `bundled/goose/sessions.ts`
// for the Goose runtime. It keeps that module's code and changes one thing:
// Hermes agents save their conversations under their own local storage key,
// so a Hermes agent never reads or trims the saved sessions of a Goose agent.
// The original module's `./goose` import already resolves to `./hermes`.
import { localSessions as gooseLocalSessions } from "@app/bundled/goose/sessions";

export {
  abortable,
  absolute,
  AgentSessions,
  IDLE_MS,
  POOL_LIMIT,
  ServerPool,
  SharedProcess,
  type Launch,
  type SavedConversation,
  type SessionsOptions,
  type SessionStore,
} from "@app/bundled/goose/sessions";

/** This plugin's local storage key for saved conversations. A new shape
 * needs a new version suffix: saved agents read this one. */
export const SESSIONS_KEY = "sagmans.hermes.sessions.v1";

/** Saved conversations per agent, under this plugin's key by default. */
export function localSessions(
  storage: Storage,
  agent: string,
  name = SESSIONS_KEY,
) {
  return gooseLocalSessions(storage, agent, name);
}
