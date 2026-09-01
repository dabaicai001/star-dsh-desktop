/**
 * Ambient module declaration for `zmodem.js/src/zmodem_browser.js`, which ships
 * no bundled type declarations and has no DefinitelyTyped package. Only the
 * browser bundle's default export is declared here; the consumer
 * (SshTerminalOverlay) narrows it to its own local `ZmodemApi` interface at the
 * point of use, so this export is typed `unknown` rather than reproducing the
 * full rz/sz send/receive surface (Sentry / Browser.send_files / save_to_disk)
 * a second time.
 */
declare module 'zmodem.js/src/zmodem_browser.js' {
  /** ZMODEM browser bundle default export (the global `Zmodem` object). */
  const Zmodem: unknown
  export default Zmodem
}
