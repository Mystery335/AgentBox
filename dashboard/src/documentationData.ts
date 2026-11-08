export const documentationData = {
  title: "Registration service",
  generatedBy: "Analyze & document",
  sourceRevision: "a7c92d1",
  exampleData: true,
  overview:
    "Validates applicant registration data, checks eligibility and prevents duplicate registration IDs. The modernization preserves observable behavior while converting the implementation from C to Java.",
  rules: [
    {
      id: "BR-01",
      title: "Required fields",
      description: "Email and registration ID must be present.",
    },
    {
      id: "BR-02",
      title: "Unique ID",
      description: "Reject registration IDs that already exist.",
    },
    {
      id: "BR-03",
      title: "Input length",
      description: "Reject fields exceeding the source-defined limit.",
    },
    {
      id: "BR-04",
      title: "Minimum age",
      description: "Accept applicants aged 18 and above.",
    },
  ],
  reviewNotes:
    "Generated documentation is a starting point for engineering review. Confirm inferred rules and dependencies against source evidence.",
  sections: [
    {
      title: "File mapping",
      paragraphs: [
        "The example run analyzes 8 source files and generates 8 Java files.",
        "The supplied comparison maps registration.c to Registration.java. Review the original and generated code side by side to trace each extracted business rule.",
        "The remaining file mappings are not included in this local example. Confirm them against the generated run artifacts.",
      ],
    },
    {
      title: "Dependencies",
      paragraphs: [
        "The original registration service is written in C; the migration target is Java 21.",
        "The example does not include a dependency manifest or a complete dependency graph. Confirm external libraries, build tools and runtime requirements against the source project before release.",
      ],
    },
    {
      title: "Assumptions",
      paragraphs: [
        "The original source is the protected behavioral baseline. Compare both implementations against the same inputs.",
        "Generated business rules are inferred and require engineering review. Confirm the required fields, unique registration IDs, input length limits and minimum age against source evidence.",
        "The source revision displayed here is part of the Figma example run. This local preview does not inspect a live repository or execute the agents.",
      ],
    },
    {
      title: "Known limitations",
      paragraphs: [
        "23 of 24 completed tests match. The generated age check excludes age 18, while the original accepts it. The proposed boundary repair is awaiting rerun.",
        "Two business rules remain untested. A passing suite does not establish equivalence for every possible input.",
        "One medium security finding still requires review. The example reports blocked baseline write and network access attempts.",
        "This local preview displays example run data. A backend connection is required to analyze source files, run agents or validate a repair.",
      ],
    },
  ],
};
