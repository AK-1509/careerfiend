import { mentions } from "@careerfiend/matcher";

/**
 * Canonical vocabulary for job-specific bullets. Semantically equivalent
 * expressions map to one family ("KPI", "success metrics", "performance
 * metrics" -> metrics_kpi) so matching works by meaning, while each family
 * keeps its surface forms so bullets can still use natural wording. Nothing
 * here rewrites text by itself: the families are evidence for matching and
 * for validation.
 */

/* --------------------------------------------------------------- verbs */

const IRREGULAR: Record<string, string> = {
  build: "built",
  lead: "led",
  run: "ran",
  write: "wrote",
  set: "set",
  drive: "drove",
  make: "made",
  teach: "taught",
  begin: "began",
  grow: "grew",
  take: "took",
  give: "gave",
  hold: "held",
  draw: "drew",
  find: "found",
  sell: "sold",
  oversee: "oversaw",
  understand: "understood",
  speak: "spoke",
  shape: "shaped",
  win: "won",
  bring: "brought",
  think: "thought",
  put: "put",
  cut: "cut",
  meet: "met",
};

export interface VerbForms {
  base: string;
  past: string;
  gerund: string;
  third: string;
}

const DOUBLE_FINAL = new Set(["plan", "ship", "map", "stop", "chat", "scan", "tag", "log", "drop", "pin"]);

export function verbForms(base: string): VerbForms {
  const b = base.toLowerCase();
  const consonantY = /[^aeiou]y$/.test(b);
  const doubles = DOUBLE_FINAL.has(b);
  const past = IRREGULAR[b] ?? (b.endsWith("e") ? `${b}d` : consonantY ? `${b.slice(0, -1)}ied` : doubles ? `${b}${b.slice(-1)}ed` : `${b}ed`);
  const gerund = b.endsWith("ie")
    ? `${b.slice(0, -2)}ying`
    : b.endsWith("e") && !b.endsWith("ee")
      ? `${b.slice(0, -1)}ing`
      : doubles
        ? `${b}${b.slice(-1)}ing`
        : `${b}ing`;
  const third = consonantY ? `${b.slice(0, -1)}ies` : /(s|sh|ch|x|z|o)$/.test(b) ? `${b}es` : `${b}s`;
  return { base: b, past, gerund, third };
}

export interface ActionFamily {
  id: string;
  verbs: string[];
  /** Claims people management or authority over others: needs explicit evidence. */
  managerial?: boolean;
  /** Families close enough that one can stand in for the other in matching (never in claims). */
  related: string[];
}

export const ACTION_FAMILIES: ActionFamily[] = [
  {
    id: "build",
    verbs: ["build", "develop", "create", "implement", "engineer", "code", "program", "construct", "assemble"],
    related: ["design", "launch", "improve"],
  },
  {
    id: "design",
    verbs: ["design", "prototype", "wireframe", "sketch", "architect", "storyboard", "illustrate", "draft"],
    related: ["build", "plan", "research"],
  },
  {
    id: "analyze",
    verbs: [
      "analyze",
      "analyse",
      "evaluate",
      "assess",
      "examine",
      "investigate",
      "audit",
      "review",
      "diagnose",
      "interpret",
      "synthesize",
      "benchmark",
      "quantify",
      "model",
      "forecast",
      "estimate",
      "calculate",
      "map",
    ],
    related: ["research", "test", "monitor"],
  },
  {
    id: "research",
    verbs: ["research", "study", "interview", "survey", "explore", "discover", "observe", "gather", "collect", "identify"],
    related: ["analyze", "test"],
  },
  {
    id: "test",
    verbs: ["test", "validate", "verify", "inspect", "qualify", "pilot", "trial", "experiment", "troubleshoot", "debug"],
    related: ["analyze", "research", "improve"],
  },
  {
    id: "plan",
    verbs: ["plan", "define", "establish", "set", "scope", "prioritize", "strategize", "outline", "frame", "specify", "determine", "shape", "propose"],
    related: ["design", "lead"],
  },
  {
    id: "lead",
    verbs: ["lead", "manage", "direct", "supervise", "oversee", "head", "mentor", "coach", "hire", "own", "champion", "spearhead", "chair"],
    managerial: true,
    related: ["plan", "collaborate"],
  },
  {
    id: "collaborate",
    verbs: ["collaborate", "partner", "coordinate", "liaise", "align", "facilitate", "work", "cooperate"],
    related: ["communicate", "lead"],
  },
  {
    id: "communicate",
    verbs: [
      "present",
      "communicate",
      "report",
      "pitch",
      "write",
      "document",
      "brief",
      "publish",
      "author",
      "translate",
      "explain",
      "advise",
      "recommend",
      "persuade",
    ],
    related: ["collaborate"],
  },
  {
    id: "improve",
    verbs: [
      "improve",
      "optimize",
      "streamline",
      "enhance",
      "refine",
      "increase",
      "reduce",
      "accelerate",
      "automate",
      "standardize",
      "upgrade",
      "redesign",
      "simplify",
      "grow",
      "scale",
    ],
    related: ["build", "test"],
  },
  { id: "launch", verbs: ["launch", "ship", "deliver", "release", "deploy", "introduce", "roll", "complete", "execute"], related: ["build", "operate"] },
  {
    id: "operate",
    verbs: [
      "run",
      "clean",
      "compile",
      "curate",
      "catalog",
      "transcribe",
      "operate",
      "maintain",
      "administer",
      "perform",
      "conduct",
      "process",
      "prepare",
      "handle",
      "organize",
      "schedule",
      "track",
      "monitor",
      "measure",
      "record",
      "update",
      "support",
      "assist",
      "help",
      "serve",
      "resolve",
    ],
    related: ["launch", "improve"],
  },
  {
    id: "sell",
    verbs: ["sell", "market", "promote", "acquire", "negotiate", "source", "procure", "close", "pitch", "fundraise", "raise"],
    related: ["communicate", "plan"],
  },
  { id: "train", verbs: ["train", "teach", "onboard", "educate", "tutor", "instruct"], related: ["communicate", "lead"] },
];

/** Every verb form -> family. */
const VERB_INDEX = new Map<string, { family: string; base: string }>();
for (const f of ACTION_FAMILIES) {
  for (const v of f.verbs) {
    const forms = verbForms(v);
    for (const form of [forms.base, forms.past, forms.gerund, forms.third]) if (!VERB_INDEX.has(form)) VERB_INDEX.set(form, { family: f.id, base: forms.base });
  }
}
VERB_INDEX.set("analysed", { family: "analyze", base: "analyse" });

export function actionOf(word: string): { family: string; base: string } | null {
  return VERB_INDEX.get(word.toLowerCase()) ?? null;
}

export function actionFamily(id: string): ActionFamily | undefined {
  return ACTION_FAMILIES.find((f) => f.id === id);
}

export function isPastTenseVerb(word: string): boolean {
  const w = word.toLowerCase();
  const a = VERB_INDEX.get(w);
  return (!!a && verbForms(a.base).past === w) || (/^[a-z]+ed$/.test(w) && w.length > 4);
}

/* ------------------------------------------------------------ concepts */

export type ConceptDomain =
  "product" | "business" | "technical" | "design" | "analytics" | "marketing" | "research" | "operations" | "quality" | "finance" | "people" | "general";

export interface ConceptFamily {
  id: string;
  label: string;
  domain: ConceptDomain;
  /** Surface forms as written in listings and résumés. */
  terms: string[];
  /** Families that are related (semantic neighbourhood), never interchangeable in claims. */
  related?: string[];
}

export const CONCEPTS: ConceptFamily[] = [
  // product
  {
    id: "product_goals",
    label: "product goals",
    domain: "product",
    terms: ["product goals", "product objectives", "product vision", "product direction"],
    related: ["product_strategy", "roadmap", "metrics_kpi"],
  },
  {
    id: "product_strategy",
    label: "product strategy",
    domain: "product",
    terms: ["product strategy", "product planning", "product decisions"],
    related: ["product_goals", "roadmap", "strategy"],
  },
  {
    id: "roadmap",
    label: "roadmap",
    domain: "product",
    terms: ["roadmap", "product roadmap", "roadmaps", "prioritization", "backlog"],
    related: ["product_goals", "project_management"],
  },
  {
    id: "requirements",
    label: "product requirements",
    domain: "product",
    terms: ["product requirements", "requirements", "PRD", "PRDs", "specifications", "specs", "user stories", "acceptance criteria", "feature requirements"],
    related: ["roadmap", "ux_design"],
  },
  {
    id: "product_features",
    label: "product features",
    domain: "product",
    terms: ["product features", "features", "feature", "product improvements", "enhancements", "functionality"],
    related: ["requirements", "software_development"],
  },
  {
    id: "product_launch",
    label: "product launch",
    domain: "product",
    terms: ["product launch", "product launches", "go-to-market", "GTM", "launch plan", "launch plans"],
    related: ["marketing_campaigns", "product_strategy"],
  },
  {
    id: "user_needs",
    label: "user needs",
    domain: "product",
    terms: ["user needs", "customer needs", "pain points", "user problems", "customer problems", "user pain points"],
    related: ["user_research", "user_feedback"],
  },
  // research
  {
    id: "user_research",
    label: "user research",
    domain: "research",
    terms: [
      "user research",
      "UX research",
      "user interviews",
      "customer interviews",
      "customer discovery",
      "ethnographic research",
      "contextual inquiry",
      "interviews",
    ],
    related: ["user_feedback", "usability_testing", "user_needs", "market_research"],
  },
  {
    id: "user_feedback",
    label: "user feedback",
    domain: "research",
    terms: ["user feedback", "customer feedback", "feedback", "survey results", "surveys", "survey", "NPS", "reviews"],
    related: ["user_research", "user_needs"],
  },
  {
    id: "usability_testing",
    label: "usability testing",
    domain: "research",
    terms: ["usability testing", "usability tests", "user testing", "usability sessions", "user tests", "usability studies"],
    related: ["user_research", "prototyping", "testing_qa"],
  },
  {
    id: "market_research",
    label: "market research",
    domain: "research",
    terms: [
      "market research",
      "market analysis",
      "market sizing",
      "market trends",
      "market landscape",
      "industry trends",
      "industry research",
      "TAM",
      "market opportunities",
    ],
    related: ["competitive_analysis", "strategy", "user_research"],
  },
  {
    id: "competitive_analysis",
    label: "competitive analysis",
    domain: "research",
    terms: [
      "competitive intelligence",
      "competitive analysis",
      "competitive landscape",
      "competitive-landscape analysis",
      "competitor research",
      "competitor analysis",
      "competitors",
      "benchmarking",
    ],
    related: ["market_research", "strategy"],
  },
  {
    id: "research_methods",
    label: "research methods",
    domain: "research",
    terms: [
      "research",
      "literature review",
      "literature reviews",
      "study design",
      "qualitative research",
      "quantitative research",
      "research methods",
      "findings",
      "insights",
    ],
    related: ["user_research", "data_analysis"],
  },
  {
    id: "experimentation",
    label: "experimentation",
    domain: "analytics",
    terms: ["A/B testing", "A/B tests", "experiments", "experimentation", "split tests", "hypothesis testing"],
    related: ["data_analysis", "usability_testing"],
  },
  // analytics
  {
    id: "metrics_kpi",
    label: "KPIs",
    domain: "analytics",
    terms: [
      "KPIs",
      "KPI",
      "key performance indicators",
      "key performance indicator",
      "success metrics",
      "performance metrics",
      "metrics",
      "OKRs",
      "OKR",
      "targets",
      "benchmarks",
    ],
    related: ["data_analysis", "dashboards", "product_goals"],
  },
  {
    id: "data_analysis",
    label: "data analysis",
    domain: "analytics",
    terms: [
      "data analysis",
      "analyze data",
      "analyzed data",
      "analytics",
      "data",
      "datasets",
      "statistical analysis",
      "statistics",
      "statistical",
      "regression",
      "quantitative analysis",
      "trend analysis",
      "data-driven",
    ],
    related: ["metrics_kpi", "dashboards", "data_modeling"],
  },
  {
    id: "dashboards",
    label: "dashboards",
    domain: "analytics",
    terms: ["dashboards", "dashboard", "reporting", "reports", "visualizations", "data visualization"],
    related: ["metrics_kpi", "data_analysis"],
  },
  {
    id: "data_modeling",
    label: "data models",
    domain: "analytics",
    terms: ["data models", "predictive models", "models", "modeling", "modelling", "forecasting", "forecasts", "forecast accuracy"],
    related: ["data_analysis", "machine_learning", "financial_modeling"],
  },
  {
    id: "machine_learning",
    label: "machine learning",
    domain: "technical",
    terms: ["machine learning", "machine-learning", "ML", "deep learning", "neural networks", "classification models", "NLP", "computer vision"],
    related: ["data_modeling", "ai"],
  },
  {
    id: "ai",
    label: "AI",
    domain: "technical",
    terms: ["AI", "artificial intelligence", "generative AI", "LLMs", "LLM", "large language models", "agentic", "AI agents", "prompt engineering"],
    related: ["machine_learning", "software_development"],
  },
  // technical
  {
    id: "software_development",
    label: "software development",
    domain: "technical",
    terms: [
      "software development",
      "software engineering",
      "software",
      "applications",
      "apps",
      "app",
      "web application",
      "code",
      "codebase",
      "programming",
      "coding",
      "scripts",
      "tools",
      "tooling",
      "plugin",
      "platform",
    ],
    related: ["product_features", "apis", "testing_qa"],
  },
  {
    id: "apis",
    label: "APIs",
    domain: "technical",
    terms: ["APIs", "API", "integrations", "integration", "endpoints", "microservices"],
    related: ["software_development", "data_pipelines"],
  },
  {
    id: "data_pipelines",
    label: "data pipelines",
    domain: "technical",
    terms: ["data pipelines", "pipelines", "pipeline", "ETL", "data infrastructure", "data engineering", "workflows automation"],
    related: ["apis", "data_analysis"],
  },
  {
    id: "cloud",
    label: "cloud infrastructure",
    domain: "technical",
    terms: ["cloud", "cloud infrastructure", "infrastructure", "deployment", "DevOps", "CI/CD"],
    related: ["software_development"],
  },
  {
    id: "testing_qa",
    label: "QA testing",
    domain: "quality",
    terms: ["QA testing", "quality assurance", "QA", "testing", "test cases", "test plans", "validation", "verification"],
    related: ["quality_control", "usability_testing", "software_development"],
  },
  {
    id: "bioinformatics",
    label: "bioinformatics",
    domain: "technical",
    terms: ["bioinformatics", "genomics", "sequencing", "RNA-seq", "computational biology"],
    related: ["data_analysis", "lab_research"],
  },
  // design
  {
    id: "ux_design",
    label: "UX design",
    domain: "design",
    terms: [
      "UX design",
      "UX",
      "user experience",
      "UI",
      "user interface",
      "interface design",
      "interaction design",
      "UI/UX",
      "user flows",
      "user workflows",
      "workflows",
      "information architecture",
    ],
    related: ["prototyping", "visual_design", "usability_testing"],
  },
  {
    id: "prototyping",
    label: "prototypes",
    domain: "design",
    terms: ["prototypes", "prototype", "prototyping", "mockups", "mock-ups", "wireframes", "MVP", "MVPs", "proof of concept"],
    related: ["ux_design", "usability_testing", "product_features"],
  },
  {
    id: "visual_design",
    label: "visual design",
    domain: "design",
    terms: ["visual design", "graphic design", "branding assets", "layouts", "typography", "illustrations", "presentation media", "design assets"],
    related: ["ux_design", "branding"],
  },
  {
    id: "design_systems",
    label: "design systems",
    domain: "design",
    terms: ["design systems", "design system", "component libraries", "style guides", "design tokens"],
    related: ["ux_design", "visual_design"],
  },
  // marketing
  {
    id: "marketing_campaigns",
    label: "marketing campaigns",
    domain: "marketing",
    terms: ["marketing campaigns", "campaigns", "campaign", "email marketing", "social media", "content marketing", "paid media", "ads"],
    related: ["content", "branding", "growth"],
  },
  {
    id: "content",
    label: "content",
    domain: "marketing",
    terms: ["content", "copy", "copywriting", "articles", "blog posts", "newsletters", "messaging", "storytelling", "B-roll", "video"],
    related: ["marketing_campaigns", "branding"],
  },
  {
    id: "branding",
    label: "brand",
    domain: "marketing",
    terms: ["brand", "branding", "brand identity", "positioning", "brand strategy", "value proposition"],
    related: ["marketing_campaigns", "visual_design"],
  },
  {
    id: "growth",
    label: "growth",
    domain: "marketing",
    terms: ["growth", "user acquisition", "acquisition", "retention", "engagement", "conversion", "funnel", "SEO"],
    related: ["marketing_campaigns", "metrics_kpi"],
  },
  // business
  {
    id: "strategy",
    label: "strategy",
    domain: "business",
    terms: ["strategy", "strategic planning", "business strategy", "strategic initiatives", "business model", "business models"],
    related: ["market_research", "product_strategy", "competitive_analysis"],
  },
  {
    id: "business_development",
    label: "business development",
    domain: "business",
    terms: ["business development", "BD", "partnerships", "partnership", "deals", "sales pipeline", "lead generation", "outreach"],
    related: ["sales", "fundraising"],
  },
  {
    id: "sales",
    label: "sales",
    domain: "business",
    terms: ["sales", "revenue", "accounts", "quota", "pipeline management", "client acquisition"],
    related: ["business_development", "pricing"],
  },
  {
    id: "pricing",
    label: "pricing",
    domain: "finance",
    terms: ["pricing", "pricing strategy", "price", "prices", "monetization", "unit economics"],
    related: ["pricing_models", "financial_modeling", "sales", "strategy"],
  },
  {
    id: "pricing_models",
    label: "pricing models",
    domain: "finance",
    terms: ["pricing models", "pricing model", "price models", "price elasticity models"],
    related: ["pricing", "financial_modeling", "data_modeling"],
  },
  {
    id: "financial_modeling",
    label: "financial models",
    domain: "finance",
    terms: [
      "financial models",
      "financial model",
      "financial modeling",
      "financial modelling",
      "valuation",
      "valuations",
      "DCF",
      "P&L",
      "projections",
      "market-sizing estimates",
      "budget",
      "budgets",
      "budgeting",
    ],
    related: ["pricing", "data_modeling", "fundraising"],
  },
  {
    id: "fundraising",
    label: "investor readiness",
    domain: "finance",
    terms: ["fundraising", "investor readiness", "investor relations", "pitch deck", "pitch decks", "investor pitch", "due diligence", "venture capital"],
    related: ["financial_modeling", "business_development"],
  },
  // operations
  {
    id: "project_management",
    label: "project management",
    domain: "operations",
    terms: [
      "project management",
      "projects",
      "project",
      "timelines",
      "timeline",
      "milestones",
      "deliverables",
      "project plans",
      "delivery timelines",
      "deadlines",
    ],
    related: ["roadmap", "process_improvement"],
  },
  {
    id: "process_improvement",
    label: "process improvement",
    domain: "operations",
    terms: [
      "process improvement",
      "process improvements",
      "process optimization",
      "processes",
      "process",
      "efficiency",
      "operational efficiency",
      "lean",
      "Six Sigma",
      "templates",
      "standardization",
    ],
    related: ["operations", "documentation", "project_management"],
  },
  {
    id: "operations",
    label: "operations",
    domain: "operations",
    terms: ["operations", "logistics", "supply chain", "inventory", "procurement", "vendor management", "manufacturing", "production"],
    related: ["process_improvement", "quality_control"],
  },
  {
    id: "documentation",
    label: "documentation",
    domain: "operations",
    terms: [
      "documentation",
      "SOPs",
      "SOP",
      "standard operating procedures",
      "technical writing",
      "records",
      "batch-manufacturing records",
      "batch records",
      "written reports",
    ],
    related: ["process_improvement", "compliance"],
  },
  // quality / regulated
  {
    id: "compliance",
    label: "compliance",
    domain: "quality",
    terms: [
      "compliance",
      "regulatory",
      "regulations",
      "GMP",
      "GxP",
      "GLP",
      "FDA",
      "audits",
      "audit readiness",
      "protocols",
      "21 CFR Part 11",
      "ICH guidelines",
    ],
    related: ["quality_control", "documentation"],
  },
  {
    id: "quality_control",
    label: "quality control",
    domain: "quality",
    terms: [
      "quality control",
      "QC",
      "batches",
      "batch",
      "inspection",
      "inspections",
      "deviations",
      "CAPA",
      "change control",
      "quality checks",
      "packaging-suitability",
    ],
    related: ["compliance", "testing_qa"],
  },
  {
    id: "lab_research",
    label: "laboratory research",
    domain: "research",
    terms: ["laboratory", "lab", "assays", "assay", "experiments in the lab", "wet lab", "cell culture", "bench work"],
    related: ["research_methods", "quality_control"],
  },
  {
    id: "clinical",
    label: "clinical research",
    domain: "research",
    terms: ["clinical trials", "clinical research", "clinical data", "patients", "healthcare", "medical"],
    related: ["compliance", "research_methods"],
  },
  // people
  {
    id: "communication",
    label: "presentations",
    domain: "people",
    terms: ["presentations", "presentation", "presented findings", "communication", "stakeholder communication", "executive updates", "pitches"],
    related: ["documentation", "content"],
  },
  {
    id: "training",
    label: "training",
    domain: "people",
    terms: ["training", "trainings", "onboarding", "workshops", "workshop", "curriculum", "teaching"],
    related: ["communication", "documentation"],
  },
  {
    id: "team_management",
    label: "team management",
    domain: "people",
    terms: ["team management", "people management", "direct reports", "managed a team", "team of", "hiring", "performance reviews"],
    related: [],
  },
  {
    id: "events",
    label: "events",
    domain: "operations",
    terms: ["events", "event", "photoshoots", "conferences", "programs"],
    related: ["marketing_campaigns", "project_management"],
  },
  {
    id: "translation_language",
    label: "bilingual communication",
    domain: "people",
    terms: ["bilingual", "translation", "language barriers", "multilingual"],
    related: ["communication"],
  },
];

/** Concepts whose single generic surface words are too broad on their own ("data", "project", "process"). */
const WEAK_TERMS = new Set([
  "data",
  "project",
  "projects",
  "process",
  "processes",
  "feature",
  "features",
  "tools",
  "app",
  "apps",
  "code",
  "software",
  "platform",
  "research",
  "feedback",
  "content",
  "events",
  "event",
  "programs",
  "batch",
  "batches",
  "records",
  "models",
  "insights",
  "findings",
  "metrics",
  "targets",
  "benchmarks",
  "price",
  "prices",
  "accounts",
  "revenue",
  "deals",
  "growth",
  "engagement",
  "video",
  "copy",
  "brand",
  "workflows",
  "validation",
  "testing",
  "lab",
  "budget",
  "budgets",
  "presentation",
  "presentations",
  "communication",
  "interviews",
  "survey",
  "surveys",
  "reviews",
  "process",
]);

export interface ConceptHit {
  id: string;
  label: string;
  domain: ConceptDomain;
  /** The wording that appeared in the text. */
  term: string;
  /** Matched only through a broad single word. */
  weak: boolean;
}

const CONCEPT_TERMS: { term: string; family: ConceptFamily }[] = CONCEPTS.flatMap((f) => f.terms.map((term) => ({ term, family: f }))).sort(
  (a, b) => b.term.length - a.term.length,
);

function escapeRe(t: string): string {
  return t.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/** Remove a matched wording (word-bounded) so shorter wordings inside it do not match again. */
function consume(text: string, term: string): string {
  return text.replace(new RegExp(`(^|[^A-Za-z0-9])${escapeRe(term)}(?=$|[^A-Za-z0-9+#])`, term.length <= 2 ? "g" : "gi"), "$1 ");
}

/** Concept families in a text, longest wording first, each family once. */
export function conceptsIn(text: string): ConceptHit[] {
  const out = new Map<string, ConceptHit>();
  let rest = ` ${text} `;
  for (const { term, family } of CONCEPT_TERMS) {
    if (!mentions(rest, term)) continue;
    const weak = WEAK_TERMS.has(term.toLowerCase());
    const prev = out.get(family.id);
    if (!prev || (prev.weak && !weak)) out.set(family.id, { id: family.id, label: family.label, domain: family.domain, term, weak });
    // Consume the wording so "market-sizing estimates" does not also count as "estimates".
    rest = consume(rest, term);
  }
  return [...out.values()];
}

export function conceptFamily(id: string): ConceptFamily | undefined {
  return CONCEPTS.find((c) => c.id === id);
}

/** Concepts that are themselves the activity: "ran usability sessions" shows testing, "user interviews" show research. */
export const CONCEPT_IMPLIES_ACTION: Record<string, string> = {
  usability_testing: "test",
  testing_qa: "test",
  experimentation: "test",
  quality_control: "test",
  user_research: "research",
  market_research: "research",
  research_methods: "research",
  lab_research: "research",
  competitive_analysis: "analyze",
  data_analysis: "analyze",
  financial_modeling: "analyze",
  prototyping: "design",
  ux_design: "design",
  documentation: "communicate",
  communication: "communicate",
  content: "communicate",
};

export function relatedConcepts(id: string): string[] {
  const f = conceptFamily(id);
  const back = CONCEPTS.filter((c) => c.related?.includes(id)).map((c) => c.id);
  return [...new Set([...(f?.related ?? []), ...back])];
}

/* ------------------------------------------------------------ hard terms */

/** Tools, technologies and methods with a precise name: only claimable when the evidence names them. */
export const TOOLS = [
  "SQL",
  "Python",
  "R",
  "Excel",
  "Microsoft Excel",
  "Google Sheets",
  "Tableau",
  "Power BI",
  "Looker",
  "Figma",
  "Sketch",
  "Adobe Creative Suite",
  "Photoshop",
  "Illustrator",
  "InDesign",
  "Premiere Pro",
  "After Effects",
  "JIRA",
  "Jira",
  "Asana",
  "Notion",
  "Confluence",
  "Salesforce",
  "HubSpot",
  "Google Analytics",
  "Mixpanel",
  "Amplitude",
  "JavaScript",
  "TypeScript",
  "React",
  "Node.js",
  "Next.js",
  "Java",
  "C++",
  "Go",
  "AWS",
  "GCP",
  "Azure",
  "Microsoft Azure",
  "Docker",
  "Kubernetes",
  "Snowflake",
  "dbt",
  "Git",
  "GitHub",
  "MATLAB",
  "SAS",
  "SPSS",
  "JMP",
  "Minitab",
  "HPLC",
  "ELISA",
  "qPCR",
  "PCR",
  "LIMS",
  "Veeva Vault",
  "Veeva",
  "SAP",
  "Microsoft Office 365",
  "Microsoft Office",
  "PowerPoint",
  "Benchling",
  "TensorFlow",
  "PyTorch",
  "pandas",
  "scikit-learn",
  "Unix",
  "Linux",
  "Claude",
  "Claude Code",
  "ChatGPT",
  "Webflow",
  "WordPress",
  "Shopify",
  "Zapier",
  "Airtable",
  "Smartsheet",
  "Spotfire",
  "Postgres",
  "PostgreSQL",
  "MongoDB",
  "Vercel",
  "Canva",
];

const TOOL_TERMS = [...TOOLS].sort((a, b) => b.length - a.length);

/** Named tools/technologies in a text (longest first; "Veeva Vault" beats "Veeva"). */
export function toolsIn(text: string): string[] {
  const found: string[] = [];
  let rest = ` ${text} `;
  for (const t of TOOL_TERMS) {
    if (!mentions(rest, t)) continue;
    found.push(t);
    rest = consume(rest, t);
  }
  return found;
}

/* ---------------------------------------------------------- stakeholders */

export interface StakeholderCategory {
  id: string;
  label: string;
  /** How a bullet refers to them (broad, never a title). */
  phrase: string;
  patterns: RegExp[];
}

export const STAKEHOLDERS: StakeholderCategory[] = [
  {
    id: "engineering",
    label: "Engineering / Technical Team",
    phrase: "engineering team",
    patterns: [
      /\b(cto|engineering (directors?|managers?|leads?|teams?)|engineers?|developers?|software teams?|technical teams?|tech leads?|it teams?|devops)\b/i,
    ],
  },
  {
    id: "product",
    label: "Product Team",
    phrase: "product team",
    patterns: [/\b(product managers?|product owners?|product directors?|product leads?|product teams?|pms?|product management)\b/i],
  },
  {
    id: "design",
    label: "Design / UX Team",
    phrase: "design team",
    patterns: [/\b(ux designers?|ui designers?|product designers?|designers?|design leads?|design teams?|ux teams?|ux researchers?|creative teams?)\b/i],
  },
  {
    id: "data",
    label: "Data / Analytics Team",
    phrase: "data team",
    patterns: [/\b(data scientists?|data analysts?|analytics (leads?|teams?)|data engineers?|data teams?|bi teams?|analysts?)\b/i],
  },
  {
    id: "marketing",
    label: "Marketing Team",
    phrase: "marketing team",
    patterns: [/\b(marketing (teams?|managers?|leads?)|marketers?|growth teams?|brand teams?|communications teams?|content teams?)\b/i],
  },
  {
    id: "sales",
    label: "Sales / Customer Team",
    phrase: "sales and customer teams",
    patterns: [
      /\b(sales (teams?|reps?|representatives?)|account executives?|account managers?|customer success( teams?| managers?)?|support teams?|business development (teams?|reps?))\b/i,
    ],
  },
  // "Quality Assurance" alone is the activity (QA testing); only a QA/quality team is a stakeholder.
  {
    id: "quality",
    label: "Quality / Regulatory Team",
    phrase: "quality and regulatory teams",
    patterns: [
      /\b(quality assurance teams?|qa teams?|qc teams?|quality control teams?|regulatory (teams?|affairs)|quality teams?|compliance teams?|validation teams?)\b/i,
      // A team named in a list of teams: "Quality Assurance and Manufacturing" (title case, case-sensitive).
      /\bQuality Assurance(?=\s+(?:and|&)\s+[A-Z])/,
    ],
  },
  {
    id: "operations",
    label: "Operations Team",
    phrase: "operations team",
    patterns: [/\b(operations (teams?|managers?)|ops teams?|supply chain teams?|manufacturing( teams?)?|logistics teams?|production teams?)\b/i],
  },
  { id: "finance", label: "Finance Team", phrase: "finance team", patterns: [/\b(finance (teams?|partners?)|accounting( teams?)?|fp&a|controllers?)\b/i] },
  {
    id: "research",
    label: "Research Team",
    phrase: "research team",
    patterns: [/\b(scientists?|researchers?|research teams?|lab teams?|principal investigators?|faculty)\b/i],
  },
  {
    id: "executive_leadership",
    label: "Executive Leadership",
    phrase: "leadership",
    patterns: [
      /\b(ceo|coo|cfo|cmo|cpo|chief [a-z]+ officer|c-suite|c-level|vps?|vice presidents?|svps?|evps?|executives?|executive team|leadership( team)?|senior leadership|founders?|co-founders?|general managers?|board( of directors| members)?|presidents?|directors?|heads? of [a-z]+)\b/i,
    ],
  },
  {
    id: "partners",
    label: "External Partners",
    phrase: "external partners",
    patterns: [/\b(external partners?|partners?|vendors?|suppliers?|agencies|agency|contractors?|cros?|consultants?|institutions?|collaborators?)\b/i],
  },
  {
    id: "customers",
    label: "Customers / Users",
    phrase: "users",
    patterns: [/\b(customers?|users?|end users?|clients?|patients?|consumers?|participants?|students?|buyers?|audiences?)\b/i],
  },
  { id: "investors", label: "Investors", phrase: "investors", patterns: [/\b(investors?|vcs?|venture capitalists?|shareholders?|limited partners|lps)\b/i] },
  {
    id: "cross_functional",
    label: "Cross-Functional Teams",
    phrase: "cross-functional teams",
    patterns: [
      /\b(cross-functional(ly)?( teams?| partners?)?|cross functional(ly)?( teams?)?|stakeholders?|functional teams?|multiple teams|two functional teams|other teams|internal teams?)\b/i,
    ],
  },
];

export interface StakeholderHit {
  category: string;
  label: string;
  /** The first wording that appeared (often a specific title). */
  as: string;
  /** Every wording of this category in the text. */
  all: string[];
}

/** Stakeholder references, generalized into broad categories. Order matters: specific teams ("Engineering Director") before executives, executives before the catch-alls. */
export function stakeholdersIn(text: string): StakeholderHit[] {
  const out = new Map<string, StakeholderHit>();
  let rest = text;
  for (const s of STAKEHOLDERS) {
    for (const p of s.patterns) {
      const g = new RegExp(p.source, p.flags.includes("g") ? p.flags : `${p.flags}g`);
      for (const m of rest.matchAll(g)) {
        const as = m[0];
        // "partner with engineers" uses partner as a verb.
        if (s.id === "partners" && /^partner$/i.test(as) && /^\s+with\b/i.test(rest.slice((m.index ?? 0) + as.length))) continue;
        const prev = out.get(s.id);
        if (prev) prev.all.push(as);
        else out.set(s.id, { category: s.id, label: s.label, as, all: [as] });
      }
      rest = rest.replace(g, " ");
    }
  }
  return [...out.values()];
}

export function stakeholderCategory(id: string): StakeholderCategory | undefined {
  return STAKEHOLDERS.find((s) => s.id === id);
}

/** Specific organizational titles: a bullet may name one only if the evidence says that exact title. */
export const TITLE_PATTERN =
  /\b(ceo|coo|cfo|cto|cmo|cpo|chief [a-z]+ officer|vp|vice president|svp|evp|director|head of [a-z]+|general manager|product manager|engineering manager|program manager|design lead|data scientist|account executive)s?\b/gi;

/* ------------------------------------------------------- low-value language */

/** Phrases that carry no transferable responsibility (culture, branding, framing). Removed from templates. */
export const LOW_VALUE_PHRASES = [
  "in a fast-paced environment",
  "in a fast paced environment",
  "fast-paced environment",
  "fast-paced",
  "fast paced",
  "dynamic environment",
  "high-growth",
  "high growth",
  "startup environment",
  "start-up environment",
  "wear many hats",
  "mission-driven",
  "world-class",
  "best-in-class",
  "cutting-edge",
  "state-of-the-art",
  "on a daily basis",
  "as needed",
  "as required",
  "and more",
  "etc.",
  "etc",
  "a variety of",
  "a wide range of",
  "various",
  "the ideal candidate will",
  "the ideal candidate",
  "we are looking for someone who can",
  "we are looking for",
  "you will be responsible for",
  "you will",
  "you'll",
  "you are",
  "responsible for",
  "ability to",
  "able to",
  "proven track record of",
  "proven ability to",
  "track record of",
  "demonstrated ability to",
  "help us",
  "join our team",
  "our team",
  "work closely with",
  "worked cross-functionally",
  "work cross-functionally",
  "cross-functionally",
];

export const LOW_VALUE_WORDS = new Set(
  (
    "strong excellent exceptional outstanding proven demonstrated solid deep keen dynamic innovative passionate driven motivated self-motivated self-starter energetic enthusiastic creative strategic tactical " +
    "highly very extremely effectively successfully seamlessly efficiently proactively closely deeply rapidly quickly continuously consistently regularly actively " +
    "key critical core crucial important essential impactful meaningful robust scalable world-class exciting amazing great best ideal top-notch rockstar ninja"
  ).split(" "),
);

/** Seniority labels that only decorate a title or team ("senior executives", "lead engineers"); never a verb ("Lead CAPA investigations"). */
export const SENIORITY =
  /\b(senior|sr\.?|junior|jr\.?|principal|staff|lead|associate)\s+(?=(product|engineering|design|data|software|ux|ui|marketing|sales|account|program|project|business|research|operations|executives?|managers?|engineers?|designers?|scientists?|analysts?|directors?|leadership|developers?|stakeholders?|leaders?|vice)\b)/gi;

/** Phrases that read as generated filler in a résumé bullet (allowed only if the user already writes them). */
export const FILLER_PHRASES = [
  "leveraged",
  "leveraging",
  "leverage",
  "pivotal role",
  "played a key role",
  "played a crucial role",
  "played a vital role",
  "played an integral role",
  "demonstrated exceptional",
  "demonstrated ability",
  "worked collaboratively",
  "collaborated effectively",
  "synergy",
  "synergies",
  "utilized",
  "utilizing",
  "innovative",
  "impactful",
  "exceptional",
  "dynamic",
  "robust",
  "cutting-edge",
  "seamless",
  "seamlessly",
  "passionate",
  "in order to",
  "a wide range of",
  "various",
  "best-in-class",
  "world-class",
  "state-of-the-art",
  "holistic",
  "transformative",
  "empowering",
  "results-driven",
  "detail-oriented",
  "drove impact",
  "driving impact",
  "spearheaded",
  "meticulously",
  "strategically",
  "successfully",
  "effectively",
  "showcasing",
  "fostering",
  "harnessing",
];

export const STOP = new Set(
  "a an the and or of in on at by for to with from into onto over under via per as is are be been being that this these those it its their our your we you they he she i who whom which what while within across through using based upon than then also both either each such".split(
    " ",
  ),
);

/** Light stem for comparing wording ("processes"/"process", "tested"/"test"). */
export function stem(word: string): string {
  const w = word.toLowerCase().replace(/[^a-z0-9+#]/g, "");
  if (w.length <= 3) return w;
  return w.replace(/(ingly|edly|ings|ing|ied|ies|ed|es|s)$/, (m) => (m === "ies" || m === "ied" ? "y" : "")).replace(/e$/, "");
}

export function contentStems(text: string): string[] {
  return text
    .split(/[^A-Za-z0-9+#]+/)
    .filter((w) => w && !STOP.has(w.toLowerCase()) && w.length > 1)
    .map(stem)
    .filter((w) => w.length > 1);
}
