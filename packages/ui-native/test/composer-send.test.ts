/* Issue #802 — on a 402 pt phone a folder · branch chip plus the model
   chip pushed Send off the row. ui-native has no React Native renderer in
   vitest, so this pins the style contract that keeps Send in the row:
   the row and the label may be narrower than their text, chips shrink,
   the label stays one line, and the trailing button does not shrink. */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const src = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../src/employees/composer.tsx",
  ),
  "utf8",
);

/** The `{ … }` of `const <name> = { … } satisfies …`, whitespace collapsed. */
function styleBody(name: string): string {
  const m = new RegExp(`const ${name} = \\{([^}]+)\\} satisfies`).exec(src);
  expect(m, name).not.toBeNull();
  return (m?.[1] ?? "").replace(/\s+/g, " ").trim().replace(/,$/, "");
}

/** Opening tag of the Pressable that carries this accessibility label. */
function pressableOpening(label: string): string {
  const marker = `accessibilityLabel="${label}"`;
  const at = src.indexOf(marker);
  expect(at, marker).toBeGreaterThanOrEqual(0);
  const open = src.lastIndexOf("<Pressable", at);
  const end = src.indexOf(">", at);
  expect(open).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(at);
  return src.slice(open, end);
}

describe("issue #802 — Send stays on the composer chips row", () => {
  test("the row and chips shrink, labels truncate, and Send does not shrink", () => {
    expect(styleBody("composerRowStyle")).toBe("minWidth: 0");
    expect(styleBody("composerChipStyle")).toBe("flexShrink: 1, minWidth: 0");
    expect(styleBody("composerChipLabelStyle")).toBe(
      "flexShrink: 1, minWidth: 0",
    );
    expect(styleBody("composerTrailingStyle")).toBe("flexShrink: 0");

    const rowAt = src.indexOf('className="mt-2 flex-row items-center gap-1.5"');
    expect(rowAt).toBeGreaterThanOrEqual(0);
    const row = src.slice(rowAt, src.indexOf("</Glass>", rowAt));
    expect(row).toContain("style={composerRowStyle}");
    expect(row).toContain('<View className="flex-1" />');
    expect(row).not.toContain("flex-wrap");

    expect(pressableOpening("Send")).toContain("style={composerTrailingStyle}");
    expect(pressableOpening("Stop")).toContain("style={composerTrailingStyle}");
    expect(src.match(/style=\{composerTrailingStyle\}/g)).toHaveLength(2);

    const chip = src.slice(src.indexOf("function Chip("));
    const beforeLabel = chip.slice(0, chip.indexOf("<Text"));
    expect(beforeLabel).toContain("style={composerChipStyle}");
    expect(beforeLabel).toContain("max-w-[170px]");

    const label = chip.slice(chip.indexOf("<Text"), chip.indexOf("</Text>"));
    expect(label).toContain("numberOfLines={1}");
    expect(label).toContain('ellipsizeMode="tail"');
    expect(label).toContain("style={composerChipLabelStyle}");
  });
});
