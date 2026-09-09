import { createPrivateFileScanner, type PrivateFileScanner } from "./privateFileScanner";

// Standard harmless EICAR antivirus-test pattern, assembled only in memory.
// The client creates no test file or stored upload and calls no AI provider.
// ClamAV may spool the stream into its own private temporary scan directory.
export function antivirusTestBytes(): Buffer {
  return Buffer.from(["X5O!P%@AP[4", "\\PZX54(P^)7CC)7}$", "EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"].join(""), "ascii");
}

export async function verifyPrivateFileScanner(scanner: PrivateFileScanner = createPrivateFileScanner()): Promise<void> {
  if (await scanner(Buffer.from("Storyhold antivirus connection check: harmless plain text.\n", "utf8")) !== "clean") {
    throw new Error("scanner_rejected_clean_probe");
  }
  if (await scanner(antivirusTestBytes()) !== "suspicious") throw new Error("scanner_missed_test_pattern");
}

export async function runPrivateFileScannerCheck(
  env: NodeJS.ProcessEnv = process.env,
  output: (message: string) => void = console.log,
): Promise<number> {
  try {
    await verifyPrivateFileScanner(createPrivateFileScanner(env));
    output("Antivirus check passed: clean content accepted and standard test pattern blocked. No uploads, database changes, AI calls, or credits used.");
    return 0;
  } catch {
    // Do not expose connection paths or raw scanner replies in operator logs.
    output("Antivirus check FAILED. Verify STORYHOLD_CLAMD_SOCKET (or loopback STORYHOLD_CLAMD_PORT), a running ClamAV daemon, and current signatures. Both clean-file approval and test-pattern detection must pass before enabling uploads.");
    return 1;
  }
}
