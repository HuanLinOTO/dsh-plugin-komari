/** Ambient declarations for the client half's CSS-module imports (tsdown inlines them). */
declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}
