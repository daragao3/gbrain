import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";

const SKILLS_DIR = join(import.meta.dir, "..", "skills");
const MANIFEST_PATH = join(SKILLS_DIR, "manifest.json");

/**
 * True when the content opens with a YAML frontmatter fence.
 *
 * CRLF-tolerant: Windows checkouts carry `---\r\n`, which an LF-only
 * `startsWith("---\n")` rejects for the entire skills corpus.
 */
function hasFrontmatterFence(content: string): boolean {
  return /^---\r?\n/.test(content);
}

/** Simple YAML frontmatter parser — extracts fields between --- delimiters */
function parseFrontmatter(content: string): Record<string, unknown> | null {
  // CRLF-tolerant fence: an LF-only fence (`\n`) silently returns null for
  // every CRLF SKILL.md, i.e. all of them on Windows. Per-line key/value
  // handling below already `.trim()`s, so stray `\r` never reaches a value.
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  const yaml = match[1];
  const result: Record<string, string> = {};
  for (const line of yaml.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim();
      const value = line.slice(colonIdx + 1).trim();
      if (key && !key.startsWith(" ") && !key.startsWith("-")) {
        result[key] = value;
      }
    }
  }
  return result;
}

/** Get all skill directories (those containing SKILL.md) */
function getSkillDirs(): string[] {
  const entries = readdirSync(SKILLS_DIR, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .filter((e) => existsSync(join(SKILLS_DIR, e.name, "SKILL.md")))
    .map((e) => e.name)
    .filter((name) => name !== "install"); // deprecated skill
}

describe("skills conformance", () => {
  const skillDirs = getSkillDirs();

  test("manifest.json exists and is valid JSON", () => {
    expect(existsSync(MANIFEST_PATH)).toBe(true);
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"));
    expect(manifest.skills).toBeDefined();
    expect(Array.isArray(manifest.skills)).toBe(true);
  });

  test("manifest lists every skill directory", () => {
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"));
    const manifestNames = manifest.skills.map((s: { name: string }) => s.name);
    for (const dir of skillDirs) {
      expect(manifestNames).toContain(dir);
    }
  });

  test("every manifest entry points to an existing SKILL.md", () => {
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"));
    for (const skill of manifest.skills) {
      const skillPath = join(SKILLS_DIR, skill.path);
      expect(existsSync(skillPath)).toBe(true);
    }
  });

  for (const dir of skillDirs) {
    describe(`skills/${dir}/SKILL.md`, () => {
      const content = readFileSync(join(SKILLS_DIR, dir, "SKILL.md"), "utf-8");

      test("has YAML frontmatter", () => {
        expect(hasFrontmatterFence(content)).toBe(true);
        const fm = parseFrontmatter(content);
        expect(fm).not.toBeNull();
      });

      test("frontmatter has required fields (name, description)", () => {
        const fm = parseFrontmatter(content);
        expect(fm).not.toBeNull();
        expect(fm!.name).toBeDefined();
        expect(fm!.description).toBeDefined();
      });

      test("has a Contract section", () => {
        expect(content).toContain("## Contract");
      });

      test("has an Anti-Patterns section", () => {
        expect(content).toContain("## Anti-Patterns");
      });

      test("has an Output Format section", () => {
        expect(content).toContain("## Output Format");
      });
    });
  }

  // -------------------------------------------------------------------------
  // parseFrontmatter / hasFrontmatterFence — CRLF frontmatter (Windows)
  // -------------------------------------------------------------------------
  //
  // On Windows (core.autocrlf=true, no tracked .gitattributes) every
  // skills/*/SKILL.md is checked out CRLF. An LF-only fence (`/^---\n.../`)
  // never matches the `---\r\n` fence, so this file's parser returned null for
  // the entire corpus and both per-skill frontmatter tests failed on every
  // skill. These cases pin the line-ending tolerance independently of however
  // the working copy happens to be checked out.

  describe("parseFrontmatter — line-ending tolerance", () => {
    const lf = (lines: string[]) => lines.join("\n");
    const crlf = (lines: string[]) => lines.join("\r\n");
    const doc = ["---", "name: webhook-transforms", "version: 1.0.0", "---", "", "# heading", ""];

    test("LF frontmatter parses (baseline)", () => {
      const fm = parseFrontmatter(lf(doc));
      expect(fm).not.toBeNull();
      expect(fm!.name).toBe("webhook-transforms");
    });

    test("CRLF frontmatter parses (LF-only fence regression)", () => {
      const fm = parseFrontmatter(crlf(doc));
      expect(fm).not.toBeNull();
      expect(fm!.name).toBe("webhook-transforms");
      expect(fm!.version).toBe("1.0.0");
    });

    test("CRLF values carry no trailing carriage return", () => {
      const fm = parseFrontmatter(crlf(doc));
      for (const value of Object.values(fm!)) {
        expect(String(value)).not.toContain("\r");
      }
    });

    test("CRLF fence is recognised by hasFrontmatterFence", () => {
      expect(hasFrontmatterFence(lf(doc))).toBe(true);
      expect(hasFrontmatterFence(crlf(doc))).toBe(true);
    });

    test("content without a fence is still rejected", () => {
      expect(hasFrontmatterFence("# heading\r\n")).toBe(false);
      expect(parseFrontmatter("# heading\r\nno frontmatter here\r\n")).toBeNull();
    });
  });

  test("no duplicate skill names in frontmatter", () => {
    const names: string[] = [];
    for (const dir of skillDirs) {
      const content = readFileSync(join(SKILLS_DIR, dir, "SKILL.md"), "utf-8");
      const fm = parseFrontmatter(content);
      if (fm?.name) {
        const name = String(fm.name);
        expect(names).not.toContain(name);
        names.push(name);
      }
    }
  });
});
