export interface ThemeApprovalSummary {
  total: number;
  accepted: number;
  export_ready: boolean;
}

export function summarizeThemeApproval(
  items: ReadonlyArray<{ status?: unknown }> | undefined,
): ThemeApprovalSummary {
  const total = items?.length ?? 0;
  const accepted = items?.filter((item) => item.status === 'accepted').length ?? 0;
  return {
    total,
    accepted,
    export_ready: total > 0 && accepted === total,
  };
}
