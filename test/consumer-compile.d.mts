// Provenance: copied from skwid138/opencode-command-normalizer
//   commit 7ddab8d6d0d23a67b7dcc753248e4673885e2120, path test/consumer-compile.d.mts
// Local modifications (see test/PROVENANCE.md): none.
export type CompileResult = {
  status: number | null;
  signal: NodeJS.Signals | string | null;
  error?: unknown;
  stdout?: string;
  stderr?: string;
};

export type CompileEvaluation = { ok: boolean; reasons: string[]; errors: string[] };

export declare function parseDiagnostics(output: string | undefined): string[];
export declare function evaluateCompile(result: CompileResult): CompileEvaluation;
