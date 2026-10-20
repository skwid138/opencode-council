// Provenance: copied from skwid138/opencode-command-normalizer
//   commit 7ddab8d6d0d23a67b7dcc753248e4673885e2120, path test/isolated-env.d.mts
// Local modifications (see test/PROVENANCE.md): none.
export declare const ROOT_VAR: string;
export declare const XDG_VARS: readonly string[];
export declare const TEMP_VARS: readonly string[];

export type IsolationLayout = {
  root: string;
  home: string;
  xdg: Record<"XDG_CONFIG_HOME" | "XDG_DATA_HOME" | "XDG_STATE_HOME" | "XDG_CACHE_HOME", string>;
  tmp: string;
  npmUserConfig: string;
  npmGlobalConfig: string;
  npmCache: string;
};

export declare function isClearedVariable(name: string): boolean;
export declare function isInside(path: string | undefined, root: string): boolean;
export declare function createIsolationRoot(parent?: string): Promise<IsolationLayout>;
export declare function buildIsolatedEnv(
  baseEnv: Record<string, string | undefined>,
  layout: IsolationLayout,
): Record<string, string>;
export declare function isolationProblems(
  env?: Record<string, string | undefined>,
  home?: string,
  temp?: string,
): string[];
export declare function assertIsolated(env?: Record<string, string | undefined>, home?: string, temp?: string): void;
export declare function removeIsolationRoot(layout: IsolationLayout): Promise<void>;
