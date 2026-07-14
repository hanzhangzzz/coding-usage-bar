import { collectStatusSnapshot } from "./runtime.js";
import { markNotified, sendNotification, shouldNotify } from "./notifier.js";

export async function runDaemonOnce(options: { dryRun?: boolean } = {}) {
  const snapshot = await collectStatusSnapshot();
  const messages: string[] = [];

  for (const { analysis } of snapshot.providers) {
    if (!shouldNotify(analysis)) {
      continue;
    }
    messages.push(sendNotification(analysis, options.dryRun));
    if (!options.dryRun) {
      markNotified(analysis);
    }
  }

  return messages.length ? messages : ["No notification needed."];
}
