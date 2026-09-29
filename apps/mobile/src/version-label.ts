/* The About row's value: "0.1.0 (build 6)". Kept pure (no expo-constants
   import) so vitest can cover it — App.tsx feeds it the real bundle values. */
export function formatVersionLabel(version: string, build?: string): string {
  return build ? `${version} (build ${build})` : version;
}
