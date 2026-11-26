import { Type } from "@sinclair/typebox";
import { resolveAilliumCoreConfig } from "../../aillium/boundary-runtime.js";
import { optionalStringEnum, stringEnum } from "../schema/typebox.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";

/**
 * Aillium workspace tool: Lark Drive documents, Lark Tasks, the calendar,
 * and asking another department's AI. Each call goes to Aillium Core with
 * the run's session key, so it acts for the business and person the run
 * belongs to. Only offered when Aillium Core is configured.
 */

export const AILLIUM_WORKSPACE_ACTIONS = [
  "drive_list",
  "doc_read",
  "doc_create",
  "doc_append",
  "tasks_list",
  "task_create",
  "task_update",
  "calendar_list",
  "meeting_create",
  "ask_department",
  "department_reply",
  "projects_list",
  "project_update",
  "codespace_start",
  "codespace_status",
  "crm_attention_list",
  "crm_customer_status",
  "crm_prepare_followup",
  "crm_meeting_prep",
  "crm_upsert_customer",
  "crm_pipeline_summary",
  "accounting_create_sales_invoice",
  "accounting_payment_status",
  "accounting_process_bill",
  "finance_expected_cashflow",
  "departments_live_status",
] as const;

// Asking a department waits for its answer, so allow well past Core's own wait.
const ASK_TIMEOUT_MS = 300_000;
const DEFAULT_TIMEOUT_MS = 60_000;

const AilliumWorkspaceSchema = Type.Object({
  action: stringEnum(AILLIUM_WORKSPACE_ACTIONS, { description: "What to do." }),
  account: optionalStringEnum(["aillium", "mine"] as const, {
    description:
      'Lark account to use: "aillium" (Aillium\'s own, the default) or "mine" (the person\'s own).',
  }),
  document: Type.Optional(
    Type.String({ description: "doc_read / doc_append: Lark document link or id." }),
  ),
  title: Type.Optional(
    Type.String({ description: "doc_create / meeting_create: document or meeting title." }),
  ),
  content: Type.Optional(
    Type.String({ description: "doc_create / doc_append: Markdown to write into the document." }),
  ),
  folder: Type.Optional(
    Type.String({ description: "doc_create: Drive folder token (root folder when omitted)." }),
  ),
  status: optionalStringEnum(["open", "done", "all"] as const, {
    description: "tasks_list: which tasks to list (default all).",
  }),
  task_id: Type.Optional(Type.String({ description: "task_update: the task id." })),
  summary: Type.Optional(Type.String({ description: "task_create / task_update: task summary." })),
  description: Type.Optional(
    Type.String({ description: "task_create / task_update / meeting_create: details." }),
  ),
  due: Type.Optional(
    Type.String({ description: "task_create / task_update: due date-time, ISO 8601 (UK time)." }),
  ),
  all_day: Type.Optional(Type.Boolean({ description: "task_create / task_update: due all day." })),
  completed: Type.Optional(
    Type.Boolean({ description: "task_update: true marks it done, false reopens it." }),
  ),
  assignees: Type.Optional(
    Type.Array(Type.String(), { description: "task_create: email addresses to assign." }),
  ),
  start: Type.Optional(Type.String({ description: "meeting_create: start, ISO 8601." })),
  end: Type.Optional(Type.String({ description: "meeting_create: end, ISO 8601." })),
  location: Type.Optional(Type.String({ description: "meeting_create: location." })),
  attendees: Type.Optional(
    Type.Array(Type.String(), { description: "meeting_create: attendee email addresses." }),
  ),
  department: Type.Optional(
    Type.String({ description: "ask_department: department name, for example Finance." }),
  ),
  question: Type.Optional(
    Type.String({ description: "ask_department: the question or piece of work, in full." }),
  ),
  context: Type.Optional(
    Type.String({ description: "ask_department: background the department needs." }),
  ),
  ref: Type.Optional(
    Type.String({ description: "department_reply: the ref ask_department returned." }),
  ),
  wait_seconds: Type.Optional(
    Type.Number({ description: "ask_department / department_reply: how long to wait (max 240)." }),
  ),
  project_id: Type.Optional(
    Type.String({
      description:
        "project_update / codespace_start / codespace_status: the project id from projects_list.",
    }),
  ),
  customer: Type.Optional(
    Type.String({
      description:
        "crm_customer_status / crm_prepare_followup / crm_upsert_customer / accounting_create_sales_invoice / accounting_payment_status: customer company name, domain, email, or id.",
    }),
  ),
  contact_name: Type.Optional(
    Type.String({ description: "crm_upsert_customer: primary contact name." }),
  ),
  contact_email: Type.Optional(
    Type.String({
      description:
        "crm_upsert_customer / crm_prepare_followup: contact or recipient email address.",
    }),
  ),
  contact_phone: Type.Optional(
    Type.String({ description: "crm_upsert_customer: contact phone number." }),
  ),
  website: Type.Optional(
    Type.String({ description: "crm_upsert_customer: company website or domain." }),
  ),
  deal_id: Type.Optional(
    Type.String({
      description: "accounting_create_sales_invoice / crm_prepare_followup: CRM deal id.",
    }),
  ),
  invoice_number: Type.Optional(
    Type.String({
      description: "accounting_process_bill / accounting_payment_status: invoice number.",
    }),
  ),
  supplier_name: Type.Optional(
    Type.String({ description: "accounting_process_bill: supplier name." }),
  ),
  amount_gbp: Type.Optional(
    Type.Number({
      description:
        "crm_upsert_customer / accounting_create_sales_invoice / accounting_process_bill: amount in GBP.",
    }),
  ),
  vat_gbp: Type.Optional(
    Type.Number({ description: "accounting_process_bill: VAT amount in GBP." }),
  ),
  horizon_days: Type.Optional(
    Type.Number({
      description:
        "crm_meeting_prep / accounting_payment_status / finance_expected_cashflow: lookahead days (default 7 or 30).",
    }),
  ),
  limit: Type.Optional(Type.Number({ description: "List actions: how many to return." })),
});

export async function callAilliumWorkspace(params: {
  sessionKey?: string;
  action: string;
  args: Record<string, unknown>;
  fetchImpl?: typeof fetch;
}): Promise<unknown> {
  const config = resolveAilliumCoreConfig();
  if (!config) {
    throw new Error("Aillium workspace tools need Aillium Core, which is not configured here.");
  }
  if (!params.sessionKey) {
    throw new Error("Aillium workspace tools only work inside an Aillium task.");
  }
  const { action: _action, ...rest } = params.args;
  const timeoutMs =
    params.action === "ask_department" || params.action === "department_reply"
      ? ASK_TIMEOUT_MS
      : Math.max(config.timeoutMs ?? 0, DEFAULT_TIMEOUT_MS);
  const res = await (params.fetchImpl ?? fetch)(`${config.baseUrl}/master-agent/runtime/tools`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-aillium-runtime-token": config.syncToken,
    },
    body: JSON.stringify({ sessionKey: params.sessionKey, action: params.action, params: rest }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const message =
      body &&
      typeof body === "object" &&
      typeof (body as { message?: unknown }).message === "string"
        ? (body as { message: string }).message
        : `Aillium could not do that (HTTP ${res.status}).`;
    throw new Error(message);
  }
  return body;
}

export function createAilliumWorkspaceTool(opts?: {
  agentSessionKey?: string;
}): AnyAgentTool | null {
  if (!resolveAilliumCoreConfig()) {
    return null;
  }
  return {
    label: "Aillium workspace",
    name: "aillium_workspace",
    description: [
      "Work with the business's projects, Codespace, Lark and departments.",
      "Projects: projects_list (projects and their next milestone), project_update (project_id, content) posts a progress update.",
      "Codespace: codespace_start (project_id, content = what to change, title) makes code changes in the project's GitHub repository on its own branch; merging always waits for a person. codespace_status (project_id) checks on it.",
      "For documents, sheets, slides, notes and PDFs use the aillium_office tool first; use Lark below when asked for or when the work must live there.",
      "Drive: drive_list, doc_read (document), doc_create (title, content as Markdown), doc_append (document, content).",
      "Lark tasks: tasks_list (status), task_create (summary, description, due, assignees), task_update (task_id, completed, ...).",
      "Calendar: calendar_list, meeting_create (title, start, end, attendees, location, description).",
      'Uses Aillium\'s own Lark account unless account="mine".',
      "Departments: ask_department (department, question, context) asks that department's AI and returns its reviewed answer; ask the same department again to follow up. If it is still working, department_reply (ref) checks again. departments_live_status shows what every department is currently working on.",
      "Aillium CRM: crm_attention_list (customers needing attention or awaiting replies), crm_customer_status (customer = name/domain/id), crm_prepare_followup (customer, contact_email, title = subject, content = body; drafts and submits for approval), crm_meeting_prep (horizon_days = 2 prepares briefings for upcoming meetings), crm_upsert_customer (customer, website, contact_name, contact_email, contact_phone, amount_gbp), crm_pipeline_summary (pipeline stages, proposals awaiting response, and revenue tiers).",
      "Finance & Accounting: accounting_create_sales_invoice (deal_id or customer, amount_gbp; prepares sales invoice awaiting Finance approval), accounting_payment_status (customer, invoice_number, horizon_days; checks paid, due, and overdue invoices), accounting_process_bill (supplier_name, invoice_number, amount_gbp, vat_gbp, due, description), finance_expected_cashflow (horizon_days = 30; verified receivables vs payables).",
      "Use UK dates and £ in anything you write.",
    ].join(" "),
    parameters: AilliumWorkspaceSchema,
    execute: async (_toolCallId, args) => {
      const params = (args ?? {}) as Record<string, unknown>;
      const action = typeof params.action === "string" ? params.action : "";
      if (!(AILLIUM_WORKSPACE_ACTIONS as readonly string[]).includes(action)) {
        throw new Error(`Unknown action "${action}".`);
      }
      const result = await callAilliumWorkspace({
        sessionKey: opts?.agentSessionKey,
        action,
        args: params,
      });
      return jsonResult(result);
    },
  };
}
