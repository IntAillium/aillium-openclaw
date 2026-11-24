import { Type } from "@sinclair/typebox";
import { resolveAilliumCoreConfig } from "../../aillium/boundary-runtime.js";
import { optionalStringEnum, stringEnum } from "../schema/typebox.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";

/**
 * Aillium Office tool: Drive, Docs, Sheets, Slides, PDF and Notes in the
 * business's own Aillium Drive. Each call goes to Aillium Core with the run's
 * session key, so it acts for the business, department and person the run
 * belongs to. Core validates every change, saves it as a version and asks a
 * person to approve sharing, permanent deletes and sending files to Lark.
 * Only offered when Aillium Core is configured.
 */

export const AILLIUM_OFFICE_ACTIONS = [
  "help",
  "files.list",
  "files.search",
  "files.open",
  "files.create_folder",
  "files.rename",
  "files.move",
  "files.copy",
  "files.trash",
  "files.restore",
  "files.purge",
  "files.share",
  "files.export",
  "files.versions",
  "files.restore_version",
  "docs.create",
  "docs.read",
  "docs.insert",
  "docs.replace",
  "docs.format",
  "docs.insert_table",
  "docs.edit",
  "docs.summarise",
  "sheets.create",
  "sheets.read_range",
  "sheets.write_range",
  "sheets.set_formula",
  "sheets.add_worksheet",
  "sheets.calculate",
  "sheets.create_chart",
  "sheets.edit",
  "slides.create",
  "slides.read",
  "slides.add_slide",
  "slides.update_slide",
  "slides.add_object",
  "slides.update_object",
  "slides.add_chart",
  "slides.set_notes",
  "slides.edit",
  "pdf.extract_text",
  "pdf.metadata",
  "pdf.summarise",
  "pdf.merge",
  "pdf.split",
  "pdf.reorder",
  "pdf.rotate",
  "pdf.delete_pages",
  "pdf.fill_form",
  "notes.create",
  "notes.update",
  "notes.search",
  "notes.extract_tasks",
  "lark.import",
  "lark.export",
  "lark.publish",
] as const;

// PDF and Lark conversions can take a while on a busy server.
const OFFICE_TIMEOUT_MS = 120_000;

const AnyObject = Type.Object({}, { additionalProperties: true });

const AilliumOfficeSchema = Type.Object({
  action: stringEnum(AILLIUM_OFFICE_ACTIONS, { description: "What to do. Use help for formats." }),
  file: Type.Optional(Type.String({ description: "File id (or exact file name)." })),
  files: Type.Optional(Type.Array(Type.String(), { description: "pdf.merge: file ids in order." })),
  title: Type.Optional(Type.String({ description: "*.create: name of the new file." })),
  name: Type.Optional(
    Type.String({ description: "New name (rename, create_folder, copy, outputs)." }),
  ),
  content: Type.Optional(
    Type.String({
      description: "docs/notes: Markdown to write (create, insert, replace section).",
    }),
  ),
  location: optionalStringEnum(["my", "org", "department"] as const, {
    description:
      "Where to save: my (the person's drive), org, or department (default for department AIs).",
  }),
  department_id: Type.Optional(Type.String({ description: "location=department: which one." })),
  folder: Type.Optional(Type.String({ description: "Folder id to save into or list." })),
  view: optionalStringEnum(
    ["my", "org", "department", "shared", "recent", "favourites", "trash"] as const,
    {
      description: "files.list: which part of Drive.",
    },
  ),
  query: Type.Optional(Type.String({ description: "files.search / notes.search: words to find." })),
  kind: optionalStringEnum(["doc", "sheet", "slides", "note", "pdf", "folder", "file"] as const, {
    description: "files.search: only this kind.",
  }),
  tag: Type.Optional(Type.String({ description: "Search by tag." })),
  tags: Type.Optional(Type.Array(Type.String(), { description: "notes.create: tags." })),
  format: optionalStringEnum(["docx", "pdf", "html", "md", "txt", "xlsx", "csv", "pptx"] as const, {
    description: "files.export / lark.export: file format.",
  }),
  version: Type.Optional(Type.Number({ description: "files.restore_version: version number." })),
  heading: Type.Optional(
    Type.String({ description: "docs.replace / docs.format: the section heading to work on." }),
  ),
  after_heading: Type.Optional(
    Type.String({ description: "docs.insert / docs.insert_table: put it after this section." }),
  ),
  find: Type.Optional(Type.String({ description: "docs.replace: text to find." })),
  replace: Type.Optional(Type.String({ description: "docs.replace: replacement text." })),
  text: Type.Optional(Type.String({ description: "docs.format: blocks containing this text." })),
  block: optionalStringEnum(["paragraph", "heading1", "heading2", "heading3", "heading4"] as const),
  align: optionalStringEnum(["left", "center", "right", "justify"] as const),
  marks: Type.Optional(AnyObject),
  append: Type.Optional(Type.String({ description: "notes.update: Markdown to add at the end." })),
  operations: Type.Optional(
    Type.Array(AnyObject, {
      description: "docs.edit / sheets.edit / slides.edit: change objects (see help).",
    }),
  ),
  sheet: Type.Optional(Type.String({ description: "Worksheet name (default the first)." })),
  range: Type.Optional(Type.String({ description: "Cell range like A1:C10." })),
  start: Type.Optional(Type.String({ description: "sheets.write_range: top-left cell, e.g. A1." })),
  cell: Type.Optional(Type.String({ description: "sheets.set_formula: the cell." })),
  cells: Type.Optional(
    Type.Array(Type.String(), {
      description: "sheets.calculate: cells to return, e.g. Sheet1!B4.",
    }),
  ),
  formula: Type.Optional(Type.String({ description: "sheets.set_formula: e.g. =SUM(B2:B10)." })),
  values: Type.Optional(
    Type.Array(Type.Array(Type.Unknown()), {
      description: 'sheets.write_range: rows of values; text starting with "=" is a formula.',
    }),
  ),
  rows: Type.Optional(
    Type.Array(Type.Array(Type.Unknown()), {
      description:
        "sheets.create: starting rows. docs.insert_table: table rows (first is the header).",
    }),
  ),
  worksheet: Type.Optional(Type.String({ description: "sheets.create: first worksheet name." })),
  chart_type: optionalStringEnum(["column", "bar", "line", "pie"] as const),
  at: Type.Optional(Type.String({ description: "sheets.create_chart: anchor cell." })),
  slide: Type.Optional(Type.Number({ description: "Slide number, from 1." })),
  slides: Type.Optional(
    Type.Array(AnyObject, {
      description: "slides.create: [{title, bullets[], body, notes, layout}] in order.",
    }),
  ),
  layout: optionalStringEnum(["title", "title-body", "two-column", "section", "blank"] as const),
  theme: optionalStringEnum(["aillium-night", "aillium-day", "rehabsync", "slate"] as const),
  body: Type.Optional(Type.String({ description: "slides: body text." })),
  bullets: Type.Optional(Type.Array(Type.String(), { description: "slides: bullet points." })),
  notes: Type.Optional(Type.String({ description: "slides: speaker notes." })),
  position: Type.Optional(Type.Number({ description: "slides.add_slide: position, from 1." })),
  object: Type.Optional(AnyObject),
  object_id: Type.Optional(Type.String({ description: "slides.update_object: the object id." })),
  changes: Type.Optional(AnyObject),
  labels: Type.Optional(Type.Array(Type.String(), { description: "slides.add_chart: labels." })),
  series: Type.Optional(
    Type.Array(AnyObject, {
      description: 'slides.add_chart: [{"name":"Revenue","values":[1,2]}].',
    }),
  ),
  from_sheet: Type.Optional(
    Type.String({
      description: "slides.add_chart: take the data from this spreadsheet (with range).",
    }),
  ),
  pages: Type.Optional(
    Type.Array(Type.String(), { description: 'pdf: pages, e.g. ["1", "3-5"].' }),
  ),
  order: Type.Optional(
    Type.Array(Type.String(), { description: "pdf.reorder: every page in the new order." }),
  ),
  degrees: Type.Optional(Type.Number({ description: "pdf.rotate: 90, 180 or 270." })),
  form_values: Type.Optional(AnyObject),
  flatten: Type.Optional(Type.Boolean({ description: "pdf.fill_form: lock the filled fields." })),
  user_ids: Type.Optional(Type.Array(Type.String(), { description: "files.share: people." })),
  department_ids: Type.Optional(
    Type.Array(Type.String(), { description: "files.share: departments." }),
  ),
  role: optionalStringEnum(["viewer", "editor"] as const),
  connection_id: Type.Optional(Type.String({ description: "lark.*: the Lark connection id." })),
  lark_file: Type.Optional(Type.String({ description: "lark.import: Lark file token." })),
  lark_type: Type.Optional(Type.String({ description: "lark.import: docx, sheet or file." })),
  lark_folder: Type.Optional(
    Type.String({ description: "lark.export / lark.publish: folder token." }),
  ),
  label: Type.Optional(Type.String({ description: "Edits: a short version label." })),
  approval_id: Type.Optional(
    Type.String({ description: "After a person approves: the approvalId from approval_required." }),
  ),
  limit: Type.Optional(Type.Number({ description: "List actions: how many to return." })),
});

export async function callAilliumOffice(params: {
  sessionKey?: string;
  action: string;
  args: Record<string, unknown>;
  fetchImpl?: typeof fetch;
}): Promise<unknown> {
  const config = resolveAilliumCoreConfig();
  if (!config) {
    throw new Error("Aillium Office needs Aillium Core, which is not configured here.");
  }
  if (!params.sessionKey) {
    throw new Error("Aillium Office tools only work inside an Aillium task.");
  }
  const { action: _action, ...rest } = params.args;
  const res = await (params.fetchImpl ?? fetch)(`${config.baseUrl}/master-agent/runtime/office`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-aillium-runtime-token": config.syncToken,
    },
    body: JSON.stringify({ sessionKey: params.sessionKey, action: params.action, params: rest }),
    signal: AbortSignal.timeout(Math.max(config.timeoutMs ?? 0, OFFICE_TIMEOUT_MS)),
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
        : `Aillium Office could not do that (HTTP ${res.status}).`;
    throw new Error(message);
  }
  return body;
}

export function createAilliumOfficeTool(opts?: { agentSessionKey?: string }): AnyAgentTool | null {
  if (!resolveAilliumCoreConfig()) {
    return null;
  }
  return {
    label: "Aillium Office",
    name: "aillium_office",
    description: [
      "Create, read and edit the business's own files in Aillium Drive: Docs, Sheets, Slides, PDFs and Notes. Use this (not the browser) for documents, spreadsheets and presentations.",
      "Find: files.search (query), files.list (view, folder), files.open (file). Save new files with location my|org|department or folder.",
      "Docs/Notes: docs.create (title, content as Markdown), docs.insert, docs.replace (heading+content, or find+replace), docs.insert_table (rows), docs.edit (operations). notes.extract_tasks lists to-dos.",
      "Sheets: sheets.create (title, rows), sheets.write_range (start, values), sheets.set_formula, sheets.read_range, sheets.calculate, sheets.create_chart. Always use formulas for totals and calculations; the engine works out the numbers.",
      "Slides: slides.create (title, slides[{title, bullets, notes}]), slides.add_slide, slides.update_slide, slides.add_chart (labels+series, or from_sheet+range), slides.set_notes.",
      "PDF: pdf.extract_text, pdf.metadata, pdf.merge (files), pdf.split (pages), pdf.reorder (order), pdf.rotate, pdf.delete_pages, pdf.fill_form (form_values).",
      "files.export (format) saves a DOCX/XLSX/PPTX/PDF copy to Drive. lark.import/export/publish move files to and from Lark.",
      "Sharing, deleting for good, sending to Lark and edits of more than 50 changes return approval_required: tell the person, and once approved call again with exactly the same details plus approval_id.",
      "Use help for the exact change formats. Use UK English, £ and dd/mm/yyyy.",
    ].join(" "),
    parameters: AilliumOfficeSchema,
    execute: async (_toolCallId, args) => {
      const params = (args ?? {}) as Record<string, unknown>;
      const action = typeof params.action === "string" ? params.action : "";
      if (!(AILLIUM_OFFICE_ACTIONS as readonly string[]).includes(action)) {
        throw new Error(`Unknown action "${action}".`);
      }
      const result = await callAilliumOffice({
        sessionKey: opts?.agentSessionKey,
        action,
        args: params,
      });
      return jsonResult(result);
    },
  };
}
