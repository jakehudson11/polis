// Minimal stub for guiding questions in standalone mode.

import { Request, Response } from "express";
import { failJson } from "../utils/fail";

export function handle_POST_generate_guiding_questions(
  _req: Request,
  res: Response
): void {
  failJson(res, 501, "polis_err_guiding_questions_not_enabled");
}
