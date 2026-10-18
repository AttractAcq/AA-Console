export const CAPTURE_METHODS = [
  {
    id: "automated_requests",
    label: "Automated Requests",
    description: "Configure delivery triggers and editable request messages.",
  },
  {
    id: "field_capture",
    label: "Field Capture Portal",
    description: "Plan and manage a customer feedback collection page.",
  },
  {
    id: "guided_interview",
    label: "Guided Interview Capture",
    description: "Prepare interview questions and an evidence capture script.",
  },
  { id: "integration", label: "Integration Capture", description: "" },
  {
    id: "manual_import",
    label: "Manual Upload & Import",
    description:
      "Collect proof from employees, contractors and business owners.",
  },
  {
    id: "outcome_followup",
    label: "Outcome Follow-up Engine",
    description: "",
  },
] as const;
export const PROOF_CATEGORIES = {
  customers: [
    "Video Testimonials",
    "Online Reviews",
    "Customer Feedback Forms",
    "Customer-Submitted Photos & Videos",
    "Referral & Recommendation Capture",
    "Customer Interviews",
  ],
  business_operations: [
    "Before-and-after Documentation",
    "Proof of Work Capture",
    "Employee Voice Notes / Field Reports",
    "Job Completion Forms",
    "Measured Result Capture",
    "Historical Project Import",
  ],
  independent_sources: [
    "Certification & Accreditations",
    "Independent Inspection & Verification",
    "Media Mentions & External Recognition",
    "Organic Mentions and Social Listening",
    "Partners and Supplier Endorsements",
    "Customer Outcome Follow-ups",
  ],
} as const;
export const PROOF_DESTINATIONS = [
  "Main Website",
  "SEO / GEO Content",
  "Google Business Profile",
  "Organic Social Media",
  "Paid Advertising",
  "Campaign Landing Pages",
  "Sales Conversations",
  "Email / SMS Nurturing",
  "Third Party Directories",
  "Proposals & Quotations",
] as const;
export const categoryLabel = (value: string) =>
  value.replaceAll("_", " ").replace(/\b\w/g, (c) => c.toUpperCase());
