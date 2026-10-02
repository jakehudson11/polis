import { describe, expect, test } from "@jest/globals";
import {
  SEED_COMMENT_TARGET_MIN,
  SEED_COMMENT_TARGET_MAX,
  SEED_COMMENT_CAP,
  buildSeedCommentSystemPrompt,
  buildSeedCommentUserPrompt,
  parseSeedComments,
  capSeedComments,
} from "../../src/utils/seedCommentPrompt";

describe("seedCommentPrompt constants", () => {
  test("target minimum is 12", () => {
    expect(SEED_COMMENT_TARGET_MIN).toBe(12);
  });

  test("target maximum is 15", () => {
    expect(SEED_COMMENT_TARGET_MAX).toBe(15);
  });

  test("safety-net cap equals target maximum", () => {
    expect(SEED_COMMENT_CAP).toBe(15);
    expect(SEED_COMMENT_CAP).toBe(SEED_COMMENT_TARGET_MAX);
  });
});

describe("parseSeedComments", () => {
  test("returns all 30 valid lines in original order without capping", () => {
    const lines = Array.from(
      { length: 30 },
      (_, i) => `Comment number ${i + 1} about the topic`
    );

    const result = parseSeedComments(lines.join("\n"));

    expect(result).toHaveLength(30);
    expect(result[0]).toBe("Comment number 1 about the topic");
    expect(result[29]).toBe("Comment number 30 about the topic");
  });

  test("drops blank and whitespace-only lines", () => {
    const result = parseSeedComments(
      "First comment\n\n   \n\t\nSecond comment\n"
    );

    expect(result).toEqual(["First comment", "Second comment"]);
  });

  test("drops a 141-char line but keeps a 140-char line", () => {
    const kept = "x".repeat(140);
    const dropped = "y".repeat(141);

    const result = parseSeedComments(`${kept}\n${dropped}`);

    expect(result).toEqual([kept]);
  });

  test("drops numbered lines and keeps plain lines", () => {
    const result = parseSeedComments(
      "1. Numbered with dot\n2) Numbered with paren\nPlain line kept"
    );

    expect(result).toEqual(["Plain line kept"]);
  });
});

describe("capSeedComments", () => {
  test("returns the first 15 items in original order when given 30", () => {
    const items = Array.from({ length: 30 }, (_, i) => `item-${i + 1}`);

    const result = capSeedComments(items);

    expect(result).toHaveLength(15);
    expect(result[0]).toBe("item-1");
    expect(result[14]).toBe("item-15");
  });

  test("leaves 12 items unchanged", () => {
    const items = Array.from({ length: 12 }, (_, i) => `item-${i + 1}`);

    expect(capSeedComments(items)).toEqual(items);
  });

  test("returns empty for empty input", () => {
    expect(capSeedComments([])).toEqual([]);
  });
});

describe("buildSeedCommentSystemPrompt", () => {
  test("targets 12–15 and never mentions 20-25", () => {
    const prompt = buildSeedCommentSystemPrompt();

    expect(prompt).toContain("12–15");
    expect(prompt).not.toContain("20-25");
    expect(prompt).not.toContain("20–25");
  });

  test("contains the explicit hard maximum sentence", () => {
    const prompt = buildSeedCommentSystemPrompt();

    expect(prompt).toContain(
      "Never produce more than 15 comments, regardless of the amount of relevant material."
    );
  });

  test("preserves the 50:50 balance language", () => {
    const prompt = buildSeedCommentSystemPrompt();

    expect(prompt).toContain(
      "deliberate 50:50 balance between comments that reflect broadly shared or universal values and comments that are polarizing or likely to divide participants"
    );
  });

  test("contains the breadth instruction", () => {
    const prompt = buildSeedCommentSystemPrompt();

    expect(prompt).toContain(
      "span the widest possible range of viewpoints and tensions"
    );
  });

  test("instructs self-curation instead of head-truncation", () => {
    const prompt = buildSeedCommentSystemPrompt();

    expect(prompt).toContain("do not simply keep the first 15");
  });
});

describe("buildSeedCommentUserPrompt", () => {
  const topic = "Should the city adopt congestion pricing?";
  const description = "A proposal to charge drivers entering the city centre.";
  const context = "Council debate notes about traffic, revenue, and fairness.";

  test("uses the 12–15 target and the 12-15 output-format line", () => {
    const prompt = buildSeedCommentUserPrompt(topic, description, context);

    expect(prompt).toContain("Generate 12–15 seed comments");
    expect(prompt).toContain(
      "Generate 12-15 seed comments, one per line, with NO numbering, NO bullets, NO labels."
    );
    expect(prompt).not.toContain("20-25");
    expect(prompt).not.toContain("20–25");
  });

  test("contains the hard-max Final Note", () => {
    const prompt = buildSeedCommentUserPrompt(topic, description, context);

    expect(prompt).toContain(
      "The absolute maximum is 15 comments. Never exceed it, even if more related statements are possible."
    );
  });

  test("preserves the odd-total balance rule within the final set", () => {
    const prompt = buildSeedCommentUserPrompt(topic, description, context);

    expect(prompt).toContain(
      "If the total number is odd, the difference between the two groups must not exceed one comment."
    );
  });

  test("interpolates the given topic, description and context", () => {
    const prompt = buildSeedCommentUserPrompt(topic, description, context);

    expect(prompt).toContain(`Topic: ${topic}`);
    expect(prompt).toContain(`Description: ${description}`);
    expect(prompt).toContain(context);
  });

  test("instructs cutting the weakest comments instead of keeping the first 15", () => {
    const prompt = buildSeedCommentUserPrompt(topic, description, context);

    expect(prompt).toContain("never keep just the first 15");
  });
});
