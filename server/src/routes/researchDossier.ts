// Minimal stub handlers to keep Polis API booting in standalone mode.
// The full research dossier feature can be wired later if needed.

import { Request, Response } from "express";
import { failJson } from "../utils/fail";

export function handle_GET_research_dossier(_req: Request, res: Response): void {
  failJson(res, 501, "polis_err_research_dossier_not_enabled");
}

export function handle_POST_regenerate_research_dossier(
  _req: Request,
  res: Response
): void {
  failJson(res, 501, "polis_err_research_dossier_not_enabled");
}

export function handle_GET_research_dossier_pdf(
  _req: Request,
  res: Response
): void {
  failJson(res, 501, "polis_err_research_dossier_not_enabled");
}
