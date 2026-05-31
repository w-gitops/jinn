/**
 * Build the params object for creating a new session via POST /api/sessions.
 * When an employee is selected, include the employee field.
 * When COO is selected (null), omit the employee field entirely.
 */
export function buildNewSessionParams(opts: {
  message: string
  selectedEmployee: string | null
  attachmentIds?: string[]
  /** Engine for the new session (new-chat only). Omit to use the employee/global default. */
  engine?: string | null
  /** Model id for the new session. */
  model?: string | null
  /** Effort level for the new session (only sent for effort-capable models). */
  effortLevel?: string | null
}): Record<string, unknown> {
  const params: Record<string, unknown> = {
    source: 'web',
    prompt: opts.message,
  }

  if (opts.selectedEmployee) {
    params.employee = opts.selectedEmployee
  }

  if (opts.attachmentIds && opts.attachmentIds.length > 0) {
    params.attachments = opts.attachmentIds
  }

  if (opts.engine) params.engine = opts.engine
  if (opts.model) params.model = opts.model
  if (opts.effortLevel) params.effortLevel = opts.effortLevel

  return params
}
