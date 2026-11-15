/** Link marks ([[phrase]], [[phrase|handle]]): taken out of stored text, never shown while streaming. */
import { describe, expect, it } from "vitest";
import { stripMarks, streamView } from "../src/core/marks";

describe("marks", () => {
  it("are taken out, and each phrase is found where it now sits", () => {
    const r = stripMarks("The [[octopus]] is a [[cephalopod|5@12]], not a [[ fish ]].");
    expect(r.text).toBe("The octopus is a cephalopod, not a  fish .");
    expect(r.marks).toEqual([
      { start: 4, end: 11, phrase: "octopus" },
      { start: 17, end: 27, phrase: "cephalopod", handle: "5@12" },
      { start: 36, end: 40, phrase: "fish" },
    ]);
    for (const m of r.marks) expect(r.text.slice(m.start, m.end)).toBe(m.phrase);
  });

  it("leave text without marks alone, and ignore brackets that are not marks", () => {
    expect(stripMarks("a [single] bracket and [[]] nothing").text).toBe("a [single] bracket and [[]] nothing");
    expect(stripMarks("plain").marks).toEqual([]);
  });

  it("never show while a model is still writing, even half-way through one", () => {
    expect(streamView("about the [[oct")).toBe("about the oct");
    expect(streamView("about the [[octopus|5@")).toBe("about the octopus");
    expect(streamView("about the [[octopus]")).toBe("about the octopus");
    expect(streamView("about the [")).toBe("about the ");
    expect(streamView("about the [[octopus]] and")).toBe("about the octopus and");
    expect(streamView("a [[x]] then [[y|z]] done")).toBe("a x then y done");
  });
});
