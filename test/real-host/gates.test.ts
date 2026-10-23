import { describe, expect, it } from "vitest";

import {
  BASE_IMAGE_ID,
  buildArgv,
  classifyTagAbsence,
  containerName,
  dockerEnv,
  dockerfileProblems,
  imageTag,
  RUN_CONTRACT,
  runArgv,
  validateBaseImageInspect,
  verifyBuiltImage,
} from "./gates.mjs";

const inspect = (config: Record<string, unknown> = {}, top: Record<string, unknown> = {}) => [
  {
    Id: BASE_IMAGE_ID,
    Os: "linux",
    Architecture: "arm64",
    RepoTags: ["local/opencode-versions-smoke:2.0.28-lnx-ver-8kibauir-ad2580b2e624"],
    RootFS: { Type: "layers", Layers: ["sha256:" + "e".repeat(64)] },
    Config: {
      Entrypoint: ["/usr/local/bin/node", "/opt/smoke/controller.mjs"],
      Cmd: null,
      User: "1000:1000",
      Env: ["PATH=/usr/local/bin:/usr/bin:/bin", "NODE_VERSION=22.14.0"],
      WorkingDir: "/",
      OnBuild: null,
      Volumes: null,
      Healthcheck: null,
      ExposedPorts: null,
      Labels: null,
      ...config,
    },
    ...top,
  },
];

describe("base image inspection", () => {
  it("records the reviewed fields and accepts the local trust anchor", () => {
    const verdict = validateBaseImageInspect(inspect(), { expectedId: BASE_IMAGE_ID });
    expect(verdict.ok).toBe(true);
    expect(Object.keys(verdict.record)).toEqual(["Id", "Os", "Architecture", "Entrypoint", "Cmd", "User", "Env", "WorkingDir", "OnBuild", "Volumes", "Healthcheck", "ExposedPorts", "Labels", "RootFS"]);
  });

  it.each([
    ["a different image id", inspect({}, { Id: "sha256:" + "f".repeat(64) }), /image id/],
    ["ONBUILD triggers", inspect({ OnBuild: ["RUN echo"] }), /OnBuild/],
    ["declared volumes", inspect({ Volumes: { "/data": {} } }), /Volumes/],
    ["a non-linux image", inspect({}, { Os: "windows" }), /linux/],
    ["a non-arm64 image", inspect({}, { Architecture: "amd64" }), /arm64/],
  ])("stops on %s", (_label, json, message) => {
    const verdict = validateBaseImageInspect(json, { expectedId: BASE_IMAGE_ID });
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join("\n")).toMatch(message);
  });

  it("rejects anything but exactly one inspected image", () => {
    expect(validateBaseImageInspect([], { expectedId: BASE_IMAGE_ID }).ok).toBe(false);
    expect(validateBaseImageInspect([...inspect(), ...inspect()], { expectedId: BASE_IMAGE_ID }).ok).toBe(false);
    expect(validateBaseImageInspect({ Id: BASE_IMAGE_ID }, { expectedId: BASE_IMAGE_ID }).ok).toBe(false);
  });
});

describe("COPY-only Dockerfile", () => {
  const good = `FROM ${BASE_IMAGE_ID}\nCOPY harness/ /opt/council-rh/\nUSER 1000:1000\nENTRYPOINT ["/usr/local/bin/node","/opt/council-rh/driver.mjs"]\nCMD []\nLABEL council-rh.owner="run-1"\n`;

  it("accepts FROM-by-id, local COPY, USER, ENTRYPOINT, CMD, LABEL", () => {
    expect(dockerfileProblems(good, { baseImageId: BASE_IMAGE_ID })).toEqual([]);
  });

  it.each([
    ["RUN", `${good}RUN echo hi\n`, /RUN/],
    ["ADD", `${good}ADD https://example.com/x /x\n`, /ADD/],
    ["COPY --from", `${good}COPY --from=other /x /x\n`, /--from/],
    ["remote COPY source", `${good}COPY https://example.com/x /x\n`, /source/],
    ["escaping COPY source", `${good}COPY ../secret /x\n`, /source/],
    ["FROM by tag", good.replace(`FROM ${BASE_IMAGE_ID}`, "FROM node:22"), /FROM/],
    ["a second FROM", `${good}FROM ${BASE_IMAGE_ID}\n`, /FROM/],
    ["shell-form ENTRYPOINT", good.replace('ENTRYPOINT ["/usr/local/bin/node","/opt/council-rh/driver.mjs"]', "ENTRYPOINT node /opt/x"), /ENTRYPOINT/],
    ["ARG", `ARG X\n${good}`, /ARG/],
    ["a line continuation", `${good}LABEL a=b \\\n  c=d\n`, /continuation/],
  ])("rejects %s", (_label, text, message) => {
    expect(dockerfileProblems(text, { baseImageId: BASE_IMAGE_ID }).join("\n")).toMatch(message);
  });
});

describe("docker argv (shell-free) and environment", () => {
  const docker = "/usr/local/bin/docker";

  it("runs every cell attached under the full containment contract", () => {
    const argv = runArgv({ docker, imageId: "sha256:" + "1".repeat(64), runId: "r1", cellId: "v2-2.0.32:s1:1", cidfile: "/tmp/x/v2.cid" });
    expect(argv[0]).toBe(docker);
    expect(argv.slice(1, 2)).toEqual(["run"]);
    for (const flag of RUN_CONTRACT) expect(argv.join(" ")).toContain(flag.join(" "));
    for (const forbidden of ["-d", "--detach", "-t", "--tty", "-i", "--interactive", "-p", "--publish", "-v", "--volume", "--mount", "--privileged", "--device", "--rm", "-e", "--env"]) {
      expect(argv).not.toContain(forbidden);
    }
    expect(argv).toContain("--pull");
    expect(argv[argv.indexOf("--pull") + 1]).toBe("never");
    expect(argv.slice(-3)).toEqual(["sha256:" + "1".repeat(64), "/opt/council-rh/driver.mjs", "v2-2.0.32:s1:1"]);
    // The entrypoint is overridden explicitly (absolute node + driver), never inherited from the image.
    expect(argv[argv.indexOf("--entrypoint") + 1]).toBe("/usr/local/bin/node");
    expect(argv.indexOf("--entrypoint")).toBeLessThan(argv.indexOf("sha256:" + "1".repeat(64)));
    expect(argv[argv.indexOf("--name") + 1]).toBe(containerName("r1", "v2-2.0.32:s1:1"));
  });

  it("pins the exact approved containment flags (independently of RUN_CONTRACT)", () => {
    const argv = runArgv({ docker, imageId: "sha256:" + "1".repeat(64), runId: "r1", cellId: "v2-2.0.32:s1:1", cidfile: "/tmp/x/v2.cid" });
    expect(argv.slice(argv.indexOf("/tmp/x/v2.cid") + 1, -3)).toEqual([
      "--network", "none", "--read-only", "--user", "1000:1000", "--init", "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges", "--cpus", "2", "--memory", "2g", "--memory-swap", "2g",
      "--pids-limit", "256", "--no-healthcheck",
      "--tmpfs", "/tmp:size=128m,noexec,nosuid,nodev",
      "--tmpfs", "/scratch:size=512m,noexec,nosuid,nodev,uid=1000,gid=1000,mode=0700",
      "--pull", "never",
      "--entrypoint", "/usr/local/bin/node",
    ]);
  });

  it("names containers and tags images by run and never reuses the base image tag", () => {
    expect(containerName("r1", "v2-2.0.32:s1:1")).toBe("council-rh-r1-v2-2.0.32_s1_1");
    expect(imageTag("v2-2.0.32", "r1")).toBe("local/council-rh:v2-2.0.32-r1");
    expect(() => containerName("bad run", "v2-2.0.32:s1:1")).toThrow(/run id/);
  });

  it("builds a COPY-only context without network or pulls, with an owned tag and iidfile", () => {
    const argv = buildArgv({ docker, contextDir: "/tmp/ctx", tag: "local/council-rh:v2-2.0.32-r1", runId: "r1", iidfile: "/tmp/ctx.iid" });
    expect(argv).toEqual([
      docker, "build", "--network", "none", "--pull=false", "--no-cache",
      "--label", "council-rh.owner=r1", "--tag", "local/council-rh:v2-2.0.32-r1", "--iidfile", "/tmp/ctx.iid",
      "--file", "/tmp/ctx/Dockerfile", "/tmp/ctx",
    ]);
  });

  it("uses a fixed socket, a fresh empty DOCKER_CONFIG, and nothing inherited", () => {
    expect(dockerEnv({ socket: "/var/run/docker.sock", configDir: "/tmp/s/docker-config", home: "/tmp/s/home" })).toEqual({
      DOCKER_HOST: "unix:///var/run/docker.sock",
      DOCKER_CONFIG: "/tmp/s/docker-config",
      HOME: "/tmp/s/home",
      PATH: "/usr/bin:/bin",
      LANG: "C",
    });
    expect(() => dockerEnv({ socket: "relative.sock", configDir: "/x", home: "/y" })).toThrow(/absolute/);
  });
});

describe("Gate B tag-absence check: only a definitive 'No such image' counts as absent", () => {
  const ref = "local/council-rh:v1-1.19.3-r1";
  const result = (overrides: Record<string, unknown>) => ({ status: 1, stdout: "[]\n", stderr: `Error response from daemon: No such image: ${ref}\n`, timedOut: false, ...overrides });

  it.each([
    ["classic daemon form (stdout [])", result({})],
    ["newer CLI form (empty stdout)", result({ stdout: "", stderr: `Error: No such image: ${ref}\n` })],
  ])("absent: %s", (_label, outcome) => {
    expect(classifyTagAbsence(outcome, ref)).toEqual({ absent: true });
  });

  it.each([
    ["the tag exists (status 0)", result({ status: 0, stdout: '[{"Id":"sha256:x"}]', stderr: "" }), /already exists/],
    ["a timeout", result({ status: null, timedOut: true }), /timed out/],
    ["a null status", result({ status: null }), /status null/],
    ["a daemon error", result({ stderr: "Cannot connect to the Docker daemon at unix:///x.sock. Is the docker daemon running?\n" }), /not a definitive "No such image"/],
    ["a permission error", result({ stderr: "permission denied while trying to connect to the Docker daemon socket\n" }), /not a definitive/],
    ["No such image for another ref", result({ stderr: "Error response from daemon: No such image: local/other:tag\n" }), /not a definitive/],
    ["No such image plus other output", result({ stderr: `warning: x\nError response from daemon: No such image: ${ref}\n` }), /not a definitive/],
    ["unexpected stdout", result({ stdout: "something\n" }), /not a definitive/],
    ["another exit status", result({ status: 125 }), /status 125/],
  ])("STOP on %s", (_label, outcome, message) => {
    const verdict = classifyTagAbsence(outcome, ref);
    expect(verdict.absent).toBe(false);
    expect(verdict.problem).toMatch(message);
  });
});

describe("Gate C built-image verification (labels and id via docker image inspect)", () => {
  const imageId = "sha256:" + "4".repeat(64);
  const expected = { imageId, runId: "r1", hostId: "v2-2.0.32", archiveSha256: "a".repeat(64), imageManifestSha256: "b".repeat(64) };
  const image = (labels: Record<string, string> = {}, top: Record<string, unknown> = {}) => [
    {
      Id: imageId,
      Config: { Labels: { "council-rh.owner": "r1", "council-rh.host": "v2-2.0.32", "council-rh.archive-sha256": "a".repeat(64), "council-rh.image-manifest-sha256": "b".repeat(64), ...labels } },
      ...top,
    },
  ];

  it("accepts the exact image with the owner, host, archive, and image-manifest labels", () => {
    expect(verifyBuiltImage(image(), expected)).toEqual([]);
  });

  it.each([
    ["another id", image({}, { Id: "sha256:" + "5".repeat(64) }), /image id/],
    ["a foreign owner label", image({ "council-rh.owner": "r0" }), /council-rh.owner/],
    ["another host label", image({ "council-rh.host": "v2-2.0.28" }), /council-rh.host/],
    ["another archive digest", image({ "council-rh.archive-sha256": "c".repeat(64) }), /council-rh.archive-sha256/],
    ["another image manifest digest", image({ "council-rh.image-manifest-sha256": "d".repeat(64) }), /council-rh.image-manifest-sha256/],
    ["no labels", [{ Id: imageId, Config: {} }], /council-rh.owner/],
    ["not exactly one image", [], /exactly one image/],
  ])("rejects %s", (_label, json, message) => {
    expect(verifyBuiltImage(json, expected).join("\n")).toMatch(message);
  });
});
