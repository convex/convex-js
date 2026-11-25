import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { injectManagedSection } from "./utils.js";

const START_MARKER = "<!-- test-start -->";
const END_MARKER = "<!-- test-end -->";

function sectionWithBody(body: string): string {
  return `${START_MARKER}\n\n${body}\n\n${END_MARKER}`;
}

// Template text whose lines break early, like convexAiMarkdownBody.
const templateBody = `When working on Convex code, **always read
\`convex/_generated/ai/guidelines.md\` first** for important guidelines on
how to correctly use Convex APIs and patterns.`;

// The same content after Prettier `proseWrap: "always"` refills the paragraph.
const reformattedBody = `When working on Convex code, **always read \`convex/_generated/ai/guidelines.md\` first** for important guidelines on how to correctly use Convex APIs and patterns.`;

describe("injectManagedSection", () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "convex-ai-files-"));
    filePath = join(dir, "AGENTS.md");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("leaves a formatter-rewrapped managed section alone (convex/convex-js#201)", async () => {
    const before = `# My project\n\n${sectionWithBody(reformattedBody)}\n`;
    writeFileSync(filePath, before, "utf8");

    const result = await injectManagedSection({
      filePath,
      startMarker: START_MARKER,
      endMarker: END_MARKER,
      section: sectionWithBody(templateBody),
    });

    expect(result.didWrite).toBe(false);
    expect(readFileSync(filePath, "utf8")).toBe(before);
  });

  it("still applies genuine content updates to the managed section", async () => {
    writeFileSync(
      filePath,
      `# My project\n\n${sectionWithBody(reformattedBody)}\n`,
      "utf8",
    );

    const result = await injectManagedSection({
      filePath,
      startMarker: START_MARKER,
      endMarker: END_MARKER,
      section: sectionWithBody(templateBody + "\n\nA brand new paragraph."),
    });

    expect(result.didWrite).toBe(true);
    expect(readFileSync(filePath, "utf8")).toContain("A brand new paragraph.");
  });

  it("still replaces a managed section whose content really drifted", async () => {
    writeFileSync(
      filePath,
      `# My project\n\n${sectionWithBody("Totally different words here.")}\n`,
      "utf8",
    );

    const result = await injectManagedSection({
      filePath,
      startMarker: START_MARKER,
      endMarker: END_MARKER,
      section: sectionWithBody(templateBody),
    });

    expect(result.didWrite).toBe(true);
    expect(readFileSync(filePath, "utf8")).toContain("guidelines.md");
  });

  it("appends the section when no markers exist", async () => {
    writeFileSync(filePath, "# My project\n", "utf8");

    const result = await injectManagedSection({
      filePath,
      startMarker: START_MARKER,
      endMarker: END_MARKER,
      section: sectionWithBody(templateBody),
    });

    expect(result.didWrite).toBe(true);
    expect(readFileSync(filePath, "utf8")).toContain(START_MARKER);
  });

  it("does not write when the section is already identical", async () => {
    const before = `# My project\n\n${sectionWithBody(templateBody)}\n`;
    writeFileSync(filePath, before, "utf8");

    const result = await injectManagedSection({
      filePath,
      startMarker: START_MARKER,
      endMarker: END_MARKER,
      section: sectionWithBody(templateBody),
    });

    expect(result.didWrite).toBe(false);
    expect(readFileSync(filePath, "utf8")).toBe(before);
  });
});
