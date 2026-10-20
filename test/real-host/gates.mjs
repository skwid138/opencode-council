// Provenance: ADAPTED (rewritten) from skwid138/opencode-command-normalizer
//   commit 7ddab8d6d0d23a67b7dcc753248e4673885e2120, path test/real-host/gates.mjs.
// Retained idea: refuse to start anything until every gate passes; provenance is
// linked, not assumed. Replaced: the Darwin / sandbox-exec / MATRIX runtime gates
// with Linux container gates (base-image inspection, COPY-only Dockerfile, the
// per-cell run contract, and the Docker authority/environment). See test/PROVENANCE.md.
//
// Everything here is pure: it validates inspect JSON / Dockerfile text and builds
// shell-free argv. Nothing here runs Docker.
import { isAbsolute } from "node:path";

import { DEFAULT_CELL_DEADLINES } from "./cells.mjs";

/** Local Node base image: the LOCAL trust anchor every image is built FROM (by id). */
export const BASE_IMAGE_ID = "sha256:422aa978464c78bd78bea13d66d189eecbb72954b264b6f89167d39c9715fdcd";
export const OWNER_LABEL = "council-rh.owner";
export const CELL_LABEL = "council-rh.cell";
export const HOST_LABEL = "council-rh.host";
export const ARCHIVE_LABEL = "council-rh.archive-sha256";
export const IMAGE_MANIFEST_LABEL = "council-rh.image-manifest-sha256";
/** Explicit per-run entrypoint (never inherited from an image): absolute node + the driver. */
export const ENTRYPOINT_NODE = "/usr/local/bin/node";
export const DRIVER_PATH = "/opt/council-rh/driver.mjs";

/** Containment applied to every container (cells, probes, spike, observational). */
export const RUN_CONTRACT = Object.freeze([
  ["--network", "none"],
  ["--read-only"],
  ["--user", "1000:1000"],
  ["--init"],
  ["--cap-drop", "ALL"],
  ["--security-opt", "no-new-privileges"],
  ["--cpus", "2"],
  ["--memory", "2g"],
  ["--memory-swap", "2g"],
  ["--pids-limit", "256"],
  ["--no-healthcheck"],
  ["--tmpfs", "/tmp:size=128m,noexec,nosuid,nodev"],
  ["--tmpfs", "/scratch:size=512m,noexec,nosuid,nodev,uid=1000,gid=1000,mode=0700"],
  ["--pull", "never"],
]);

/** Per-cell deadlines (ms). Exceeding any is FAIL + stop. */
export const DEADLINES = Object.freeze({
  // Defaults only; per-cell values come from cells.mjs cellDeadlines(scenario) (S4: 270 s / 240 s).
  dockerRun: DEFAULT_CELL_DEADLINES.controllerMs,
  driverWork: DEFAULT_CELL_DEADLINES.driverMs,
  containerRemove: 30_000,
  absenceVerify: 15_000,
  imageInspect: 15_000,
  imageBuild: 300_000,
  imageRemove: 60_000,
  download: 300_000,
});

export const OUTPUT_CAPS = Object.freeze({ stdoutBytes: 1024 * 1024, stderrBytes: 256 * 1024 });

const RUN_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const empty = (value) => value === null || value === undefined || (Array.isArray(value) && value.length === 0) || (isRecord(value) && Object.keys(value).length === 0);

function assertRunId(runId) {
  if (!RUN_ID.test(runId)) throw new Error(`invalid run id ${JSON.stringify(runId)}`);
}

export function containerName(runId, cellId) {
  assertRunId(runId);
  return `council-rh-${runId}-${String(cellId).replaceAll(":", "_")}`;
}

export function imageTag(hostId, runId) {
  assertRunId(runId);
  return `local/council-rh:${hostId}-${runId}`;
}

/**
 * Validates `docker image inspect <ref>` JSON (an array) for the base image.
 * Records the reviewed fields; OnBuild must be empty and any Volumes stop the gate.
 */
export function validateBaseImageInspect(json, { expectedId }) {
  const problems = [];
  if (!Array.isArray(json) || json.length !== 1 || !isRecord(json[0])) {
    return { ok: false, problems: ["inspect output must be an array of exactly one image"], record: null };
  }
  const image = json[0];
  const config = isRecord(image.Config) ? image.Config : {};
  const record = {
    Id: image.Id ?? null,
    Os: image.Os ?? null,
    Architecture: image.Architecture ?? null,
    Entrypoint: config.Entrypoint ?? null,
    Cmd: config.Cmd ?? null,
    User: config.User ?? null,
    Env: config.Env ?? null,
    WorkingDir: config.WorkingDir ?? null,
    OnBuild: config.OnBuild ?? null,
    Volumes: config.Volumes ?? null,
    Healthcheck: config.Healthcheck ?? null,
    ExposedPorts: config.ExposedPorts ?? null,
    Labels: config.Labels ?? null,
    RootFS: image.RootFS ?? null,
  };
  if (!IMAGE_ID.test(String(image.Id)) || image.Id !== expectedId) problems.push(`image id ${image.Id} is not the expected ${expectedId}`);
  if (image.Os !== "linux") problems.push(`image Os is ${image.Os}, expected linux`);
  if (image.Architecture !== "arm64") problems.push(`image Architecture is ${image.Architecture}, expected arm64`);
  if (!empty(config.OnBuild)) problems.push("image OnBuild triggers must be empty");
  if (!empty(config.Volumes)) problems.push("image declares Volumes; STOP");
  return { ok: problems.length === 0, problems, record };
}

const ALLOWED_INSTRUCTIONS = new Set(["FROM", "COPY", "USER", "WORKDIR", "ENTRYPOINT", "CMD", "LABEL"]);

function copySourceProblem(source) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source) || source.startsWith("/") || source.split("/").includes("..") || /[*?[\]]/.test(source)) {
    return `COPY source ${source} is not a plain relative path inside the context`;
  }
  return null;
}

/** Problems with a generated Dockerfile; empty when it is COPY-only FROM the base image id. */
export function dockerfileProblems(text, { baseImageId }) {
  const problems = [];
  const lines = String(text).split("\n").map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("#"));
  let froms = 0;
  lines.forEach((line, index) => {
    if (line.endsWith("\\")) {
      problems.push(`line continuation is not allowed: ${line}`);
      return;
    }
    const [instruction, ...rest] = line.split(/\s+/);
    const upper = instruction.toUpperCase();
    if (!ALLOWED_INSTRUCTIONS.has(upper)) {
      problems.push(`instruction ${upper} is not allowed (COPY-only build)`);
      return;
    }
    if (upper === "FROM") {
      froms += 1;
      if (index !== 0 || rest.length !== 1 || rest[0] !== baseImageId) problems.push(`FROM must be the single first instruction, by base image id ${baseImageId}`);
    }
    if (upper === "COPY") {
      const args = rest.filter((arg) => !arg.startsWith("--"));
      for (const flag of rest.filter((arg) => arg.startsWith("--"))) {
        if (!/^--(chown|chmod)=[0-9:]+$/.test(flag)) problems.push(`COPY flag ${flag} is not allowed (no --from or remote sources)`);
      }
      if (args.length < 2) problems.push(`COPY needs a source and a destination: ${line}`);
      for (const source of args.slice(0, -1)) {
        const problem = copySourceProblem(source);
        if (problem) problems.push(problem);
      }
    }
    if (upper === "ENTRYPOINT" || upper === "CMD") {
      let parsed = null;
      try {
        parsed = JSON.parse(rest.join(" "));
      } catch {
        parsed = null;
      }
      if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) problems.push(`${upper} must use exec (JSON array) form`);
    }
  });
  if (froms !== 1) problems.push(`FROM must appear exactly once (found ${froms})`);
  return problems;
}

/**
 * Attached `docker run` for one cell (no -d/-t/-i, no ports/binds/devices/env). The entrypoint is
 * overridden explicitly: `--entrypoint /usr/local/bin/node <image> /opt/council-rh/driver.mjs <cellId>`.
 */
export function runArgv({ docker, imageId, runId, cellId, cidfile }) {
  if (!isAbsolute(docker)) throw new Error("docker executable path must be absolute");
  if (!IMAGE_ID.test(imageId)) throw new Error(`run needs an exact image id, got ${imageId}`);
  if (!isAbsolute(cidfile)) throw new Error("cidfile path must be absolute");
  return [
    docker,
    "run",
    "--name",
    containerName(runId, cellId),
    "--label",
    `${OWNER_LABEL}=${runId}`,
    "--label",
    `${CELL_LABEL}=${cellId}`,
    "--cidfile",
    cidfile,
    ...RUN_CONTRACT.flat(),
    "--entrypoint",
    ENTRYPOINT_NODE,
    imageId,
    DRIVER_PATH,
    cellId,
  ];
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * `docker image inspect <ref>` outcome -> { absent: true } only for a DEFINITIVE "No such image":
 * exit 1, not timed out, stdout empty or `[]`, and stderr exactly one "No such image: <ref>" line
 * (daemon form "Error response from daemon: ..." or newer CLI form "Error: ..."). Anything else
 * (timeout, null status, daemon / permission errors, other output) is { absent: false, problem }.
 */
export function classifyTagAbsence(result, ref) {
  if (result?.timedOut) return { absent: false, problem: `tag check for ${ref} timed out` };
  if (result?.status === 0) return { absent: false, problem: `tag ${ref} already exists; never overwrite tags` };
  if (result?.status !== 1) return { absent: false, problem: `tag check for ${ref} exited with status ${result?.status ?? null}` };
  const stdout = String(result.stdout ?? "").trim();
  const stderr = String(result.stderr ?? "").trim();
  const definitive = new RegExp(`^Error(?: response from daemon)?: No such image: ${escapeRegExp(ref)}$`);
  if ((stdout === "" || stdout === "[]") && definitive.test(stderr)) return { absent: true };
  return { absent: false, problem: `tag check for ${ref} is not a definitive "No such image" (stderr ${JSON.stringify(stderr.slice(0, 200))})` };
}

/** Problems with `docker image inspect <id>` JSON for a Gate B image (exact id + owner/host/archive/manifest labels). */
export function verifyBuiltImage(json, { imageId, runId, hostId, archiveSha256, imageManifestSha256 }) {
  if (!Array.isArray(json) || json.length !== 1 || !isRecord(json[0])) return ["inspect output must be an array of exactly one image"];
  const image = json[0];
  const labels = isRecord(image.Config) && isRecord(image.Config.Labels) ? image.Config.Labels : {};
  const problems = [];
  if (image.Id !== imageId) problems.push(`image id ${image.Id} != ${imageId}`);
  for (const [label, value] of [[OWNER_LABEL, runId], [HOST_LABEL, hostId], [ARCHIVE_LABEL, archiveSha256], [IMAGE_MANIFEST_LABEL, imageManifestSha256]]) {
    if (labels[label] !== value) problems.push(`label ${label}=${labels[label]} != ${value}`);
  }
  return problems;
}

export function buildArgv({ docker, contextDir, tag, runId, iidfile }) {
  if (!isAbsolute(docker) || !isAbsolute(contextDir) || !isAbsolute(iidfile)) throw new Error("build paths must be absolute");
  assertRunId(runId);
  return [docker, "build", "--network", "none", "--pull=false", "--no-cache", "--label", `${OWNER_LABEL}=${runId}`, "--tag", tag, "--iidfile", iidfile, "--file", `${contextDir}/Dockerfile`, contextDir];
}

export const inspectArgv = ({ docker, ref }) => [docker, "image", "inspect", ref];
export const removeContainerArgv = ({ docker, containerId }) => [docker, "rm", "-f", containerId];
/** Empty stdout means absent. Matches by exact id AND ownership label. */
export const absenceArgv = ({ docker, containerId, runId }) => [docker, "ps", "-a", "--no-trunc", "--filter", `id=${containerId}`, "--filter", `label=${OWNER_LABEL}=${runId}`, "--format", "{{.ID}}"];
export const removeImageArgv = ({ docker, imageId }) => [docker, "image", "rm", imageId];

/** Docker CLI environment: fixed socket, fresh empty config dir, nothing inherited. */
export function dockerEnv({ socket, configDir, home }) {
  for (const [name, value] of [["socket", socket], ["configDir", configDir], ["home", home]]) {
    if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  }
  return { DOCKER_HOST: `unix://${socket}`, DOCKER_CONFIG: configDir, HOME: home, PATH: "/usr/bin:/bin", LANG: "C" };
}
