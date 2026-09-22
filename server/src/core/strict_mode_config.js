export const STRICT_TOOL_MODE = {
  enabled: true,
  requireJsonForTools: true,
  blockNarrativeActions: true,
  allowTextOnlyWhenNoTool: true,
  maxRetries: 1
};

export function shouldForceToolMode(tools = []) {
  return STRICT_TOOL_MODE.enabled && Array.isArray(tools) && tools.length > 0;
}
