import { describe, expect, test } from "bun:test";
import * as React from "react";
import { renderToString } from "../../../utils/staticRender";
import { ShellProgressMessage } from "../ShellProgressMessage";

describe("ShellProgressMessage", () => {
  test("renders progress metadata on its own line", async () => {
    const output = await renderToString(
      <ShellProgressMessage
        output={["bun test v1.3.11", "", "3 pass"].join("\n")}
        fullOutput={["bun test v1.3.11", "", "3 pass"].join("\n")}
        elapsedTimeSeconds={367}
        totalLines={8}
        verbose={false}
      />,
      80,
    );

    const lines = output.split("\n").map(line => line.trimEnd());
    const passLine = lines.find(line => line.includes("3 pass"));
    const metaLine = lines.find(line => line.includes("+3 lines"));

    expect(passLine).toBeString();
    expect(metaLine).toBeString();
    expect(passLine).not.toContain("+3 lines");
  });
});
