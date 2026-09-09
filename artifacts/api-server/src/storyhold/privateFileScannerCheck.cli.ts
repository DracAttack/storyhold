import { runPrivateFileScannerCheck } from "./privateFileScannerCheck";

process.exitCode = await runPrivateFileScannerCheck();
