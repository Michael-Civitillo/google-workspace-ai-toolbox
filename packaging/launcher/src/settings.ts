import {
  CONFIG_VERSION,
  generatePassword,
  generateSessionSecret,
  type LauncherConfig,
  type PasswordPromptResult,
  type StoredConfig,
} from "./config.ts";

/**
 * Working out this run's settings from launcher.json, the environment and the
 * command line, and what launcher.json should hold afterwards.
 */

/** Where this run's password came from. */
export type PasswordSource = "flag" | "environment" | "saved" | "generated" | "chosen";

export interface SettingsInputs {
  /** --port, --password and --set-password. */
  portFlag: number | null;
  passwordFlag: string | null;
  setPassword: boolean;
  /** APP_PASSWORD from the environment (launcher.env included). */
  envPassword: string | undefined;
  stored: Partial<LauncherConfig>;
  /** The port to remember. */
  port: number;
  autoSignIn: boolean;
  /** Shown in messages: where the password is kept. */
  configFile: string;
}

export interface SettingsIO {
  info(message: string): void;
  warn(message: string): void;
  plain(message: string): void;
  prompt(): Promise<PasswordPromptResult>;
}

export interface ResolvedSettings {
  /** What this run uses. */
  config: LauncherConfig;
  passwordSource: PasswordSource;
  /** What launcher.json should hold now, or null when it is already right. */
  toSave: StoredConfig | null;
}

/**
 * Merge, lowest priority first: stored config, launcher.env, the real
 * environment, then command-line flags. Prompt only when that leaves no
 * password at all.
 *
 * A password given in the environment is used for this run and not saved:
 * APP_PASSWORD set for one start (or in launcher.env, which is read on every
 * start anyway) should not end up written into launcher.json for good.
 * --password, --set-password and a generated password are saved.
 */
export async function resolveSettings(
  input: SettingsInputs,
  io: SettingsIO
): Promise<ResolvedSettings> {
  const { stored } = input;
  let dirty = input.portFlag !== null && input.portFlag !== stored.port;

  let sessionSecret = stored.sessionSecret ?? "";
  if (!sessionSecret) {
    sessionSecret = generateSessionSecret();
    dirty = true;
  }

  let password = "";
  let source: PasswordSource = "saved";
  if (input.passwordFlag) {
    password = input.passwordFlag;
    source = "flag";
  } else if (input.envPassword) {
    password = input.envPassword;
    source = "environment";
  } else if (stored.password) {
    password = stored.password;
    source = "saved";
  }

  if (!password && input.autoSignIn && !input.setPassword) {
    // Nobody is going to type this: the launcher signs the browser in itself.
    // It still has to exist, because it is what the launcher proves itself
    // with and what any other browser would need.
    password = generatePassword();
    source = "generated";
    io.info(
      `A sign-in password was generated and saved in ${input.configFile}. You only ` +
        `need it to sign in from another browser: run with --set-password to choose ` +
        `your own.`
    );
  } else if (input.setPassword || !password) {
    io.plain("");
    io.plain(
      input.setPassword
        ? "Choose the password you'll use to sign in to the web interface."
        : "First run. Choose the password you'll use to sign in (12+ characters)."
    );
    const result = await io.prompt().catch(() => ({
      password: generatePassword(),
      generated: true,
    }));
    password = result.password;
    if (result.generated) {
      source = "generated";
      // Never on the console: output may be going to a file or a service log.
      io.plain("");
      io.warn(
        `No terminal to ask on, so a password was generated and saved in ` +
          `${input.configFile}. Read it there when you need it, or run with ` +
          `--set-password in a terminal to choose your own.`
      );
      io.plain("");
    } else {
      source = "chosen";
      io.plain("Saved. Change it any time with --set-password.");
    }
  }

  const config: LauncherConfig = {
    version: CONFIG_VERSION,
    port: input.port,
    password,
    sessionSecret,
    // --no-browser is a choice about this run, not a setting to remember.
    openBrowser: stored.openBrowser ?? true,
  };
  const keptPassword = source === "environment" ? stored.password : password;
  if (stored.password !== keptPassword || stored.version !== CONFIG_VERSION) dirty = true;

  const toSave: StoredConfig = { ...config, password: keptPassword };
  if (keptPassword === undefined) delete toSave.password;
  return { config, passwordSource: source, toSave: dirty ? toSave : null };
}
