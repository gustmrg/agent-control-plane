import type { Sandbox } from "@agent-control/contracts";

export type OutputFormat = "table" | "json";

export const printValue = (value: unknown, output: OutputFormat) => {
  if (output === "json") console.log(JSON.stringify(value, null, 2));
  else console.log(String(value));
};

export const printSandboxes = (sandboxes: Sandbox[], output: OutputFormat) => {
  if (output === "json") {
    console.log(JSON.stringify(sandboxes, null, 2));
    return;
  }
  if (sandboxes.length === 0) {
    console.log("No sandboxes");
    return;
  }
  const rows = [
    ["NAME", "STATE", "IMAGE", "CREATED"],
    ...sandboxes.map((sandbox) => [
      sandbox.name,
      sandbox.observedState,
      sandbox.image,
      sandbox.createdAt,
    ]),
  ];
  const widths = rows[0]!.map((_, index) =>
    Math.max(...rows.map((row) => row[index]!.length)),
  );
  for (const row of rows) {
    console.log(
      row
        .map((value, index) => value.padEnd(widths[index]!))
        .join("  ")
        .trimEnd(),
    );
  }
};

export const printSandbox = (sandbox: Sandbox, output: OutputFormat) => {
  if (output === "json") {
    console.log(JSON.stringify(sandbox, null, 2));
    return;
  }
  console.log(`Name:       ${sandbox.name}`);
  console.log(`ID:         ${sandbox.id}`);
  console.log(`State:      ${sandbox.observedState}`);
  console.log(`Desired:    ${sandbox.desiredState}`);
  console.log(`Image:      ${sandbox.image}`);
  console.log(`Repository: ${sandbox.repositoryUrl ?? "-"}`);
  console.log(`Created:    ${sandbox.createdAt}`);
  if (sandbox.lastError) console.log(`Error:      ${sandbox.lastError}`);
};
