import z from "@deepseek-ai/schemastery";
import { Context, Volatile } from "@deepseek-ai/cordis";
//#region src/index.d.ts
declare const name = "dsh-komari";
declare const inject: string[];
/** The live Cordis config the Loader passes to \`apply\`. */
interface EntryConfig {
  /** Live panel address, e.g. \`https://status.example.com\`. */
  endpoint: Volatile<string> | string;
  /** Live panel account name. */
  username: Volatile<string> | string;
  /** Live panel account password. */
  password: Volatile<string> | string;
  /** Live per-request HTTP timeout. */
  requestTimeoutMs: Volatile<number> | number;
  /** Live upper bound for one whole file transfer. */
  transferTimeoutMs: Volatile<number> | number;
}
/**
 * Schemastery schema for the plugin's profile-owned Config.
 * Every user-editable field is \`.volatile()\`; the defaults below are the
 * composition-layer seed, and a committed settings edit updates the running
 * reference in place.
 */
declare const Config: z<EntryConfig>;
declare function apply(ctx: Context, config?: EntryConfig): void;
//#endregion
export { Config, EntryConfig, apply, inject, name };