/* Asset modules imported by src (bundlers resolve them to URLs; typecheck
   needs the declaration since packages/ui has no vite/client types). */
declare module "*.svg" {
  const src: string;
  export default src;
}
