/**
 * Convert VS Code's desktop userdata URI path into a native Windows path.
 *
 * `revealFileInOS` normally understands VS Code resources, but passing a
 * `vscode-userdata:` URI through to Windows can produce an "open this link"
 * protocol prompt. Returning undefined keeps remote and web resources on
 * VS Code's normal reveal path.
 */
export function nativeWindowsUserDataPath(
  scheme: string,
  uriPath: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform !== 'win32' || scheme !== 'vscode-userdata') return undefined;

  const drivePath = /^\/([a-z]:\/.*)$/i.exec(uriPath)?.[1];
  return drivePath?.replace(/\//g, '\\');
}
