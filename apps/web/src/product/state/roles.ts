/** The customer roles, in words (the server holds what each may do). */
export const ROLE_TEXT: Record<string, { label: string; can: string }> = {
  ADMIN: { label: 'Administrator', can: 'Everything, including the team and settings.' },
  FINANCE: {
    label: 'Finance',
    can: 'Uploads, decisions, rejections, business records and the audit trail.',
  },
  REVIEWER: { label: 'Reviewer', can: 'Sees invoices and answers questions.' },
};
