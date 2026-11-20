import { describe, expect, it } from "vitest";
import { parseResumeLines, type PdfLine } from "../src/index";

const line = (text: string, size = 10, x = 54): PdfLine => ({ text, size, x, y: 0, page: 1 });

describe("résumé PDF reader", () => {
  it("a line naming the open section ('Personal project' under PROJECTS) stays part of the entry", () => {
    const lines = [
      line("Alex Morgan", 20),
      line("alex.morgan@example.com"),
      line("PROJECTS", 12),
      line("Deviation Tracker  2024"),
      line("Personal project"),
      line("• Built a spreadsheet dashboard that flags overdue deviations"),
      line("Education", 12),
      line("State University"),
      line("B.S. in Biology  2019 – 2023"),
    ];
    const { resume } = parseResumeLines({ lines, text: lines.map((l) => l.text).join("\n"), pages: 1 });
    const projects = resume.experiences.filter((e) => e.type === "project");
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({ title: "Deviation Tracker", organization: "Personal project", startDate: "2024" });
    expect(projects[0]!.responsibilities).toEqual(["Built a spreadsheet dashboard that flags overdue deviations"]);
    // A real heading in title case and larger text still starts its section.
    expect(resume.experiences.find((e) => e.type === "education")).toMatchObject({ organization: "State University", endDate: "2023" });
    expect(resume.experiences.some((e) => e.title === "Untitled entry")).toBe(false);
  });
});
