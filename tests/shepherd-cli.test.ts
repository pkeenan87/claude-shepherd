import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli/shepherd.js";

describe("shepherd CLI", () => {
  it("prints the package version", () => {
    const out: string[] = [];
    const version = JSON.parse(readFileSync(path.resolve(__dirname, "..", "package.json"), "utf8")).version;
    expect(main(["version"], (text) => out.push(text))).toBe(0);
    expect(out.join("")).toBe(`${version}\n`);
  });
});
