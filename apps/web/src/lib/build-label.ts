/**
 * #85 AC-4 + #141: a build running the fake engine is labeled — never
 * indistinguishable from a build running Hermes. The label follows the
 * engine the harness actually runs (system.status's engine name), not the
 * build identity: an ad-hoc `--engine=hermes` bundle is not labeled.
 */
export const buildLabel = (engineName: string | undefined) =>
  engineName === "engine-fake" ? "dev · fake engine" : undefined;
